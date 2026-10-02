import { createCaptureRepository } from '../shared/storage/captureRepository.js';
import { TransferError, createTransferId } from '../shared/storage/transferProtocol.js';
import { validateWebGlPackage } from '../inspection/webgl/package.js';
import { validateWebGpuPackage, WEBGPU_CAPTURE_SCHEMA } from '../inspection/webgpu/package.js';

const INDEX_KEY = 'ispettoreCaptureIndexes';
const TRANSFER_KEY = 'ispettoreTransferStatus';

export function normalizeStoredPackage(capture) {
  if (capture?.schema === WEBGPU_CAPTURE_SCHEMA) {
    return validateWebGpuPackage(capture);
  }
  return validateWebGlPackage(capture);
}

function senderInfo(sender) {
  return {
    tabId: sender?.tab?.id ?? null,
    documentId: sender?.documentId ?? null,
    frameId: Number.isInteger(sender?.frameId) ? sender.frameId : null
  };
}

function createSessionIndex(storage) {
  async function getIndexes() {
    const result = await storage.get(INDEX_KEY);
    return Array.isArray(result?.[INDEX_KEY]) ? result[INDEX_KEY] : [];
  }
  return {
    async getAll() {
      return getIndexes();
    },
    async replace(summaries) {
      await storage.set({ [INDEX_KEY]: summaries });
      return true;
    }
  };
}

function createTransferStatus(storage) {
  async function getStatus() {
    const result = await storage.get(TRANSFER_KEY);
    return result?.[TRANSFER_KEY] ?? {};
  }
  return {
    async set(transferId, status) {
      const all = await getStatus();
      all[transferId] = status;
      await storage.set({ [TRANSFER_KEY]: all });
      return true;
    },
    async remove(transferId) {
      const all = await getStatus();
      delete all[transferId];
      await storage.set({ [TRANSFER_KEY]: all });
      return true;
    },
    async getAll() {
      return getStatus();
    }
  };
}

export async function installCaptureStorage({ budgetBytes } = {}) {
  const repository = createCaptureRepository({
    validatePackage: (capture) => normalizeStoredPackage(capture),
    budgetBytes
  });

  const session = chrome.storage.session;
  const index = createSessionIndex(session);
  const status = createTransferStatus(session);

  async function syncIndexFromRepository() {
    const summaries = await repository.listCaptureSummaries();
    await index.replace(summaries);
    return summaries;
  }

  async function handleTransferMessage(message, sender) {
    const { phase, transferId } = message ?? {};

    if (phase === 'begin') {
      const payload = message.payload ?? {};
      await repository.beginTransfer({
        transferId,
        captureId: payload.captureId,
        schema: payload.schema,
        version: payload.version,
        source: {
          url: payload.source?.url ?? null,
          capturedAt: payload.source?.capturedAt ?? null,
          ...senderInfo(sender)
        },
        chunkCount: payload.chunkCount,
        totalChars: payload.totalChars,
        checksum: payload.checksum,
        checksumAlgorithm: payload.checksumAlgorithm
      });
      await status.set(transferId, {
        status: 'receiving',
        receivedChunks: 0,
        chunkCount: payload.chunkCount
      });
      return { ok: true };
    }

    if (phase === 'chunk') {
      const receivedChunks = await repository.storeChunk({ transferId, index: message.index, data: message.data });
      const pending = await repository.getPendingTransfer(transferId);
      await status.set(transferId, {
        status: pending?.status ?? 'receiving',
        receivedChunks,
        chunkCount: pending?.chunkCount ?? 0
      });
      return { ok: true, receivedChunks };
    }

    if (phase === 'end') {
      let record;
      try {
        record = await repository.finalizeTransfer(transferId);
      } catch (error) {
        if (!(await repository.getPendingTransfer(transferId))) await status.remove(transferId);
        throw error;
      }
      await repository.evictIfNeeded();
      await repository.cleanupStalePending();
      await status.remove(transferId);
      await syncIndexFromRepository();
      return {
        ok: true,
        captureId: record.captureId,
        byteSize: record.meta.byteSize,
        commandCount: record.meta.commandCount
      };
    }

    if (phase === 'cancel') {
      await repository.cancelTransfer(transferId);
      await status.remove(transferId);
      return { ok: true };
    }

    return { ok: false, error: 'Unknown transfer phase' };
  }

  async function handleStorageCommand(message, sender) {
    const { command, captureId } = message ?? {};

    if (command === 'listCaptures') {
      await syncIndexFromRepository();
      return { ok: true, captures: await index.getAll() };
    }

    if (command === 'getCapture') {
      const record = await repository.getCapture(captureId);
      return record
        ? { ok: true, capture: record.package }
        : { ok: false, error: 'Capture not found' };
    }

    if (command === 'deleteCapture') {
      const removed = await repository.deleteCapture(captureId);
      await syncIndexFromRepository();
      return { ok: Boolean(removed), removed };
    }

    if (command === 'importCapture') {
      const capture = await validateImportedCapture(message.data);
      const record = await repository.putCapture({
        captureId: message.captureId ?? createTransferId(),
        package: capture,
        source: { ...senderInfo(sender), imported: true }
      });
      await repository.evictIfNeeded();
      await syncIndexFromRepository();
      return { ok: true, captureId: record.captureId };
    }

    if (command === 'getStorageInfo') {
      return { ok: true, storage: await repository.getStorageInfo() };
    }

    if (command === 'cleanupPending') {
      await repository.cleanupStalePending();
      return { ok: true };
    }

    if (command === 'refreshIndex') {
      await syncIndexFromRepository();
      return { ok: true };
    }

    return { ok: false, error: 'Unknown storage command' };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== 'ISPETTORE_TRANSFER' && message?.type !== 'ISPETTORE_STORAGE') return;
    const handler =
      message.type === 'ISPETTORE_TRANSFER'
        ? handleTransferMessage(message, sender)
        : handleStorageCommand(message, sender);
    handler
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  });

  await repository.cleanupStalePending().catch(() => {});
  let summaries = [];
  try {
    summaries = await syncIndexFromRepository();
  } catch (error) {
    console.error('Ispettore: capture index sync failed', error?.message || error);
  }

  globalThis.__ISPETTORE_STORAGE__ = Object.freeze({
    listCaptures: () => repository.listCaptureSummaries(),
    getCapture: (id) => repository.getCapture(id),
    deleteCapture: (id) => repository.deleteCapture(id),
    getStorageInfo: () => repository.getStorageInfo(),
    cleanupPending: () => repository.cleanupStalePending(),
    getCaptureIndexes: () => index.getAll(),
    getTransferStatus: () => status.getAll()
  });

  return { repository, index, status, syncIndexFromRepository, summaries };
}

async function validateImportedCapture(data) {
  let capture = data;
  if (typeof data === 'string') {
    try {
      capture = JSON.parse(data);
    } catch (error) {
      throw new TransferError(`Imported capture is not valid JSON: ${error?.message ?? error}`);
    }
  }
  if (capture == null || typeof capture !== 'object') {
    throw new TransferError('Imported capture is empty');
  }
  return normalizeStoredPackage(capture);
}
