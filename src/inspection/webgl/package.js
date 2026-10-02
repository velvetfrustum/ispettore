import { createWebGlEvents } from './events.js';
import { decodeBinaryBlob, encodeBinaryBlob } from '../../shared/capture/blobs.js';

const WEBGL_CAPTURE_SCHEMA = 'ispettore-webgl-capture';
const WEBGL_CAPTURE_VERSION = 1;

export function encodeWebGlBlob(id, value) {
  return encodeBinaryBlob(id, value);
}

export function decodeWebGlBlob(blob) {
  return decodeBinaryBlob(blob);
}

export function createWebGlPackage({ width, height, attributes = {}, context = {}, commands, blobs = [], frames = [], events, programs = {}, checkpoint = null, inspectionStatus = {} }) {
  const copiedCommands = commands?.map((command) => ({ ...command })) ?? [];
  const copiedFrames = frames.map((frame) =>
    frame.prefix ? { ...frame, prefix: { ...frame.prefix } } : { ...frame }
  );
  const capture = {
    schema: WEBGL_CAPTURE_SCHEMA,
    version: WEBGL_CAPTURE_VERSION,
    context: {
      api: 'webgl',
      width,
      height,
      attributes: { ...attributes },
      ...context
    },
    commands: copiedCommands,
    blobs: blobs.map((blob) => ({ ...blob })),
    frames: copiedFrames,
    events: (events ?? createWebGlEvents(copiedCommands, copiedFrames)).map((event) => ({ ...event })),
    programs: { ...programs },
    checkpoint: checkpoint
      ? { ...checkpoint, buffers: (checkpoint.buffers ?? []).map((buffer) => ({ ...buffer })) }
      : null,
    inspectionStatus: {
      level: 'supported',
      reasons: [],
      ...inspectionStatus
    }
  };
  validateWebGlPackage(capture);
  return capture;
}

export function validateWebGlPackage(capture, { validateBlobData = true } = {}) {
  if (capture?.schema !== WEBGL_CAPTURE_SCHEMA || capture.version !== WEBGL_CAPTURE_VERSION) {
    throw new TypeError('Unsupported WebGL capture package');
  }
  if (
    capture.context?.api !== 'webgl' ||
    !Number.isInteger(capture.context.width) ||
    capture.context.width < 1 ||
    !Number.isInteger(capture.context.height) ||
    capture.context.height < 1
  ) {
    throw new TypeError('Invalid WebGL capture context');
  }
  if (capture.context.version != null && capture.context.version !== 1 && capture.context.version !== 2) {
    throw new TypeError('WebGL capture context version must be 1 or 2');
  }
  if (capture.programs != null && (typeof capture.programs !== 'object' || Array.isArray(capture.programs))) {
    throw new TypeError('WebGL capture programs must be an object keyed by program id');
  }
  if (!Array.isArray(capture.commands) || !Array.isArray(capture.blobs)) {
    throw new TypeError('WebGL capture commands and blobs must be arrays');
  }
  const blobIds = new Set();
  for (const blob of capture.blobs) {
    if (!blob?.id || blobIds.has(blob.id)) throw new TypeError('WebGL capture blob ids must be unique');
    if (validateBlobData) decodeWebGlBlob(blob);
    blobIds.add(blob.id);
  }
  if (capture.checkpoint != null) {
    const checkpoint = capture.checkpoint;
    if (
      !Number.isInteger(checkpoint.commandIndex) ||
      checkpoint.commandIndex < 0 ||
      checkpoint.commandIndex > capture.commands.length
    ) {
      throw new TypeError('Invalid WebGL capture checkpoint command index');
    }
    if (!Array.isArray(checkpoint.buffers)) {
      throw new TypeError('WebGL capture checkpoint buffers must be an array');
    }
    for (const buffer of checkpoint.buffers) {
      if (typeof buffer?.id !== 'string' || !buffer.id) {
        throw new TypeError('WebGL capture checkpoint buffer requires an id');
      }
      if (!Number.isInteger(buffer.byteLength) || buffer.byteLength < 0) {
        throw new TypeError('Invalid WebGL capture checkpoint buffer byte length');
      }
      if (!blobIds.has(buffer.blob)) {
        throw new TypeError(`WebGL capture checkpoint buffer references an unknown blob: ${buffer.blob}`);
      }
    }
  }

  const levels = new Set(['supported', 'degraded', 'unsupported']);
  if (capture.inspectionStatus && !levels.has(capture.inspectionStatus.level)) {
    throw new TypeError('Invalid WebGL capture inspection status level');
  }
  for (const command of capture.commands) {
    if (!command || typeof command.op !== 'string') {
      throw new TypeError('Every WebGL capture command requires an opcode');
    }
    if (command.failed) {
      if (!command.error) throw new TypeError('Failed WebGL capture commands require an error reason');
      continue;
    }
    if (!Array.isArray(command.args) || !Array.isArray(command.argTypes)) {
      throw new TypeError('WebGL capture commands require positional args and argTypes');
    }
    if (command.args.length !== command.argTypes.length) {
      throw new TypeError('WebGL capture command args and argTypes must have equal length');
    }
    if (command.semantic != null && (typeof command.semantic !== 'object' || Array.isArray(command.semantic))) {
      throw new TypeError('WebGL capture command semantic annotations must be objects');
    }
  }
  if (capture.context.overflow != null) {
    if (
      (capture.context.overflow.kind !== 'command-count' && capture.context.overflow.kind !== 'bytes') ||
      !Number.isInteger(capture.context.overflow.limit) ||
      capture.context.overflow.limit < 0 ||
      !Number.isInteger(capture.context.overflow.captured) ||
      capture.context.overflow.captured < capture.context.overflow.limit
    ) {
      throw new TypeError('Invalid WebGL capture overflow status');
    }
  }
  if (!Array.isArray(capture.frames)) {
    throw new TypeError('WebGL capture frames must be an array');
  }
  const frameById = new Map();
  let previousEnd = 0;
  for (const frame of capture.frames) {
    if (!frame || typeof frame.frameId !== 'string' || !frame.frameId) {
      throw new TypeError('WebGL capture frames require a frame id');
    }
    if (frameById.has(frame.frameId)) throw new TypeError('WebGL capture frame ids must be unique');
    if (
      !Number.isInteger(frame.startCommandIndex) ||
      frame.startCommandIndex < previousEnd ||
      !Number.isInteger(frame.endCommandIndex) ||
      frame.endCommandIndex <= frame.startCommandIndex ||
      frame.endCommandIndex > capture.commands.length
    ) {
      throw new TypeError('WebGL capture frame command indexes must be ordered and in range');
    }
    if (typeof frame.label !== 'string' || typeof frame.kind !== 'string') {
      throw new TypeError('WebGL capture frames require a label and kind');
    }
    if (frame.commandCount !== frame.endCommandIndex - frame.startCommandIndex) {
      throw new TypeError('WebGL capture frame command counts must match their indexes');
    }
    if (!Number.isInteger(frame.blobCount) || frame.blobCount < 0 || !Number.isFinite(frame.byteSize) || frame.byteSize < 0) {
      throw new TypeError('WebGL capture frame size statistics must be non-negative');
    }
    if (frame.prefix != null) {
      if (
        frame.prefix.endCommandIndex !== frame.endCommandIndex ||
        frame.prefix.commandCount !== frame.endCommandIndex ||
        !Number.isFinite(frame.prefix.byteSize) ||
        frame.prefix.byteSize < 0
      ) {
        throw new TypeError('WebGL capture frame reconstruction prefixes must match their indexes');
      }
    }
    frameById.set(frame.frameId, frame);
    previousEnd = frame.endCommandIndex;
  }
  if (!Array.isArray(capture.events)) {
    throw new TypeError('WebGL capture events must be an array');
  }
  const seenEids = new Set();
  let previousEventCommandIndex = -1;
  for (const event of capture.events) {
    const frame = frameById.get(event?.frameId);
    if (!Number.isInteger(event?.eid) || event.eid < 1 || seenEids.has(event.eid)) {
      throw new TypeError('WebGL capture EIDs must be unique positive integers');
    }
    if (
      !frame ||
      !Number.isInteger(event.commandIndex) ||
      event.commandIndex < frame.startCommandIndex ||
      event.commandIndex >= frame.endCommandIndex ||
      event.commandIndex <= previousEventCommandIndex
    ) {
      throw new TypeError('WebGL capture event command indexes must be ordered and inside their frame');
    }
    if (typeof event.kind !== 'string' || typeof event.op !== 'string' || typeof event.label !== 'string') {
      throw new TypeError('WebGL capture events require kind, operation, and label strings');
    }
    seenEids.add(event.eid);
    previousEventCommandIndex = event.commandIndex;
  }
  if (capture.context.resizes != null) {
    if (!Array.isArray(capture.context.resizes)) {
      throw new TypeError('WebGL capture context resizes must be an array');
    }
    let previousCommandIndex = -1;
    for (const resize of capture.context.resizes) {
      if (
        !Number.isInteger(resize?.commandIndex) ||
        resize.commandIndex < previousCommandIndex ||
        resize.commandIndex > capture.commands.length
      ) {
        throw new TypeError('WebGL capture resize command indexes must be ordered and in range');
      }
      previousCommandIndex = resize.commandIndex;
    }
  }
  return capture;
}
