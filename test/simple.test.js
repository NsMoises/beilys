const { test, describe } = require('node:test');
const assert = require('node:assert');

describe('Simple Test', () => {
  test('basic test', () => {
    assert.strictEqual(1 + 1, 2);
  });
});

console.log('Simple test completed');