import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  bakeImageUpload,
  canonicalizeImageSource,
  isImageSource
} from '../../src/backend/webgl/capture/canonicalize.js';

describe('WebGL image-source canonicalization', () => {
  it('recognizes DOM image sources by their object tag', () => {
    assert.equal(isImageSource({ [Symbol.toStringTag]: 'HTMLCanvasElement' }), true);
    assert.equal(isImageSource({ [Symbol.toStringTag]: 'ImageBitmap' }), true);
    assert.equal(isImageSource({ [Symbol.toStringTag]: 'OffscreenCanvas' }), true);
    assert.equal(isImageSource({ [Symbol.toStringTag]: 'HTMLImageElement' }), true);
    assert.equal(isImageSource({ [Symbol.toStringTag]: 'HTMLVideoElement' }), true);
    assert.equal(isImageSource({}), false);
    assert.equal(isImageSource(null), false);
    assert.equal(isImageSource(undefined), false);
  });

  it('bakes flip and premultiply into the canvas RGBA8 bytes', () => {
    const pixels = new Uint8ClampedArray([
      10, 20, 30, 255,
      40, 50, 60, 128,
      70, 80, 90, 64,
      100, 110, 120, 255
    ]);
    const flipped = bakeImageUpload(pixels, {
      width: 1,
      height: 4,
      flipY: true,
      premultiply: false
    });
    assert.deepEqual(Array.from(flipped), [100, 110, 120, 255, 70, 80, 90, 64, 40, 50, 60, 128, 10, 20, 30, 255]);

    const premultiplied = bakeImageUpload(pixels, {
      width: 1,
      height: 4,
      flipY: false,
      premultiply: true
    });
    assert.deepEqual(Array.from(premultiplied), [
      10, 20, 30, 255,
      20, 25, 30, 128,
      18, 20, 23, 64,
      100, 110, 120, 255
    ]);
  });

  it('does not convert color channels based on the texture internal format', () => {
    const pixels = new Uint8ClampedArray([128, 64, 32, 255]);
    const result = bakeImageUpload(pixels, {
      width: 1,
      height: 1,
      flipY: false,
      premultiply: false
    });
    assert.equal(result, pixels);
    assert.deepEqual(Array.from(result), [128, 64, 32, 255]);
  });

  it('rejects color-management modes that a synchronous 2D read cannot reproduce', () => {
    const image = { width: 1, height: 1, [Symbol.toStringTag]: 'HTMLImageElement' };
    assert.throws(
      () => canonicalizeImageSource(image, { colorSpaceConversion: 0 }),
      /cannot be captured synchronously/
    );
    const canvas = { width: 1, height: 1, [Symbol.toStringTag]: 'HTMLCanvasElement' };
    assert.throws(
      () => canonicalizeImageSource(canvas, { unpackColorSpaceName: 'display-p3' }),
      /unsupported unpack color space display-p3/
    );
  });
});
