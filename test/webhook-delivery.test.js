const { test, describe, before, beforeEach } = require('node:test');
const assert = require('node:assert');

function createMockDb() {
  return {
    collection: () => ({
      createIndex: async () => {},
      createIndexes: async () => {},
      insertOne: async () => ({ insertedId: 'test-id' }),
      findOne: async () => null,
      updateOne: async () => ({}),
      find: () => ({
        limit: () => ({
          toArray: async () => [],
        }),
      }),
      countDocuments: async () => 0,
    }),
  };
}

describe('WebhookDelivery', () => {
  let WebhookDelivery;

  before(async () => {
    WebhookDelivery = (await import('../services/WebhookDelivery.js')).default;
  });

  test('calcula backoff exponencial correctamente', () => {
    const delivery = new WebhookDelivery({}, { WEBHOOK_URL: '', WEBHOOK_TOKEN: '' });
    const t1 = delivery.calculateNextRetry(1).getTime() - Date.now();
    const t2 = delivery.calculateNextRetry(2).getTime() - Date.now();
    const t3 = delivery.calculateNextRetry(3).getTime() - Date.now();
    assert.ok(Math.abs(t1 - 60000) < 5000);
    assert.ok(Math.abs(t2 - 120000) < 5000);
    assert.ok(Math.abs(t3 - 240000) < 5000);
  });

  test('anonimiza numeros de telefono', () => {
    const delivery = new WebhookDelivery({}, { WEBHOOK_URL: '', WEBHOOK_TOKEN: '' });
    const anon = delivery.anonymizePhone('51999999999');
    assert.ok(!anon.includes('51999999999'));
    assert.strictEqual(delivery.anonymizePhone(''), 'unknown');
  });

  test('anonimiza LIDs', () => {
    const delivery = new WebhookDelivery({}, { WEBHOOK_URL: '', WEBHOOK_TOKEN: '' });
    const anon = delivery.anonymizeLid('12345678@lid');
    assert.ok(!anon.includes('12345678'));
    assert.strictEqual(delivery.anonymizeLid(''), 'none');
  });

  test('encola mensaje sin duplicarlo', async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => ({ status: 200, ok: true, statusText: 'OK' });

    const db = createMockDb();
    const delivery = new WebhookDelivery(db, {
      WEBHOOK_URL: 'https://example.com/webhook',
      WEBHOOK_TOKEN: 'test-token',
    });
    await delivery.init();

    const msg = {
      messageId: 'test-msg-1',
      from: '51999999999',
      timestamp: Math.floor(Date.now() / 1000),
      type: 'text',
      text: 'Hola',
    };

    const r1 = await delivery.queueMessage(msg);
    assert.strictEqual(r1.created, true);

    const r2 = await delivery.queueMessage(msg);
    assert.strictEqual(r2.alreadyExists, true);
    delivery.stop();
    global.fetch = originalFetch;
  });
});

console.log('WebhookDelivery tests completed');