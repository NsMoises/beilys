const { test, describe } = require('node:test');
const assert = require('node:assert');

const MediaService = require('../services/MediaService.js');

describe('MediaService', () => {
  test('detecta tipos de mensaje', () => {
    const service = new MediaService({}, {}, {});
    assert.strictEqual(service.getMessageType({ message: { imageMessage: {} } }), 'image');
    assert.strictEqual(service.getMessageType({ message: { audioMessage: {} } }), 'audio');
    assert.strictEqual(service.getMessageType({ message: { videoMessage: {} } }), 'video');
    assert.strictEqual(service.getMessageType({ message: { documentMessage: {} } }), 'document');
    assert.strictEqual(service.getMessageType({ message: { stickerMessage: {} } }), 'sticker');
    assert.strictEqual(service.getMessageType({ message: { locationMessage: {} } }), 'location');
    assert.strictEqual(service.getMessageType({ message: { contactMessage: {} } }), 'contact');
    assert.strictEqual(service.getMessageType({ message: { reactionMessage: {} } }), 'reaction');
    assert.strictEqual(service.getMessageType({ message: { conversation: 'hola' } }), 'text');
    assert.strictEqual(service.getMessageType({ message: {} }), null);
    assert.strictEqual(service.getMessageType({}), null);
  });

  test('detecta nota de voz', () => {
    const service = new MediaService({}, {}, {});
    const type = service.getMessageType({ message: { audioMessage: { ptt: true } } });
    assert.strictEqual(type, 'audio');
  });

  test('extrae metadatos de imagen', async () => {
    const service = new MediaService({}, {}, {});
    const data = await service.extractMediaData(
      { message: { imageMessage: { mimetype: 'image/jpeg', fileLength: 12345 } } },
      'image',
    );
    assert.strictEqual(data.mimeType, 'image/jpeg');
    assert.strictEqual(data.size, 12345);
    assert.strictEqual(data.isVoiceNote, false);
  });

  test('extrae metadatos de audio/nota de voz', async () => {
    const service = new MediaService({}, {}, {});
    const data = await service.extractMediaData(
      { message: { audioMessage: { mimetype: 'audio/ogg', seconds: 8, ptt: true } } },
      'audio',
    );
    assert.strictEqual(data.mimeType, 'audio/ogg');
    assert.strictEqual(data.duration, 8);
    assert.strictEqual(data.isVoiceNote, true);
  });

  test('retorna extensiones correctas', () => {
    const service = new MediaService({}, {}, {});
    assert.strictEqual(service.getExtensionFromMimeType('image'), '.jpg');
    assert.strictEqual(service.getExtensionFromMimeType('audio'), '.ogg');
    assert.strictEqual(service.getExtensionFromMimeType('video'), '.mp4');
    assert.strictEqual(service.getExtensionFromMimeType('document'), '.pdf');
    assert.strictEqual(service.getExtensionFromMimeType('sticker'), '.webp');
    assert.strictEqual(service.getExtensionFromMimeType('desconocido'), '.bin');
  });

  test('media no disponible devuelve estado media_unavailable', async () => {
    const service = new MediaService({}, {}, {});
    service.downloadMedia = async () => null;
    const result = await service.processMediaMessage({
      key: { id: 'media-1', remoteJid: '51999999999@s.whatsapp.net' },
      message: { imageMessage: { mimetype: 'image/jpeg' } },
    });
    assert.ok(result);
    assert.strictEqual(result.type, 'image');
    assert.strictEqual(result.media.status, 'media_unavailable');
    assert.strictEqual(result.media.mimeType, 'image/jpeg');
  });
});

console.log('MediaService tests completed');