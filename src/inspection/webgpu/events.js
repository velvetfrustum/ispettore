const DRAW_OPS = new Set([
  'draw',
  'drawIndexed',
  'drawIndirect',
  'drawIndexedIndirect'
]);
const DISPATCH_OPS = new Set(['dispatchWorkgroups', 'dispatchWorkgroupsIndirect']);
const COPY_OPS = new Set([
  'copyBufferToBuffer',
  'copyBufferToTexture',
  'copyTextureToBuffer',
  'copyTextureToTexture'
]);
const WRITE_OPS = new Set(['writeBuffer', 'writeTexture', 'mappedWrite']);
const CLEAR_OPS = new Set(['clearBuffer']);

export function webGpuEventKind(op, command) {
  if (typeof op !== 'string') return null;
  if (op === 'beginRenderPass' && command?.args?.[0]?.colorAttachments?.some((attachment) => attachment?.loadOp === 'clear')) return 'clear';
  if (DRAW_OPS.has(op)) return 'draw';
  if (DISPATCH_OPS.has(op)) return 'dispatch';
  if (COPY_OPS.has(op)) return 'copy';
  if (WRITE_OPS.has(op)) return 'write';
  if (CLEAR_OPS.has(op)) return 'clear';
  return null;
}

export function createWebGpuEvents(commands, frames) {
  const events = [];
  for (const frame of frames ?? []) {
    for (let commandIndex = frame.startCommandIndex; commandIndex < frame.endCommandIndex; commandIndex++) {
      const command = commands?.[commandIndex];
      const kind = command?.failed ? null : webGpuEventKind(command?.op, command);
      if (!kind) continue;
      events.push({
        eid: events.length + 1,
        commandIndex,
        frameId: frame.frameId,
        kind,
        op: command.op,
        label: command.op
      });
    }
  }
  return events;
}
