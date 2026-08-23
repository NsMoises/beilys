require('dotenv').config();

const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const express = require('express');
const cors = require('cors');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  useMongoDBAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');

// Import configuration
const config = require('./config');

// Import services
const Database = require('./utils/Database');
const LidResolver = require('./services/LidResolver');
const WebhookDelivery = require('./services/WebhookDelivery');
const MediaService = require('./services/MediaService');
const MessageProcessor = require('./services/MessageProcessor');

// Import logger
const { createLogger } = require('./utils/logger');

const logger = createLogger('bot');

class WhatsAppBot {
  constructor() {
    this.socket = null;
    this.status = 'connecting';
    this.server = null;
    this.tunnelProcess = null;
    this.lastTunnelUrl = '';
    this.db = null;
    this.database = null;
    this.lidResolver = null;
    this.webhookDelivery = null;
    this.mediaService = null;
    this.messageProcessor = null;
    this.forwardedIds = new Set();
    this.MAX_FORWARDED_IDS = config.MAX_FORWARDED_IDS;
    this.messageCache = new Map();
    this.MAX_CACHE_SIZE = config.MAX_CACHE_SIZE;
  }

  async initialize() {
    logger.info('Initializing WhatsApp Bot...');

    // Connect to MongoDB
    if (config.MONGODB_URI) {
      this.database = new Database(config.MONGODB_URI, config.MONGODB_DB);
      this.db = await this.database.connect();
    }

    // Initialize services
    await this.initializeServices();
    
    // Setup HTTP server
    await this.setupHttpServer();

    // Start public tunnel before registering/connecting
    await this.startTunnelIfNeeded();
    
    // Connect to WhatsApp
    await this.connectToWhatsApp();
  }

  async initializeServices() {
    logger.info('Initializing services...');

    // Initialize LID resolver
    this.lidResolver = new LidResolver(this.db, this.socket);
    await this.lidResolver.init();

    // Initialize webhook delivery
    this.webhookDelivery = new WebhookDelivery(this.db, {
      WEBHOOK_URL: config.WEBHOOK_URL,
      WEBHOOK_TOKEN: config.WEBHOOK_TOKEN,
    });
    await this.webhookDelivery.init();

    // Initialize media service
    this.mediaService = new MediaService(this.db, this.socket, {
      MEDIA_STORAGE_PATH: config.MEDIA_STORAGE_PATH,
      MEDIA_EXPIRY_MS: config.MEDIA_EXPIRY_MS,
      MAX_FILE_SIZE: config.MAX_FILE_SIZE,
    });
    await this.mediaService.init();

    // Initialize message processor
    this.messageProcessor = new MessageProcessor(this.db, this.socket, {
      WEBHOOK_URL: config.WEBHOOK_URL,
      WEBHOOK_TOKEN: config.WEBHOOK_TOKEN,
    });
    await this.messageProcessor.init();

    logger.info('Services initialized');
  }

  setupHttpServer() {
    const app = express();
    this.app = app;
    
    // Middleware
    app.use(express.json({ limit: '50mb' }));
    app.use(cors());
    
    // Make services available to routes
    app.locals.messageProcessor = this.messageProcessor;
    app.locals.mediaService = this.mediaService;
    app.locals.webhookDelivery = this.webhookDelivery;
    app.locals.socket = this.socket;
    app.locals.bot = this;

    // Routes
    const mediaRoutes = require('./routes/media');
    const statusRoutes = require('./routes/status');
    
    app.use('/media', mediaRoutes);
    app.use('/status', statusRoutes);

    // Health check
    app.get('/', (req, res) => {
      res.json({
        bot: config.BOT_NAME,
        status: this.status,
        tunnel: this.lastTunnelUrl || null,
        uptime: process.uptime(),
      });
    });

    app.get('/health', (req, res) => {
      res.json({
        status: this.status,
        tunnel: this.lastTunnelUrl || null,
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
      });
    });

    // API endpoints
    app.post('/send-message', async (req, res) => {
      await this.handleSendMessage(req, res);
    });

    // Webhook registration endpoint
    app.post('/register', async (req, res) => {
      await this.handleRegister(req, res);
    });

    // Webhook endpoint for receiving messages from Baileys (internal)
    app.post('/internal/webhook', async (req, res) => {
      await this.handleInternalWebhook(req, res);
    });

    this.server = http.createServer(app);
    
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(config.PORT, () => {
        this.server.off('error', reject);
        console.log(`Server listening on port ${config.PORT}`);
        resolve();
      });
    });
  }

  async connectToWhatsApp() {
    const { state, saveCreds } = await this.getAuthState();
    const { version } = await fetchLatestBaileysVersion();
    logger.info(`Using Baileys version ${version.join('.')}`);

    this.socket = makeWASocket({
      version,
      auth: state,
      logger: logger.child({ module: 'baileys' }),
      printQRInTerminal: false,
      browser: [config.BOT_NAME, 'Chrome', '22.0'],
    });

    this.saveCreds = saveCreds;
    this.updateServiceSockets(this.socket);
    this.socket.ev.on('creds.update', saveCreds);

    // LID mapping update handler
    this.socket.ev.on('lid-mapping.update', ({ lid, pn }) => {
      if (lid && pn) {
        this.lidResolver?.handleLidMappingUpdate({ lid, pn });
        logger.debug({ lid, pn }, 'Updated LID -> PN mapping');
      }
    });

    this.socket.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.status = 'waiting_qr';
        console.log('\nScan this QR with the phone number that will run the bot:');
        console.log('WhatsApp > Linked Devices > Link a Device\n');
        qrcode.generate(qr, { small: true });
      }

      if (connection === 'close') {
        const shouldReconnect =
          update.lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        this.status = 'disconnected';
        console.log(`Connection closed: ${update.lastDisconnect?.error?.message || 'unknown reason'}`);
        
        if (shouldReconnect) {
          console.log('Reconnecting in 3 seconds...');
          setTimeout(() => this.connectToWhatsApp(), 3000);
        } else {
          console.log('Session closed in WhatsApp. Delete auth_info/ or MongoDB collection and scan QR again.');
        }
      }

      if (connection === 'open') {
        this.status = 'connected';
        console.log('Connected to WhatsApp.');
      }
    });

    this.socket.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      
      for (const msg of messages) {
        // Skip messages with requestId (sent messages)
        if (msg.key.requestId) continue;
        await this.processMessage(msg);
      }
    });

    this.socket.ev.on('messages.update', (updates) => {
      this.handleMessageUpdate(updates);
    });
  }

  updateServiceSockets(socket) {
    if (this.lidResolver) this.lidResolver.socket = socket;
    if (this.mediaService) this.mediaService.socket = socket;
    if (this.app) this.app.locals.socket = socket;
    if (this.messageProcessor) {
      this.messageProcessor.socket = socket;
      if (this.messageProcessor.lidResolver) this.messageProcessor.lidResolver.socket = socket;
      if (this.messageProcessor.mediaService) this.messageProcessor.mediaService.socket = socket;
    }
  }

  async getAuthState() {
    if (config.MONGODB_URI) {
      const { MongoClient } = require('mongodb');
      const client = new MongoClient(config.MONGODB_URI);
      await client.connect();
      const db = client.db(config.MONGODB_DB || 'whatsapp-bot');
      logger.info('Session persisted in MongoDB');
      const { state, saveCreds } = await useMongoDBAuthState(db);
      return { state, saveCreds };
    }
    
    const AUTH_DIR = path.join(__dirname, 'auth_info');
    logger.info('Session persisted in local files (auth_info/)');
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    return { state, saveCreds };
  }

  async processMessage(msg) {
    try {
      await this.messageProcessor.processMessage(msg);
    } catch (error) {
      logger.error({ err: error, msgId: msg.key.id }, 'Error processing message');
    }
  }

  async handleMessageUpdate(updates) {
    for (const update of updates) {
      const id = update.key?.id;
      if (!id) continue;
      
      let status = null;
      if (update.status === 2) status = 'sent';
      else if (update.status === 3) status = 'delivered';
      else if (update.status === 4) status = 'read';
      else return;

      const statusKey = `st:${id}:${status}`;
      if (this.forwardedIds.has(statusKey)) return;
      
      this.forwardedIds.add(statusKey);
      if (this.forwardedIds.size > this.MAX_FORWARDED_IDS) {
        const firstKey = this.forwardedIds.keys().next().value;
        if (firstKey) this.forwardedIds.delete(firstKey);
      }

      const payload = {
        statuses: [{
          id: id,
          status,
          timestamp: update.receiptTimestamp
            ? Math.floor(Number(update.receiptTimestamp) || 0)
            : Math.floor(Date.now() / 1000),
        }]
      };

      await this.webhookDelivery.forwardToWebhook({ statuses: payload.statuses });
    }
  }

  async handleSendMessage(req, res) {
    const body = req.body || {};
    const to = body.to || body.number || body.phone;
    logger.info(
      {
        to: to ? this.maskPhone(to) : undefined,
        hasText: Boolean(body.text || body.message),
        authorized: this.isAuthorized(req),
      },
      'Send-message request received',
    );

    if (!this.isAuthorized(req)) {
      return res.status(401).json({
        ok: false,
        error: 'No autorizado. Envia Authorization: Bearer <API_TOKEN>',
      });
    }

    if (!this.socket || this.status !== 'connected') {
      return res.status(503).json({ ok: false, error: 'Bot not connected to WhatsApp' });
    }

    try {
      const text = body.text || body.message;

      if (!to || !text) {
        return res.status(400).json({ ok: false, error: 'Missing fields: to (number) and text (message)' });
      }

      const jid = this.normalizeJid(to);
      const sent = await this.socket.sendMessage(jid, { text });
      logger.info(`Message sent to ${jid} (id ${sent.key?.id})`);
      
      res.json({ ok: true, id: sent.key?.id, to: jid });
    } catch (err) {
      logger.error({ err }, 'Error sending message');
      res.status(500).json({ ok: false, error: err.message || 'Error sending message' });
    }
  }

  async handleRegister(req, res) {
    try {
      const { base_url, access_token, phone_e164 } = req.body;
      
      if (!base_url || !access_token || !phone_e164) {
        return res.status(400).json({ ok: false, error: 'Missing required fields' });
      }

      // Update bot configuration
      this.webhookDelivery.config.WEBHOOK_URL = base_url;
      this.webhookDelivery.config.WEBHOOK_TOKEN = access_token;
      
      // Register the URL
      await this.registerWithWeb(base_url);
      
      res.json({ ok: true, message: 'Bot registered successfully' });
    } catch (error) {
      logger.error({ err: error }, 'Error registering bot');
      res.status(500).json({ ok: false, error: error.message });
    }
  }

  isAuthorized(req) {
    if (!config.API_TOKEN) return true;
    return (req.headers.authorization || '') === `Bearer ${config.API_TOKEN}`;
  }

  async startTunnelIfNeeded() {
    if (!config.TUNNEL_ENABLED || !config.WEBHOOK_URL) return;

    try {
      const tunnelUrl = await this.startCloudflareTunnel();
      if (!tunnelUrl) return;

      this.lastTunnelUrl = tunnelUrl;
      global.lastTunnelUrl = tunnelUrl;
      console.log(`Public tunnel ready: ${tunnelUrl}`);
      await this.registerWithWeb(tunnelUrl);
    } catch (error) {
      logger.warn({ err: error }, 'Could not start/register Cloudflare tunnel');
      console.warn(`Tunnel not started: ${error.message}`);
    }
  }

  startCloudflareTunnel() {
    if (this.tunnelProcess) return Promise.resolve(this.lastTunnelUrl);

    const candidates = [
      path.join(__dirname, 'cloudflared.exe'),
      'cloudflared',
    ];
    const command = candidates.find((candidate) => candidate === 'cloudflared' || fs.existsSync(candidate));
    if (!command) {
      throw new Error('cloudflared.exe not found');
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error('Timed out waiting for Cloudflare tunnel URL'));
        }
      }, 30000);

      const localUrl = `http://${config.TUNNEL_HOST}:${config.PORT}`;
      const child = spawn(command, ['tunnel', '--url', localUrl], {
        cwd: __dirname,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      this.tunnelProcess = child;

      const handleOutput = (chunk) => {
        const text = chunk.toString();
        const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
        if (match && !settled) {
          settled = true;
          clearTimeout(timeout);
          resolve(match[0]);
        }
      };

      child.stdout.on('data', handleOutput);
      child.stderr.on('data', handleOutput);
      child.once('error', (error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(error);
        }
      });
      child.once('exit', (code) => {
        this.tunnelProcess = null;
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error(`cloudflared exited before creating a tunnel (code ${code})`));
        }
      });
    });
  }

  async registerWithWeb(publicUrl) {
    const registerUrl = config.AUTO_REGISTER_URL || config.WEBHOOK_URL;
    if (!registerUrl) return;

    const payload = {
      event: 'bot_registered',
      base_url: publicUrl,
      bot_url: publicUrl,
      public_url: publicUrl,
      access_token: config.API_TOKEN,
      phone_e164: config.PHONE_E164,
      timestamp: new Date().toISOString(),
    };

    try {
      const response = await fetch(registerUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.WEBHOOK_TOKEN ? { Authorization: `Bearer ${config.WEBHOOK_TOKEN}` } : {}),
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`registration failed with HTTP ${response.status}: ${body.slice(0, 200)}`);
      }

      logger.info({ publicUrl, registerUrl }, 'Public tunnel registered with web');
    } catch (error) {
      logger.warn({ err: error, publicUrl, registerUrl }, 'Could not register public tunnel with web');
      console.warn(`Could not register tunnel URL with web: ${error.message}`);
    }
  }

  async shutdown() {
    if (this.tunnelProcess) {
      this.tunnelProcess.kill();
      this.tunnelProcess = null;
    }
    this.webhookDelivery?.stop();
    this.messageProcessor?.webhookDelivery?.stop();
    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
    }
    await this.database?.close?.();
  }

  async handleInternalWebhook(req, res) {
    try {
      // This endpoint receives messages from the bot itself
      // and forwards them to the Laravel webhook
      const payload = req.body;
      await this.webhookDelivery.forwardToWebhook(payload);
      res.json({ ok: true });
    } catch (error) {
      logger.error({ err: error }, 'Error in internal webhook');
      res.status(500).json({ ok: false, error: error.message });
    }
  }

  normalizeJid(phone) {
    const value = String(phone).replace('@s.whatsapp.net', '').replace(/:\d+$/, '');
    const digits = value.replace(/[^\d]/g, '');
    return `${digits}@s.whatsapp.net`;
  }

  maskPhone(phone) {
    const value = String(phone).replace('@s.whatsapp.net', '').replace(/:\d+$/, '');
    const digits = value.replace(/[^\d]/g, '');
    if (digits.length <= 4) return '****';
    return `${digits.slice(0, 2)}${'*'.repeat(digits.length - 4)}${digits.slice(-2)}`;
  }

  async start() {
    try {
      await this.initialize();
      console.log('Bot started successfully');
    } catch (error) {
      console.error('Failed to start bot:', error);
      process.exit(1);
    }
  }
}

// Main entry point
if (require.main === module) {
  (async () => {
    const bot = new WhatsAppBot();
    const stop = async () => {
      await bot.shutdown();
      process.exit(0);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    await bot.start();
  })().catch((error) => {
    console.error('Failed to start bot:', error);
    process.exit(1);
  });
}
