import { createWebGlPackage, encodeWebGlBlob, validateWebGlPackage } from './package.js';
import { lookupWebGlCapture } from './lookup.js';
import { describeWebGlCapture } from './view.js';
import { diffWebGlPackages } from './diff.js';
import { createCaptureRepository } from '../../shared/storage/captureRepository.js';
import { createTransferId } from '../../shared/storage/transferProtocol.js';

const repository = createCaptureRepository({ validatePackage: (capture) => validateWebGlPackage(capture) });

let currentCaptureId = null;
let currentCapture = null;

async function inspectCapture(captureId, options) {
  if (currentCaptureId !== captureId || !currentCapture) {
    return { ok: false, error: 'Capture is not loaded' };
  }
  const target = options.eid != null ? options.eid : options.commandIndex != null ? options.commandIndex : null;
  if (target == null) {
    return { ok: false, error: 'An event id or command index is required' };
  }
  try {
    return { ok: true, ...lookupWebGlCapture(currentCapture, options) };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

function refreshIndex() {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: 'ISPETTORE_STORAGE', command: 'refreshIndex' }, () => {
        resolve(!chrome.runtime.lastError);
      });
    } catch (_) {
      resolve(false);
    }
  });
}

window.__ISPETTORE_WEBGL_INSPECTOR__ = {
  createPackage: createWebGlPackage,
  encodeBlob: encodeWebGlBlob,
  inspect(capture, options) {
    capture = validateWebGlPackage(capture, { validateBlobData: false });
    return lookupWebGlCapture(capture, options ?? {});
  },
  async listStoredCaptures() {
    return { ok: true, captures: await repository.listCaptureSummaries() };
  },
  async getStoredCapture(captureId) {
    const record = await repository.getCapture(captureId);
    return record ? { ok: true, capture: record.package } : { ok: false, error: 'Capture not found' };
  },
  async deleteStoredCapture(captureId) {
    const removed = await repository.deleteCapture(captureId);
    await refreshIndex();
    return { ok: Boolean(removed), removed: Boolean(removed) };
  },
  async inspectStored(captureId, options) {
    const record = await repository.getCapture(captureId);
    if (!record) return { ok: false, error: 'Capture not found' };
    return { ok: true, ...lookupWebGlCapture(record.package, options ?? {}) };
  },
  async exportStoredCapture(captureId) {
    const record = await repository.getCapture(captureId);
    if (!record) return { ok: false, error: 'Capture not found' };
    return {
      ok: true,
      captureId,
      filename: `ispettore-${captureId}.json`,
      data: JSON.stringify(record.package),
      meta: { ...(record.meta ?? {}) }
    };
  },
  async downloadStoredCapture(captureId) {
    const exported = await window.__ISPETTORE_WEBGL_INSPECTOR__.exportStoredCapture(captureId);
    if (!exported.ok) return exported;
    const blob = new Blob([exported.data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = exported.filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return { ok: true, captureId, filename: exported.filename };
  },
  async importCapture(data) {
    let capture = data;
    if (typeof data === 'string') {
      try {
        capture = JSON.parse(data);
      } catch (error) {
        return { ok: false, error: `Imported capture is not valid JSON: ${error?.message ?? error}` };
      }
    }
    if (capture == null || typeof capture !== 'object') {
      return { ok: false, error: 'Imported capture is empty' };
    }
    try {
      const captureId = createTransferId();
      const record = await repository.putCapture({
        captureId,
        package: capture,
        source: { imported: true }
      });
      await refreshIndex();
      return { ok: true, captureId: record.captureId };
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  }
};

async function handleInspectionMessage(message) {
  const { command, payload = {} } = message;

  switch (command) {
    case 'listStoredCaptures':
      return window.__ISPETTORE_WEBGL_INSPECTOR__.listStoredCaptures();

    case 'describeCapture': {
      const record = await repository.getCapture(payload.captureId);
      if (!record) return { ok: false, error: 'Capture not found' };
      return {
        ok: true,
        captureId: payload.captureId,
        view: describeWebGlCapture(record.package),
        meta: record.meta ?? {}
      };
    }

    case 'loadCapture': {
      const record = await repository.getCapture(payload.captureId);
      if (!record) return { ok: false, error: 'Capture not found' };
      currentCaptureId = payload.captureId;
      currentCapture = record.package;
      return { ok: true, captureId: payload.captureId };
    }

    case 'inspect':
      return inspectCapture(payload.captureId, payload);

    case 'restart': {
      currentCaptureId = null;
      currentCapture = null;
      return { ok: true };
    }

    case 'deleteStoredCapture': {
      const result = await window.__ISPETTORE_WEBGL_INSPECTOR__.deleteStoredCapture(payload.captureId);
      if (currentCaptureId === payload.captureId) {
        currentCaptureId = null;
        currentCapture = null;
      }
      return result;
    }

    case 'diff': {
      const [a, b] = await Promise.all([
        repository.getCapture(payload.captureIdA),
        repository.getCapture(payload.captureIdB)
      ]);
      if (!a || !b) return { ok: false, error: 'One of the compared captures is missing' };
      return { ok: true, diff: diffWebGlPackages(a.package, b.package) };
    }

    default:
      return { ok: false, error: `Unknown inspection command ${command}` };
  }
}

window.addEventListener('message', (event) => {
  const message = event.data;
  if (!message || message.type !== 'ISPETTORE_INSPECT' || !Number.isInteger(message.id)) return;

  handleInspectionMessage(message)
    .then((result) => {
      event.source?.postMessage(
        { type: 'ISPETTORE_INSPECT_RESULT', id: message.id, ...result },
        event.origin
      );
    })
    .catch((error) => {
      event.source?.postMessage(
        {
          type: 'ISPETTORE_INSPECT_RESULT',
          id: message.id,
          ok: false,
          error: error?.message || String(error)
        },
        event.origin
      );
    });
});
