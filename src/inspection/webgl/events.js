const DRAW_OP = /^draw(?:Arrays|Elements|ArraysInstanced|ElementsInstanced|RangeElements)(?:ANGLE)?$/;
const CLEAR_OPS = new Set(['clear', 'clearBufferfi', 'clearBufferfv', 'clearBufferiv', 'clearBufferuiv']);
const COPY_OPS = new Set([
  'blitFramebuffer',
  'copyBufferSubData',
  'copyTexImage2D',
  'copyTexSubImage2D',
  'copyTexSubImage3D'
]);

export function webGlEventKind(op) {
  if (typeof op !== 'string') return null;
  if (DRAW_OP.test(op)) return 'draw';
  if (CLEAR_OPS.has(op)) return 'clear';
  if (COPY_OPS.has(op)) return op === 'blitFramebuffer' ? 'blit' : 'copy';
  return null;
}

export function createWebGlEvents(commands, frames) {
  const events = [];
  for (const frame of frames ?? []) {
    for (let commandIndex = frame.startCommandIndex; commandIndex < frame.endCommandIndex; commandIndex++) {
      const command = commands?.[commandIndex];
      const kind = command?.failed ? null : webGlEventKind(command?.op);
      if (!kind) continue;
      events.push({
        eid: events.length + 1,
        commandIndex,
        frameId: frame.frameId,
        kind,
        op: command.op,
        label: command.semantic?.object?.name || command.semantic?.pass?.name || command.op
      });
    }
  }
  return events;
}
