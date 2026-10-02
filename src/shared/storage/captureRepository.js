import { textByteLength } from './hash.js';
import { TransferError, parseTransferPackage, verifyTransfer } from './transferProtocol.js';

const DB_NAME = 'ispettore';
const DB_VERSION = 2;
const CAPTURES = 'captures';
const PENDING_TRANSFERS = 'pendingTransfers';
const PENDING_CHUNKS = 'pendingChunks';
const PENDING_CAPTURE_INDEX = 'captureId';

const DEFAULT_BUDGET_BYTES = 256 * 1024 * 1024;
const STALE_PENDING_MAX_AGE_MS = 30 * 60 * 1000;

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(CAPTURES)) {
        const store = database.createObjectStore(CAPTURES, { keyPath: 'captureId' });
        store.createIndex('capturedAt', 'capturedAt');
      }
      const transfers = database.objectStoreNames.contains(PENDING_TRANSFERS)
        ? request.transaction.objectStore(PENDING_TRANSFERS)
        : database.createObjectStore(PENDING_TRANSFERS, { keyPath: 'transferId' });
      if (!transfers.indexNames.contains(PENDING_CAPTURE_INDEX)) {
        transfers.createIndex(PENDING_CAPTURE_INDEX, 'captureId');
      }
      if (!database.objectStoreNames.contains(PENDING_CHUNKS)) {
        const store = database.createObjectStore(PENDING_CHUNKS, { keyPath: ['transferId', 'index'] });
        store.createIndex('transferId', 'transferId');
      }
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
    request.onblocked = () => reject(new Error('IndexedDB open blocked by another connection'));
  });
}

function isIdbRequest(value) {
  return (
    value != null &&
    typeof value === 'object' &&
    typeof value.readyState === 'string' &&
    value.onsuccess !== undefined
  );
}

function isObjectLike(value) {
  return value != null && typeof value === 'object';
}

export function createCaptureRepository({
  validatePackage = (capture) => capture,
  budgetBytes = DEFAULT_BUDGET_BYTES
} = {}) {
  let databasePromise = null;
  const activeFinalizations = new Set();

  async function database() {
    if (typeof indexedDB === 'undefined') throw new TransferError('IndexedDB is not available');
    if (!databasePromise) {
      databasePromise = openDatabase().catch((error) => {
        databasePromise = null;
        throw error;
      });
    }
    return databasePromise;
  }

  async function storeRequest(storeName, mode, mutate) {
    const db = await database();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, mode);
      const store = transaction.objectStore(storeName);
      let requestResult;
      let requestError = null;
      const request = mutate(store);
      if (isIdbRequest(request)) {
        request.onsuccess = () => {
          requestResult = request.result;
        };
        request.onerror = () => {
          requestError = request.error ?? new Error('IndexedDB request failed');
        };
      }
      transaction.oncomplete = () => {
        if (requestError) reject(requestError);
        else resolve(requestResult);
      };
      transaction.onerror = () => {
        reject(transaction.error ?? requestError ?? new Error('IndexedDB transaction failed'));
      };
      transaction.onabort = () => {
        reject(transaction.error ?? requestError ?? new Error('IndexedDB transaction aborted'));
      };
    });
  }

  async function get(storeName, key) {
    return storeRequest(storeName, 'readonly', (store) => store.get(key));
  }

  async function getAll(storeName) {
    return storeRequest(storeName, 'readonly', (store) => store.getAll());
  }

  async function getAllByIndex(storeName, indexName, key) {
    return storeRequest(storeName, 'readonly', (store) => store.index(indexName).getAll(key));
  }

  async function deleteKey(storeName, key) {
    await storeRequest(storeName, 'readwrite', (store) => store.delete(key));
    return true;
  }

  async function claimTransferForFinalization(transferId) {
    const db = await database();
    return new Promise((resolve, reject) => {
      let operationError = null;
      let claimed = null;
      const transaction = db.transaction(PENDING_TRANSFERS, 'readwrite');
      const transfers = transaction.objectStore(PENDING_TRANSFERS);
      const request = transfers.get(transferId);
      request.onsuccess = () => {
        const pending = request.result;
        if (!pending) {
          operationError = new TransferError('Transfer was not started or was cancelled');
          transaction.abort();
          return;
        }
        if (pending.status === 'finalizing') {
          claimed = pending;
          return;
        }
        claimed = { ...pending, status: 'finalizing', lastUpdatedAt: Date.now() };
        transfers.put(claimed);
      };
      request.onerror = () => {
        operationError = request.error ?? new Error('IndexedDB pending read failed');
      };
      transaction.oncomplete = () => resolve(claimed);
      transaction.onabort = () => reject(operationError ?? transaction.error ?? new Error('IndexedDB transaction aborted'));
      transaction.onerror = () => {
        operationError ??= transaction.error ?? new Error('IndexedDB transaction failed');
      };
    });
  }

  async function commitFinalizedCapture(transferId, record) {
    const db = await database();
    return new Promise((resolve, reject) => {
      let operationError = null;
      const transaction = db.transaction([CAPTURES, PENDING_TRANSFERS, PENDING_CHUNKS], 'readwrite');
      const captures = transaction.objectStore(CAPTURES);
      const transfers = transaction.objectStore(PENDING_TRANSFERS);
      const chunks = transaction.objectStore(PENDING_CHUNKS);
      const pendingRequest = transfers.get(transferId);
      pendingRequest.onsuccess = () => {
        const pending = pendingRequest.result;
        if (!pending || pending.status !== 'finalizing' || pending.captureId !== record.captureId) {
          operationError = new TransferError('Transfer finalization state was lost');
          transaction.abort();
          return;
        }

        const captureRequest = captures.add(record);
        captureRequest.onerror = () => {
          operationError = new TransferError('Capture id is already in use');
        };
        transfers.delete(transferId);
        const cursorRequest = chunks.index('transferId').openCursor(IDBKeyRange.only(transferId));
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (cursor) {
            cursor.delete();
            cursor.continue();
          }
        };
        cursorRequest.onerror = () => {
          operationError = cursorRequest.error ?? new Error('IndexedDB cursor failed');
          transaction.abort();
        };
      };
      pendingRequest.onerror = () => {
        operationError = pendingRequest.error ?? new Error('IndexedDB pending read failed');
      };
      transaction.oncomplete = () => resolve(record);
      transaction.onabort = () => reject(operationError ?? transaction.error ?? new Error('IndexedDB transaction aborted'));
      transaction.onerror = () => {
        operationError ??= transaction.error ?? new Error('IndexedDB transaction failed');
      };
    });
  }

  function validateBeginRecord(record) {
    if (!isObjectLike(record)) throw new TransferError('Transfer begin record is required');
    if (typeof record.transferId !== 'string' || !record.transferId) {
      throw new TransferError('Transfer requires a transfer id');
    }
    if (typeof record.captureId !== 'string' || !record.captureId) {
      throw new TransferError('Transfer requires a capture id');
    }
    if (!Number.isInteger(record.chunkCount) || record.chunkCount < 1) {
      throw new TransferError('Transfer requires a positive chunk count');
    }
    if (!Number.isInteger(record.totalChars) || record.totalChars < 0) {
      throw new TransferError('Transfer requires a valid character count');
    }
    if (typeof record.checksum !== 'string' || !record.checksum) {
      throw new TransferError('Transfer requires a checksum');
    }
  }

  return {
    async beginTransfer(record) {
      validateBeginRecord(record);
      const pendingRecord = {
        transferId: record.transferId,
        captureId: record.captureId,
        schema: record.schema ?? null,
        version: record.version ?? null,
        source: isObjectLike(record.source) ? { ...record.source } : {},
        chunkCount: record.chunkCount,
        totalChars: record.totalChars,
        checksum: record.checksum,
        checksumAlgorithm: record.checksumAlgorithm ?? 'fnv',
        receivedChunks: 0,
        lastUpdatedAt: Date.now(),
        status: 'receiving'
      };
      const db = await database();
      return new Promise((resolve, reject) => {
        let operationError = null;
        const transaction = db.transaction([PENDING_TRANSFERS, CAPTURES], 'readwrite');
        const transfers = transaction.objectStore(PENDING_TRANSFERS);
        const captures = transaction.objectStore(CAPTURES);
        const transferRequest = transfers.get(record.transferId);
        transferRequest.onsuccess = () => {
          if (transferRequest.result) {
            operationError = new TransferError('Transfer id is already in use');
            transaction.abort();
            return;
          }
          const captureRequest = captures.get(record.captureId);
          captureRequest.onsuccess = () => {
            if (captureRequest.result) {
              operationError = new TransferError('Capture id is already in use');
              transaction.abort();
              return;
            }
            const pendingCaptureRequest = transfers.index(PENDING_CAPTURE_INDEX).get(record.captureId);
            pendingCaptureRequest.onsuccess = () => {
              if (pendingCaptureRequest.result) {
                operationError = new TransferError('Capture id is already in use');
                transaction.abort();
                return;
              }
              transfers.add(pendingRecord);
            };
            pendingCaptureRequest.onerror = () => {
              operationError = pendingCaptureRequest.error ?? new Error('IndexedDB pending capture read failed');
            };
          };
          captureRequest.onerror = () => {
            operationError = captureRequest.error ?? new Error('IndexedDB capture read failed');
          };
        };
        transferRequest.onerror = () => {
          operationError = transferRequest.error ?? new Error('IndexedDB pending read failed');
        };
        transaction.oncomplete = () => resolve(true);
        transaction.onabort = () => reject(operationError ?? transaction.error ?? new Error('IndexedDB transaction aborted'));
        transaction.onerror = () => {
          operationError ??= transaction.error ?? new Error('IndexedDB transaction failed');
        };
      });
    },

    async getPendingTransfer(transferId) {
      return get(PENDING_TRANSFERS, transferId);
    },

    async storeChunk({ transferId, index, data }) {
      if (typeof transferId !== 'string' || !transferId) throw new TransferError('Chunk requires a transfer id');
      if (!Number.isInteger(index) || index < 0) throw new TransferError('Chunk index is invalid');
      if (typeof data !== 'string') throw new TransferError('Chunk data is missing');
      const db = await database();
      return new Promise((resolve, reject) => {
        let settled = false;
        let nextReceived = 0;
        const fail = (error) => {
          if (settled) return;
          settled = true;
          reject(error);
          try {
            transaction.abort();
          } catch (_) {
            /* transaction may already be inactive */
          }
        };
        const transaction = db.transaction([PENDING_TRANSFERS, PENDING_CHUNKS], 'readwrite');
        const transfers = transaction.objectStore(PENDING_TRANSFERS);
        const chunks = transaction.objectStore(PENDING_CHUNKS);

        const pendingRequest = transfers.get(transferId);
        pendingRequest.onsuccess = () => {
          const pending = pendingRequest.result;
          if (!pending) return fail(new TransferError('Transfer was not started or was cancelled'));
          if (pending.status === 'finalizing') return fail(new TransferError('Transfer is already being finalized'));
          if (index >= pending.chunkCount) return fail(new TransferError(`Chunk index ${index} is out of range`));

          const existingRequest = chunks.get([transferId, index]);
          existingRequest.onsuccess = () => {
            if (existingRequest.result) return fail(new TransferError(`Chunk ${index} was received more than once`));
            chunks.put({ transferId, index, data });
            nextReceived = pending.receivedChunks + 1;
            transfers.put({ ...pending, receivedChunks: nextReceived, lastUpdatedAt: Date.now() });
          };
          existingRequest.onerror = () => fail(existingRequest.error ?? new Error('IndexedDB chunk read failed'));
        };
        pendingRequest.onerror = () => fail(pendingRequest.error ?? new Error('IndexedDB pending read failed'));

        transaction.oncomplete = () => {
          if (!settled) {
            settled = true;
            resolve(nextReceived);
          }
        };
        transaction.onabort = () => fail(transaction.error ?? new Error('IndexedDB transaction aborted'));
        transaction.onerror = () => fail(transaction.error ?? new Error('IndexedDB transaction failed'));
      });
    },

    async finalizeTransfer(transferId) {
      if (typeof transferId !== 'string' || !transferId) throw new TransferError('Transfer id is required');
      if (activeFinalizations.has(transferId)) throw new TransferError('Transfer is already being finalized');
      activeFinalizations.add(transferId);
      try {
        const pending = await claimTransferForFinalization(transferId);

        const chunks = await getAllByIndex(PENDING_CHUNKS, 'transferId', transferId);
        let text;
        try {
          text = await verifyTransfer(chunks, {
            chunkCount: pending.chunkCount,
            totalChars: pending.totalChars,
            checksum: pending.checksum,
            checksumAlgorithm: pending.checksumAlgorithm
          });
        } catch (error) {
          await this.cancelTransfer(transferId).catch(() => {});
          throw error;
        }

        let capture;
        try {
          capture = await validatePackage(parseTransferPackage(text));
        } catch (error) {
          await this.cancelTransfer(transferId).catch(() => {});
          throw error instanceof TransferError
            ? error
            : new TransferError(`Captured package is invalid: ${error?.message ?? error}`);
        }

        const record = {
          captureId: pending.captureId,
          schema: capture.schema ?? null,
          version: capture.version ?? null,
          source: { ...(pending.source ?? {}) },
          capturedAt: pending.source?.capturedAt ?? new Date().toISOString(),
          meta: {
            byteSize: textByteLength(text),
            commandCount: Array.isArray(capture.commands) ? capture.commands.length : 0,
            blobCount: Array.isArray(capture.blobs) ? capture.blobs.length : 0,
            chunkCount: pending.chunkCount
          },
          package: capture
        };
        try {
          return await commitFinalizedCapture(transferId, record);
        } catch (error) {
          await this.cancelTransfer(transferId).catch(() => {});
          throw error;
        }
      } finally {
        activeFinalizations.delete(transferId);
      }
    },

    async cancelTransfer(transferId) {
      if (typeof transferId !== 'string' || !transferId) return false;
      const db = await database();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction([PENDING_TRANSFERS, PENDING_CHUNKS], 'readwrite');
        const transfers = transaction.objectStore(PENDING_TRANSFERS);
        const chunks = transaction.objectStore(PENDING_CHUNKS);
        const cursorRequest = chunks.index('transferId').openCursor(IDBKeyRange.only(transferId));
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (cursor) {
            cursor.delete();
            cursor.continue();
          } else {
            transfers.delete(transferId);
          }
        };
        cursorRequest.onerror = () => reject(cursorRequest.error ?? new Error('IndexedDB cursor failed'));
        transaction.oncomplete = () => resolve(true);
        transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
        transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
      });
    },

    async putCapture(record) {
      if (!isObjectLike(record) || typeof record.captureId !== 'string' || !record.captureId) {
        throw new TransferError('Stored capture requires a capture id');
      }
      const capture = await validatePackage(record.package);
      const stored = {
        captureId: record.captureId,
        schema: capture.schema ?? null,
        version: capture.version ?? null,
        source: isObjectLike(record.source) ? { ...record.source } : {},
        capturedAt: record.capturedAt ?? new Date().toISOString(),
        meta: {
          byteSize: textByteLength(JSON.stringify(capture)),
          commandCount: Array.isArray(capture.commands) ? capture.commands.length : 0,
          blobCount: Array.isArray(capture.blobs) ? capture.blobs.length : 0,
          chunkCount: 0
        },
        package: capture
      };
      const db = await database();
      return new Promise((resolve, reject) => {
        let operationError = null;
        const transaction = db.transaction([CAPTURES, PENDING_TRANSFERS], 'readwrite');
        const captures = transaction.objectStore(CAPTURES);
        const transfers = transaction.objectStore(PENDING_TRANSFERS);
        const pendingRequest = transfers.index(PENDING_CAPTURE_INDEX).get(stored.captureId);
        pendingRequest.onsuccess = () => {
          if (pendingRequest.result) {
            operationError = new TransferError('Capture id is already in use');
            transaction.abort();
            return;
          }
          const captureRequest = captures.add(stored);
          captureRequest.onerror = () => {
            operationError = new TransferError('Capture id is already in use');
          };
        };
        pendingRequest.onerror = () => {
          operationError = pendingRequest.error ?? new Error('IndexedDB pending capture read failed');
        };
        transaction.oncomplete = () => resolve(stored);
        transaction.onabort = () => reject(operationError ?? transaction.error ?? new Error('IndexedDB transaction aborted'));
        transaction.onerror = () => {
          operationError ??= transaction.error ?? new Error('IndexedDB transaction failed');
        };
      });
    },

    async listCaptureSummaries() {
      const records = await getAll(CAPTURES);
      return records
        .map(({ captureId, schema, version, capturedAt, source, meta }) => ({
          captureId,
          schema,
          version,
          capturedAt,
          source,
          meta
        }))
        .sort((a, b) => String(a.capturedAt) < String(b.capturedAt) ? -1 : 1);
    },

    async getCapture(captureId) {
      const record = await get(CAPTURES, captureId);
      if (!record) return null;
      const capture = await validatePackage(record.package);
      return {
        ...record,
        schema: capture.schema,
        version: capture.version,
        package: capture
      };
    },

    async deleteCapture(captureId) {
      if (typeof captureId !== 'string' || !captureId) return false;
      const existing = await get(CAPTURES, captureId);
      if (!existing) return false;
      await deleteKey(CAPTURES, captureId);
      return true;
    },

    async cleanupStalePending(maxAgeMs = STALE_PENDING_MAX_AGE_MS) {
      const now = Date.now();
      const pendings = await getAll(PENDING_TRANSFERS);
      for (const pending of pendings) {
        if (now - (pending.lastUpdatedAt ?? 0) > maxAgeMs) {
          await this.cancelTransfer(pending.transferId);
        }
      }
      return true;
    },

    async evictIfNeeded() {
      const records = await getAll(CAPTURES);
      const sorted = [...records].sort((a, b) => String(a.capturedAt) < String(b.capturedAt) ? -1 : 1);
      let used = sorted.reduce((sum, record) => sum + (record.meta?.byteSize ?? 0), 0);
      while (used > budgetBytes && sorted.length > 1) {
        const oldest = sorted.shift();
        used -= oldest.meta?.byteSize ?? 0;
        await this.deleteCapture(oldest.captureId);
      }
      return {
        evicted: sorted.length !== records.length,
        usedBytes: Math.max(0, used),
        overBudget: used > budgetBytes
      };
    },

    async getStorageInfo() {
      const records = await getAll(CAPTURES);
      const pendings = await getAll(PENDING_TRANSFERS);
      const usedBytes = records.reduce((sum, record) => sum + (record.meta?.byteSize ?? 0), 0);
      return {
        usedBytes,
        captureCount: records.length,
        pendingTransferCount: pendings.length,
        budgetBytes,
        overBudget: usedBytes > budgetBytes
      };
    }
  };
}
