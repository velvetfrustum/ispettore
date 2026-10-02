import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveReadTarget, readPixelsFromTarget, bakeEventPreview } from '../../src/backend/webgl/capture/livePreview.js';

const GL = {
  NO_ERROR: 0,
  DRAW_FRAMEBUFFER_BINDING: 0x8ca6,
  READ_FRAMEBUFFER_BINDING: 0x8caa,
  TEXTURE_BINDING_2D: 0x8069,
  DRAW_FRAMEBUFFER: 0x8ca9,
  READ_FRAMEBUFFER: 0x8ca8,
  FRAMEBUFFER: 0x8d40,
  FRAMEBUFFER_BINDING: 0x8ca6,
  COLOR_ATTACHMENT0: 0x8ce0,
  FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE: 0x8cd0,
  FRAMEBUFFER_ATTACHMENT_OBJECT_NAME: 0x8cd1,
  NONE: 0,
  RENDERBUFFER: 0x8d41,
  TEXTURE: 0x1702,
  RGBA: 0x1908,
  UNSIGNED_BYTE: 0x1401,
  FLOAT: 0x1406,
  HALF_FLOAT: 0x140b,
  IMPLEMENTATION_COLOR_READ_FORMAT: 0x8b9b,
  IMPLEMENTATION_COLOR_READ_TYPE: 0x8b9a,
  VIEWPORT: 0x0ba2,
  CURRENT_PROGRAM: 0x8b8c,
  ACTIVE_TEXTURE: 0x84e0,
  MAX_TEXTURE_IMAGE_UNITS: 0x8872,
  TEXTURE0: 0x84c0
};

/**
 * A fake WebGL2 context modeling a floating-point / half-float render target (e.g. an HDR
 * ping-pong accumulation buffer). Its `readPixels` throws on (RGBA, UNSIGNED_BYTE) — real
 * ANGLE/Chrome does the same for such a framebuffer ("glReadPixelsRobustANGLE: Invalid
 * format and type combination") — so any code path that still *guesses* UNSIGNED_BYTE first
 * and only recovers afterward fails this test instead of only a real user's console.
 */
function createHdrFakeContext(readType) {
  const calls = [];
  const encoded = new Map([
    [GL.FLOAT, () => new Float32Array(64).fill(0.5)],
    [GL.HALF_FLOAT, () => new Uint16Array(64).fill(0x3800)] // 0x3800 is the half-float bit pattern for 0.5
  ]);

  return {
    calls,
    drawingBufferWidth: 4,
    drawingBufferHeight: 4,
    getError: () => GL.NO_ERROR,
    getExtension: () => null,
    bindFramebuffer() {},
    bindTexture() {},
    getParameter(pname) {
      if (pname === GL.IMPLEMENTATION_COLOR_READ_TYPE) return readType;
      if (pname === GL.IMPLEMENTATION_COLOR_READ_FORMAT) return GL.RGBA;
      return null;
    },
    readPixels(x, y, w, h, format, type, out) {
      calls.push({ format, type });
      if (format === GL.RGBA && type === GL.UNSIGNED_BYTE && readType !== GL.UNSIGNED_BYTE) {
        throw new Error('GL_INVALID_OPERATION: glReadPixelsRobustANGLE: Invalid format and type combination.');
      }
      if (type !== readType) throw new Error(`unexpected readPixels type ${type}`);
      out.set(encoded.get(type)().subarray(0, out.length));
    },
    ...GL
  };
}

/**
 * A fake WebGL2 context whose `getTexParameter`/`readPixels` throw on any parameter/format
 * they don't recognize as a real WebGL2 enum — this is what a real browser's WebGL
 * implementation does in practice (logs INVALID_ENUM and refuses the call), so a fake that
 * throws on the same inputs makes an accidental non-existent-enum bug (e.g. `gl.TEXTURE_WIDTH`,
 * which does not exist in WebGL2) fail loudly here instead of only in a real browser console.
 */
function createStrictFakeContext({ colorAttachmentTarget = 'texture' } = {}) {
  const KNOWN_TEX_PARAMS = new Set(); // WebGL has no width/height tex param — none are "known" for this test
  const KNOWN_READ_FORMATS = new Set([GL.RGBA]);
  let framebuffer = { id: 'fbo-1' };

  return {
    drawingBufferWidth: 4,
    drawingBufferHeight: 4,
    getError: () => GL.NO_ERROR,
    getExtension: () => null,
    bindFramebuffer() {},
    bindRenderbuffer() {},
    bindTexture() {},
    activeTexture() {},
    getParameter(pname) {
      if (pname === GL.DRAW_FRAMEBUFFER_BINDING || pname === GL.FRAMEBUFFER_BINDING) return framebuffer;
      if (pname === GL.VIEWPORT) return [0, 0, 4, 4];
      return null;
    },
    getFramebufferAttachmentParameter(target, attachment, pname) {
      if (pname === GL.FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE) {
        return colorAttachmentTarget === 'texture' ? GL.TEXTURE : GL.RENDERBUFFER;
      }
      if (pname === GL.FRAMEBUFFER_ATTACHMENT_OBJECT_NAME) return { id: 'attachment-object' };
      throw new Error(`unexpected getFramebufferAttachmentParameter pname ${pname}`);
    },
    getRenderbufferParameter() {
      return 4;
    },
    getTexParameter(target, pname) {
      if (!KNOWN_TEX_PARAMS.has(pname)) {
        throw new Error(`INVALID_ENUM: getTexParameter called with unrecognized pname ${pname}`);
      }
      return 0;
    },
    readPixels(x, y, w, h, format, type, pixels) {
      if (!KNOWN_READ_FORMATS.has(format)) {
        throw new Error(`INVALID_ENUM: readPixels called with unsupported format ${format}`);
      }
      pixels.fill(120);
    },
    ...GL
  };
}

describe('WebGL live preview baking (Spector-style)', () => {
  it('never calls getTexParameter to size a texture-backed color attachment (no such WebGL enum exists)', () => {
    const gl = createStrictFakeContext({ colorAttachmentTarget: 'texture' });
    // Must not throw — resolveReadTarget should fall back to the viewport, never attempt
    // gl.getTexParameter(gl.TEXTURE_2D, gl.TEXTURE_WIDTH) (TEXTURE_WIDTH does not exist on
    // WebGL2RenderingContext, so that call always raised INVALID_ENUM in a real browser).
    const target = resolveReadTarget(gl);
    assert.equal(target.width, 4);
    assert.equal(target.height, 4);
  });

  it('bakes a preview against a texture-backed framebuffer without any invalid-enum GL calls', () => {
    const gl = createStrictFakeContext({ colorAttachmentTarget: 'texture' });
    const preview = bakeEventPreview(gl);
    assert.ok(preview.color, 'color summary should still succeed via the viewport fallback');
    assert.equal(preview.reasons.length, 0);
  });

  it('only reads the color attachment (WebGL readPixels cannot read depth)', () => {
    const gl = createStrictFakeContext({ colorAttachmentTarget: 'renderbuffer' });
    // The fake's readPixels throws on any non-RGBA format, so a depth read would fail here.
    const preview = bakeEventPreview(gl);
    assert.deepEqual(preview.reasons, []);
    assert.equal('depth' in preview, false);
  });

  it('reads a floating-point render target with its own (RGBA, FLOAT) combo, never guessing UNSIGNED_BYTE first', () => {
    const gl = createHdrFakeContext(GL.FLOAT);
    const pixels = readPixelsFromTarget(gl, { framebuffer: null, width: 4, height: 4, samples: 0 });

    assert.deepEqual(gl.calls, [{ format: GL.RGBA, type: GL.FLOAT }]);
    assert.equal(pixels.length, 64);
    assert.ok(pixels.every((channel) => channel === 128), 'linear 0.5 should decode to ~128/255');
  });

  it('reads a half-float render target with its own (RGBA, HALF_FLOAT) combo, never guessing UNSIGNED_BYTE first', () => {
    const gl = createHdrFakeContext(GL.HALF_FLOAT);
    const pixels = readPixelsFromTarget(gl, { framebuffer: null, width: 4, height: 4, samples: 0 });

    assert.deepEqual(gl.calls, [{ format: GL.RGBA, type: GL.HALF_FLOAT }]);
    assert.equal(pixels.length, 64);
    assert.ok(pixels.every((channel) => channel === 128), 'half-float 0.5 should decode to ~128/255');
  });
});
