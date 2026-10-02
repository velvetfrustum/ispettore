export function resolveWebGpuCommandIndex(capture, { eid, commandIndex } = {}) {
  const index = eid != null
    ? capture.events?.find((event) => event.eid === eid)?.commandIndex
    : commandIndex ?? capture.commands.length - 1;
  if (!Number.isInteger(index) || index < 0 || index >= capture.commands.length) {
    throw new RangeError('The requested event or command is not in the capture');
  }
  return index;
}

export function lookupWebGpuCapture(capture, options = {}) {
  const index = resolveWebGpuCommandIndex(capture, options);
  const preview = capture.commands[index].preview;
  const reason = capture.version === 1
    ? 'This older capture has no stored image for this event. Capture a new frame; GPU reconstruction is no longer used.'
    : 'No live preview was captured at this command. Inspection never executes GPU commands.';
  const reasons = preview?.reasons ?? (preview?.color?.preview ? [] : [reason]);
  const base = capture.inspectionStatus ?? { level: 'supported', reasons: [] };
  return {
    ok: true,
    selectedCommandIndex: index,
    width: preview?.width ?? capture.context.canvas?.width ?? null,
    height: preview?.height ?? capture.context.canvas?.height ?? null,
    color: preview?.color ?? { available: false, reason },
    colorTarget: preview?.colorTarget ?? null,
    inspectionStatus: {
      level: base.level === 'unsupported' ? 'unsupported' : reasons.length || base.level === 'degraded' ? 'degraded' : 'supported',
      reasons: [...new Set([...(base.reasons ?? []), ...reasons])]
    }
  };
}
