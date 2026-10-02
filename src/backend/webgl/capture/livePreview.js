/**
 * Spector-style eager preview baking: called against the LIVE page context immediately
 * after a significant command (draw/clear/blit/copy) has already executed, so it reads
 * back exactly what the app just rendered — no reconstruction, no isolated context.
 */

const PREVIEW_MAX_DIM = 512;

function clearGlErrors(gl) {
  if (typeof gl?.getError !== 'function') return;
  try {
    while (gl.getError() !== (gl.NO_ERROR ?? 0)) {
      /* drain */
    }
  } catch (_) {
    /* ignore */
  }
}

// WebGL2 splits the framebuffer binding into READ/DRAW targets; WebGL1 only has FRAMEBUFFER.
// Both paths read the enum from the context itself, so a WebGL1 context is never handed a
// WebGL2-only enum (which would raise INVALID_ENUM).
function hasSeparateReadFramebuffer(gl) {
  return typeof gl.READ_FRAMEBUFFER === 'number' && typeof gl.READ_FRAMEBUFFER_BINDING === 'number';
}

function drawFramebufferTarget(gl) {
  return typeof gl.DRAW_FRAMEBUFFER === 'number' ? gl.DRAW_FRAMEBUFFER : gl.FRAMEBUFFER;
}

function drawFramebufferBinding(gl) {
  return typeof gl.DRAW_FRAMEBUFFER_BINDING === 'number' ? gl.DRAW_FRAMEBUFFER_BINDING : gl.FRAMEBUFFER_BINDING;
}

export function resolveReadTarget(gl) {
  try {
    const framebuffer = gl.getParameter(drawFramebufferBinding(gl));
    if (!framebuffer) {
      return { framebuffer: null, width: gl.drawingBufferWidth, height: gl.drawingBufferHeight, samples: 0 };
    }
    const attachmentTarget = drawFramebufferTarget(gl);
    const objectType = gl.getFramebufferAttachmentParameter(
      attachmentTarget,
      gl.COLOR_ATTACHMENT0,
      gl.FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE
    );
    if (objectType === gl.NONE) {
      return { framebuffer: null, width: gl.drawingBufferWidth, height: gl.drawingBufferHeight, samples: 0 };
    }
    const object = gl.getFramebufferAttachmentParameter(
      attachmentTarget,
      gl.COLOR_ATTACHMENT0,
      gl.FRAMEBUFFER_ATTACHMENT_OBJECT_NAME
    );
    let width = null;
    let height = null;
    let samples = 0;
    if (objectType === gl.RENDERBUFFER) {
      const previousRenderbuffer = gl.getParameter(gl.RENDERBUFFER_BINDING);
      try {
        gl.bindRenderbuffer(gl.RENDERBUFFER, object);
        width = gl.getRenderbufferParameter(gl.RENDERBUFFER, gl.RENDERBUFFER_WIDTH);
        height = gl.getRenderbufferParameter(gl.RENDERBUFFER, gl.RENDERBUFFER_HEIGHT);
        if (typeof gl.RENDERBUFFER_SAMPLES === 'number') {
          samples = gl.getRenderbufferParameter(gl.RENDERBUFFER, gl.RENDERBUFFER_SAMPLES) | 0;
        }
      } catch (_) {
        /* fallback below */
      } finally {
        gl.bindRenderbuffer(gl.RENDERBUFFER, previousRenderbuffer);
      }
    }
    // A TEXTURE-backed color attachment falls through to the viewport-based guess below:
    // WebGL2 has no `getTexParameter(TEXTURE_WIDTH/HEIGHT)` (those are desktop-GL-only
    // enums; passing them raises INVALID_ENUM without a value) and no other way to query a
    // texture's dimensions without having tracked them at upload time, which live capture
    // deliberately does not do.
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      const vp = gl.getParameter(gl.VIEWPORT);
      if (vp && vp[2] > 0 && vp[3] > 0) {
        width = vp[2];
        height = vp[3];
      } else {
        width = gl.drawingBufferWidth;
        height = gl.drawingBufferHeight;
      }
    }
    return { framebuffer, width, height, samples };
  } catch (_) {
    return { framebuffer: null, width: gl.drawingBufferWidth, height: gl.drawingBufferHeight, samples: 0 };
  }
}

const HALF_FLOAT = 0x140b;
const HALF_FLOAT_OES = 0x8d61;

function halfToFloat(half) {
  const sign = (half & 0x8000) >> 15;
  const exponent = (half & 0x7c00) >> 10;
  const mantissa = half & 0x03ff;
  if (exponent === 0) {
    if (mantissa === 0) return sign ? -0 : 0;
    return (sign ? -1 : 1) * 2 ** -14 * (mantissa / 1024);
  }
  if (exponent === 0x1f) return mantissa ? NaN : sign ? -Infinity : Infinity;
  return (sign ? -1 : 1) * 2 ** (exponent - 15) * (1 + mantissa / 1024);
}

function toChannelByte(value) {
  return Number.isFinite(value) ? Math.max(0, Math.min(255, Math.round(value * 255))) : 0;
}

function saveFramebufferBindings(gl) {
  try {
    if (hasSeparateReadFramebuffer(gl)) {
      return {
        read: gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),
        draw: gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING),
        texture2D: gl.getParameter(gl.TEXTURE_BINDING_2D)
      };
    }
    return {
      framebuffer: gl.getParameter(gl.FRAMEBUFFER_BINDING),
      texture2D: gl.getParameter(gl.TEXTURE_BINDING_2D)
    };
  } catch (_) {
    return null;
  }
}

function restoreFramebufferBindings(gl, saved) {
  if (!saved) return;
  try {
    if ('framebuffer' in saved) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, saved.framebuffer);
    } else {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, saved.read);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, saved.draw);
    }
    gl.bindTexture(gl.TEXTURE_2D, saved.texture2D);
  } catch (_) {}
}

function canBlitToScratch(gl) {
  return (
    hasSeparateReadFramebuffer(gl) &&
    typeof gl.blitFramebuffer === 'function' &&
    typeof gl.texStorage2D === 'function' &&
    typeof gl.RGBA8 === 'number'
  );
}

export function readPixelsFromTarget(gl, target) {
  const { framebuffer, width, height } = target;
  const w = width || 1;
  const h = height || 1;
  const pixels = new Uint8Array(w * h * 4);
  clearGlErrors(gl);
  const saved = saveFramebufferBindings(gl);
  const readTarget = hasSeparateReadFramebuffer(gl) ? gl.READ_FRAMEBUFFER : gl.FRAMEBUFFER;

  if (typeof gl?.getExtension === 'function') {
    try {
      gl.getExtension('EXT_color_buffer_float');
      gl.getExtension('EXT_color_buffer_half_float');
    } catch (_) {}
  }

  // readPixels only accepts (RGBA, UNSIGNED_BYTE) or the read framebuffer's own
  // (IMPLEMENTATION_COLOR_READ_FORMAT, IMPLEMENTATION_COLOR_READ_TYPE) pair — anything else
  // raises GL_INVALID_OPERATION ("Invalid format and type combination"), logged to the
  // console unconditionally by the browser regardless of whether the JS side checks
  // getError() afterward. So the type must be *queried first* and read with exactly once,
  // never guessed-then-recovered — guessing UNSIGNED_BYTE against a float/half-float render
  // target (ping-pong accumulation buffers, HDR blur passes, ...) reliably hits this error.
  const tryReadDirect = (fb) => {
    try {
      if (typeof gl?.bindFramebuffer === 'function') gl.bindFramebuffer(readTarget, fb);
      if (typeof gl?.readPixels !== 'function') return false;
      clearGlErrors(gl);

      const readType = gl.getParameter?.(gl.IMPLEMENTATION_COLOR_READ_TYPE) ?? gl.UNSIGNED_BYTE;
      const readFormat = gl.getParameter?.(gl.IMPLEMENTATION_COLOR_READ_FORMAT) ?? gl.RGBA;
      clearGlErrors(gl);

      if (readType === gl.UNSIGNED_BYTE) {
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        return typeof gl?.getError !== 'function' || gl.getError() === gl.NO_ERROR;
      }

      if (readFormat !== gl.RGBA) {
        // A non-RGBA implementation read format doesn't map cleanly onto our fixed 4-channel
        // buffer — let the blit-to-RGBA8-scratch fallback handle it instead of guessing.
        return false;
      }

      if (readType === gl.FLOAT) {
        const floatPixels = new Float32Array(w * h * 4);
        gl.readPixels(0, 0, w, h, readFormat, readType, floatPixels);
        if (gl.getError?.() !== gl.NO_ERROR) return false;
        for (let i = 0; i < pixels.length; i++) pixels[i] = toChannelByte(floatPixels[i]);
        return true;
      }

      if (readType === HALF_FLOAT || readType === HALF_FLOAT_OES) {
        const halfPixels = new Uint16Array(w * h * 4);
        gl.readPixels(0, 0, w, h, readFormat, readType, halfPixels);
        if (gl.getError?.() !== gl.NO_ERROR) return false;
        for (let i = 0; i < pixels.length; i++) pixels[i] = toChannelByte(halfToFloat(halfPixels[i]));
        return true;
      }

      // Some other implementation-defined type (e.g. an integer format) — not handled here;
      // fall through to the blit-to-RGBA8-scratch path below where the context supports it.
      return false;
    } catch (_) {}
    return false;
  };

  try {
    if (!framebuffer || !target.samples) {
      if (tryReadDirect(framebuffer)) return pixels;
    }
    // Multisampled renderbuffers and non-RGBA8 read formats need a resolve blit into an
    // RGBA8 scratch target. WebGL1 has neither multisampled framebuffers nor blits, so on a
    // WebGL1 context an unreadable target stays an empty (black) preview.
    if (!canBlitToScratch(gl)) return pixels;

    let scratchFramebuffer = null;
    let scratchTexture = null;
    try {
      scratchTexture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, scratchTexture);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
      scratchFramebuffer = gl.createFramebuffer();
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, scratchFramebuffer);
      gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, scratchTexture, 0);

      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, framebuffer);
      gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);

      if (tryReadDirect(scratchFramebuffer)) return pixels;
    } catch (_) {
      tryReadDirect(framebuffer);
    } finally {
      if (scratchFramebuffer) gl.deleteFramebuffer(scratchFramebuffer);
      if (scratchTexture) gl.deleteTexture(scratchTexture);
    }
  } finally {
    restoreFramebufferBindings(gl, saved);
  }
  return pixels;
}

function rgbaToPreview(rgba, width, height, maxDim = PREVIEW_MAX_DIM) {
  try {
    const scale = Math.min(1, maxDim / Math.max(width, height));
    const previewWidth = Math.max(1, Math.round(width * scale));
    const previewHeight = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = previewWidth;
    canvas.height = previewHeight;
    const context = canvas.getContext('2d');
    if (!context) return null;
    const imageData = context.createImageData(previewWidth, previewHeight);
    for (let y = 0; y < previewHeight; y++) {
      const sourceY = height - 1 - Math.min(height - 1, Math.round(y / scale));
      for (let x = 0; x < previewWidth; x++) {
        const sourceX = Math.min(width - 1, Math.round(x / scale));
        const source = (sourceY * width + sourceX) * 4;
        const target = (y * previewWidth + x) * 4;
        imageData.data[target] = rgba[source];
        imageData.data[target + 1] = rgba[source + 1];
        imageData.data[target + 2] = rgba[source + 2];
        imageData.data[target + 3] = rgba[source + 3];
      }
    }
    context.putImageData(imageData, 0, 0);
    return canvas.toDataURL('image/png');
  } catch (_) {
    return null;
  }
}

function summarizeColorBuffer(gl, width, height, pixels) {
  let min = 255;
  let max = 0;
  let hash = 2166136261;
  for (let index = 0; index < pixels.length; index += 4) {
    const luminance = Math.round((pixels[index] + pixels[index + 1] + pixels[index + 2]) / 3);
    min = Math.min(min, luminance);
    max = Math.max(max, luminance);
    for (let channel = 0; channel < 4; channel++) {
      hash ^= pixels[index + channel];
      hash = Math.imul(hash, 16777619);
    }
  }
  return {
    min,
    max,
    range: max - min,
    hash: hash >>> 0,
    preview: rgbaToPreview(pixels, width, height)
  };
}

/**
 * Bakes exactly what the panel's inspection result shape needs, read back from the live
 * context right after a significant command executed. Never throws — capture must never
 * break the page; a failure degrades to a `null`/`available:false` field instead.
 */
export function bakeEventPreview(context) {
  const reasons = [];
  let width = context.drawingBufferWidth;
  let height = context.drawingBufferHeight;
  let color = null;
  let colorTarget = 'default';

  try {
    const target = resolveReadTarget(context);
    width = target.framebuffer ? target.width : context.drawingBufferWidth;
    height = target.framebuffer ? target.height : context.drawingBufferHeight;
    colorTarget = target.framebuffer ? 'framebuffer' : 'default';
    const pixels = readPixelsFromTarget(context, target);
    color = summarizeColorBuffer(context, width, height, pixels);
  } catch (error) {
    reasons.push(`preview readback failed: ${error?.message ?? error}`);
  }

  return { width, height, color, colorTarget, reasons };
}
