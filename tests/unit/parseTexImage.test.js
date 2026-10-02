import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseTexImageArgs } from '../../src/backend/webgl/parseTexImage.js';

describe('parseTexImageArgs', () => {
  it('reads width and height from 9-arg texImage2D (not format/type)', () => {
    const RGBA = 0x1908;
    const UNSIGNED_BYTE = 0x1401;
    const { width, height } = parseTexImageArgs([
      0x0de1, 0, RGBA, 128, 64, 0, RGBA, UNSIGNED_BYTE, null
    ]);
    assert.equal(width, 128);
    assert.equal(height, 64);
  });

  it('uses width/height slots (args 3–4), not format/type (args 6–7)', () => {
    const RGBA = 0x1908;
    const UNSIGNED_BYTE = 0x1401;
    const { width, height } = parseTexImageArgs([
      0x0de1, 0, RGBA, 2, 2, 0, RGBA, UNSIGNED_BYTE, null
    ]);
    assert.equal(width, 2);
    assert.equal(height, 2);
  });

  it('returns upload format metadata used by runtime texture records', () => {
    const RGBA = 0x1908;
    const UNSIGNED_BYTE = 0x1401;
    const parsed = parseTexImageArgs([
      0x0de1, 0, RGBA, 16, 8, 0, RGBA, UNSIGNED_BYTE, null
    ]);
    assert.equal(parsed.internalFormat, RGBA);
    assert.equal(parsed.pixelType, UNSIGNED_BYTE);
  });
});
