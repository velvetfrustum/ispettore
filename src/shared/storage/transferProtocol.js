import { hashText } from './hash.js';

export const TRANSFER_CHANNEL = 'ISPETTORE';
export const TRANSFER_CHUNK_CHARS = 1024 * 1024;

export const TRANSFER_MESSAGE_TYPES = Object.freeze({
  BEGIN: 'TRANSFER_BEGIN',
  CHUNK: 'TRANSFER_CHUNK',
  END: 'TRANSFER_END',
  CANCEL: 'TRANSFER_CANCEL',
  ACK: 'TRANSFER_ACK',
  ERROR: 'TRANSFER_ERROR'
});

export class TransferError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TransferError';
  }
}

export function createTransferId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function planTransfer(text, chunkChars = TRANSFER_CHUNK_CHARS) {
  const size = Number.isInteger(chunkChars) && chunkChars > 0 ? chunkChars : TRANSFER_CHUNK_CHARS;
  const chunkCount = Math.max(1, Math.ceil(text.length / size));
  return { chunkCount, totalChars: text.length, chunkChars: size };
}

export function splitIntoChunks(text, chunkChars = TRANSFER_CHUNK_CHARS) {
  const { chunkCount, chunkChars: size } = planTransfer(text, chunkChars);
  const chunks = [];
  for (let index = 0; index < chunkCount; index += 1) {
    chunks.push({ index, data: text.slice(index * size, (index + 1) * size) });
  }
  return chunks;
}

export function reassembleChunks(chunks, { chunkCount, totalChars } = {}) {
  if (!Array.isArray(chunks)) throw new TransferError('Transfer chunks are missing');

  const byIndex = new Map();
  for (const chunk of chunks) {
    if (!Number.isInteger(chunk?.index) || chunk.index < 0) {
      throw new TransferError('Transfer chunk index is invalid');
    }
    if (byIndex.has(chunk.index)) {
      throw new TransferError(`Transfer chunk ${chunk.index} was sent more than once`);
    }
    byIndex.set(chunk.index, chunk);
  }

  if (chunkCount != null) {
    if (byIndex.size !== chunkCount) {
      throw new TransferError(`Transfer is incomplete (received ${byIndex.size} of ${chunkCount} chunks)`);
    }
  } else if (byIndex.size === 0) {
    throw new TransferError('Transfer has no chunks');
  }

  const parts = [];
  const expected = chunkCount ?? byIndex.size;
  for (let index = 0; index < expected; index += 1) {
    const chunk = byIndex.get(index);
    if (!chunk || typeof chunk.data !== 'string') {
      throw new TransferError(`Transfer is missing chunk ${index}`);
    }
    parts.push(chunk.data);
  }

  const text = parts.join('');
  if (totalChars != null && text.length !== totalChars) {
    throw new TransferError('Transfer character count does not match');
  }
  return text;
}

export function parseTransferPackage(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new TransferError(`Transfer package is not valid JSON: ${error?.message ?? error}`);
  }
  return parsed;
}

export async function verifyTransfer(chunks, { chunkCount, totalChars, checksum, checksumAlgorithm }) {
  const text = reassembleChunks(chunks, { chunkCount, totalChars });
  const hash = await hashText(text, { algorithm: checksumAlgorithm });
  if (hash.hex !== checksum) {
    throw new TransferError('Transfer checksum mismatch');
  }
  return text;
}