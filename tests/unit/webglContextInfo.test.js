import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  WEBGL_LIMIT_PARAMETERS,
  captureWebGlContextInfo,
  trackWebGlCanvasResize
} from '../../src/backend/webgl/capture/contextInfo.js';

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

function createFakeContext(overrides = {}) {
  const canvas = new FakeCanvas(300, 150);
  return {
    canvas,
    getContextAttributes() {
      return { alpha: false, antialias: false, depth: true, preserveDrawingBuffer: true };
    },
    drawingBufferWidth: 300,
    drawingBufferHeight: 150,
    getSupportedExtensions() {
      return ['EXT_color_buffer_float', 'WEBGL_multi_draw'];
    },
    getParameter(parameter) {
      if (parameter === 0x0d33) return 16384;
      if (parameter === 0x0d3a) return [8192, 8192];
      return null;
    },
    MAX_TEXTURE_SIZE: 0x0d33,
    MAX_VIEWPORT_DIMS: 0x0d3a,
    ...overrides
  };
}

describe('WebGL context info', () => {
  it('captures attributes, drawing-buffer dimensions, and canvas size', () => {
    const context = createFakeContext();
    const info = captureWebGlContextInfo(context);

    assert.deepEqual(info.attributes, {
      alpha: false,
      antialias: false,
      depth: true,
      preserveDrawingBuffer: true
    });
    assert.equal(info.drawingBufferWidth, 300);
    assert.equal(info.drawingBufferHeight, 150);
    assert.equal(info.canvasWidth, 300);
    assert.equal(info.canvasHeight, 150);
    assert.deepEqual(info.supportedExtensions, ['EXT_color_buffer_float', 'WEBGL_multi_draw']);
  });

  it('normalizes array-valued limits', () => {
    const info = captureWebGlContextInfo(createFakeContext());
    assert.equal(info.limits.MAX_TEXTURE_SIZE, 16384);
    assert.deepEqual(info.limits.MAX_VIEWPORT_DIMS, [8192, 8192]);
  });

  it('normalizes bigint-valued limits into a JSON-safe value', () => {
    const context = createFakeContext({
      MAX_SERVER_WAIT_TIMEOUT: 0x9111,
      getParameter(parameter) {
        if (parameter === 0x9111) return 0x1fffffffffffffn;
        return null;
      }
    });
    const info = captureWebGlContextInfo(context);

    assert.deepEqual(info.limits.MAX_SERVER_WAIT_TIMEOUT, {
      type: 'bigint',
      value: '9007199254740991'
    });
    assert.doesNotThrow(() => JSON.stringify(info));
  });

  it('omits limits the context does not define', () => {
    const context = createFakeContext({ MAX_TEXTURE_SIZE: undefined });
    const info = captureWebGlContextInfo(context);
    assert.equal(info.limits.MAX_TEXTURE_SIZE, undefined);
    assert.equal('MAX_TEXTURE_SIZE' in info.limits, false);
  });

  it('falls back gracefully when context queries fail or are missing', () => {
    const info = captureWebGlContextInfo({
      canvas: { width: 320, height: 240 },
      getContextAttributes() {
        throw new Error('context lost');
      },
      getParameter() {
        throw new Error('context lost');
      },
      getSupportedExtensions() {
        return null;
      }
    });

    assert.equal(info.attributes, null);
    assert.deepEqual(info.limits, {});
    assert.deepEqual(info.supportedExtensions, []);
    assert.equal(info.drawingBufferWidth, null);
    assert.equal(info.canvasWidth, 320);
  });

  it('handles a missing canvas', () => {
    const info = captureWebGlContextInfo({});
    assert.equal(info.canvasWidth, null);
    assert.equal(info.canvasHeight, null);
    assert.equal(info.attributes, null);
  });

  it('lists a stable set of WebGL limit parameters', () => {
    assert.ok(WEBGL_LIMIT_PARAMETERS.length >= 40);
    assert.ok(WEBGL_LIMIT_PARAMETERS.includes('MAX_TEXTURE_SIZE'));
    assert.ok(WEBGL_LIMIT_PARAMETERS.includes('MAX_3D_TEXTURE_SIZE'));
    assert.ok(WEBGL_LIMIT_PARAMETERS.includes('MAX_ARRAY_TEXTURE_LAYERS'));
    assert.ok(WEBGL_LIMIT_PARAMETERS.includes('MAX_COLOR_ATTACHMENTS'));
    assert.ok(WEBGL_LIMIT_PARAMETERS.includes('MAX_UNIFORM_BLOCK_SIZE'));
    assert.ok(WEBGL_LIMIT_PARAMETERS.includes('UNIFORM_BUFFER_OFFSET_ALIGNMENT'));
  });

  it('queries supported extensions once', () => {
    let calls = 0;
    const context = createFakeContext({
      getSupportedExtensions() {
        calls++;
        return ['EXT_color_buffer_float'];
      }
    });

    const info = captureWebGlContextInfo(context);

    assert.equal(calls, 1);
    assert.deepEqual(info.supportedExtensions, ['EXT_color_buffer_float']);
  });
});

describe('WebGL canvas resize tracking', () => {
  it('records size changes and stays quiet for identical writes', () => {
    const canvas = new FakeCanvas(300, 150);
    const events = [];
    const tracker = trackWebGlCanvasResize(canvas, (size) => events.push(size));

    canvas.width = 800;
    canvas.height = 600;
    canvas.width = 800;

    assert.deepEqual(events, [
      { width: 800, height: 150 },
      { width: 800, height: 600 }
    ]);
    assert.equal(canvas.width, 800);
    assert.equal(canvas.height, 600);
    assert.deepEqual(tracker.trackedProperties, ['width', 'height']);
    tracker.uninstall();
  });

  it('compares the coerced size instead of the assigned value', () => {
    const canvas = new FakeCanvas(300, 150);
    const width = Object.getOwnPropertyDescriptor(FakeCanvas.prototype, 'width');
    Object.defineProperty(canvas, 'width', {
      configurable: true,
      enumerable: width.enumerable,
      get: width.get,
      set(value) {
        width.set.call(this, Number(value));
      }
    });
    const events = [];
    trackWebGlCanvasResize(canvas, (size) => events.push(size));

    canvas.width = '300';

    assert.deepEqual(events, []);
    assert.equal(canvas.width, 300);
  });

  it('restores a pre-existing own accessor when untracking', () => {
    const canvas = new FakeCanvas(10, 10);
    const inherited = Object.getOwnPropertyDescriptor(FakeCanvas.prototype, 'width');
    const own = {
      configurable: true,
      enumerable: false,
      get: inherited.get,
      set: inherited.set
    };
    Object.defineProperty(canvas, 'width', own);
    const tracker = trackWebGlCanvasResize(canvas, () => {});

    tracker.uninstall();

    const restored = Object.getOwnPropertyDescriptor(canvas, 'width');
    assert.equal(restored.get, own.get);
    assert.equal(restored.set, own.set);
    assert.equal(restored.enumerable, false);
  });

  it('does not overwrite a replacement accessor during cleanup', () => {
    const canvas = new FakeCanvas(10, 10);
    const tracker = trackWebGlCanvasResize(canvas, () => {});
    const replacement = {
      configurable: true,
      get() {
        return 99;
      },
      set() {}
    };
    Object.defineProperty(canvas, 'width', replacement);

    tracker.uninstall();

    assert.equal(Object.getOwnPropertyDescriptor(canvas, 'width').get, replacement.get);
  });

  it('swallows observer and installation failures', () => {
    const canvas = new FakeCanvas(10, 10);
    trackWebGlCanvasResize(canvas, () => {
      throw new Error('observer failed');
    });
    assert.doesNotThrow(() => {
      canvas.width = 20;
    });
    assert.equal(canvas.width, 20);

    const nonExtensible = new FakeCanvas(10, 10);
    Object.preventExtensions(nonExtensible);
    const tracker = trackWebGlCanvasResize(nonExtensible, () => {});
    assert.deepEqual(tracker.trackedProperties, []);
    assert.doesNotThrow(() => {
      nonExtensible.width = 20;
    });
    assert.equal(nonExtensible.width, 20);
  });

  it('stops reporting after untracking', () => {
    const canvas = new FakeCanvas(10, 10);
    const events = [];
    const tracker = trackWebGlCanvasResize(canvas, (size) => events.push(size));

    canvas.width = 20;
    tracker.uninstall();
    canvas.height = 30;

    assert.deepEqual(events, [{ width: 20, height: 10 }]);
    assert.equal(canvas.height, 30);
  });

  it('is a no-op for surfaces without accessor size properties', () => {
    const plain = { width: 1, height: 1 };
    const tracker = trackWebGlCanvasResize(plain, () => {});
    tracker.uninstall();
    assert.equal(plain.width, 1);
    assert.deepEqual(trackWebGlCanvasResize(null, () => {}).trackedProperties, []);
    assert.deepEqual(trackWebGlCanvasResize(undefined, () => {}).trackedProperties, []);
  });
});
