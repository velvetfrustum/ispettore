import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fnv1aHex, hashText, textByteLength, textBytes } from '../../src/shared/storage/hash.js';

describe('storage hashing', () => {
  it('computes a stable 16-hex FNV-1a checksum', () => {
    const hex = fnv1aHex(textBytes('ispettore'));
    assert.equal(hex.length, 16);
    assert.match(hex, /^[0-9a-f]{16}$/);
    assert.equal(fnv1aHex(textBytes('ispettore')), hex);
  });

  it('hashes text deterministically and reports the algorithm used', async () => {
    const first = await hashText('same text');
    const second = await hashText('same text');
    assert.equal(first.hex, second.hex);
    assert.equal(first.algorithm, second.algorithm);
    assert.ok(['sha256', 'fnv'].includes(first.algorithm));
    assert.equal(first.hex.length, first.algorithm === 'sha256' ? 64 : 16);
  });

  it('supports forcing the synchronous FNV fallback', async () => {
    const hash = await hashText('fallback', { algorithm: 'fnv' });
    assert.equal(hash.algorithm, 'fnv');
    assert.equal(hash.hex.length, 16);
  });

  it('rejects unknown checksum algorithms', async () => {
    await assert.rejects(() => hashText('payload', { algorithm: 'unknown' }), /Unsupported checksum algorithm/);
  });

  it('detects different inputs with overwhelming probability', async () => {
    const a = await hashText('capture one');
    const b = await hashText('capture two');
    assert.notEqual(a.hex, b.hex);
  });

  it('measures text length in UTF-8 bytes', () => {
    assert.equal(textByteLength('abc'), 3);
    assert.equal(textByteLength('ispettore'), 9);
  });
});
