export const WEBGL_LIMIT_PARAMETERS = Object.freeze([
  'ALIASED_LINE_WIDTH_RANGE',
  'ALIASED_POINT_SIZE_RANGE',
  'MAX_3D_TEXTURE_SIZE',
  'MAX_ARRAY_TEXTURE_LAYERS',
  'MAX_CLIENT_WAIT_TIMEOUT_WEBGL',
  'MAX_COLOR_ATTACHMENTS',
  'MAX_COMBINED_FRAGMENT_UNIFORM_COMPONENTS',
  'MAX_COMBINED_TEXTURE_IMAGE_UNITS',
  'MAX_COMBINED_UNIFORM_BLOCKS',
  'MAX_COMBINED_VERTEX_UNIFORM_COMPONENTS',
  'MAX_CUBE_MAP_TEXTURE_SIZE',
  'MAX_DRAW_BUFFERS',
  'MAX_ELEMENT_INDEX',
  'MAX_ELEMENTS_INDICES',
  'MAX_ELEMENTS_VERTICES',
  'MAX_FRAGMENT_INPUT_COMPONENTS',
  'MAX_FRAGMENT_UNIFORM_BLOCKS',
  'MAX_FRAGMENT_UNIFORM_COMPONENTS',
  'MAX_FRAGMENT_UNIFORM_VECTORS',
  'MAX_PROGRAM_TEXEL_OFFSET',
  'MAX_RENDERBUFFER_SIZE',
  'MAX_SAMPLES',
  'MAX_SERVER_WAIT_TIMEOUT',
  'MAX_TEXTURE_IMAGE_UNITS',
  'MAX_TEXTURE_LOD_BIAS',
  'MAX_TEXTURE_SIZE',
  'MAX_TRANSFORM_FEEDBACK_INTERLEAVED_COMPONENTS',
  'MAX_TRANSFORM_FEEDBACK_SEPARATE_ATTRIBS',
  'MAX_TRANSFORM_FEEDBACK_SEPARATE_COMPONENTS',
  'MAX_UNIFORM_BLOCK_SIZE',
  'MAX_UNIFORM_BUFFER_BINDINGS',
  'MAX_UNIFORM_LOCATIONS',
  'MAX_VARYING_COMPONENTS',
  'MAX_VIEWPORT_DIMS',
  'MAX_VERTEX_ATTRIBS',
  'MAX_VERTEX_OUTPUT_COMPONENTS',
  'MAX_VERTEX_TEXTURE_IMAGE_UNITS',
  'MAX_VERTEX_UNIFORM_BLOCKS',
  'MAX_VERTEX_UNIFORM_COMPONENTS',
  'MAX_VERTEX_UNIFORM_VECTORS',
  'MAX_VARYING_VECTORS',
  'MIN_PROGRAM_TEXEL_OFFSET',
  'UNIFORM_BUFFER_OFFSET_ALIGNMENT'
]);

export function webGlVersion(context) {
  if (typeof WebGL2RenderingContext !== 'undefined' && context instanceof WebGL2RenderingContext) return 2;
  if (typeof WebGLRenderingContext !== 'undefined' && context instanceof WebGLRenderingContext) return 1;
  return typeof context?.createVertexArray === 'function' ? 2 : 1;
}

function safeQuery(fn, fallback) {
  try {
    return fn() ?? fallback;
  } catch (_) {
    return fallback;
  }
}

function normalizeValue(value) {
  if (Array.isArray(value) || ArrayBuffer.isView(value)) return Array.from(value);
  if (typeof value === 'bigint') return { type: 'bigint', value: value.toString() };
  return value;
}

export function captureWebGlDrawingBufferSize(context) {
  return {
    drawingBufferWidth: safeQuery(() => context.drawingBufferWidth, null),
    drawingBufferHeight: safeQuery(() => context.drawingBufferHeight, null)
  };
}

/**
 * Captures the static context facts: WebGL version, creation attributes, drawing-buffer and
 * canvas dimensions, hardware limits, and supported extensions. Limits whose enum the context
 * does not expose (WebGL2-only limits on a WebGL1 context) are skipped, never queried.
 */
export function captureWebGlContextInfo(context) {
  const canvas = context?.canvas ?? null;
  const attributes = safeQuery(() => {
    const attrs = context.getContextAttributes();
    return attrs ? { ...attrs } : null;
  }, null);

  const limits = {};
  for (const name of WEBGL_LIMIT_PARAMETERS) {
    const key = context[name];
    if (typeof key !== 'number') continue;
    limits[name] = safeQuery(() => normalizeValue(context.getParameter(key)), null);
  }

  const supportedExtensions = safeQuery(() => {
    const extensions = context.getSupportedExtensions();
    return extensions ? [...extensions] : [];
  }, []);

  return {
    version: webGlVersion(context),
    attributes,
    ...captureWebGlDrawingBufferSize(context),
    canvasWidth: canvas ? safeQuery(() => canvas.width, null) : null,
    canvasHeight: canvas ? safeQuery(() => canvas.height, null) : null,
    limits,
    supportedExtensions
  };
}

/**
 * Observes `width`/`height` writes on the drawing surface and reports the new size. Works for
 * HTMLCanvasElement and OffscreenCanvas instances whose size lives behind accessor
 * descriptors, and returns a no-op otherwise.
 */
export function trackWebGlCanvasResize(canvas, onResize) {
  if (!canvas || typeof canvas !== 'object') {
    return { trackedProperties: [], uninstall() {} };
  }

  const wrappedProps = [];
  for (const prop of ['width', 'height']) {
    const originalOwnDescriptor = Object.getOwnPropertyDescriptor(canvas, prop);
    let owner = canvas;
    let descriptor = originalOwnDescriptor;
    while (!descriptor && (owner = Object.getPrototypeOf(owner))) {
      descriptor = Object.getOwnPropertyDescriptor(owner, prop);
    }
    if (!descriptor || typeof descriptor.get !== 'function' || typeof descriptor.set !== 'function') {
      continue;
    }
    const { get, set } = descriptor;
    const wrappedGet = function () {
      return get.call(this);
    };
    const wrappedSet = function (value) {
      let previous;
      let comparable = true;
      try {
        previous = get.call(this);
      } catch (_) {
        comparable = false;
      }

      set.call(this, value);
      if (!comparable) return;

      let current;
      try {
        current = get.call(this);
      } catch (_) {
        return;
      }
      if (current === previous) return;

      try {
        onResize?.({ width: this.width, height: this.height });
      } catch (_) {
        /* instrumentation must not change application behavior */
      }
    };

    try {
      Object.defineProperty(canvas, prop, {
        configurable: true,
        enumerable: descriptor.enumerable,
        get: wrappedGet,
        set: wrappedSet
      });
      wrappedProps.push({ prop, originalOwnDescriptor, wrappedGet, wrappedSet });
    } catch (_) {
      /* a non-extensible drawing surface remains usable, but resize tracking is unavailable */
    }
  }

  const trackedProperties = wrappedProps.map(({ prop }) => prop);

  return {
    trackedProperties,
    uninstall() {
      for (const { prop, originalOwnDescriptor, wrappedGet, wrappedSet } of wrappedProps) {
        const current = Object.getOwnPropertyDescriptor(canvas, prop);
        if (current?.get !== wrappedGet || current?.set !== wrappedSet) continue;
        try {
          if (originalOwnDescriptor) Object.defineProperty(canvas, prop, originalOwnDescriptor);
          else delete canvas[prop];
        } catch (_) {
          /* instrumentation cleanup must not change application behavior */
        }
      }
    }
  };
}
