const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');

const MessageProcessor = require('../services/MessageProcessor.js');

function createMockDb() {
  return {
    collection: () => ({
      createIndex: async () => {},
      insertOne: async () => ({ insertedId: 'test-id' }),
      findOne: async () => null,
      updateOne: async () => ({}),
      find: () => ({ limit: () => ({ toArray: async () => [] }) }),
      deleteMany: async () => ({ deletedCount: 0 }),
      countDocuments: async () => 0,
    }),
  };
}

describe('MessageProcessor', () => {
  let processor;

  beforeEach(async () => {
    processor = new MessageProcessor(
      createMockDb(),
      { signalRepository: { lidMapping: { getPNForLID: async () => null } } },
      { WEBHOOK_URL: 'https://example.com', WEBHOOK_TOKEN: 'test' },
    );
    processor.webhookDelivery.startProcessing = () => {};
    await processor.init();
  });

  test('ignora mensajes propios (fromMe)', async () => {
    const msg = {
      key: { fromMe: true, remoteJid: '51999999999@s.whatsapp.net', id: 'm1' },
      message: { conversation: 'Hola' },
    };
    await processor.processMessage(msg);
    assert.strictEqual(processor.isProcessed('m1'), false);
  });

  test('ignora estados (status@broadcast)', async () => {
    const msg = {
      key: { fromMe: false, remoteJid: 'status@broadcast', id: 'm2' },
      message: { conversation: 'Estado' },
    };
    await processor.processMessage(msg);
    assert.strictEqual(processor.isProcessed('m2'), false);
  });

  test('ignora grupos (@g.us)', async () => {
    const msg = {
      key: { fromMe: false, remoteJid: '123@g.us', id: 'm3' },
      message: { conversation: 'Grupo' },
    };
    await processor.processMessage(msg);
    assert.strictEqual(processor.isProcessed('m3'), false);
  });

  test('ignora mensajes con requestId', async () => {
    const msg = {
      key: { fromMe: false, remoteJid: '51999999999@s.whatsapp.net', id: 'm4', requestId: 'r1' },
      message: { conversation: 'Hola' },
    };
    await processor.processMessage(msg);
    assert.strictEqual(processor.isProcessed('m4'), false);
  });

  test('procesa mensaje de texto y lo envia al webhook con telefono real', async () => {
    let queued = null;
    processor.webhookDelivery.queueMessage = async (data) => {
      queued = data;
      return { created: true };
    };

    const msg = {
      key: { fromMe: false, remoteJid: '51999999999@s.whatsapp.net', id: 'm5' },
      message: { conversation: 'Hola mundo' },
      pushName: 'Test User',
      messageTimestamp: 1720000000,
    };
    await processor.processMessage(msg);

    assert.ok(queued, 'El mensaje debio encolarse');
    assert.strictEqual(queued.from, '51999999999');
    assert.strictEqual(queued.text, 'Hola mundo');
    assert.strictEqual(queued.type, 'text');
  });

  test('procesa mensaje LID resolviendo telefono real', async () => {
    let queued = null;
    processor.webhookDelivery.queueMessage = async (data) => {
      queued = data;
      return { created: true };
    };
    processor.lidResolver.localCache.set('111@lid', '51922222222@s.whatsapp.net');

    const msg = {
      key: { fromMe: false, remoteJid: '111@lid', id: 'm6' },
      message: { conversation: 'Desde LID' },
      pushName: 'LID User',
      messageTimestamp: 1720000000,
    };
    await processor.processMessage(msg);

    assert.ok(queued, 'El mensaje LID debio encolarse');
    assert.strictEqual(queued.from, '51922222222');
    assert.strictEqual(queued.fromLid, '111@lid');
  });

  test('limpia sufijo de dispositivo en telefonos resueltos por Baileys', async () => {
    let queued = null;
    processor.webhookDelivery.queueMessage = async (data) => {
      queued = data;
      return { created: true };
    };
    processor.lidResolver.localCache.set('222@lid', '51933333333:0@s.whatsapp.net');

    await processor.processMessage({
      key: { fromMe: false, remoteJid: '222@lid', id: 'm6-device' },
      message: { conversation: 'Desde LID con device id' },
      messageTimestamp: 1720000000,
    });

    assert.ok(queued, 'El mensaje LID debio encolarse');
    assert.strictEqual(queued.from, '51933333333');
  });

  test('deduplica mensajes repetidos', async () => {
    let count = 0;
    processor.webhookDelivery.queueMessage = async () => {
      count++;
      return { created: true };
    };

    const msg = {
      key: { fromMe: false, remoteJid: '51999999999@s.whatsapp.net', id: 'dup-1' },
      message: { conversation: 'Duplicado' },
      messageTimestamp: 1720000000,
    };
    await processor.processMessage(msg);
    await processor.processMessage(msg);
    assert.strictEqual(count, 1);
  });

  test('detecta tipos de mensaje', () => {
    assert.strictEqual(processor.getMessageType({ message: { imageMessage: {} } }), 'image');
    assert.strictEqual(processor.getMessageType({ message: { audioMessage: {} } }), 'audio');
    assert.strictEqual(processor.getMessageType({ message: { videoMessage: {} } }), 'video');
    assert.strictEqual(processor.getMessageType({ message: { documentMessage: {} } }), 'document');
    assert.strictEqual(processor.getMessageType({ message: { stickerMessage: {} } }), 'sticker');
    assert.strictEqual(processor.getMessageType({ message: { locationMessage: {} } }), 'location');
    assert.strictEqual(processor.getMessageType({ message: { contactMessage: {} } }), 'contact');
    assert.strictEqual(processor.getMessageType({ message: { reactionMessage: {} } }), 'reaction');
    assert.strictEqual(
      processor.getMessageType({ message: { extendedTextMessage: { contextInfo: { stanzaId: 'x' } } } }),
      'reply',
    );
    assert.strictEqual(processor.getMessageType({ message: { conversation: 'hola' } }), 'text');
  });

  test('mapea estados de Baileys 2/3/4 a sent/delivered/read', async () => {
    let forwarded = null;
    processor.webhookDelivery.forwardToWebhook = async (payload) => {
      forwarded = payload;
    };

    await processor.handleMessageUpdate([{
      key: { id: 'st-1' },
      status: 3,
      receiptTimestamp: 1720000000,
    }]);

    assert.ok(forwarded, 'Debio reenviar el estado');
    assert.strictEqual(forwarded.statuses[0].status, 'delivered');
  });

  test('envia ubicacion con latitud/longitud', async () => {
    let queued = null;
    processor.webhookDelivery.queueMessage = async (data) => {
      queued = data;
      return { created: true };
    };

    await processor.processMessage({
      key: { fromMe: false, remoteJid: '51999999999@s.whatsapp.net', id: 'loc-1' },
      message: { locationMessage: { degreesLatitude: -12.046, degreesLongitude: -77.043, name: 'Lima' } },
      messageTimestamp: 1720000000,
    });

    assert.ok(queued);
    assert.strictEqual(queued.type, 'location');
    assert.strictEqual(queued.location.latitude, -12.046);
    assert.strictEqual(queued.location.longitude, -77.043);
    assert.strictEqual(queued.location.name, 'Lima');
  });

  test('envia contacto compartido', async () => {
    let queued = null;
    processor.webhookDelivery.queueMessage = async (data) => {
      queued = data;
      return { created: true };
    };

    await processor.processMessage({
      key: { fromMe: false, remoteJid: '51999999999@s.whatsapp.net', id: 'ct-1' },
      message: { contactMessage: { displayName: 'Juan Perez', vcard: 'BEGIN:VCARD...' } },
      messageTimestamp: 1720000000,
    });

    assert.ok(queued);
    assert.strictEqual(queued.type, 'contact');
    assert.strictEqual(queued.contact.display_name, 'Juan Perez');
    assert.strictEqual(queued.contact.vcard, 'BEGIN:VCARD...');
  });

  test('envia reaccion con emoji y mensaje original', async () => {
    let queued = null;
    processor.webhookDelivery.queueMessage = async (data) => {
      queued = data;
      return { created: true };
    };

    await processor.processMessage({
      key: { fromMe: false, remoteJid: '51999999999@s.whatsapp.net', id: 're-1' },
      message: { reactionMessage: { text: '👍', key: { id: 'original-msg' } } },
      messageTimestamp: 1720000000,
    });

    assert.ok(queued);
    assert.strictEqual(queued.type, 'reaction');
    assert.strictEqual(queued.reaction.emoji, '👍');
    assert.strictEqual(queued.reaction.message_id, 'original-msg');
  });

  test('envia imagen con caption y metadatos de media', async () => {
    let queued = null;
    processor.webhookDelivery.queueMessage = async (data) => {
      queued = data;
      return { created: true };
    };
    processor.mediaService.processMediaMessage = async () => ({
      type: 'image',
      media: { downloadId: 'abc123', mimeType: 'image/jpeg', filename: 'foto.jpg', size: 1024 },
    });

    await processor.processMessage({
      key: { fromMe: false, remoteJid: '51999999999@s.whatsapp.net', id: 'img-1' },
      message: { imageMessage: { caption: 'Mira esta foto', mimetype: 'image/jpeg' } },
      messageTimestamp: 1720000000,
    });

    assert.ok(queued);
    assert.strictEqual(queued.type, 'image');
    assert.strictEqual(queued.text, 'Mira esta foto');
    assert.strictEqual(queued.media.mimeType, 'image/jpeg');
    assert.strictEqual(queued.media.size, 1024);
  });

  test('envia respuesta (reply) con context_id', async () => {
    let queued = null;
    processor.webhookDelivery.queueMessage = async (data) => {
      queued = data;
      return { created: true };
    };

    await processor.processMessage({
      key: { fromMe: false, remoteJid: '51999999999@s.whatsapp.net', id: 'rep-1' },
      message: { extendedTextMessage: { text: 'Respuesta', contextInfo: { stanzaId: 'orig-1' } } },
      messageTimestamp: 1720000000,
    });

    assert.ok(queued);
    assert.strictEqual(queued.type, 'reply');
    assert.strictEqual(queued.contextId, 'orig-1');
    assert.strictEqual(queued.text, 'Respuesta');
  });
});

console.log('MessageProcessor tests completed');
