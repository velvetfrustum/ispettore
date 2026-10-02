import { getWebGpuContextId } from './objectRegistry.js';
import { webGpuEventKind } from '../../../inspection/webgpu/events.js';

function captureStack() {
  return (new Error().stack ?? '').split('\n').slice(1).map((line) => line.trim())
    .filter((line) => line && !line.includes('chrome-extension://')).slice(0, 20);
}

export function createWebGpuDeviceJournal(device, { adapter, deviceRequest } = {}) {
  const commands = [];
  const frames = [];
  const registry = new Map();
  const resources = {};
  let currentFrame = null;
  let armed = false;
  let recording = false;
  let pendingPreviews = [];
  let lastTimestamp = performance.now();
  let sequence = 0;
  let pendingCount = 0;
  let registrations = 0;

  function pruneResources() {
    const reachable = new Set();
    const visit = (value) => {
      if (!value || typeof value !== 'object') return;
      if (typeof value.ref === 'string') {
        if (reachable.has(value.ref)) return;
        reachable.add(value.ref);
        visit(registry.get(value.ref)?.metadata.args);
      } else {
        for (const item of Object.values(value)) visit(item);
      }
    };
    for (const [id, entry] of registry) if (entry.ref.deref()) visit({ ref: id });
    for (const id of registry.keys()) if (!reachable.has(id)) registry.delete(id);
  }

  function retain(value) {
    if (!value || typeof value !== 'object' || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return;
    if (typeof value.ref === 'string') {
      const id = value.ref;
      if (resources[id]) return;
      const entry = registry.get(id);
      if (!entry) return;
      resources[id] = entry.metadata;
      retain(entry.metadata.args);
      return;
    }
    for (const item of Object.values(value)) retain(item);
  }

  const journal = {
    device,
    contextId: getWebGpuContextId(device),
    adapterInfo: { vendor: adapter?.info?.vendor ?? '', architecture: adapter?.info?.architecture ?? '' },
    deviceInfo: { features: [...device.features], limits: Object.fromEntries(Object.keys(device.limits).map((key) => [key, device.limits[key]])) },
    deviceRequest: deviceRequest ?? null,
    commands,
    resources,
    submissionCount: 0,
    get frames() { return frames.slice(); },
    get isArmed() { return armed; },
    get recording() { return recording; },
    get previewFrame() { return recording ? currentFrame : null; },
    get frameId() { return recording ? currentFrame?.frameId : null; },
    registerResource(id, object, metadata) {
      registry.set(id, { ref: new WeakRef(object), metadata });
      if (++registrations % 256 === 0) pruneResources();
    },
    forgetResource(id) { registry.delete(id); },
    addPreview(pending) {
      pendingCount++;
      pendingPreviews.push(pending.finally(() => { pendingCount--; }));
    },
    async collectPendingPreviews() { await Promise.all(pendingPreviews); },
    arm() {
      if (recording || armed || pendingCount) return false;
      armed = true;
      return true;
    },
    ensureFrame() {
      if (armed && !currentFrame) {
        const frameId = `${this.contextId}:on-demand:${++sequence}`;
        this.markFrameStart({ frameId, kind: 'on-demand', label: 'on-demand submission' });
        queueMicrotask(() => {
          if (currentFrame?.frameId === frameId) this.markFrameEnd();
        });
      }
      return recording;
    },
    markFrameStart({ frameId, label = 'frame', kind = 'animation-frame' }) {
      if (typeof frameId !== 'string' || !frameId) throw new TypeError('Capture frames require a frame id');
      if (currentFrame) this.markFrameEnd();
      currentFrame = { frameId, label, kind, startCommandIndex: 0 };
      if (!armed) return;
      armed = false;
      recording = true;
      commands.length = 0;
      frames.length = 0;
      pendingPreviews = [];
      for (const id of Object.keys(resources)) delete resources[id];
      pruneResources();
      lastTimestamp = performance.now();
    },
    markFrameEnd() {
      if (!currentFrame) return;
      if (recording) {
        if (commands.some((command) => webGpuEventKind(command.op, command) || command.op === 'submit')) {
          frames.push({ ...currentFrame, endCommandIndex: commands.length, commandCount: commands.length });
        } else {
          armed = true;
          commands.length = 0;
        }
      }
      recording = false;
      currentFrame = null;
    },
    record(entry) {
      if (!recording) return null;
      const now = performance.now();
      const command = {
        op: entry.op, argTypes: entry.argTypes ?? [], args: entry.args ?? [],
        resultId: entry.resultId ?? null, receiverId: entry.receiverId ?? null,
        failed: entry.failed ?? null, error: entry.error ?? null,
        durationMs: Math.max(0, Math.round((now - lastTimestamp) * 1000) / 1000)
      };
      lastTimestamp = now;
      retain(command.args);
      if (command.resultId) retain({ ref: command.resultId });
      if (command.receiverId) retain({ ref: command.receiverId });
      const kind = webGpuEventKind(command.op, command);
      if (kind) {
        command.stackTrace = captureStack();
        const reason = kind === 'dispatch'
          ? 'Compute dispatch output is not a color attachment; GPU-written buffer/texture contents were not captured for this dispatch.'
          : kind === 'draw'
            ? 'No live image was captured for this draw. Only the final draw of a supported submitted render pass has a preview.'
            : 'This operation has no captured color output.';
        command.preview = { color: { available: false, reason }, reasons: [reason] };
      }
      commands.push(command);
      return command;
    },
    recordFailure(op, stage, error) { return this.record({ op, failed: stage, error }); }
  };
  return journal;
}
