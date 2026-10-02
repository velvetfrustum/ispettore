import { textByteLength } from '../../../shared/storage/hash.js';
import { createWebGlPackage, encodeWebGlBlob } from '../../../inspection/webgl/package.js';

const IMAGE_UPLOAD_METHODS = new Set(['texImage2D', 'texSubImage2D']);

function isBlobType(type) {
  return (
    type === 'data-view' ||
    type === 'array-buffer' ||
    type === 'shared-array-buffer' ||
    type === 'image-source' ||
    (typeof type === 'string' && type.startsWith('typed-array:'))
  );
}

function normalizeImageUpload(op, args, argTypes, source) {
  if (!source || typeof source !== 'object') return null;
  const blobType = 'image-source';
  const { width, height } = source;

  if (op === 'texImage2D' && args.length === 6) {
    return {
      args: [args[0], args[1], args[2], width, height, 0, args[3], args[4], source.pixels],
      argTypes: [argTypes[0], argTypes[1], argTypes[2], 'number', 'number', 'number', argTypes[3], argTypes[4], blobType]
    };
  }

  if (op === 'texSubImage2D' && args.length === 7) {
    return {
      args: [args[0], args[1], args[2], args[3], width, height, args[4], args[5], source.pixels],
      argTypes: [argTypes[0], argTypes[1], argTypes[2], argTypes[3], 'number', 'number', argTypes[4], argTypes[5], blobType]
    };
  }

  return null;
}

/**
 * Every significant command's preview is baked live, from the real framebuffer, at the
 * moment it executed — so none of the reasons below ever make a preview wrong, only the
 * raw command log incomplete. Under the Spector-style live capture model (docs/PLAN.md,
 * Phase 9) that is always at most a 'degraded' outcome, never 'unsupported'.
 */
function inspectionStatusFromJournal(journal, failures, commandCount = journal.commands.length) {
  const reasons = [];
  const seen = new Set();
  for (let index = 0; index < commandCount; index++) {
    const command = journal.commands[index];
    if (!command.failed) continue;
    const reason = `captured ${command.op} failed (${command.failed}): ${command.error ?? 'unknown error'}`;
    if (seen.has(reason)) continue;
    seen.add(reason);
    reasons.push(reason);
  }
  for (const failure of failures) {
    const reason = `captured command is missing from the package: ${failure.op}`;
    if (seen.has(reason)) continue;
    seen.add(reason);
    reasons.push(reason);
  }
  if (journal.overflow) {
    const reason = `capture hit the ${journal.overflow.kind} budget (limit ${journal.overflow.limit}, captured ${journal.overflow.captured})`;
    if (!seen.has(reason)) reasons.push(reason);
  }
  const evicted = journal.evictedCommandCount ?? 0;
  if (evicted > 0) {
    reasons.push(`capture dropped the first ${evicted} command(s) of this frame to stay within the rolling command cap`);
  }
  return {
    level: reasons.length ? 'degraded' : 'supported',
    reasons
  };
}

function referencedBlobIds(referencedBlobs, start, end) {
  const ids = new Set();
  for (let index = start; index < end; index++) {
    for (const id of referencedBlobs[index] ?? []) ids.add(id);
  }
  return ids;
}

function serializeFrames(journal, serializedCommands, blobs, referencedBlobs, rawRanges) {
  const evicted = journal.evictedCommandCount ?? 0;
  const blobByid = new Map(blobs.map((blob) => [blob.id, blob]));
  const commandByteLengths = serializedCommands.map((entry) => textByteLength(JSON.stringify(entry)));
  const commandBytesPrefix = [0];
  for (const length of commandByteLengths) {
    commandBytesPrefix.push(commandBytesPrefix[commandBytesPrefix.length - 1] + length);
  }
  const blobBytesPrefix = [0];
  for (let index = 0; index < referencedBlobs.length; index++) {
    let bytes = blobBytesPrefix[index];
    for (const id of referencedBlobs[index] ?? []) {
      const blob = blobByid.get(id);
      if (blob) bytes += textByteLength(blob.data);
    }
    blobBytesPrefix.push(bytes);
  }
  return rawRanges.map((range) => {
    const start = range.startCommandIndex - evicted;
    const end = range.endCommandIndex - evicted;
    const blobCount = referencedBlobIds(referencedBlobs, start, end).size;
    return {
      frameId: range.frameId,
      label: range.label ?? 'frame',
      kind: range.kind ?? 'animation-frame',
      startCommandIndex: start,
      endCommandIndex: end,
      commandCount: end - start,
      blobCount,
      byteSize: commandBytesPrefix[end] - commandBytesPrefix[start] + (blobBytesPrefix[end] - blobBytesPrefix[start]),
      prefix: {
        endCommandIndex: end,
        commandCount: end,
        byteSize: commandBytesPrefix[end] + blobBytesPrefix[end]
      }
    };
  });
}

/**
 * Serializes a live WebGL2 command journal into a versioned, JSON-safe capture package.
 * Typed-array values become immutable blobs, DOM image uploads are canonicalized to the
 * equivalent pixel-array overload, resource references stay stable ids, and failed capture
 * commands are preserved with explicit inspection-status diagnostics.
 *
 * Recording is bounded to a single armed frame (docs/PLAN.md, Phase 9: Spector-style live
 * capture), so `journal.commands` is already small — there is no prefix to reconstruct or
 * compact. Each significant command (draw/clear/blit/copy) already carries a `preview`
 * baked live at the moment it executed; that preview is carried straight through to the
 * package so the panel's inspection lookup never needs to re-run any command.
 */
export function serializeWebGlJournal(journal, options = {}) {
  if (!journal || !Array.isArray(journal.commands)) {
    throw new TypeError('A WebGL command journal is required');
  }

  const evictedCommandCount = journal.evictedCommandCount ?? 0;
  const journalFrames = Array.isArray(journal.frames) ? journal.frames : [];
  const selectedRange = options.frameId
    ? journalFrames.find((frame) => frame.frameId === options.frameId)
    : null;
  if (options.frameId && !selectedRange) {
    throw new RangeError(`WebGL capture frame ${options.frameId} is not available`);
  }
  const commandCount = selectedRange
    ? selectedRange.endCommandIndex - evictedCommandCount
    : journal.commands.length;
  if (commandCount < 0 || commandCount > journal.commands.length) {
    throw new RangeError(`WebGL capture frame ${options.frameId} is outside the retained journal`);
  }

  const gpuTimings = options.gpuTimings instanceof Map ? options.gpuTimings : null;
  const rawRanges = selectedRange ? [selectedRange] : journalFrames;
  const cache = selectedRange ? null : options.cache ?? null;
  const cachedCount =
    cache &&
    cache.count != null &&
    cache.count <= journal.commands.length &&
    cache.evictedCommandCount === evictedCommandCount
      ? cache.count
      : 0;
  if (cache && cachedCount !== cache.count) {
    cache.count = 0;
    cache.evictedCommandCount = evictedCommandCount;
    cache.serializedCommands = [];
    cache.blobs = [];
    cache.referencedBlobs = [];
  }

  const blobs = cachedCount ? cache.blobs.slice() : [];
  const serializedCommands = cachedCount ? cache.serializedCommands.slice() : [];
  const referencedBlobs = cachedCount ? cache.referencedBlobs.slice() : [];
  const failures = [];
  let blobSequence = cachedCount ? cache.blobs.length : 0;

  for (let commandIndex = 0; commandIndex < commandCount; commandIndex++) {
    const command = journal.commands[commandIndex];

    if (commandIndex < cachedCount) {
      const entry = serializedCommands[commandIndex];
      if (entry.failed === 'missing') failures.push({ op: entry.op ?? 'unknown' });
      continue;
    }

    if (command.failed) {
      serializedCommands.push({
        op: command.op,
        argTypes: null,
        args: null,
        resultId: null,
        failed: command.failed,
        error: command.error ?? null
      });
      referencedBlobs.push([]);
      continue;
    }

    if (!Array.isArray(command.args) || !Array.isArray(command.argTypes)) {
      failures.push({ op: command.op ?? 'unknown' });
      serializedCommands.push({
        op: command.op ?? 'unknown',
        argTypes: null,
        args: null,
        resultId: null,
        failed: 'missing',
        error: 'captured command is missing from the package'
      });
      referencedBlobs.push([]);
      continue;
    }

    let args = [...command.args];
    const argTypes = [...command.argTypes];
    const lastIndex = args.length - 1;

    if (IMAGE_UPLOAD_METHODS.has(command.op) && argTypes[lastIndex] === 'image-source') {
      const normalized = normalizeImageUpload(command.op, args, argTypes, args[lastIndex]);
      if (!normalized) {
        failures.push({ op: command.op });
        serializedCommands.push({
          op: command.op,
          argTypes: null,
          args: null,
          resultId: null,
          failed: 'missing',
          error: 'captured image upload is missing from the package'
        });
        referencedBlobs.push([]);
        continue;
      }
      args = normalized.args;
      argTypes.splice(0, argTypes.length, ...normalized.argTypes);
    }

    const commandBlobIds = [];
    const encodedArgs = args.map((value, index) => {
      const type = argTypes[index];
      if (isBlobType(type)) {
        const id = `blob-${++blobSequence}`;
        try {
          blobs.push(encodeWebGlBlob(id, value));
        } catch (error) {
          throw new TypeError(
            `Captured ${command.op} argument ${index} is not encodable as a blob: ${error?.message ?? error}`
          );
        }
        commandBlobIds.push(id);
        return { blob: id };
      }
      return value;
    });

    serializedCommands.push({
      op: command.op,
      argTypes,
      args: encodedArgs,
      resultId: command.resultId ?? null,
      failed: null,
      error: null,
      semantic: command.semantic ?? null,
      durationMs: Number.isFinite(command.durationMs) ? command.durationMs : null,
      preview: command.preview ?? null,
      details: command.details ?? null,
      status: command.status ?? null,
      gpuTimingMs: gpuTimings?.get(commandIndex) ?? null
    });
    referencedBlobs.push(commandBlobIds);
  }

  if (cache) {
    cache.count = serializedCommands.length;
    cache.evictedCommandCount = evictedCommandCount;
    cache.serializedCommands = serializedCommands;
    cache.blobs = blobs;
    cache.referencedBlobs = referencedBlobs;
  }

  const frames = serializeFrames(journal, serializedCommands, blobs, referencedBlobs, rawRanges);

  const contextInfo = journal.contextInfo ?? {};
  const width = contextInfo.drawingBufferWidth ?? contextInfo.canvasWidth ?? 1;
  const height = contextInfo.drawingBufferHeight ?? contextInfo.canvasHeight ?? 1;

  return createWebGlPackage({
    width,
    height,
    attributes: contextInfo.attributes ?? {},
    context: {
      version: contextInfo.version ?? null,
      canvas:
        contextInfo.canvasWidth == null && contextInfo.canvasHeight == null
          ? null
          : { width: contextInfo.canvasWidth, height: contextInfo.canvasHeight },
      drawingBuffer:
        contextInfo.drawingBufferWidth == null && contextInfo.drawingBufferHeight == null
          ? null
          : { width: contextInfo.drawingBufferWidth, height: contextInfo.drawingBufferHeight },
      capabilities: contextInfo.limits ?? {},
      extensions: contextInfo.supportedExtensions ?? [],
      resizes: Array.isArray(journal.resizes)
        ? journal.resizes
            .filter(
              (resize) =>
                resize != null &&
                typeof resize === 'object' &&
                resize.commandIndex < evictedCommandCount + commandCount
            )
            .map((resize) => ({
              ...resize,
              commandIndex: resize.commandIndex - evictedCommandCount
            }))
        : [],
      resizeTracking: contextInfo.resizeTracking ?? null,
      overflow: journal.overflow ?? null,
      recordedFromContextCreation: evictedCommandCount === 0
    },
    commands: serializedCommands,
    blobs,
    frames,
    programs: journal.programSources ? Object.fromEntries(journal.programSources) : {},
    inspectionStatus: inspectionStatusFromJournal(journal, failures, commandCount)
  });
}
