const WebhookDelivery = require('./services/WebhookDelivery.js');

async function main() {
  const db = {
    collection: () => ({
      createIndex: async () => {},
      insertOne: async () => ({ insertedId: 'test-id' }),
      findOne: async () => null,
      updateOne: async () => ({}),
      find: () => ({ limit: () => ({ toArray: async () => [] }) }),
      countDocuments: async () => 0,
    }),
  };

  const delivery = new WebhookDelivery(db, {
    WEBHOOK_URL: 'https://example.com/webhook',
    WEBHOOK_TOKEN: 'test-token',
  });

  await delivery.init();

  const msg = {
    messageId: 'test-msg-' + Date.now(),
    from: '51999999999',
    timestamp: Math.floor(Date.now() / 1000),
    type: 'text',
    text: 'Hola',
  };

  const r1 = await delivery.queueMessage(msg);
  console.log('Primera vez created:', r1.created);

  const r2 = await delivery.queueMessage(msg);
  console.log('Segunda vez alreadyExists:', r2.alreadyExists);

  const stats = await delivery.getStats();
  console.log('Stats:', JSON.stringify(stats));

  delivery.stop();
  console.log('TEST PASSED');
  process.exit(0);
}

main().catch((err) => {
  console.error('TEST FAILED:', err.message);
  process.exit(1);
});