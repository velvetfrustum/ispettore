import { hashText } from './hash.js';
import {
  TRANSFER_CHANNEL,
  TRANSFER_CHUNK_CHARS,
  TRANSFER_MESSAGE_TYPES,
  createTransferId,
  planTransfer,
  splitIntoChunks
} from './transferProtocol.js';

const ACK_TIMEOUT_MS = 120000;

let installed = false;
const pendingAcks = new Map();

function ackKey(phase, index) {
  return phase === 'chunk' ? `chunk:${index}` : phase;
}

function onWindowMessage(event) {
  if (event.source !== window || !event.data || event.data.channel !== TRANSFER_CHANNEL) return;
  const message = event.data;
  const { transferId, phase, index } = message ?? {};
  if (
    message.type !== TRANSFER_MESSAGE_TYPES.ACK &&
    message.type !== TRANSFER_MESSAGE_TYPES.ERROR
  ) {
    return;
  }
  const perTransfer = pendingAcks.get(transferId);
  if (!perTransfer) return;
  const key = ackKey(phase, index);
  const entry = perTransfer.get(key);
  if (!entry) return;
  perTransfer.delete(key);
  clearTimeout(entry.timer);
  if (perTransfer.size === 0) pendingAcks.delete(transferId);
  if (message.type === TRANSFER_MESSAGE_TYPES.ERROR) {
    entry.reject(new Error(message.error || 'Capture transfer failed'));
  } else {
    entry.resolve(message);
  }
}

export function installTransferSender() {
  if (installed) return;
  installed = true;
  window.addEventListener('message', onWindowMessage);
}

function awaitAck(transferId, phase, index) {
  return new Promise((resolve, reject) => {
    let perTransfer = pendingAcks.get(transferId);
    if (!perTransfer) {
      perTransfer = new Map();
      pendingAcks.set(transferId, perTransfer);
    }
    const key = ackKey(phase, index);
    const timer = setTimeout(() => {
      perTransfer.delete(key);
      if (perTransfer.size === 0) pendingAcks.delete(transferId);
      reject(new Error('Capture transfer timed out'));
    }, ACK_TIMEOUT_MS);
    perTransfer.set(key, { resolve, reject, timer });
  });
}

function postToContent(message) {
  window.postMessage({ channel: TRANSFER_CHANNEL, ...message }, '*');
}

async function beginTransfer(text, packageValue, options) {
  const { chunkCount, totalChars } = planTransfer(text, options.chunkChars);
  const checksum = await hashText(text);
  const transferId = options.transferId ?? createTransferId();
  const captureId = options.captureId ?? createTransferId();

  postToContent({
    type: TRANSFER_MESSAGE_TYPES.BEGIN,
    transferId,
    payload: {
      captureId,
      schema: packageValue.schema ?? null,
      version: packageValue.version ?? null,
      chunkCount,
      totalChars,
      checksum: checksum.hex,
      checksumAlgorithm: checksum.algorithm,
      source: {
        url: typeof location !== 'undefined' ? location.href : null,
        capturedAt: new Date().toISOString()
      }
    }
  });
  const ack = await awaitAck(transferId, 'begin');
  if (!ack?.ok) throw new Error(ack?.error || 'Capture transfer was rejected');
  return { transferId, captureId, chunks: splitIntoChunks(text, options.chunkChars) };
}

async function sendChunks(transferId, chunks) {
  for (const chunk of chunks) {
    postToContent({ type: TRANSFER_MESSAGE_TYPES.CHUNK, transferId, index: chunk.index, data: chunk.data });
    const ack = await awaitAck(transferId, 'chunk', chunk.index);
    if (!ack?.ok) throw new Error(ack?.error || `Chunk ${chunk.index} was rejected`);
  }
}

async function endTransfer(transferId) {
  postToContent({ type: TRANSFER_MESSAGE_TYPES.END, transferId });
  const ack = await awaitAck(transferId, 'end');
  if (!ack?.ok) throw new Error(ack?.error || 'Capture transfer did not finalize');
  return ack;
}

export async function sendWebGlPackage(packageValue, options = {}) {
  if (packageValue == null || typeof packageValue !== 'object') {
    throw new TypeError('A WebGL capture package is required');
  }

  const transferId = options.transferId ?? null;
  if (transferId) {
    const perTransfer = pendingAcks.get(transferId);
    if (perTransfer) {
      for (const entry of perTransfer.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error('Capture transfer was superseded'));
      }
      pendingAcks.delete(transferId);
    }
  }

  let text;
  try {
    text = JSON.stringify(packageValue);
  } catch (error) {
    if (error instanceof RangeError && /invalid string length/i.test(error.message)) {
      console.warn('[ispettore] JSON.stringify overflowed while serializing the capture package', {
        commands: Array.isArray(packageValue.commands) ? packageValue.commands.length : null,
        blobs: Array.isArray(packageValue.blobs) ? packageValue.blobs.length : null
      });
      return {
        ok: false,
        error:
          'Capture is too large for Chromium to serialize as one package — the armed frame issued an extreme number of commands or referenced very large blobs.'
      };
    }
    return { ok: false, error: `Capture package is not serializable: ${error?.message ?? error}` };
  }

  let started;
  try {
    started = await beginTransfer(text, packageValue, options);
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }

  try {
    await sendChunks(started.transferId, started.chunks);
    const ack = await endTransfer(started.transferId);
    return {
      ok: true,
      transferId: started.transferId,
      captureId: ack.captureId ?? started.captureId,
      byteSize: ack.byteSize ?? 0,
      commandCount: ack.commandCount ?? 0
    };
  } catch (error) {
    postToContent({ type: TRANSFER_MESSAGE_TYPES.CANCEL, transferId: started.transferId });
    return { ok: false, error: error?.message ?? String(error) };
  }
}
