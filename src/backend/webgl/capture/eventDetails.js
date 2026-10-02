import { resolveWebGlObjectId } from './objectRegistry.js';
import { parameterNamesFor } from '../intercept/parameterNames.js';
import { webGlEventKind } from '../../../inspection/webgl/events.js';

/**
 * Spector-style command details, read from the live context right after a significant command
 * (draw/clear/blit/copy) executed: named arguments, stack trace, the context state groups
 * Spector attaches to that command, the bound framebuffer, and — for draws — program, shader,
 * attribute, uniform, uniform-block and transform-feedback state. It also classifies every
 * state-changing command of the frame as valid, redundant, disabled or unused the way Spector
 * does. Values are stringified here (enum names, bit masks) so the panel stays API-agnostic.
 *
 * WebGL2-only and extension-only queries run only when the context has them, so a WebGL1
 * context is never handed an enum it does not know.
 */

const MAX_ARRAY_VALUES = 32;
const SAMPLE_VERTICES = 8;
const SAMPLE_INDICES = 24;

// [DataView getter, byte size, normalization divisor] per WebGL component type name.
const COMPONENT_READERS = {
  FLOAT: ['getFloat32', 4, null],
  HALF_FLOAT: ['half', 2, null],
  BYTE: ['getInt8', 1, 127],
  UNSIGNED_BYTE: ['getUint8', 1, 255],
  SHORT: ['getInt16', 2, 32767],
  UNSIGNED_SHORT: ['getUint16', 2, 65535],
  INT: ['getInt32', 4, 2147483647],
  UNSIGNED_INT: ['getUint32', 4, 4294967295]
};
const INDEX_TYPES = { 0x1401: ['getUint8', 1], 0x1403: ['getUint16', 2], 0x1405: ['getUint32', 4] };

function halfToFloat(half) {
  const exponent = (half >> 10) & 0x1f;
  const mantissa = half & 0x3ff;
  const sign = half & 0x8000 ? -1 : 1;
  if (exponent === 0) return sign * 2 ** -14 * (mantissa / 1024);
  if (exponent === 31) return mantissa ? NaN : sign * Infinity;
  return sign * 2 ** (exponent - 15) * (1 + mantissa / 1024);
}

function readComponent(view, offset, [getter, , divisor], normalized) {
  const raw = getter === 'half' ? halfToFloat(view.getUint16(offset, true)) : view[getter](offset, true);
  if (!normalized || divisor == null) return raw;
  return Math.max(raw / divisor, -1);
}
const MAX_STACK_FRAMES = 20;

const BLEND_FACTOR = 'blend-factor';
const STENCIL_OP = 'stencil-op';
const NONE_OR_ENUM = 'none-or-enum';

// [name, kind, version, changeCommands, options]. kind: 'value' | 'enum' | 'uint'.
// `cap` marks enable/disable/hint targets: those change commands only count when their first
// argument is this parameter's enum.
const STATE_GROUPS = [
  {
    name: 'BlendState',
    enable: 'BLEND',
    params: [
      ['BLEND', 'value', 1, ['enable', 'disable'], { cap: true }],
      ['BLEND_COLOR', 'value', 1, ['blendColor']],
      ['BLEND_DST_ALPHA', 'enum', 1, ['blendFunc', 'blendFuncSeparate'], { domain: BLEND_FACTOR }],
      ['BLEND_DST_RGB', 'enum', 1, ['blendFunc', 'blendFuncSeparate'], { domain: BLEND_FACTOR }],
      ['BLEND_EQUATION', 'enum', 1, ['blendEquation', 'blendEquationSeparate']],
      ['BLEND_EQUATION_ALPHA', 'enum', 1, ['blendEquation', 'blendEquationSeparate']],
      ['BLEND_EQUATION_RGB', 'enum', 1, ['blendEquation', 'blendEquationSeparate']],
      ['BLEND_SRC_ALPHA', 'enum', 1, ['blendFunc', 'blendFuncSeparate'], { domain: BLEND_FACTOR }],
      ['BLEND_SRC_RGB', 'enum', 1, ['blendFunc', 'blendFuncSeparate'], { domain: BLEND_FACTOR }]
    ]
  },
  {
    name: 'ClearState',
    consumers: 'clear',
    params: [
      ['COLOR_CLEAR_VALUE', 'value', 1, ['clearColor']],
      ['DEPTH_CLEAR_VALUE', 'value', 1, ['clearDepth']],
      ['STENCIL_CLEAR_VALUE', 'value', 1, ['clearStencil']]
    ]
  },
  { name: 'ColorState', params: [['COLOR_WRITEMASK', 'value', 1, ['colorMask']]] },
  {
    name: 'CoverageState',
    params: [
      ['SAMPLE_COVERAGE_VALUE', 'value', 1, ['sampleCoverage']],
      ['SAMPLE_COVERAGE_INVERT', 'value', 1, ['sampleCoverage']],
      ['SAMPLE_COVERAGE', 'value', 1, ['enable', 'disable'], { cap: true }],
      ['SAMPLE_ALPHA_TO_COVERAGE', 'value', 1, ['enable', 'disable'], { cap: true }]
    ]
  },
  {
    name: 'CullState',
    enable: 'CULL_FACE',
    params: [
      ['CULL_FACE', 'value', 1, ['enable', 'disable'], { cap: true }],
      ['CULL_FACE_MODE', 'enum', 1, ['cullFace']]
    ]
  },
  {
    name: 'DepthState',
    enable: 'DEPTH_TEST',
    params: [
      ['DEPTH_TEST', 'value', 1, ['enable', 'disable'], { cap: true }],
      ['DEPTH_FUNC', 'enum', 1, ['depthFunc']],
      ['DEPTH_RANGE', 'value', 1, ['depthRange']],
      ['DEPTH_WRITEMASK', 'value', 1, ['depthMask']]
    ]
  },
  {
    name: 'DrawState',
    params: [
      ['DITHER', 'value', 1, ['enable', 'disable'], { cap: true }],
      ['VIEWPORT', 'value', 1, ['viewport']],
      ['FRONT_FACE', 'enum', 1, ['frontFace']],
      ['FRAGMENT_SHADER_DERIVATIVE_HINT_OES', 'enum', 1, ['hint'], { cap: true, extension: 'OES_standard_derivatives' }],
      ['RASTERIZER_DISCARD', 'value', 2, ['enable', 'disable'], { cap: true }],
      ['FRAGMENT_SHADER_DERIVATIVE_HINT', 'enum', 2, ['hint'], { cap: true }]
    ]
  },
  {
    name: 'PolygonOffsetState',
    enable: 'POLYGON_OFFSET_FILL',
    params: [
      ['POLYGON_OFFSET_FILL', 'value', 1, ['enable', 'disable'], { cap: true }],
      ['POLYGON_OFFSET_FACTOR', 'value', 1, ['polygonOffset']],
      ['POLYGON_OFFSET_UNITS', 'value', 1, ['polygonOffset']]
    ]
  },
  {
    name: 'ScissorState',
    consumers: 'draw-or-clear',
    enable: 'SCISSOR_TEST',
    params: [
      ['SCISSOR_TEST', 'value', 1, ['enable', 'disable'], { cap: true }],
      ['SCISSOR_BOX', 'value', 1, ['scissor']]
    ]
  },
  {
    name: 'StencilState',
    enable: 'STENCIL_TEST',
    params: [
      ['STENCIL_TEST', 'value', 1, ['enable', 'disable'], { cap: true }],
      ['STENCIL_BACK_FAIL', 'enum', 1, ['stencilOp', 'stencilOpSeparate'], { domain: STENCIL_OP }],
      ['STENCIL_BACK_FUNC', 'enum', 1, ['stencilFunc', 'stencilFuncSeparate']],
      ['STENCIL_BACK_PASS_DEPTH_FAIL', 'enum', 1, ['stencilOp', 'stencilOpSeparate'], { domain: STENCIL_OP }],
      ['STENCIL_BACK_PASS_DEPTH_PASS', 'enum', 1, ['stencilOp', 'stencilOpSeparate'], { domain: STENCIL_OP }],
      ['STENCIL_BACK_REF', 'value', 1, ['stencilFunc', 'stencilFuncSeparate']],
      ['STENCIL_BACK_VALUE_MASK', 'uint', 1, ['stencilFunc', 'stencilFuncSeparate']],
      ['STENCIL_BACK_WRITEMASK', 'uint', 1, ['stencilMask', 'stencilMaskSeparate']],
      ['STENCIL_FAIL', 'enum', 1, ['stencilOp', 'stencilOpSeparate'], { domain: STENCIL_OP }],
      ['STENCIL_FUNC', 'enum', 1, ['stencilFunc', 'stencilFuncSeparate']],
      ['STENCIL_PASS_DEPTH_FAIL', 'enum', 1, ['stencilOp', 'stencilOpSeparate'], { domain: STENCIL_OP }],
      ['STENCIL_PASS_DEPTH_PASS', 'enum', 1, ['stencilOp', 'stencilOpSeparate'], { domain: STENCIL_OP }],
      ['STENCIL_REF', 'value', 1, ['stencilFunc', 'stencilFuncSeparate']],
      ['STENCIL_VALUE_MASK', 'uint', 1, ['stencilFunc', 'stencilFuncSeparate']],
      ['STENCIL_WRITEMASK', 'uint', 1, ['stencilMask', 'stencilMaskSeparate']]
    ]
  }
].map((group) => ({
  ...group,
  params: group.params.map(([name, kind, version, changes, options = {}]) => ({ name, kind, version, changes, ...options }))
}));

const STATUS_RANK = { unused: 10, disabled: 20, redundant: 30, valid: 40 };

const PRIMITIVE_NAMES = ['POINTS', 'LINES', 'LINE_LOOP', 'LINE_STRIP', 'TRIANGLES', 'TRIANGLE_STRIP', 'TRIANGLE_FAN'];
const ENUM_ARGUMENTS = new Set([
  'target', 'textarget', 'renderbuffertarget', 'readTarget', 'writeTarget', 'type', 'format', 'internalformat',
  'pname', 'cap', 'func', 'face', 'usage', 'attachment', 'filter', 'shadertype', 'precisiontype', 'src',
  'modeRGB', 'modeAlpha', 'bufferMode'
]);
const BLEND_FACTOR_ARGUMENTS = new Set(['sfactor', 'dfactor', 'srcRGB', 'dstRGB', 'srcAlpha', 'dstAlpha']);
const STENCIL_OP_ARGUMENTS = new Set(['fail', 'zfail', 'zpass', 'sfail', 'dpfail', 'dppass']);
const BUFFER_BITS = [['COLOR_BUFFER_BIT', 0x4000], ['DEPTH_BUFFER_BIT', 0x0100], ['STENCIL_BUFFER_BIT', 0x0400]];

function isConstantName(key) {
  return /^[A-Z][A-Z0-9_]*$/.test(key);
}

function createEnumNames(context) {
  const names = new Map();
  const add = (source) => {
    for (let proto = source; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
      for (const key of Object.getOwnPropertyNames(proto)) {
        if (!isConstantName(key)) continue;
        let value;
        try {
          value = source[key];
        } catch (_) {
          continue;
        }
        if (typeof value === 'number' && !names.has(value)) names.set(value, key);
      }
    }
  };
  add(context);
  return {
    add,
    name(value, domain = null) {
      if (typeof value !== 'number') return value;
      if (domain === BLEND_FACTOR && (value === 0 || value === 1)) return value ? 'ONE' : 'ZERO';
      if (domain === STENCIL_OP && value === 0) return 'ZERO';
      if (domain === NONE_OR_ENUM && value === 0) return 'NONE';
      if (domain === 'primitive') return PRIMITIVE_NAMES[value] ?? value;
      if (value < 0x100) return value;
      return names.get(value) ?? `0x${value.toString(16)}`;
    }
  };
}

function formatBinary(value) {
  return typeof value === 'number' ? `0b${(value >>> 0).toString(2)}` : value;
}

function roundNumber(value) {
  return Number.isInteger(value) ? value : Math.round(value * 1e6) / 1e6;
}

function plainValue(value) {
  if (value == null) return value ?? null;
  if (ArrayBuffer.isView(value) || Array.isArray(value)) return Array.from(value, (entry) => plainValue(entry));
  if (typeof value === 'number') return roundNumber(value);
  if (typeof value === 'bigint') return value.toString();
  return value;
}

function capList(values) {
  if (values.length <= MAX_ARRAY_VALUES) return values;
  return [...values.slice(0, MAX_ARRAY_VALUES), `… ${values.length - MAX_ARRAY_VALUES} more`];
}

function argumentDisplay(value, type, parameterName, op, enums) {
  if (type === 'resource') return value?.ref ?? null;
  if (type === 'null') return null;
  if (type === 'readback-destination') return `${value?.arrayType ?? 'buffer'}(${value?.byteLength ?? '?'} bytes) destination`;
  if (type === 'image-source') return `${value?.kind ?? 'image'} ${value?.width ?? '?'}×${value?.height ?? '?'}`;
  if (typeof type === 'string' && type.startsWith('typed-array:')) {
    return `${type.slice(12)}(${value?.length ?? 0}) [${capList(Array.from(value ?? [], roundNumber)).join(', ')}]`;
  }
  if (type === 'data-view' || type === 'array-buffer' || type === 'shared-array-buffer') {
    return `${type}(${value?.byteLength ?? 0} bytes)`;
  }
  if (type === 'sequence') return capList((value ?? []).map((entry) => plainValue(entry)));
  if (typeof value !== 'number') return value;
  if (parameterName === 'mode' || parameterName === 'primitiveMode') {
    return op === 'hint' ? enums.name(value) : enums.name(value, 'primitive');
  }
  if (parameterName === 'mask' && (op === 'clear' || op === 'blitFramebuffer')) {
    const bits = BUFFER_BITS.filter(([, bit]) => value & bit).map(([name]) => name);
    return bits.length ? bits.join(' | ') : value;
  }
  if (parameterName === 'texture' && op === 'activeTexture') return `TEXTURE${value - 0x84c0}`;
  if (parameterName === 'buffer' && op.startsWith('clearBuffer')) return enums.name(value);
  if (BLEND_FACTOR_ARGUMENTS.has(parameterName)) return enums.name(value, BLEND_FACTOR);
  if (STENCIL_OP_ARGUMENTS.has(parameterName)) return enums.name(value, STENCIL_OP);
  if (ENUM_ARGUMENTS.has(parameterName)) return enums.name(value);
  return roundNumber(value);
}

// MDN documents several methods on a shared page (uniform*, vertexAttrib*, clearBuffer*).
function mdnPage(op) {
  if (/^uniform[1-4](?:ui|i|f)v?$/.test(op)) return 'uniform';
  if (/^uniformMatrix/.test(op)) return 'uniformMatrix';
  if (/^vertexAttribI4/.test(op)) return 'vertexAttribI';
  if (/^vertexAttrib[1-4]f/.test(op)) return 'vertexAttrib';
  if (/^clearBuffer/.test(op)) return 'clearBuffer';
  return op;
}

function mdnLink(op) {
  const root = 'https://developer.mozilla.org/en-US/docs/Web/API/';
  if (op.endsWith('ANGLE')) return `${root}ANGLE_instanced_arrays/${op}`;
  if (op.endsWith('OES')) return `${root}OES_vertex_array_object/${op}`;
  if (op.endsWith('WEBGL')) return null;
  const webgl1 = typeof WebGLRenderingContext !== 'undefined' && typeof WebGLRenderingContext.prototype[op] === 'function';
  const webgl2 = typeof WebGL2RenderingContext !== 'undefined' && typeof WebGL2RenderingContext.prototype[op] === 'function';
  if (!webgl1 && !webgl2) return null;
  return `${root}${webgl1 ? 'WebGLRenderingContext' : 'WebGL2RenderingContext'}/${mdnPage(op)}`;
}

function captureStack() {
  const stack = new Error().stack ?? '';
  return stack
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line && !line.includes('chrome-extension://'))
    .slice(0, MAX_STACK_FRAMES);
}

function shaderName(source) {
  return /^[ \t]*#define[ \t]+SHADER_NAME[ \t]+(\S.*)$/m.exec(source ?? '')?.[1]?.trim() ?? null;
}

export function createEventDetailsRecorder(context, { version, enabledExtensions, describeTexture, getProgramLabel } = {}) {
  const gl = context;
  const enums = createEnumNames(context);
  const ref = (object) => (object ? resolveWebGlObjectId(context, object) : null);
  const extension = (name) => enabledExtensions?.get(name) ?? null;

  const paramEnum = (param) => {
    if (param.extension) return extension(param.extension)?.[param.name];
    return gl[param.name];
  };
  const available = (param) => param.version <= version && typeof paramEnum(param) === 'number';

  const changeIndex = new Map();
  for (const group of STATE_GROUPS) {
    for (const param of group.params) {
      for (const op of param.changes) {
        const list = changeIndex.get(op) ?? [];
        list.push({ group, param });
        changeIndex.set(op, list);
      }
    }
  }

  let pendingChanges = new Map();
  // Buffer reads stall until the GPU has caught up, so draw-time samples are queued and read in
  // one batch: before the next command that can modify a buffer, or at the end of the frame.
  let pendingSamples = [];
  const programLayouts = new Map();
  let samplers = null;
  let previousState = new Map();
  const programSources = new Map();

  function readParam(param) {
    const value = gl.getParameter(paramEnum(param));
    if (param.kind === 'enum') return enums.name(value, param.domain ?? null);
    if (param.kind === 'uint') return formatBinary(value);
    return plainValue(value);
  }

  function groupsFor(op) {
    const kind = webGlEventKind(op);
    return STATE_GROUPS.filter((group) => {
      if (group.consumers === 'clear') return op === 'clear';
      if (group.consumers === 'draw-or-clear') return kind === 'draw' || op === 'clear';
      return kind === 'draw';
    });
  }

  function noteCommand(op, values, commandIndex) {
    if (op === 'linkProgram' || op === 'deleteProgram') programLayouts.delete(values?.[0]);
    const targets = changeIndex.get(op);
    if (!targets) return;
    for (const { param } of targets) {
      if (!available(param)) continue;
      if (param.cap && values?.[0] !== paramEnum(param)) continue;
      const list = pendingChanges.get(param.name) ?? [];
      list.push(commandIndex);
      pendingChanges.set(param.name, list);
    }
  }

  function classifyGroup(group, entries, setStatus) {
    const enabled = group.enable ? Boolean(gl.isEnabled(gl[group.enable])) : true;
    const commands = { valid: [], redundant: [], disabled: [] };
    const mark = (commandIndex, status) => {
      setStatus(commandIndex, status);
      if (!commands[status].includes(commandIndex)) commands[status].push(commandIndex);
    };
    for (const param of group.params) {
      const pending = pendingChanges.get(param.name);
      if (!pending?.length) continue;
      pendingChanges.delete(param.name);
      for (const commandIndex of pending.slice(0, -1)) mark(commandIndex, 'redundant');
      const last = pending[pending.length - 1];
      const unchanged = previousState.has(param.name) &&
        JSON.stringify(previousState.get(param.name)) === JSON.stringify(entries[param.name]);
      mark(last, unchanged ? 'redundant' : enabled ? 'valid' : 'disabled');
    }
    for (const param of group.params) {
      if (param.name in entries) previousState.set(param.name, entries[param.name]);
    }
    return commands;
  }

  function readStateGroups(op, setStatus) {
    return groupsFor(op).map((group) => {
      const entries = {};
      for (const param of group.params) {
        if (param.extension && param.version <= version && !extension(param.extension)) {
          entries[param.name] = `Extension ${param.extension} is unavailable.`;
          continue;
        }
        if (!available(param)) continue;
        entries[param.name] = readParam(param);
      }
      const commands = classifyGroup(group, entries, setStatus);
      return { name: group.name, entries, commands };
    });
  }

  function readRenderbuffer(renderbuffer) {
    const previous = gl.getParameter(gl.RENDERBUFFER_BINDING);
    try {
      gl.bindRenderbuffer(gl.RENDERBUFFER, renderbuffer);
      const info = {
        width: gl.getRenderbufferParameter(gl.RENDERBUFFER, gl.RENDERBUFFER_WIDTH),
        height: gl.getRenderbufferParameter(gl.RENDERBUFFER, gl.RENDERBUFFER_HEIGHT),
        internalFormat: enums.name(gl.getRenderbufferParameter(gl.RENDERBUFFER, gl.RENDERBUFFER_INTERNAL_FORMAT))
      };
      if (version > 1) info.msaaSamples = gl.getRenderbufferParameter(gl.RENDERBUFFER, gl.RENDERBUFFER_SAMPLES);
      return info;
    } finally {
      gl.bindRenderbuffer(gl.RENDERBUFFER, previous);
    }
  }

  function readAttachment(name, attachment, { color = false } = {}) {
    const target = gl.FRAMEBUFFER;
    const type = gl.getFramebufferAttachmentParameter(target, attachment, gl.FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE);
    if (type === gl.NONE) return null;
    const object = gl.getFramebufferAttachmentParameter(target, attachment, gl.FRAMEBUFFER_ATTACHMENT_OBJECT_NAME);
    const state = { attachment: name };
    if (type === gl.RENDERBUFFER) {
      state.type = 'RENDERBUFFER';
      state.renderbuffer = ref(object);
      if (object) Object.assign(state, readRenderbuffer(object));
    } else if (type === gl.TEXTURE) {
      state.type = 'TEXTURE';
      state.texture = ref(object);
      state.textureLevel = gl.getFramebufferAttachmentParameter(target, attachment, gl.FRAMEBUFFER_ATTACHMENT_TEXTURE_LEVEL);
      state.textureCubeMapFace = enums.name(
        gl.getFramebufferAttachmentParameter(target, attachment, gl.FRAMEBUFFER_ATTACHMENT_TEXTURE_CUBE_MAP_FACE),
        NONE_OR_ENUM
      );
      if (version > 1) {
        state.textureLayer = gl.getFramebufferAttachmentParameter(target, attachment, gl.FRAMEBUFFER_ATTACHMENT_TEXTURE_LAYER);
      }
      const described = object ? describeTexture?.(object) : null;
      if (described) Object.assign(state, described);
    }
    const srgb = extension('EXT_sRGB');
    if (color && version === 1 && srgb) {
      state.encoding = enums.name(
        gl.getFramebufferAttachmentParameter(target, attachment, srgb.FRAMEBUFFER_ATTACHMENT_COLOR_ENCODING_EXT)
      );
    }
    if (version > 1) {
      for (const [key, pname] of [
        ['redSize', 'FRAMEBUFFER_ATTACHMENT_RED_SIZE'],
        ['greenSize', 'FRAMEBUFFER_ATTACHMENT_GREEN_SIZE'],
        ['blueSize', 'FRAMEBUFFER_ATTACHMENT_BLUE_SIZE'],
        ['alphaSize', 'FRAMEBUFFER_ATTACHMENT_ALPHA_SIZE'],
        ['depthSize', 'FRAMEBUFFER_ATTACHMENT_DEPTH_SIZE'],
        ['stencilSize', 'FRAMEBUFFER_ATTACHMENT_STENCIL_SIZE']
      ]) {
        state[key] = gl.getFramebufferAttachmentParameter(target, attachment, gl[pname]);
      }
      state.componentType = enums.name(
        gl.getFramebufferAttachmentParameter(target, attachment, gl.FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE)
      );
      if (color) {
        state.encoding = enums.name(
          gl.getFramebufferAttachmentParameter(target, attachment, gl.FRAMEBUFFER_ATTACHMENT_COLOR_ENCODING)
        );
      }
    }
    return state;
  }

  function colorAttachmentEnums() {
    const drawBuffers = extension('WEBGL_draw_buffers');
    if (version === 1 && drawBuffers) {
      const count = gl.getParameter(drawBuffers.MAX_DRAW_BUFFERS_WEBGL);
      return Array.from({ length: count }, (_, index) => [`COLOR_ATTACHMENT${index}_WEBGL`, drawBuffers.COLOR_ATTACHMENT0_WEBGL + index]);
    }
    if (version > 1) {
      const count = Math.min(gl.getParameter(gl.MAX_DRAW_BUFFERS), gl.getParameter(gl.MAX_COLOR_ATTACHMENTS));
      return Array.from({ length: count }, (_, index) => [`COLOR_ATTACHMENT${index}`, gl.COLOR_ATTACHMENT0 + index]);
    }
    return [['COLOR_ATTACHMENT0', gl.COLOR_ATTACHMENT0]];
  }

  function readFramebuffer() {
    const framebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    if (!framebuffer) {
      return { frameBuffer: null, target: 'canvas', width: gl.drawingBufferWidth, height: gl.drawingBufferHeight };
    }
    const state = {
      frameBuffer: ref(framebuffer),
      status: enums.name(gl.checkFramebufferStatus(gl.FRAMEBUFFER)),
      colorAttachments: [],
      depthAttachment: null,
      stencilAttachment: null
    };
    for (const [name, attachment] of colorAttachmentEnums()) {
      const read = readAttachment(name, attachment, { color: true });
      if (read) state.colorAttachments.push(read);
    }
    state.depthAttachment = readAttachment('DEPTH_ATTACHMENT', gl.DEPTH_ATTACHMENT);
    state.stencilAttachment = readAttachment('STENCIL_ATTACHMENT', gl.STENCIL_ATTACHMENT);
    if (version === 1 && !state.depthAttachment && !state.stencilAttachment) {
      state.depthStencilAttachment = readAttachment('DEPTH_STENCIL_ATTACHMENT', gl.DEPTH_STENCIL_ATTACHMENT);
    }
    return state;
  }

  function readProgram(program) {
    const status = {
      program: ref(program),
      label: getProgramLabel?.(program) ?? null,
      LINK_STATUS: gl.getProgramParameter(program, gl.LINK_STATUS),
      VALIDATE_STATUS: gl.getProgramParameter(program, gl.VALIDATE_STATUS),
      DELETE_STATUS: gl.getProgramParameter(program, gl.DELETE_STATUS),
      ATTACHED_SHADERS: gl.getProgramParameter(program, gl.ATTACHED_SHADERS),
      ACTIVE_ATTRIBUTES: gl.getProgramParameter(program, gl.ACTIVE_ATTRIBUTES),
      ACTIVE_UNIFORMS: gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS)
    };
    if (version > 1) {
      status.ACTIVE_UNIFORM_BLOCKS = gl.getProgramParameter(program, gl.ACTIVE_UNIFORM_BLOCKS);
      status.TRANSFORM_FEEDBACK_BUFFER_MODE = enums.name(gl.getProgramParameter(program, gl.TRANSFORM_FEEDBACK_BUFFER_MODE));
      status.TRANSFORM_FEEDBACK_VARYINGS = gl.getProgramParameter(program, gl.TRANSFORM_FEEDBACK_VARYINGS);
    }
    const shaders = (gl.getAttachedShaders(program) ?? []).map((shader) => {
      const type = gl.getShaderParameter(shader, gl.SHADER_TYPE);
      return {
        shader: ref(shader),
        shaderType: enums.name(type),
        type: type === gl.VERTEX_SHADER ? 'vertex' : type === gl.FRAGMENT_SHADER ? 'fragment' : enums.name(type),
        COMPILE_STATUS: gl.getShaderParameter(shader, gl.COMPILE_STATUS),
        DELETE_STATUS: gl.getShaderParameter(shader, gl.DELETE_STATUS),
        object: shader
      };
    });
    const programRef = status.program;
    if (programRef && !programSources.has(programRef)) {
      programSources.set(programRef, {
        label: status.label,
        attributeCount: status.ACTIVE_ATTRIBUTES,
        shaders: shaders.map(({ type, object }) => ({ type, source: gl.getShaderSource(object) ?? '' }))
      });
    }
    const sources = programSources.get(programRef)?.shaders ?? [];
    return {
      programStatus: status,
      shaders: shaders.map(({ object, ...shader }, index) => ({ ...shader, name: shaderName(sources[index]?.source) }))
    };
  }

  // Buffer contents are only readable on WebGL2 (getBufferSubData). COPY_READ_BUFFER accepts
  // every buffer, including element-array buffers, and its binding is restored afterwards.
  function readBufferBytes(buffer, offset, length) {
    if (version < 2 || !buffer || length <= 0 || gl.getParameter(gl.TRANSFORM_FEEDBACK_ACTIVE)) return null;
    const previous = gl.getParameter(gl.COPY_READ_BUFFER_BINDING);
    gl.bindBuffer(gl.COPY_READ_BUFFER, buffer);
    try {
      const size = gl.getBufferParameter(gl.COPY_READ_BUFFER, gl.BUFFER_SIZE);
      if (!(offset < size)) return null;
      const bytes = new Uint8Array(Math.min(length, size - offset));
      gl.getBufferSubData(gl.COPY_READ_BUFFER, offset, bytes);
      return bytes;
    } finally {
      gl.bindBuffer(gl.COPY_READ_BUFFER, previous);
    }
  }

  function decodeAttribute(bytes, { reader, stride, elementBytes, arraySize, normalized }) {
    const view = new DataView(bytes.buffer);
    const values = [];
    for (let vertex = 0; vertex < SAMPLE_VERTICES; vertex++) {
      const base = vertex * stride;
      if (base + elementBytes > bytes.byteLength) break;
      const components = [];
      for (let component = 0; component < arraySize; component++) {
        components.push(roundNumber(readComponent(view, base + component * reader[1], reader, normalized)));
      }
      values.push(components);
    }
    return values;
  }

  function sampleAttribute(state, buffer, firstVertex) {
    const reader = COMPONENT_READERS[state.arrayType];
    if (!reader || !state.enabled) return undefined;
    if (version < 2) return { unavailable: 'Buffer contents cannot be read back on WebGL1' };
    const elementBytes = reader[1] * state.arraySize;
    const stride = state.stride || elementBytes;
    const sample = { firstVertex, values: [] };
    const layout = { reader, stride, elementBytes, arraySize: state.arraySize, normalized: state.normalized };
    pendingSamples.push({
      buffer,
      offset: state.offsetPointer + stride * firstVertex,
      length: stride * (SAMPLE_VERTICES - 1) + elementBytes,
      apply: (bytes) => {
        sample.values = decodeAttribute(bytes, layout);
      }
    });
    return sample;
  }

  function sampleIndices(op, values) {
    const names = parameterNamesFor(op, values.length) ?? [];
    const type = values[names.indexOf('type')];
    const offset = values[names.indexOf('offset')] ?? 0;
    const reader = INDEX_TYPES[type];
    if (!reader) return undefined;
    if (version < 2) return { unavailable: 'Buffer contents cannot be read back on WebGL1' };
    const sample = { offset, type: enums.name(type), values: [] };
    pendingSamples.push({
      buffer: gl.getParameter(gl.ELEMENT_ARRAY_BUFFER_BINDING),
      offset,
      length: reader[1] * SAMPLE_INDICES,
      apply: (bytes) => {
        const view = new DataView(bytes.buffer);
        for (let at = 0; at + reader[1] <= bytes.byteLength; at += reader[1]) sample.values.push(view[reader[0]](at, true));
      }
    });
    return sample;
  }

  function flushSamples() {
    const pending = pendingSamples;
    pendingSamples = [];
    const reads = new Map();
    for (const request of pending) {
      const key = request.buffer;
      const range = `${request.offset}:${request.length}`;
      let perBuffer = reads.get(key);
      if (!perBuffer) reads.set(key, (perBuffer = new Map()));
      if (!perBuffer.has(range)) perBuffer.set(range, readBufferBytes(request.buffer, request.offset, request.length));
      const bytes = perBuffer.get(range);
      if (bytes) request.apply(bytes);
    }
  }

  // Active attribute/uniform names, types and locations only change when a program is relinked.
  function programLayout(program) {
    let layout = programLayouts.get(program);
    if (layout) return layout;
    const attributes = Array.from({ length: gl.getProgramParameter(program, gl.ACTIVE_ATTRIBUTES) }, (_, index) => {
      const info = gl.getActiveAttrib(program, index);
      return { info, location: gl.getAttribLocation(program, info.name) };
    });
    const uniforms = Array.from({ length: gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) }, (_, index) => {
      const info = gl.getActiveUniform(program, index);
      const isArray = info.size > 1 && info.name.endsWith('[0]');
      const name = isArray ? info.name.slice(0, -3) : info.name;
      const location = gl.getUniformLocation(program, info.name);
      const elements = isArray && location
        ? Array.from({ length: Math.min(info.size, MAX_ARRAY_VALUES) }, (_, element) => gl.getUniformLocation(program, `${name}[${element}]`))
        : null;
      return { info, isArray, name, location, elements };
    });
    layout = { attributes, uniforms };
    programLayouts.set(program, layout);
    return layout;
  }

  function readAttribute({ info, location }, firstVertex) {
    const state = { name: info.name, size: info.size, type: enums.name(info.type), location };
    if (location < 0) return state;
    Object.assign(state, {
      enabled: gl.getVertexAttrib(location, gl.VERTEX_ATTRIB_ARRAY_ENABLED),
      bufferBinding: ref(gl.getVertexAttrib(location, gl.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING)),
      arraySize: gl.getVertexAttrib(location, gl.VERTEX_ATTRIB_ARRAY_SIZE),
      arrayType: enums.name(gl.getVertexAttrib(location, gl.VERTEX_ATTRIB_ARRAY_TYPE)),
      normalized: gl.getVertexAttrib(location, gl.VERTEX_ATTRIB_ARRAY_NORMALIZED),
      stride: gl.getVertexAttrib(location, gl.VERTEX_ATTRIB_ARRAY_STRIDE),
      offsetPointer: gl.getVertexAttribOffset(location, gl.VERTEX_ATTRIB_ARRAY_POINTER),
      vertexAttrib: plainValue(gl.getVertexAttrib(location, gl.CURRENT_VERTEX_ATTRIB))
    });
    const buffer = gl.getVertexAttrib(location, gl.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING);
    const instancing = extension('ANGLE_instanced_arrays');
    if (version > 1) {
      state.integer = gl.getVertexAttrib(location, gl.VERTEX_ATTRIB_ARRAY_INTEGER);
      state.divisor = gl.getVertexAttrib(location, gl.VERTEX_ATTRIB_ARRAY_DIVISOR);
    } else if (instancing) {
      state.divisor = gl.getVertexAttrib(location, instancing.VERTEX_ATTRIB_ARRAY_DIVISOR_ANGLE);
    }
    if (buffer) state.sample = sampleAttribute(state, buffer, state.divisor ? 0 : firstVertex);
    return state;
  }

  function samplerTargets() {
    const targets = new Map([
      [gl.SAMPLER_2D, ['TEXTURE_2D', 'TEXTURE_BINDING_2D']],
      [gl.SAMPLER_CUBE, ['TEXTURE_CUBE_MAP', 'TEXTURE_BINDING_CUBE_MAP']]
    ]);
    if (version > 1) {
      for (const [sampler, target] of [
        ['SAMPLER_3D', '3D'], ['SAMPLER_2D_SHADOW', '2D'], ['SAMPLER_2D_ARRAY', '2D_ARRAY'],
        ['SAMPLER_2D_ARRAY_SHADOW', '2D_ARRAY'], ['SAMPLER_CUBE_SHADOW', 'CUBE_MAP'], ['INT_SAMPLER_2D', '2D'],
        ['INT_SAMPLER_3D', '3D'], ['INT_SAMPLER_CUBE', 'CUBE_MAP'], ['INT_SAMPLER_2D_ARRAY', '2D_ARRAY'],
        ['UNSIGNED_INT_SAMPLER_2D', '2D'], ['UNSIGNED_INT_SAMPLER_3D', '3D'],
        ['UNSIGNED_INT_SAMPLER_CUBE', 'CUBE_MAP'], ['UNSIGNED_INT_SAMPLER_2D_ARRAY', '2D_ARRAY']
      ]) {
        targets.set(gl[sampler], [`TEXTURE_${target}`, `TEXTURE_BINDING_${target}`]);
      }
    }
    return targets;
  }

  function readTexture(unit, [targetName, bindingName]) {
    const previousUnit = gl.getParameter(gl.ACTIVE_TEXTURE);
    gl.activeTexture(gl.TEXTURE0 + unit);
    try {
      const target = gl[targetName];
      const texture = gl.getParameter(gl[bindingName]);
      const state = { unit, target: targetName, texture: ref(texture) };
      if (!texture) return state;
      const texParam = (pname) => gl.getTexParameter(target, pname);
      Object.assign(state, {
        magFilter: enums.name(texParam(gl.TEXTURE_MAG_FILTER)),
        minFilter: enums.name(texParam(gl.TEXTURE_MIN_FILTER)),
        wrapS: enums.name(texParam(gl.TEXTURE_WRAP_S)),
        wrapT: enums.name(texParam(gl.TEXTURE_WRAP_T))
      });
      const anisotropic = extension('EXT_texture_filter_anisotropic');
      if (anisotropic) state.anisotropy = texParam(anisotropic.TEXTURE_MAX_ANISOTROPY_EXT);
      if (version > 1) {
        Object.assign(state, {
          baseLevel: texParam(gl.TEXTURE_BASE_LEVEL),
          maxLevel: texParam(gl.TEXTURE_MAX_LEVEL),
          immutable: texParam(gl.TEXTURE_IMMUTABLE_FORMAT),
          immutableLevels: texParam(gl.TEXTURE_IMMUTABLE_LEVELS)
        });
        const sampler = gl.getParameter(gl.SAMPLER_BINDING);
        if (sampler) {
          const samplerParam = (pname) => gl.getSamplerParameter(sampler, pname);
          Object.assign(state, {
            sampler: ref(sampler),
            samplerMagFilter: enums.name(samplerParam(gl.TEXTURE_MAG_FILTER)),
            samplerMinFilter: enums.name(samplerParam(gl.TEXTURE_MIN_FILTER)),
            samplerWrapS: enums.name(samplerParam(gl.TEXTURE_WRAP_S)),
            samplerWrapT: enums.name(samplerParam(gl.TEXTURE_WRAP_T)),
            samplerWrapR: enums.name(samplerParam(gl.TEXTURE_WRAP_R)),
            samplerMinLod: samplerParam(gl.TEXTURE_MIN_LOD),
            samplerMaxLod: samplerParam(gl.TEXTURE_MAX_LOD),
            samplerCompareMode: enums.name(samplerParam(gl.TEXTURE_COMPARE_MODE), NONE_OR_ENUM),
            samplerCompareFunc: enums.name(samplerParam(gl.TEXTURE_COMPARE_FUNC))
          });
        } else {
          Object.assign(state, {
            wrapR: enums.name(texParam(gl.TEXTURE_WRAP_R)),
            minLod: texParam(gl.TEXTURE_MIN_LOD),
            maxLod: texParam(gl.TEXTURE_MAX_LOD),
            compareMode: enums.name(texParam(gl.TEXTURE_COMPARE_MODE), NONE_OR_ENUM),
            compareFunc: enums.name(texParam(gl.TEXTURE_COMPARE_FUNC))
          });
        }
      }
      const described = describeTexture?.(texture);
      if (described) Object.assign(state, described);
      return state;
    } finally {
      gl.activeTexture(previousUnit);
    }
  }

  function readUniform(program, { info, isArray, name, location, elements }) {
    const state = { name, size: info.size, type: enums.name(info.type) };
    if (!location) return state;
    let units;
    if (isArray) {
      const values = [];
      for (const elementLocation of elements) {
        if (elementLocation) values.push(plainValue(gl.getUniform(program, elementLocation)));
      }
      if (info.size > MAX_ARRAY_VALUES) values.push(`… ${info.size - MAX_ARRAY_VALUES} more`);
      state.values = values;
      units = values.filter((value) => typeof value === 'number');
    } else {
      state.value = plainValue(gl.getUniform(program, location));
      units = [state.value];
    }
    const target = samplers.get(info.type);
    if (target) state.textures = units.map((unit) => readTexture(unit, target));
    return state;
  }

  function readUniformBlocks(program, uniforms) {
    const blockCount = gl.getProgramParameter(program, gl.ACTIVE_UNIFORM_BLOCKS);
    const blocks = [];
    for (let index = 0; index < blockCount; index++) {
      const bindingPoint = gl.getActiveUniformBlockParameter(program, index, gl.UNIFORM_BLOCK_BINDING);
      blocks.push({
        name: gl.getActiveUniformBlockName(program, index),
        bindingPoint,
        size: gl.getActiveUniformBlockParameter(program, index, gl.UNIFORM_BLOCK_DATA_SIZE),
        activeUniformCount: gl.getActiveUniformBlockParameter(program, index, gl.UNIFORM_BLOCK_ACTIVE_UNIFORMS),
        vertex: gl.getActiveUniformBlockParameter(program, index, gl.UNIFORM_BLOCK_REFERENCED_BY_VERTEX_SHADER),
        fragment: gl.getActiveUniformBlockParameter(program, index, gl.UNIFORM_BLOCK_REFERENCED_BY_FRAGMENT_SHADER),
        buffer: ref(gl.getIndexedParameter(gl.UNIFORM_BUFFER_BINDING, bindingPoint))
      });
    }
    if (uniforms.length) {
      const indices = uniforms.map((_, index) => index);
      const layout = (pname) => gl.getActiveUniforms(program, indices, pname);
      const blockIndices = layout(gl.UNIFORM_BLOCK_INDEX);
      const offsets = layout(gl.UNIFORM_OFFSET);
      const arrayStrides = layout(gl.UNIFORM_ARRAY_STRIDE);
      const matrixStrides = layout(gl.UNIFORM_MATRIX_STRIDE);
      const rowMajors = layout(gl.UNIFORM_IS_ROW_MAJOR);
      uniforms.forEach((uniform, index) => {
        if (blockIndices[index] < 0) return;
        Object.assign(uniform, {
          blockName: blocks[blockIndices[index]]?.name ?? null,
          offset: offsets[index],
          arrayStride: arrayStrides[index],
          matrixStride: matrixStrides[index],
          rowMajor: rowMajors[index]
        });
      });
    }
    return blocks;
  }

  function readTransformFeedback(program) {
    if (!gl.getParameter(gl.TRANSFORM_FEEDBACK_ACTIVE)) return null;
    const count = gl.getProgramParameter(program, gl.TRANSFORM_FEEDBACK_VARYINGS);
    const varyings = [];
    for (let index = 0; index < count; index++) {
      const info = gl.getTransformFeedbackVarying(program, index);
      varyings.push({
        name: info.name,
        size: info.size,
        type: enums.name(info.type),
        buffer: ref(gl.getIndexedParameter(gl.TRANSFORM_FEEDBACK_BUFFER_BINDING, index)),
        bufferStart: plainValue(gl.getIndexedParameter(gl.TRANSFORM_FEEDBACK_BUFFER_START, index)),
        bufferSize: plainValue(gl.getIndexedParameter(gl.TRANSFORM_FEEDBACK_BUFFER_SIZE, index))
      });
    }
    return { mode: enums.name(gl.getProgramParameter(program, gl.TRANSFORM_FEEDBACK_BUFFER_MODE)), varyings };
  }

  function readDrawCall(op, values) {
    const program = gl.getParameter(gl.CURRENT_PROGRAM);
    if (!program) return null;
    const drawCall = readProgram(program);
    let firstVertex = 0;
    if (op.includes('Elements')) {
      drawCall.elementArray = ref(gl.getParameter(gl.ELEMENT_ARRAY_BUFFER_BINDING));
      drawCall.indexSample = sampleIndices(op, values);
    } else {
      const names = parameterNamesFor(op, values.length) ?? [];
      firstVertex = Number.isInteger(values[names.indexOf('first')]) ? values[names.indexOf('first')] : 0;
    }
    const layout = programLayout(program);
    drawCall.attributes = layout.attributes.map((attribute) => readAttribute(attribute, firstVertex));
    samplers ??= samplerTargets();
    drawCall.uniforms = layout.uniforms.map((uniform) => readUniform(program, uniform));
    if (version > 1) {
      drawCall.uniformBlocks = readUniformBlocks(program, drawCall.uniforms);
      drawCall.transformFeedback = readTransformFeedback(program);
    }
    return drawCall;
  }

  function commandSection(op, values, types, encodedArgs) {
    const names = parameterNamesFor(op, values.length);
    return {
      name: op,
      help: mdnLink(op),
      arguments: values.map((value, index) => {
        const name = names?.[index] ?? `arg${index}`;
        const display = types[index] === 'resource' ? encodedArgs?.[index] : value;
        return { name, value: argumentDisplay(display, types[index], name, op, enums) };
      })
    };
  }

  return {
    get programSources() {
      return programSources;
    },
    addExtension(object) {
      enums.add(object);
    },
    noteCommand,
    captureStack,
    consume({ op, values, types, encodedArgs, stackTrace }, setStatus) {
      const details = { command: commandSection(op, values ?? [], types ?? [], encodedArgs), stackTrace };
      try {
        details.states = readStateGroups(op, setStatus);
        details.frameBuffer = readFramebuffer();
        if (webGlEventKind(op) === 'draw') details.drawCall = readDrawCall(op, values ?? []);
      } catch (error) {
        details.error = `Details capture failed: ${error?.message ?? error}`;
      }
      return details;
    },
    flushSamples,
    beginFrame() {
      pendingSamples = [];
      pendingChanges = new Map();
      previousState = new Map();
      programSources.clear();
      for (const group of STATE_GROUPS) {
        for (const param of group.params) {
          if (available(param)) previousState.set(param.name, readParam(param));
        }
      }
    },
    finishFrame(setStatus) {
      flushSamples();
      for (const pending of pendingChanges.values()) {
        for (const commandIndex of pending) setStatus(commandIndex, 'unused');
      }
      pendingChanges = new Map();
    }
  };
}

export function mergeCommandStatus(current, next) {
  return (STATUS_RANK[next] ?? 0) > (STATUS_RANK[current] ?? 0) ? next : current;
}
