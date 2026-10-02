import { canonicalizeImageSource, isImageSource } from './canonicalize.js';

const ARRAY_BUFFER = 'array-buffer';
const DATA_VIEW = 'data-view';
const IMAGE_SOURCE = 'image-source';
const READBACK_DESTINATION = 'readback-destination';
const RESOURCE = 'resource';
const SEQUENCE = 'sequence';
const SHARED_ARRAY_BUFFER = 'shared-array-buffer';

const GL_UNPACK_FLIP_Y_WEBGL = 0x9240;
const GL_UNPACK_PREMULTIPLY_ALPHA_WEBGL = 0x9241;
const GL_UNPACK_COLORSPACE_CONVERSION_WEBGL = 0x9243;
const GL_BROWSER_DEFAULT_WEBGL = 0x9244;
const GL_RGBA = 0x1908;
const GL_UNSIGNED_BYTE = 0x1401;

function queryUnpackState(nativeGetParameter) {
  const state = {
    flipY: false,
    premultiplyAlpha: false,
    colorSpaceConversion: GL_BROWSER_DEFAULT_WEBGL
  };
  if (typeof nativeGetParameter !== 'function') return state;
  const queries = [
    [GL_UNPACK_FLIP_Y_WEBGL, 'flipY'],
    [GL_UNPACK_PREMULTIPLY_ALPHA_WEBGL, 'premultiplyAlpha'],
    [GL_UNPACK_COLORSPACE_CONVERSION_WEBGL, 'colorSpaceConversion']
  ];
  for (const [pname, key] of queries) {
    try {
      state[key] = nativeGetParameter(pname);
    } catch (_) {
      state[key] = key === 'colorSpaceConversion' ? GL_BROWSER_DEFAULT_WEBGL : false;
    }
  }
  return state;
}

const SEQUENCE_ELEMENT_TYPES = new Set(['number', 'boolean', 'string', 'undefined']);
const SIGNATURE_TYPES = new Set(['undefined', 'number', 'boolean', 'string']);

const TYPED_ARRAY_TAGS = new Map([
  ['[object Int8Array]', Int8Array],
  ['[object Uint8Array]', Uint8Array],
  ['[object Uint8ClampedArray]', Uint8ClampedArray],
  ['[object Int16Array]', Int16Array],
  ['[object Uint16Array]', Uint16Array],
  ['[object Int32Array]', Int32Array],
  ['[object Uint32Array]', Uint32Array],
  ['[object Float32Array]', Float32Array],
  ['[object Float64Array]', Float64Array]
]);

function tagOf(value) {
  return Object.prototype.toString.call(value);
}

function isDataView(value) {
  return tagOf(value) === '[object DataView]';
}

function viewInfo(value) {
  const tag = tagOf(value);
  const ArrayType = TYPED_ARRAY_TAGS.get(tag);
  if (ArrayType) return { name: ArrayType.name, ArrayType };
  if (isDataView(value)) return { name: 'DataView' };
  return null;
}

function bufferKind(value) {
  const tag = tagOf(value);
  if (tag === '[object ArrayBuffer]') return ARRAY_BUFFER;
  if (tag === '[object SharedArrayBuffer]') return SHARED_ARRAY_BUFFER;
  return null;
}

function isDetached(buffer) {
  if (bufferKind(buffer) !== ARRAY_BUFFER) return false;
  return 'detached' in ArrayBuffer.prototype ? buffer.detached : false;
}

function copyBytes(buffer, byteOffset, byteLength, descriptor, index) {
  if (isDetached(buffer)) {
    throw new TypeError(`${descriptor.name} argument ${index} is backed by a detached buffer`);
  }
  try {
    return new Uint8Array(buffer, byteOffset, byteLength).slice();
  } catch (error) {
    throw new TypeError(
      `${descriptor.name} argument ${index} is backed by an unreadable buffer: ${error.message}`
    );
  }
}

function copyView(view, descriptor, index) {
  const bytes = copyBytes(view.buffer, view.byteOffset, view.byteLength, descriptor, index);
  if (isDataView(view)) return new DataView(bytes.buffer);
  const ArrayType = TYPED_ARRAY_TAGS.get(tagOf(view));
  if (!ArrayType) throw new TypeError(`${descriptor.name} argument ${index} is an unrecognized ArrayBuffer view`);
  return new ArrayType(bytes.buffer);
}

function copyBuffer(buffer, descriptor, index) {
  return copyBytes(buffer, 0, buffer.byteLength, descriptor, index).buffer;
}

function copySequence(sequence, descriptor, index) {
  return sequence.map((element) => {
    if (element === null || SEQUENCE_ELEMENT_TYPES.has(typeof element)) return element;
    throw new TypeError(`${descriptor.name} argument ${index} contains an unsupported object element`);
  });
}

function snapshotImageSource(context, value, index, descriptor, args, nativeGetParameter) {
  let format;
  let type;
  if (descriptor.name === 'texImage2D' && args.length === 6) {
    format = args[3];
    type = args[4];
  } else if (descriptor.name === 'texSubImage2D' && args.length === 7) {
    format = args[4];
    type = args[5];
  } else {
    throw new TypeError(`${descriptor.name} argument ${index}: DOM image-source overload is unsupported`);
  }
  if (format !== GL_RGBA || type !== GL_UNSIGNED_BYTE) {
    throw new TypeError(
      `${descriptor.name} argument ${index}: DOM image-source capture requires RGBA/UNSIGNED_BYTE`
    );
  }
  try {
    const canonical = canonicalizeImageSource(value, {
      unpackColorSpaceName: context?.unpackColorSpace,
      ...queryUnpackState(nativeGetParameter)
    });
    return { type: IMAGE_SOURCE, value: canonical };
  } catch (error) {
    throw new TypeError(`${descriptor.name} argument ${index}: ${error.message}`);
  }
}

function snapshotArgument(context, value, index, descriptor, isReadback, args, nativeGetParameter) {
  if (value === null) return { type: 'null', value: null };

  const primitive = typeof value;
  if (SIGNATURE_TYPES.has(primitive)) return { type: primitive, value };

  if (ArrayBuffer.isView(value)) {
    const info = viewInfo(value);
    if (!info) {
      throw new TypeError(`${descriptor.name} argument ${index} is an unrecognized ArrayBuffer view`);
    }
    if (isReadback) {
      return {
        type: READBACK_DESTINATION,
        value: { arrayType: info.name, byteLength: value.byteLength }
      };
    }
    if (isDataView(value)) return { type: DATA_VIEW, value: copyView(value, descriptor, index) };
    return { type: `typed-array:${info.name}`, value: copyView(value, descriptor, index) };
  }

  const buffer = bufferKind(value);
  if (buffer) return { type: buffer, value: copyBuffer(value, descriptor, index) };

  if (Array.isArray(value)) return { type: SEQUENCE, value: copySequence(value, descriptor, index) };

  if (isImageSource(value)) {
    return snapshotImageSource(context, value, index, descriptor, args, nativeGetParameter);
  }

  if (descriptor.argResourceIndexes.includes(index)) return { type: RESOURCE, value };

  throw new TypeError(`${descriptor.name} received an unsupported object argument at index ${index}`);
}

/**
 * Copies every mutable input before the native command runs and records the exact
 * argument signature, so overloads that differ only by arity or argument type stay
 * distinguishable after the journal is serialized. `nativeGetParameter` must be the
 * unwrapped context query used to read pixel-store state without polluting the journal.
 */
export function snapshotWebGlArguments(context, args, descriptor, nativeGetParameter) {
  const isReadback = descriptor.category === 'readback';
  const values = new Array(args.length);
  const types = new Array(args.length);

  for (let index = 0; index < args.length; index++) {
    const { type, value } = snapshotArgument(
      context,
      args[index],
      index,
      descriptor,
      isReadback,
      args,
      nativeGetParameter
    );
    types[index] = type;
    values[index] = value;
  }

  return { values, types };
}
