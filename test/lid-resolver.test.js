const { test, describe, before, beforeEach } = require('node:test');
const assert = require('node:assert');

const LidResolver = require('../services/LidResolver.js');

function createMockDb() {
  return {
    collection: () => ({
      createIndex: async () => {},
      updateOne: async () => ({}),
      findOne: async () => null,
      find: () => ({ limit: () => ({ toArray: async () => [] }) }),
    }),
  };
}

describe('LidResolver', () => {
  let lidResolver;

  beforeEach(() => {
    lidResolver = new LidResolver(
      createMockDb(),
      { signalRepository: { lidMapping: { getPNForLID: async () => null } } },
    );
  });

  test('resuelve LID con remoteJidAlt', async () => {
    const msg = { key: { remoteJid: '123@lid', remoteJidAlt: '51999999999@s.whatsapp.net' } };
    const result = await lidResolver.resolvePhoneFromLid(msg);
    assert.strictEqual(result, '51999999999@s.whatsapp.net');
  });

  test('resuelve LID con participantPn', async () => {
    const msg = { key: { remoteJid: '123@lid', participantPn: '51988888888@s.whatsapp.net' } };
    const result = await lidResolver.resolvePhoneFromLid(msg);
    assert.strictEqual(result, '51988888888@s.whatsapp.net');
  });

  test('resuelve LID con senderPn', async () => {
    const msg = { key: { remoteJid: '123@lid', senderPn: '51977777777@s.whatsapp.net' } };
    const result = await lidResolver.resolvePhoneFromLid(msg);
    assert.strictEqual(result, '51977777777@s.whatsapp.net');
  });

  test('resuelve LID con participantAlt', async () => {
    const msg = { key: { remoteJid: '123@lid', participantAlt: '51966666666@s.whatsapp.net' } };
    const result = await lidResolver.resolvePhoneFromLid(msg);
    assert.strictEqual(result, '51966666666@s.whatsapp.net');
  });

  test('resuelve LID desde cache local', async () => {
    lidResolver.localCache.set('123@lid', '51955555555@s.whatsapp.net');
    const msg = { key: { remoteJid: '123@lid' } };
    const result = await lidResolver.resolvePhoneFromLid(msg);
    assert.strictEqual(result, '51955555555@s.whatsapp.net');
  });

  test('resuelve LID mediante signalRepository', async () => {
    lidResolver.socket = {
      signalRepository: {
        lidMapping: {
          getPNForLID: async (lid) => (lid === '999@lid' ? '51944444444@s.whatsapp.net' : null),
        },
      },
    };
    const msg = { key: { remoteJid: '999@lid' } };
    const result = await lidResolver.resolvePhoneFromLid(msg);
    assert.strictEqual(result, '51944444444@s.whatsapp.net');
  });

  test('retorna null para LID no resoluble', async () => {
    const msg = { key: { remoteJid: 'unresolvable@lid' } };
    const result = await lidResolver.resolvePhoneFromLid(msg);
    assert.strictEqual(result, null);
  });

  test('lid-mapping.update actualiza cache', () => {
    lidResolver.handleLidMappingUpdate({ lid: '777@lid', pn: '51933333333@s.whatsapp.net' });
    assert.strictEqual(lidResolver.localCache.get('777@lid'), '51933333333@s.whatsapp.net');
  });
});

console.log('LidResolver tests completed');