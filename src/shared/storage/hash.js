function bytesToHex(bytes) {
  let hex = '';
  for (let index = 0; index < bytes.length; index += 1) hex += bytes[index].toString(16).padStart(2, '0');
  return hex;
}

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const FNV_MASK = 0xffffffffffffffffn;

export function fnv1aHex(bytes) {
  let hash = FNV_OFFSET;
  for (let index = 0; index < bytes.length; index += 1) {
    hash ^= BigInt(bytes[index]);
    hash = (hash * FNV_PRIME) & FNV_MASK;
  }
  return hash.toString(16).padStart(16, '0');
}

export function textBytes(text) {
  return new TextEncoder().encode(text);
}

export function textByteLength(text) {
  return textBytes(text).byteLength;
}

export async function hashText(text, { algorithm } = {}) {
  const bytes = textBytes(text);

  if (algorithm != null && algorithm !== 'fnv' && algorithm !== 'sha256') {
    throw new TypeError(`Unsupported checksum algorithm: ${algorithm}`);
  }

  if (algorithm !== 'fnv' && globalThis.crypto?.subtle?.digest) {
    try {
      const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
      return { algorithm: 'sha256', hex: bytesToHex(new Uint8Array(digest)) };
    } catch (error) {
      if (algorithm === 'sha256') {
        throw new Error(`SHA-256 checksum is unavailable: ${error?.message ?? error}`);
      }
    }
  }

  if (algorithm === 'sha256') throw new Error('SHA-256 checksum is unavailable');

  return { algorithm: 'fnv', hex: fnv1aHex(bytes) };
}
