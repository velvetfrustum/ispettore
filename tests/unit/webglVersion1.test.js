import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createWebGlCommandJournal } from '../../src/backend/webgl/capture/commandJournal.js';
import { captureWebGlContextInfo } from '../../src/backend/webgl/capture/contextInfo.js';
import { bakeEventPreview, readPixelsFromTarget, resolveReadTarget } from '../../src/backend/webgl/capture/livePreview.js';
import { webGlEventKind } from '../../src/inspection/webgl/events.js';

const WEBGL1_ENUMS = {
  NO_ERROR: 0,
  NONE: 0,
  TRIANGLES: 0x0004,
  ARRAY_BUFFER: 0x8892,
  BLEND: 0x0be2,
  CULL_FACE: 0x0b44,
  DEPTH_TEST: 0x0b71,
  DITHER: 0x0bd0,
  SCISSOR_TEST: 0x0c11,
  STENCIL_TEST: 0x0b90,
  POLYGON_OFFSET_FILL: 0x8037,
  SAMPLE_ALPHA_TO_COVERAGE: 0x809e,
  VIEWPORT: 0x0ba2,
  SCISSOR_BOX: 0x0c10,
  COLOR_CLEAR_VALUE: 0x0c22,
  COLOR_WRITEMASK: 0x0c23,
  DEPTH_CLEAR_VALUE: 0x0b73,
  STENCIL_CLEAR_VALUE: 0x0b91,
  DEPTH_WRITEMASK: 0x0b72,
  DEPTH_FUNC: 0x0b74,
  CULL_FACE_MODE: 0x0b45,
  FRONT_FACE: 0x0b46,
  BLEND_EQUATION_RGB: 0x8009,
  BLEND_EQUATION_ALPHA: 0x883d,
  BLEND_SRC_RGB: 0x80c9,
  BLEND_DST_RGB: 0x80c8,
  BLEND_SRC_ALPHA: 0x80cb,
  BLEND_DST_ALPHA: 0x80ca,
  CURRENT_PROGRAM: 0x8b8d,
  ACTIVE_TEXTURE: 0x84e0,
  TEXTURE0: 0x84c0,
  TEXTURE_2D: 0x0de1,
  TEXTURE_BINDING_2D: 0x8069,
  MAX_TEXTURE_IMAGE_UNITS: 0x8872,
  MAX_TEXTURE_SIZE: 0x0d33,
  MAX_VIEWPORT_DIMS: 0x0d3a,
  MAX_VERTEX_ATTRIBS: 0x8869,
  FRAMEBUFFER: 0x8d40,
  FRAMEBUFFER_BINDING: 0x8ca6,
  RENDERBUFFER: 0x8d41,
  RENDERBUFFER_BINDING: 0x8ca7,
  RENDERBUFFER_WIDTH: 0x8d42,
  RENDERBUFFER_HEIGHT: 0x8d43,
  COLOR_ATTACHMENT0: 0x8ce0,
  FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE: 0x8cd0,
  FRAMEBUFFER_ATTACHMENT_OBJECT_NAME: 0x8cd1,
  TEXTURE: 0x1702,
  RGBA: 0x1908,
  UNSIGNED_BYTE: 0x1401,
  FLOAT: 0x1406,
  IMPLEMENTATION_COLOR_READ_TYPE: 0x8b9a,
  IMPLEMENTATION_COLOR_READ_FORMAT: 0x8b9b
};

const PARAMETER_VALUES = new Map([
  [WEBGL1_ENUMS.VIEWPORT, new Int32Array([0, 0, 4, 4])],
  [WEBGL1_ENUMS.SCISSOR_BOX, new Int32Array([0, 0, 4, 4])],
  [WEBGL1_ENUMS.COLOR_CLEAR_VALUE, new Float32Array([0, 0, 0, 1])],
  [WEBGL1_ENUMS.COLOR_WRITEMASK, [true, true, true, true]],
  [WEBGL1_ENUMS.MAX_VIEWPORT_DIMS, new Int32Array([4096, 4096])],
  [WEBGL1_ENUMS.MAX_TEXTURE_SIZE, 4096],
  [WEBGL1_ENUMS.MAX_VERTEX_ATTRIBS, 16],
  [WEBGL1_ENUMS.MAX_TEXTURE_IMAGE_UNITS, 8],
  [WEBGL1_ENUMS.ACTIVE_TEXTURE, WEBGL1_ENUMS.TEXTURE0],
  [WEBGL1_ENUMS.IMPLEMENTATION_COLOR_READ_TYPE, WEBGL1_ENUMS.UNSIGNED_BYTE],
  [WEBGL1_ENUMS.IMPLEMENTATION_COLOR_READ_FORMAT, WEBGL1_ENUMS.RGBA]
]);

const KNOWN_ENUMS = new Set(Object.values(WEBGL1_ENUMS));

class FakeCanvas {
  constructor(width, height) {
    this._width = width;
    this._height = height;
  }

  get width() {
    return this._width;
  }

  set width(value) {
    this._width = value;
  }

  get height() {
    return this._height;
  }

  set height(value) {
    this._height = value;
  }
}

/**
 * A fake WebGL1 context that exposes only WebGL1 enums and methods, and throws on any enum it
 * does not know — like a real browser raising INVALID_ENUM — so a WebGL2-only enum or method
 * leaking into the WebGL1 path fails here instead of in a real console.
 */
function createWebGl1Context({ framebufferBound = false } = {}) {
  const calls = [];
  const state = {
    framebuffer: framebufferBound ? { id: 'fbo' } : null,
    renderbuffer: null
  };
  const requireEnum = (method, value) => {
    if (!KNOWN_ENUMS.has(value)) throw new Error(`INVALID_ENUM: ${method}(${value})`);
  };
  const timerQueries = [];
  const extensions = {
    ANGLE_instanced_arrays: {
      drawArraysInstancedANGLE(...args) {
        calls.push(['drawArraysInstancedANGLE', ...args]);
      },
      drawElementsInstancedANGLE() {},
      vertexAttribDivisorANGLE() {}
    },
    OES_vertex_array_object: {
      createVertexArrayOES: () => ({ vao: true }),
      bindVertexArrayOES(vao) {
        calls.push(['bindVertexArrayOES', vao]);
      },
      deleteVertexArrayOES() {},
      isVertexArrayOES: () => true
    },
    EXT_disjoint_timer_query: {
      TIME_ELAPSED_EXT: 0x88bf,
      QUERY_RESULT_EXT: 0x8866,
      QUERY_RESULT_AVAILABLE_EXT: 0x8867,
      createQueryEXT() {
        const query = { query: timerQueries.length + 1 };
        timerQueries.push(query);
        return query;
      },
      beginQueryEXT(target) {
        calls.push(['beginQueryEXT', target]);
      },
      endQueryEXT(target) {
        calls.push(['endQueryEXT', target]);
      },
      getQueryObjectEXT(query, pname) {
        return pname === 0x8867 ? true : 2_000_000;
      },
      deleteQueryEXT() {}
    }
  };
  const canvas = new FakeCanvas(4, 4);

  return {
    ...WEBGL1_ENUMS,
    calls,
    canvas,
    drawingBufferWidth: 4,
    drawingBufferHeight: 4,
    getContextAttributes: () => ({ alpha: true, antialias: true }),
    getSupportedExtensions: () => Object.keys(extensions),
    getExtension: (name) => extensions[name] ?? null,
    getError: () => WEBGL1_ENUMS.NO_ERROR,
    isEnabled(cap) {
      requireEnum('isEnabled', cap);
      return false;
    },
    enable() {},
    getParameter(pname) {
      requireEnum('getParameter', pname);
      calls.push(['getParameter', pname]);
      if (pname === WEBGL1_ENUMS.FRAMEBUFFER_BINDING) return state.framebuffer;
      if (pname === WEBGL1_ENUMS.RENDERBUFFER_BINDING) return state.renderbuffer;
      return PARAMETER_VALUES.get(pname) ?? null;
    },
    bindFramebuffer(target, framebuffer) {
      requireEnum('bindFramebuffer', target);
      if (target !== WEBGL1_ENUMS.FRAMEBUFFER) throw new Error(`INVALID_ENUM: bindFramebuffer(${target})`);
      calls.push(['bindFramebuffer', framebuffer]);
      state.framebuffer = framebuffer;
    },
    bindRenderbuffer(target, renderbuffer) {
      requireEnum('bindRenderbuffer', target);
      state.renderbuffer = renderbuffer;
    },
    getRenderbufferParameter(target, pname) {
      requireEnum('getRenderbufferParameter', pname);
      return 4;
    },
    getFramebufferAttachmentParameter(target, attachment, pname) {
      if (target !== WEBGL1_ENUMS.FRAMEBUFFER) throw new Error(`INVALID_ENUM: framebuffer target ${target}`);
      requireEnum('getFramebufferAttachmentParameter', pname);
      if (pname === WEBGL1_ENUMS.FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE) return WEBGL1_ENUMS.RENDERBUFFER;
      return { id: 'color-renderbuffer' };
    },
    bindTexture(target) {
      requireEnum('bindTexture', target);
    },
    activeTexture() {},
    readPixels(x, y, width, height, format, type, pixels) {
      if (format !== WEBGL1_ENUMS.RGBA || type !== WEBGL1_ENUMS.UNSIGNED_BYTE) {
        throw new Error('INVALID_OPERATION: readPixels format/type');
      }
      calls.push(['readPixels', width, height]);
      pixels.fill(200);
    },
    createBuffer: () => ({}),
    bindBuffer() {},
    drawArrays(...args) {
      calls.push(['drawArrays', ...args]);
    },
    clear() {}
  };
}

function isolatedCapture() {
  let isolated = false;
  return {
    shouldCapture: () => !isolated,
    runIsolated(fn) {
      const previous = isolated;
      isolated = true;
      try {
        return fn();
      } finally {
        isolated = previous;
      }
    }
  };
}

describe('WebGL1 capture', () => {
  it('reports version 1 and only queries limits the context exposes', () => {
    const context = createWebGl1Context();
    const info = captureWebGlContextInfo(context);
    assert.equal(info.version, 1);
    assert.equal(info.limits.MAX_TEXTURE_SIZE, 4096);
    assert.deepEqual(info.limits.MAX_VIEWPORT_DIMS, [4096, 4096]);
    assert.equal('MAX_3D_TEXTURE_SIZE' in info.limits, false);
  });

  it('reads back the bound framebuffer through FRAMEBUFFER and restores the binding', () => {
    const context = createWebGl1Context({ framebufferBound: true });
    const bound = context.getParameter(context.FRAMEBUFFER_BINDING);
    const target = resolveReadTarget(context);
    assert.equal(target.framebuffer, bound);
    assert.equal(target.samples, 0);
    assert.equal(target.width, 4);

    const pixels = readPixelsFromTarget(context, target);
    assert.equal(pixels[0], 200);
    assert.equal(context.getParameter(context.FRAMEBUFFER_BINDING), bound);
  });

  it('bakes a preview of the default framebuffer without touching WebGL2 enums', () => {
    const context = createWebGl1Context();
    const preview = bakeEventPreview(context);
    assert.deepEqual(preview.reasons, []);
    assert.equal(preview.colorTarget, 'default');
    assert.equal(preview.color.min, 200);
  });

  it('records ANGLE instanced draws and OES vertex arrays as regular commands and events', () => {
    const context = createWebGl1Context();
    const journal = createWebGlCommandJournal(context, isolatedCapture());
    journal.arm();
    journal.markFrameStart({ frameId: 'frame:1', kind: 'animation-frame' });

    const vaoExtension = context.getExtension('OES_vertex_array_object');
    const instancing = context.getExtension('ANGLE_instanced_arrays');
    const vao = vaoExtension.createVertexArrayOES();
    vaoExtension.bindVertexArrayOES(vao);
    instancing.drawArraysInstancedANGLE(context.TRIANGLES, 0, 3, 10);
    journal.markFrameEnd();

    const ops = journal.commands.map((command) => command.op);
    assert.deepEqual(ops, [
      'getExtension',
      'getExtension',
      'createVertexArrayOES',
      'bindVertexArrayOES',
      'drawArraysInstancedANGLE'
    ]);
    const [, , create, bind, draw] = journal.commands;
    assert.match(create.resultId, /:vertex-array-/);
    assert.equal(bind.args[0].ref, create.resultId);
    assert.deepEqual(draw.args, [context.TRIANGLES, 0, 3, 10]);
    assert.equal(webGlEventKind(draw.op), 'draw');
    assert.equal(draw.preview.color.min, 200);
    assert.equal(journal.valid, true);
  });

  it('records extension draws when the app obtained the extension before the capture was armed', () => {
    const context = createWebGl1Context();
    const journal = createWebGlCommandJournal(context, isolatedCapture());
    const instancing = context.getExtension('ANGLE_instanced_arrays');
    journal.arm();
    journal.markFrameStart({ frameId: 'frame:1', kind: 'animation-frame' });
    instancing.drawArraysInstancedANGLE(context.TRIANGLES, 0, 3, 4);
    journal.markFrameEnd();

    assert.deepEqual(journal.commands.map((command) => command.op), ['drawArraysInstancedANGLE']);
    assert.equal(webGlEventKind(journal.commands[0].op), 'draw');
  });

  it('captures Spector-style details for a WebGL1 draw using only WebGL1 enums', () => {
    const context = createWebGl1Context();
    const journal = createWebGlCommandJournal(context, isolatedCapture());
    journal.arm();
    journal.markFrameStart({ frameId: 'frame:1', kind: 'animation-frame' });
    context.enable(context.BLEND);
    context.drawArrays(context.TRIANGLES, 0, 3);
    journal.markFrameEnd();

    const [enable, draw] = journal.commands;
    assert.equal(draw.details.error, undefined);
    assert.deepEqual(draw.details.command.arguments, [
      { name: 'mode', value: 'TRIANGLES' },
      { name: 'first', value: 0 },
      { name: 'count', value: 3 }
    ]);
    const groups = Object.fromEntries(draw.details.states.map((group) => [group.name, group]));
    assert.equal(groups.DrawState.entries.FRONT_FACE, null);
    assert.equal('RASTERIZER_DISCARD' in groups.DrawState.entries, false);
    assert.equal(groups.DrawState.entries.FRAGMENT_SHADER_DERIVATIVE_HINT_OES, 'Extension OES_standard_derivatives is unavailable.');
    assert.deepEqual(groups.BlendState.commands.redundant, [0]);
    assert.equal(enable.status, 'redundant');
    assert.equal(draw.details.frameBuffer.target, 'canvas');
    assert.equal(draw.details.drawCall, null);
  });

  it('times draws through EXT_disjoint_timer_query without recording the timer calls', async () => {
    const context = createWebGl1Context();
    const journal = createWebGlCommandJournal(context, isolatedCapture());
    context.getExtension('EXT_disjoint_timer_query');
    journal.arm();
    journal.markFrameStart({ frameId: 'frame:1', kind: 'animation-frame' });
    context.drawArrays(context.TRIANGLES, 0, 3);
    journal.markFrameEnd();

    assert.deepEqual(journal.commands.map((command) => command.op), ['drawArrays']);
    const timer = context.calls.filter(([name]) => name === 'beginQueryEXT' || name === 'endQueryEXT');
    assert.deepEqual(timer, [['beginQueryEXT', 0x88bf], ['endQueryEXT', 0x88bf]]);
    const timings = await journal.collectPendingGpuTimings();
    assert.equal(timings.get(0), 2);
  });
});
