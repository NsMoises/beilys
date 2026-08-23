require('dotenv').config();

const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  useMongoDBAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');

const PREFIX = process.env.PREFIX || '!';
const BOT_NAME = process.env.BOT_NAME || 'MiBotWhatsApp';
const MONGODB_URI = process.env.MONGODB_URI;
const PORT = process.env.PORT || 3000;
const API_TOKEN = process.env.API_TOKEN;
const WEBHOOK_URL = (process.env.WEBHOOK_URL || '').replace(/\/+$/, '');
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || '';
const AUTH_DIR = path.join(__dirname, 'auth_info');

const webhookEnabled = Boolean(WEBHOOK_URL && WEBHOOK_TOKEN);
const forwardedIds = new Set();
const MAX_FORWARDED_IDS = 4000;

// LID to Phone mapping
const lidToPhoneJid = new Map();

let status = 'connecting';
let socket;

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

function postJson(url, payload, onSuccess, onError) {
  const body = JSON.stringify(payload);
  const client = url.startsWith('https') ? https : http;
  const req = client.request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${WEBHOOK_TOKEN}`,
      'Content-Length': Buffer.byteLength(body),
    },
    timeout: 30000,
  }, (res) => {
    res.on('data', () => {});
    res.on('end', () => onSuccess(res.statusCode));
  });
  req.on('timeout', () => req.destroy(new Error('timeout')));
  req.on('error', onError);
  req.end(body);
}

function forwardToWebhook(payload) {
  if (!webhookEnabled) return;
  postJson(
    WEBHOOK_URL,
    payload,
    (statusCode) => logger.info(`Webhook respondio ${statusCode}`),
    (err) => logger.error({ err }, 'Error al reenviar al webhook'),
  );
}

function rememberForwarded(id) {
  forwardedIds.add(id);
  if (forwardedIds.size > MAX_FORWARDED_IDS) {
    for (const oldId of forwardedIds) {
      forwardedIds.delete(oldId);
      if (forwardedIds.size <= MAX_FORWARDED_IDS / 2) break;
    }
  }
}

let lastTunnelUrl = '';

function registerWithWeb(baseUrl) {
  if (!webhookEnabled) return;
  postJson(
    `${WEBHOOK_URL.replace(/\/+$/, '')}/register`,
    { base_url: baseUrl },
    (statusCode) => {
      if (statusCode === 200) {
        logger.info(`URL del bot registrada en la web: ${baseUrl}`);
      } else {
        logger.error(`La web rechazo el registro de la URL (HTTP ${statusCode}). Conecta el bot una vez desde el panel.`);
      }
    },
    (err) => logger.error({ err }, 'Error al registrar la URL en la web'),
  );
}

function startTunnel() {
  if (!webhookEnabled) return;
  const cloudflared = path.join(__dirname, 'cloudflared.exe');
  if (!fs.existsSync(cloudflared)) {
    logger.warn('No se encontro cloudflared.exe; el bot no tendra URL publica.');
    return;
  }

  logger.info('Iniciando tunel automatico de Cloudflare...');
  const child = spawn(cloudflared, ['tunnel', '--url', `http://localhost:${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  let buffer = '';

  const extractUrl = (chunk) => {
    buffer += chunk.toString();
    const match = buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
    if (match && match[0] !== lastTunnelUrl) {
      lastTunnelUrl = match[0];
      logger.info(`Tunel publico: ${lastTunnelUrl}`);
      registerWithWeb(lastTunnelUrl);
    }
  };

  child.stdout.on('data', extractUrl);
  child.stderr.on('data', extractUrl);
  child.on('exit', (code) => {
    logger.warn(`El tunel se cerro (codigo ${code}). Reiniciando en 10 segundos...`);
    lastTunnelUrl = '';
    setTimeout(startTunnel, 10000);
  });
}

function getHelpText() {
  return [
    `*${BOT_NAME}* - Comandos disponibles:`,
    `${PREFIX}ping - Verifica si el bot responde`,
    `${PREFIX}info - Estado de la conexion`,
    `${PREFIX}help - Muestra esta ayuda`,
  ].join('\n');
}

async function getAuthState() {
  if (MONGODB_URI) {
    const { MongoClient } = require('mongodb');
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    const db = client.db(process.env.MONGODB_DB || 'whatsapp-bot');
    logger.info('Sesion persistida en MongoDB');
    const { state, saveCreds } = await useMongoDBAuthState(db);
    return { state, saveCreds };
  }
  logger.info('Sesion persistida en archivos locales (auth_info/)');
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  return { state, saveCreds };
}

function resolvePhoneFromLid(msg) {
  const remoteJid = msg.key.remoteJid;
  const lid = remoteJid.endsWith('@lid') ? remoteJid : null;
  
  if (!lid) return null;

  // 1. Try remoteJidAlt
  if (msg.key.remoteJidAlt && String(msg.key.remoteJidAlt).endsWith('@s.whatsapp.net')) {
    return msg.key.remoteJidAlt;
  }

  // 2. Try participantPn
  if (msg.key.participantPn && String(msg.key.participantPn).endsWith('@s.whatsapp.net')) {
    return msg.key.participantPn;
  }

  // 3. Try senderPn
  if (msg.key.senderPn && String(msg.key.senderPn).endsWith('@s.whatsapp.net')) {
    return msg.key.senderPn;
  }

  // 4. Try participantAlt
  if (msg.key.participantAlt && String(msg.key.participantAlt).endsWith('@s.whatsapp.net')) {
    return msg.key.participantAlt;
  }

  // 5. Try local LID -> PN map
  const mappedPn = lidToPhoneJid.get(lid);
  if (mappedPn && String(mappedPn).endsWith('@s.whatsapp.net')) {
    return mappedPn;
  }

  // 6. Try socket.signalRepository.lidMapping.getPNForLID(lid)
  if (socket?.signalRepository?.lidMapping?.getPNForLID) {
    try {
      const pn = socket.signalRepository.lidMapping.getPNForLID(lid);
      if (pn && String(pn).endsWith('@s.whatsapp.net')) {
        return pn;
      }
    } catch (e) {
      // Ignore errors from signalRepository
    }
  }

  return null;
}

async function handleMessage(sock, msg) {
  if (msg.key.fromMe) return;
  if (msg.key.remoteJid === 'status@broadcast') return;

  const remoteJid = msg.key.remoteJid;
  const isLid = remoteJid.endsWith('@lid');
  const isRegular = remoteJid.endsWith('@s.whatsapp.net');

  if (!isLid && !isRegular) return;

  const text =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption ||
    '';

  if (!text) return;

  let fromPhoneJid = null;

  if (isRegular) {
    fromPhoneJid = remoteJid;
  } else if (isLid) {
    fromPhoneJid = resolvePhoneFromLid(msg);
    
    if (!fromPhoneJid) {
      logger.warn({ lid: msg.key.remoteJid, msgId: msg.key.id }, 'No se pudo resolver LID a telefono real. Esperando lid-mapping.update.');
      return;
    }
  }

  // Normalize to phone number without @s.whatsapp.net
  const fromPhone = fromPhoneJid.replace('@s.whatsapp.net', '');

  if (webhookEnabled) {
    if (forwardedIds.has(msg.key.id)) return;
    rememberForwarded(msg.key.id);
    forwardToWebhook({
      messages: [{
        id: msg.key.id,
        from: fromPhone,
        text,
        timestamp: msg.messageTimestamp
          ? Math.floor(Number(msg.messageTimestamp) || 0)
          : Math.floor(Date.now() / 1000),
        name: msg.pushName || undefined,
      }],
    });
    return;
  }

  // Local command handling (non-webhook mode)
  const jid = isRegular ? remoteJid : ` ${fromPhoneJid}`; // fallback for local commands
  
  if (!text.startsWith(PREFIX)) {
    sock.sendMessage(jid, {
      text: `Hola, soy ${BOT_NAME}. Escribe ${PREFIX}help para ver los comandos disponibles.`,
    }, { quoted: msg });
    return;
  }

  const args = text.slice(PREFIX.length).trim().split(/\s+/);
  const cmd = (args.shift() || '').toLowerCase();

  switch (cmd) {
    case 'ping':
      sock.sendMessage(jid, { text: 'pong' }, { quoted: msg });
      break;
    case 'info':
      sock.sendMessage(jid, {
        text: `Estado: ${status}\nNombre: ${BOT_NAME}\nPrefijo: ${PREFIX}`,
      }, { quoted: msg });
      break;
    case 'help':
      sock.sendMessage(jid, { text: getHelpText() }, { quoted: msg });
      break;
    default:
      sock.sendMessage(jid, {
        text: `Comando "${cmd}" no reconocido. Usa ${PREFIX}help para ver los comandos.`,
      }, { quoted: msg });
  }
}

async function connectToWhatsApp() {
  const { state, saveCreds } = await getAuthState();
  const { version } = await fetchLatestBaileysVersion();
  logger.info(`Usando Baileys version ${version.join('.')}`);

  socket = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: [BOT_NAME, 'Chrome', '22.0'],
  });

  socket.ev.on('creds.update', saveCreds);

  // LID mapping update handler
  socket.ev.on('lid-mapping.update', ({ lid, pn }) => {
    if (lid && pn) {
      lidToPhoneJid.set(lid, pn);
      logger.debug({ lid, pn }, 'Actualizado mapeo LID -> PN');
    }
  });

  socket.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      status = 'waiting_qr';
      console.log('\nEscanea este QR con el numero que usara el bot:');
      console.log('WhatsApp > Dispositivos vinculados > Vincular dispositivo\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      status = 'disconnected';
      console.log(`Conexion cerrada: ${lastDisconnect?.error?.message || 'motivo desconocido'}`);
      if (shouldReconnect) {
        console.log('Reconectando en 3 segundos...');
        setTimeout(connectToWhatsApp, 3000);
      } else {
        console.log('Sesion cerrada en WhatsApp. Borra auth_info/ o la coleccion en Mongo y escanea el QR de nuevo.');
      }
    }

    if (connection === 'open') {
      status = 'connected';
      console.log('Conectado a WhatsApp.');
    }
  });

  socket.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    
    // Ignore events that include requestId (typically sent messages)
    for (const msg of messages) {
      if (msg.key.requestId) continue;
      await handleMessage(socket, msg);
    }
  });

  socket.ev.on('messages.update', (updates) => {
    if (!webhookEnabled) return;
    const statuses = [];
    for (const update of updates) {
      const id = update.key?.id;
      if (!id) continue;
      
      // Baileys status mapping: 2 = sent, 3 = delivered, 4 = read
      let status = null;
      if (update.status === 2) status = 'sent';
      else if (update.status === 3) status = 'delivered';
      else if (update.status === 4) status = 'read';
      
      if (!status) continue;
      if (forwardedIds.has(`st:${id}:${status}`)) continue;
      rememberForwarded(`st:${id}:${status}`);
      
      statuses.push({
        id,
        status,
        timestamp: update.receiptTimestamp
          ? Math.floor(Number(update.receiptTimestamp) || 0)
          : Math.floor(Date.now() / 1000),
      });
    }
    if (statuses.length > 0) {
      forwardToWebhook({ statuses });
    }
  });
}

function normalizeJid(phone) {
  let digits = String(phone).replace(/[^\d]/g, '');
  if (digits.endsWith('@s.whatsapp.net')) return digits;
  return `${digits}@s.whatsapp.net`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) {
        reject(new Error('Body demasiado grande'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function isAuthorized(req) {
  if (!API_TOKEN) return false;
  const header = req.headers['authorization'] || '';
  return header === `Bearer ${API_TOKEN}`;
}

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function sendJson(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function sendMessageHandler(req, res) {
  if (!socket || status !== 'connected') {
    sendJson(res, 503, { ok: false, error: 'El bot no esta conectado a WhatsApp' });
    return;
  }

  let body;
  try {
    body = JSON.parse((await readBody(req)) || '{}');
  } catch (err) {
    sendJson(res, 400, { ok: false, error: 'JSON invalido' });
    return;
  }

  const to = body.to || body.number || body.phone;
  const text = body.text || body.message;

  if (!to || !text) {
    sendJson(res, 400, { ok: false, error: 'Faltan campos: to (numero) y text (mensaje)' });
    return;
  }

  try {
    const jid = normalizeJid(to);
    const sent = await socket.sendMessage(jid, { text });
    logger.info(`Mensaje enviado a ${jid} (id ${sent.key?.id})`);
    
    // Note: We don't assume delivery just because Baileys returned an ID.
    // Delivery status will be received via messages.update events.
    sendJson(res, 200, { ok: true, id: sent.key?.id, to: jid });
  } catch (err) {
    // Handle specific error codes from WhatsApp
    if (err.name === 'BaileysError' || err.message?.includes('463')) {
      logger.error({ err, to: normalizeJid(to) }, 'Error 463: cuenta restringida o falta tc token');
      sendJson(res, 500, { 
        ok: false, 
        error: 'WhatsApp restringio el envio a este contacto (error 463)' 
      });
    } else {
      logger.error({ err }, 'Error al enviar mensaje por API');
      sendJson(res, 500, { ok: false, error: err.message || 'Error al enviar el mensaje' });
    }
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) {
        reject(new Error('Body demasiado grande'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function isAuthorized(req) {
  if (!API_TOKEN) return false;
  const header = req.headers['authorization'] || '';
  return header === `Bearer ${API_TOKEN}`;
}

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function sendJson(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  setCorsHeaders(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/') {
    sendJson(res, 200, { bot: BOT_NAME, status, uptime: process.uptime() });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/send-message') {
    if (!isAuthorized(req)) {
      sendJson(res, 401, { ok: false, error: 'No autorizado. Envia Authorization: Bearer <API_TOKEN>' });
      return;
    }
    await sendMessageHandler(req, res);
    return;
  }

  sendJson(res, 404, { ok: false, error: 'Ruta no encontrada' });
});

server.listen(PORT, () => {
  logger.info(`Servidor de estado escuchando en el puerto ${PORT}`);
  startTunnel();
});

process.on('SIGINT', () => {
  console.log('Cerrando...');
  server.close();
  process.exit(0);
});

connectToWhatsApp().catch((err) => {
  console.error('Error al iniciar el bot:', err);
  process.exit(1);
});