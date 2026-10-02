import { decodeBinaryBlob } from '../../shared/capture/blobs.js';
import { createWebGpuEvents, webGpuEventKind } from './events.js';

export const WEBGPU_CAPTURE_SCHEMA = 'ispettore-webgpu-capture';
export const WEBGPU_CAPTURE_VERSION = 2;

const INSPECTION_STATUS_LEVELS = new Set(['supported', 'degraded', 'unsupported']);

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

export function createWebGpuPackage({
  context,
  commands,
  resources = {},
  blobs = [],
  frames = [],
  events,
  inspectionStatus = {}
}) {
  const capture = {
    schema: WEBGPU_CAPTURE_SCHEMA,
    version: WEBGPU_CAPTURE_VERSION,
    context: { api: 'webgpu', ...context },
    commands: commands.map((command) => ({ ...command })),
    resources: { ...resources },
    blobs: blobs.map((blob) => ({ ...blob })),
    frames: frames.map((frame) => ({ ...frame })),
    events: (events ?? createWebGpuEvents(commands, frames)).map((event) => ({ ...event })),
    inspectionStatus: { level: 'supported', reasons: [], ...inspectionStatus }
  };
  validateWebGpuPackage(capture);
  return capture;
}

export function validateWebGpuPackage(capture) {
  if (capture?.schema !== WEBGPU_CAPTURE_SCHEMA || ![1, WEBGPU_CAPTURE_VERSION].includes(capture.version)) {
    throw new TypeError('Unsupported WebGPU capture package');
  }
  if (capture.context?.api !== 'webgpu' || !isPlainObject(capture.context)) {
    throw new TypeError('Invalid WebGPU capture context');
  }
  if (!Array.isArray(capture.commands) || !Array.isArray(capture.blobs)) {
    throw new TypeError('WebGPU capture commands and blobs must be arrays');
  }
  if (capture.version === 2) {
    if (!isPlainObject(capture.resources)) throw new TypeError('WebGPU live captures require resource metadata');
    for (const resource of Object.values(capture.resources)) {
      if (!isPlainObject(resource) || typeof resource.op !== 'string' || !Array.isArray(resource.args)) {
        throw new TypeError('Invalid WebGPU resource metadata');
      }
    }
  }
  const blobIds = new Set();
  for (const blob of capture.blobs) {
    if (!blob?.id || blobIds.has(blob.id)) throw new TypeError('WebGPU capture blob ids must be unique');
    decodeBinaryBlob(blob);
    blobIds.add(blob.id);
  }
  if (capture.inspectionStatus && !INSPECTION_STATUS_LEVELS.has(capture.inspectionStatus.level)) {
    throw new TypeError('Invalid WebGPU capture inspection status level');
  }
  for (const command of capture.commands) {
    if (!command || typeof command.op !== 'string') {
      throw new TypeError('Every WebGPU capture command requires an opcode');
    }
    if (command.failed) {
      if (!command.error) throw new TypeError('Failed WebGPU capture commands require an error reason');
      continue;
    }
    if (!Array.isArray(command.args) || !Array.isArray(command.argTypes)) {
      throw new TypeError('WebGPU capture commands require positional args and argTypes');
    }
    if (command.args.length !== command.argTypes.length) {
      throw new TypeError('WebGPU capture command args and argTypes must have equal length');
    }
  }
  if (!Array.isArray(capture.frames)) {
    throw new TypeError('WebGPU capture frames must be an array');
  }
  const frameById = new Map();
  let previousEnd = 0;
  for (const frame of capture.frames) {
    if (!frame || typeof frame.frameId !== 'string' || !frame.frameId) {
      throw new TypeError('WebGPU capture frames require a frame id');
    }
    if (frameById.has(frame.frameId)) throw new TypeError('WebGPU capture frame ids must be unique');
    if (
      !Number.isInteger(frame.startCommandIndex) ||
      frame.startCommandIndex < previousEnd ||
      !Number.isInteger(frame.endCommandIndex) ||
      frame.endCommandIndex <= frame.startCommandIndex ||
      frame.endCommandIndex > capture.commands.length
    ) {
      throw new TypeError('WebGPU capture frame command indexes must be ordered and in range');
    }
    if (frame.commandCount !== frame.endCommandIndex - frame.startCommandIndex) {
      throw new TypeError('WebGPU capture frame command counts must match their indexes');
    }
    if (!Number.isFinite(frame.byteSize) || frame.byteSize < 0) {
      throw new TypeError('WebGPU capture frame size statistics must be non-negative');
    }
    frameById.set(frame.frameId, frame);
    previousEnd = frame.endCommandIndex;
  }
  if (!Array.isArray(capture.events)) {
    throw new TypeError('WebGPU capture events must be an array');
  }
  const seenEids = new Set();
  let previousEventCommandIndex = -1;
  for (const event of capture.events) {
    const frame = frameById.get(event?.frameId);
    if (!Number.isInteger(event?.eid) || event.eid < 1 || seenEids.has(event.eid)) {
      throw new TypeError('WebGPU capture EIDs must be unique positive integers');
    }
    if (
      !frame ||
      !Number.isInteger(event.commandIndex) ||
      event.commandIndex < frame.startCommandIndex ||
      event.commandIndex >= frame.endCommandIndex ||
      event.commandIndex <= previousEventCommandIndex
    ) {
      throw new TypeError('WebGPU capture event command indexes must be ordered and inside their frame');
    }
    if (typeof event.kind !== 'string' || typeof event.op !== 'string' || typeof event.label !== 'string') {
      throw new TypeError('WebGPU capture events require kind, operation, and label strings');
    }
    if (webGpuEventKind(event.op, capture.commands[event.commandIndex]) !== event.kind) {
      throw new TypeError(`WebGPU capture event kind does not match its operation: ${event.op}`);
    }
    seenEids.add(event.eid);
    previousEventCommandIndex = event.commandIndex;
  }
  return capture;
}
