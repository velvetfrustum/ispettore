const TYPED_ARRAY_TAGS = new Set(
  [
    'Int8Array',
    'Uint8Array',
    'Uint8ClampedArray',
    'Int16Array',
    'Uint16Array',
    'Int32Array',
    'Uint32Array',
    'Float32Array',
    'Float64Array',
    'BigInt64Array',
    'BigUint64Array'
  ].map((name) => `[object ${name}]`)
);

function typedArrayTag(value) {
  const tag = Object.prototype.toString.call(value);
  if (!TYPED_ARRAY_TAGS.has(tag)) return null;
  return tag.slice(8, -1);
}

function arrayBufferTag(value) {
  const tag = Object.prototype.toString.call(value);
  if (tag === '[object ArrayBuffer]') return 'array-buffer';
  if (tag === '[object SharedArrayBuffer]') {
    return typeof SharedArrayBuffer !== 'undefined' ? 'shared-array-buffer' : null;
  }
  if (tag === '[object DataView]') return 'data-view';
  return null;
}

function copyTypedArray(value, name) {
  const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  const ArrayType = globalThis[name];
  return new ArrayType(bytes.buffer, bytes.byteOffset, bytes.byteLength / ArrayType.BYTES_PER_ELEMENT);
}

export function snapshotBinary(value) {
  const typedName = typedArrayTag(value);
  if (typedName) return { value: copyTypedArray(value, typedName), type: `typed-array:${typedName}` };
  const bufferTag = arrayBufferTag(value);
  if (!bufferTag) return null;
  if (bufferTag === 'data-view') {
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
    return { value: new DataView(bytes.buffer), type: 'data-view' };
  }
  const bytes = new Uint8Array(value).slice();
  return { value: bytes.buffer, type: bufferTag };
}
