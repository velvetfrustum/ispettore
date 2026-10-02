const BINARY_ARRAY_TYPES = {
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array
};

function tagOf(value) {
  return Object.prototype.toString.call(value);
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * API-neutral immutable encoding for typed arrays, ArrayBuffer, SharedArrayBuffer, and
 * DataView values. Used by every backend serializer so binary inputs survive JSON packages.
 */
export function encodeBinaryBlob(id, value) {
  if (!id) throw new TypeError('Capture blobs require an id');

  const tag = tagOf(value);
  let arrayType;
  let bytes;
  if (tag === '[object ArrayBuffer]' || tag === '[object SharedArrayBuffer]') {
    arrayType = tag.slice(8, -1);
    bytes = new Uint8Array(value);
  } else if (tag === '[object DataView]') {
    arrayType = 'DataView';
    bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  } else if (ArrayBuffer.isView(value) && BINARY_ARRAY_TYPES[tag.slice(8, -1)]) {
    arrayType = tag.slice(8, -1);
    bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  } else {
    throw new TypeError('Capture blobs require an ArrayBuffer or ArrayBuffer view');
  }
  return {
    id,
    arrayType,
    byteLength: bytes.byteLength,
    data: bytesToBase64(bytes)
  };
}

export function decodeBinaryBlob(blob) {
  if (typeof blob?.data !== 'string') {
    throw new TypeError(`Unsupported capture blob ${blob?.id ?? ''}`.trim());
  }
  const bytes = base64ToBytes(blob.data);
  if (bytes.byteLength !== blob.byteLength) {
    throw new TypeError(`Invalid byte length for capture blob ${blob.id}`);
  }
  if (blob.arrayType === 'ArrayBuffer') return bytes.buffer;
  if (blob.arrayType === 'SharedArrayBuffer') {
    if (typeof SharedArrayBuffer === 'undefined') {
      throw new TypeError(`Unsupported capture blob ${blob.id}`);
    }
    const buffer = new SharedArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    return buffer;
  }
  if (blob.arrayType === 'DataView') return new DataView(bytes.buffer);

  const ArrayType = BINARY_ARRAY_TYPES[blob.arrayType];
  if (!ArrayType || bytes.byteLength % ArrayType.BYTES_PER_ELEMENT !== 0) {
    throw new TypeError(`Unsupported capture blob ${blob.id}`);
  }
  return new ArrayType(bytes.buffer);
}
