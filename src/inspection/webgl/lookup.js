const LEVEL_RANK = { supported: 0, degraded: 1, unsupported: 2 };

function worseLevel(a, b) {
  return LEVEL_RANK[b] > LEVEL_RANK[a] ? b : a;
}

/**
 * Every significant command (draw/clear/blit/copy) already carries a preview baked live,
 * at the moment it executed on the real page (docs/PLAN.md, Phase 9 — Spector-style
 * capture). Inspection is therefore a pure lookup: find the nearest baked preview at or
 * before the requested command, no reconstruction, no isolated context, no re-execution.
 */
function findPreviewAtOrBefore(commands, commandIndex) {
  for (let index = commandIndex; index >= 0; index--) {
    const command = commands[index];
    if (command?.preview) return { command, commandIndex: index };
  }
  return null;
}

function buildTimings(capture) {
  const timings = {};
  for (const event of capture.events ?? []) {
    const ms = capture.commands?.[event.commandIndex]?.gpuTimingMs;
    if (Number.isFinite(ms)) timings[event.eid] = ms;
  }
  return Object.keys(timings).length ? timings : undefined;
}

/**
 * Resolves a `{eid | commandIndex}` inspection request against a capture package built
 * by `serializeWebGlJournal`, returning the result shape consumed by `src/ui/captureView.js`.
 */
export function lookupWebGlCapture(capture, { eid, commandIndex } = {}) {
  let targetIndex;
  if (eid != null) {
    const event = (capture.events ?? []).find((entry) => entry.eid === eid);
    if (!event) throw new RangeError(`WebGL inspection event ${eid} is not in the capture`);
    targetIndex = event.commandIndex;
  } else if (commandIndex != null) {
    if (!Number.isInteger(commandIndex)) {
      throw new RangeError('WebGL inspection command must be an integer index');
    }
    targetIndex = commandIndex;
  } else {
    targetIndex = capture.commands.length - 1;
  }
  if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= capture.commands.length) {
    throw new RangeError('WebGL inspection command is out of range');
  }

  const found = findPreviewAtOrBefore(capture.commands, targetIndex);
  const captureLevel = capture.inspectionStatus?.level ?? 'supported';
  const timings = buildTimings(capture);

  if (!found) {
    return {
      width: capture.context.width,
      height: capture.context.height,
      selectedCommandIndex: targetIndex,
      color: null,
      colorTarget: 'default',
      inspectionStatus: {
        level: worseLevel(captureLevel, 'degraded'),
        reasons: ['no draw, clear, blit, or copy has executed yet at this point in the frame']
      },
      ...(timings ? { timings } : {})
    };
  }

  const { preview } = found.command;
  const level = worseLevel(captureLevel, preview.reasons?.length ? 'degraded' : 'supported');
  const target = capture.commands[targetIndex];
  const details = found.commandIndex === targetIndex ? target.details ?? null : null;
  const programRef = details?.drawCall?.programStatus?.program;
  return {
    width: preview.width,
    height: preview.height,
    selectedCommandIndex: targetIndex,
    color: preview.color,
    colorTarget: preview.colorTarget,
    inspectionStatus: { level, reasons: [...(capture.inspectionStatus?.reasons ?? []), ...(preview.reasons ?? [])] },
    command: {
      commandIndex: targetIndex,
      op: target.op,
      resultId: target.resultId ?? null,
      status: target.status ?? null,
      durationMs: target.durationMs ?? null,
      gpuTimingMs: target.gpuTimingMs ?? null
    },
    details,
    program: programRef ? capture.programs?.[programRef] ?? null : null,
    ...(timings ? { timings } : {})
  };
}
