import { diffSequences } from '../sequenceDiff.js';

function sortedHistogram(histogram) {
  return Object.entries(histogram)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, count]) => ({ key, count }));
}

function commandHistogram(capture) {
  const histogram = {};
  for (const command of capture.commands ?? []) {
    const op = command?.op ?? 'unknown';
    histogram[op] = (histogram[op] ?? 0) + 1;
  }
  return histogram;
}

function histogramDelta(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const delta = {};
  for (const key of keys) {
    const diff = (b[key] ?? 0) - (a[key] ?? 0);
    if (diff !== 0) delta[key] = diff;
  }
  return sortedHistogram(delta);
}

function firstDivergenceIndex(commandsA, commandsB) {
  const length = Math.min(commandsA.length, commandsB.length);
  for (let index = 0; index < length; index++) {
    const a = commandsA[index];
    const b = commandsB[index];
    if (a?.op !== b?.op) return index;
    if (a?.failed !== b?.failed) return index;
    if (a?.failed) continue;
    const aArgs = a?.args;
    const bArgs = b?.args;
    if (Array.isArray(aArgs) && Array.isArray(bArgs)) {
      if (aArgs.length !== bArgs.length) return index;
      for (let arg = 0; arg < aArgs.length; arg++) {
        const av = aArgs[arg];
        const bv = bArgs[arg];
        const aRef = av?.ref ?? av?.blob ?? av;
        const bRef = bv?.ref ?? bv?.blob ?? bv;
        if (Array.isArray(av) || Array.isArray(bv)) {
          if (av?.length !== bv?.length) return index;
          continue;
        }
        if (aRef !== bRef) return index;
      }
    } else if (aArgs !== bArgs) {
      return index;
    }
  }
  return null;
}

function frameSummary(capture) {
  const frames = Array.isArray(capture?.frames) ? capture.frames : [];
  return {
    count: frames.length,
    byId: frames.map((frame) => ({
      frameId: frame.frameId,
      kind: frame.kind,
      startCommandIndex: frame.startCommandIndex,
      endCommandIndex: frame.endCommandIndex,
      commandCount: frame.commandCount
    }))
  };
}

function diffById(itemsA, itemsB, id, changed) {
  const byIdA = new Map(itemsA.map((item) => [item[id], item]));
  const byIdB = new Map(itemsB.map((item) => [item[id], item]));
  const added = [];
  const removed = [];
  const changedItems = [];
  for (const [itemId, item] of byIdB) {
    if (!byIdA.has(itemId)) added.push(item);
    else if (changed(byIdA.get(itemId), item)) changedItems.push(item);
  }
  for (const [itemId, item] of byIdA) {
    if (!byIdB.has(itemId)) removed.push(item);
  }
  return { added, removed, changed: changedItems };
}

function hashText(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

const MAX_INLINE_ARRAY_VALUES = 16;

function formatDiffArg(value, blobLabels) {
  if (value == null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    const shown = value.slice(0, MAX_INLINE_ARRAY_VALUES).map((item) => formatDiffArg(item, blobLabels));
    const rest = value.length > MAX_INLINE_ARRAY_VALUES ? `, …+${value.length - MAX_INLINE_ARRAY_VALUES}` : '';
    return `[${shown.join(', ')}${rest}]`;
  }
  if (typeof value === 'object') {
    if (value.blob != null) return blobLabels.get(value.blob) ?? `blob:${value.blob}`;
    if (value.ref != null) return String(value.ref);
    return JSON.stringify(value);
  }
  return String(value);
}

// Blob ids are assigned sequentially per capture, so two captures uploading identical data
// still get different ids; label blobs by type, size and content hash so lines compare equal.
function blobLabelsFor(capture) {
  const labels = new Map();
  for (const blob of capture?.blobs ?? []) {
    if (blob?.id == null) continue;
    const content = typeof blob.data === 'string' ? blob.data : JSON.stringify(blob.data ?? null);
    labels.set(blob.id, `‹${blob.arrayType ?? blob.kind ?? 'blob'} ${blob.byteLength ?? '?'}B #${hashText(content)}›`);
  }
  return labels;
}

/**
 * One comparable text line per command: op plus arguments, with blob payloads replaced by
 * content hashes. Used to align two captures side by side.
 */
function commandDiffLines(capture) {
  const blobLabels = blobLabelsFor(capture);
  return (capture?.commands ?? []).map((command) => {
    const op = command?.op ?? 'unknown';
    if (command?.failed) return `${op} [failed: ${command.failed}]`;
    if (!Array.isArray(command?.args) || !command.args.length) return op;
    return `${op}(${command.args.map((value) => formatDiffArg(value, blobLabels)).join(', ')})`;
  });
}

export function diffCapturePackages(captureA, captureB) {
  const commandsA = captureA?.commands ?? [];
  const commandsB = captureB?.commands ?? [];
  const blobsA = captureA?.blobs ?? [];
  const blobsB = captureB?.blobs ?? [];
  const contextA = captureA?.context ?? {};
  const contextB = captureB?.context ?? {};
  const framesA = frameSummary(captureA);
  const framesB = frameSummary(captureB);
  const eventsA = captureA?.events ?? [];
  const eventsB = captureB?.events ?? [];
  const linesA = commandDiffLines(captureA);
  const linesB = commandDiffLines(captureB);
  const alignment = diffSequences(linesA, linesB, {
    coarseKeys: [commandsA.map((command) => command?.op ?? 'unknown'), commandsB.map((command) => command?.op ?? 'unknown')]
  });

  const attributesChanged = [];
  const attrsA = contextA.attributes ?? {};
  const attrsB = contextB.attributes ?? {};
  for (const key of new Set([...Object.keys(attrsA), ...Object.keys(attrsB)])) {
    if (attrsA[key] !== attrsB[key]) attributesChanged.push(key);
  }

  return {
    schema: { equal: captureA?.schema === captureB?.schema && captureA?.version === captureB?.version },
    context: {
      equal:
        contextA.width === contextB.width &&
        contextA.height === contextB.height &&
        attributesChanged.length === 0,
      widthA: contextA.width,
      heightA: contextA.height,
      widthB: contextB.width,
      heightB: contextB.height,
      attributesChanged,
      overflowA: contextA.overflow ?? null,
      overflowB: contextB.overflow ?? null
    },
    frames: {
      ...diffById(framesA.byId, framesB.byId, 'frameId', (a, b) => a.commandCount !== b.commandCount),
      countA: framesA.count,
      countB: framesB.count
    },
    events: {
      ...diffById(
        eventsA,
        eventsB,
        'eid',
        (a, b) => a.commandIndex !== b.commandIndex || a.kind !== b.kind || a.op !== b.op || a.label !== b.label
      ),
      countA: eventsA.length,
      countB: eventsB.length
    },
    commands: {
      countA: commandsA.length,
      countB: commandsB.length,
      delta: commandsB.length - commandsA.length,
      equal: commandsA.length === commandsB.length && firstDivergenceIndex(commandsA, commandsB) == null,
      firstDivergenceIndex: firstDivergenceIndex(commandsA, commandsB),
      methodDelta: histogramDelta(commandHistogram(captureA), commandHistogram(captureB))
    },
    lines: {
      a: linesA,
      b: linesB,
      chunks: alignment.chunks,
      truncated: alignment.truncated,
      coarse: alignment.coarse === true
    },
    blobs: {
      countA: blobsA.length,
      countB: blobsB.length,
      byteSizeA: blobsA.reduce((sum, blob) => sum + (blob?.byteLength ?? 0), 0),
      byteSizeB: blobsB.reduce((sum, blob) => sum + (blob?.byteLength ?? 0), 0)
    },
    inspectionStatus: {
      levelA: captureA?.inspectionStatus?.level ?? null,
      levelB: captureB?.inspectionStatus?.level ?? null
    }
  };
}
