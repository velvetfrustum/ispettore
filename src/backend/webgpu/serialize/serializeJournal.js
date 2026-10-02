import { textByteLength } from '../../../shared/storage/hash.js';
import { encodeBinaryBlob } from '../../../shared/capture/blobs.js';
import { createWebGpuPackage } from '../../../inspection/webgpu/package.js';

const BINARY_TAG = /^(typed-array:[A-Za-z0-9]+|array-buffer|shared-array-buffer|data-view)$/;

export function serializeWebGpuJournal(journal, { frameId } = {}) {
  if (!journal || !Array.isArray(journal.commands)) throw new TypeError('A WebGPU device journal is required');
  const frame = frameId ? journal.frames.find((candidate) => candidate.frameId === frameId) : journal.frames.at(-1);
  if (frameId && !frame) throw new RangeError(`WebGPU capture frame ${frameId} is not available`);
  const blobs = [];
  const commands = (frame ? journal.commands.slice(frame.startCommandIndex, frame.endCommandIndex) : []).map((command) => ({
    ...command,
    args: command.failed ? null : command.args.map((value, index) => {
      if (!BINARY_TAG.test(command.argTypes[index])) return value;
      const id = `blob-${blobs.length + 1}`;
      blobs.push(encodeBinaryBlob(id, value));
      return { blob: id };
    }),
    argTypes: command.failed ? null : [...command.argTypes]
  }));
  const failures = commands.filter((command) => command.failed).map((command) => `captured ${command.op} failed (${command.failed}): ${command.error}`);
  failures.push(...(journal.captureWarnings ?? []));
  const previewReasons = commands.flatMap((command) => command.preview?.reasons ?? []);
  const reasons = [...new Set([...failures, ...previewReasons])];
  const frames = frame ? [{
    ...frame, startCommandIndex: 0, endCommandIndex: commands.length, commandCount: commands.length,
    blobCount: blobs.length, byteSize: textByteLength(JSON.stringify(commands)) + blobs.reduce((size, blob) => size + textByteLength(blob.data), 0)
  }] : [];
  return createWebGpuPackage({
    context: {
      adapter: journal.adapterInfo ?? {}, device: journal.deviceInfo ?? {}, deviceRequest: journal.deviceRequest ?? null,
      configuration: journal.configuration ?? null, canvas: journal.canvas ?? null,
      captureMode: 'live', recordedFromContextCreation: false, overflow: null
    },
    commands, resources: { ...journal.resources }, blobs, frames,
    inspectionStatus: { level: failures.length ? 'unsupported' : reasons.length ? 'degraded' : 'supported', reasons }
  });
}
