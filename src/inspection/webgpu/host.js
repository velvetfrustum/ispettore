import { describeWebGpuEvent } from './eventState.js';
import { createCaptureRepository } from '../../shared/storage/captureRepository.js';
import { createTransferId } from '../../shared/storage/transferProtocol.js';
import { validateWebGpuPackage, WEBGPU_CAPTURE_SCHEMA, WEBGPU_CAPTURE_VERSION } from './package.js';
import { lookupWebGpuCapture } from './lookup.js';
import { diffCapturePackages } from '../../shared/capture/diff.js';

const root = document.getElementById('inspection-root');
const repository = createCaptureRepository({ validatePackage: (capture) => validateWebGpuPackage(capture) });

let currentCaptureId = null;
let currentCapture = null;

function summarizeCommand(command, commandIndex) {
  return {
    commandIndex,
    op: command?.op ?? 'unknown',
    argTypes: command?.argTypes ?? null,
    args: Array.isArray(command?.args)
      ? command.args.map((value) =>
          value && typeof value === 'object' && value.blob != null ? { blob: value.blob } : value
        )
      : command?.args ?? null,
    resultId: command?.resultId ?? null,
    failed: command?.failed ?? null,
    error: command?.error ?? null,
    durationMs: Number.isFinite(command?.durationMs) ? command.durationMs : null,
    semantic: null
  };
}

function describeWebGpuCapture(capture) {
  const blobs = Array.isArray(capture?.blobs) ? capture.blobs : [];
  const commands = (Array.isArray(capture?.commands) ? capture.commands : []).map(summarizeCommand);
  return {
    schema: capture?.schema ?? WEBGPU_CAPTURE_SCHEMA,
    version: capture?.version ?? WEBGPU_CAPTURE_VERSION,
    capturedAt: capture?.capturedAt ?? null,
    context: capture?.context ?? null,
    inspectionStatus: capture?.inspectionStatus ?? { level: 'supported', reasons: [] },
    frames: Array.isArray(capture?.frames) ? capture.frames : [],
    events: Array.isArray(capture?.events) ? capture.events : [],
    commands,
    blobCount: blobs.length,
    blobBytes: blobs.reduce((sum, blob) => sum + (blob?.byteLength ?? 0), 0)
  };
}

function withEventState(capture, result) {
  if (!result?.ok || !Number.isInteger(result.selectedCommandIndex)) return result;
  const commandIndex = result.selectedCommandIndex;
  const command = capture.commands?.[commandIndex];
  let details = null;
  try {
    details = describeWebGpuEvent(capture, commandIndex);
  } catch (error) {
    details = { api: 'webgpu', kind: 'other', error: `Pipeline state could not be rebuilt: ${error?.message ?? error}` };
  }
  return {
    ...result,
    command: command
      ? { commandIndex, op: command.op, resultId: command.resultId ?? null, durationMs: command.durationMs ?? null, gpuTimingMs: null }
      : null,
    details
  };
}

async function describeStoredEvent(captureId, { eid, commandIndex } = {}) {
  const record = await repository.getCapture(captureId);
  if (!record) throw new Error('Capture not found');
  const capture = record.package;
  const resolvedIndex = eid != null
    ? capture.events?.find((event) => event.eid === eid)?.commandIndex
    : commandIndex;
  if (!Number.isInteger(resolvedIndex) || resolvedIndex < 0 || resolvedIndex >= capture.commands.length) {
    throw new RangeError('The requested event is not in the capture');
  }
  return withEventState(capture, {
    ok: true,
    selectedCommandIndex: resolvedIndex,
    width: null,
    height: null,
    inspectionStatus: capture.inspectionStatus ?? { level: 'supported', reasons: [] }
  });
}

async function inspectStoredCapture(captureId, options) {
  if (currentCaptureId !== captureId || !currentCapture) {
    const record = await repository.getCapture(captureId);
    if (!record) throw new Error('Capture not found');
    currentCaptureId = captureId;
    currentCapture = record.package;
  }
  return withEventState(currentCapture, lookupWebGpuCapture(currentCapture, options));
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

window.__ISPETTORE_WEBGPU_INSPECTOR__ = {
  schema: WEBGPU_CAPTURE_SCHEMA,
  version: WEBGPU_CAPTURE_VERSION,
  inspect(capture, options = {}) {
    validateWebGpuPackage(capture);
    const result = withEventState(capture, lookupWebGpuCapture(capture, options));
    if (result.color?.preview) {
      const image = document.createElement('img');
      image.src = result.color.preview;
      image.alt = 'Captured color output';
      root.replaceChildren(image);
    } else {
      root.textContent = result.color?.reason ?? 'No live preview was captured.';
    }
    return result;
  },
  restart() {
    currentCaptureId = null;
    currentCapture = null;
    return { ok: true };
  },
  async listStoredCaptures() {
    return { ok: true, captures: await repository.listCaptureSummaries() };
  },
  async getStoredCapture(captureId) {
    const record = await repository.getCapture(captureId);
    return record ? { ok: true, capture: record.package } : { ok: false, error: 'Capture not found' };
  },
  async storeCapture(capture, captureId = createTransferId()) {
    const record = await repository.putCapture({
      captureId,
      package: validateWebGpuPackage(capture),
      source: { imported: true }
    });
    return { ok: true, captureId: record.captureId };
  },
  async deleteStoredCapture(captureId) {
    const removed = await repository.deleteCapture(captureId);
    return { ok: Boolean(removed), removed: Boolean(removed) };
  },
  async exportStoredCapture(captureId) {
    const record = await repository.getCapture(captureId);
    if (!record) return { ok: false, error: 'Capture not found' };
    return {
      ok: true,
      captureId,
      filename: `ispettore-webgpu-${captureId}.json`,
      data: JSON.stringify(record.package)
    };
  },
  async downloadStoredCapture(captureId) {
    const exported = await window.__ISPETTORE_WEBGPU_INSPECTOR__.exportStoredCapture(captureId);
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
      return await this.storeCapture(capture);
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  },
  async inspectStored(captureId, options = {}) {
    const record = await repository.getCapture(captureId);
    if (!record) return { ok: false, error: 'Capture not found' };
    return this.inspect(record.package, options);
  }};

window.addEventListener('message', (event) => {
  const message = event.data;
  if (!message || message.type !== 'ISPETTORE_INSPECT' || !Number.isInteger(message.id)) return;
  const api = window.__ISPETTORE_WEBGPU_INSPECTOR__;

  (async () => {
    const { command, payload = {} } = message;
    switch (command) {
      case 'listStoredCaptures':
        return api.listStoredCaptures();

      case 'describeCapture': {
        const record = await repository.getCapture(payload.captureId);
        if (!record) return { ok: false, error: 'Capture not found' };
        return {
          ok: true,
          captureId: payload.captureId,
          view: describeWebGpuCapture(record.package),
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
        return inspectStoredCapture(payload.captureId, payload);

      case 'describeEvent':
        return describeStoredEvent(payload.captureId, payload);

      case 'restart':
        currentCaptureId = null;
        currentCapture = null;
        return { ok: true };

      case 'deleteStoredCapture': {
        const result = await api.deleteStoredCapture(payload.captureId);
        if (currentCaptureId === payload.captureId) {
          currentCaptureId = null;
          currentCapture = null;
        }
        await refreshIndex();
        return result;
      }

      case 'diff': {
        const [a, b] = await Promise.all([
          repository.getCapture(payload.captureIdA),
          repository.getCapture(payload.captureIdB)
        ]);
        if (!a || !b) return { ok: false, error: 'One of the compared captures is missing' };
        return { ok: true, diff: diffCapturePackages(a.package, b.package) };
      }

      case 'downloadStoredCapture':
        return api.downloadStoredCapture(payload.captureId);

      case 'importCapture':
        return api.importCapture(payload.data);

      default:
        return { ok: false, error: `Unknown WebGPU inspection command ${command}` };
    }
  })()
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
