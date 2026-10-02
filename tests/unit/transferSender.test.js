import assert from 'node:assert/strict';
import test from 'node:test';
import { sendWebGlPackage } from '../../src/shared/storage/transferSender.js';

test('sendWebGlPackage explains the browser string-size limit', async () => {
  const stringify = JSON.stringify;
  JSON.stringify = () => {
    throw new RangeError('Invalid string length');
  };

  try {
    const result = await sendWebGlPackage({ schema: 'test' });
    assert.equal(result.ok, false);
    assert.match(result.error, /too large for Chromium/);
    assert.match(result.error, /extreme number of commands/);
  } finally {
    JSON.stringify = stringify;
  }
});
