import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getTextureHintText } from '../../src/shared/textureHints.js';

describe('getTextureHintText', () => {
  it('returns cube-map hint for 1×1 cube faces', () => {
    const hint = getTextureHintText({
      width: 1,
      height: 1,
      target: 'TEXTURE_CUBE_MAP_NEGATIVE_Z'
    });
    assert.match(hint, /cube map face/);
    assert.match(hint, /TEXTURE_CUBE_MAP_NEGATIVE_Z/);
  });

  it('returns null for normal-sized textures', () => {
    assert.equal(getTextureHintText({ width: 128, height: 128, target: 'TEXTURE_2D' }), null);
  });

  it('returns MeshStandardMaterial hint for 16×16 TEXTURE_2D placeholders', () => {
    const hint = getTextureHintText({ width: 16, height: 16, target: 'TEXTURE_2D' });
    assert.match(hint, /MeshStandardMaterial/);
    assert.match(hint, /default texture fallback/);
  });
});
