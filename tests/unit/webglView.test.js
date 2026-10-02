import test from 'node:test';
import assert from 'node:assert/strict';
import {
  describeWebGlCapture,
  summarizeCommand,
  buildEventIndex,
  preferredPreviewEvent,
  isDrawOp
} from '../../src/inspection/webgl/view.js';
import { webGlEventKind } from '../../src/inspection/webgl/events.js';

function command(op, args = [], semantic = null, extra = {}) {
  return { commandIndex: 0, op, argTypes: args.map(() => 'number'), args, resultId: null, failed: null, error: null, semantic, ...extra };
}

function packageFor(commands, frames = [], events = []) {
  return {
    schema: 'ispettore-webgl-capture',
    version: 1,
    capturedAt: '2026-01-01T00:00:00.000Z',
    context: { api: 'webgl', width: 64, height: 64, attributes: {}, resizes: [] },
    commands,
    blobs: [{ id: 'b1', arrayType: 'Uint8Array', byteLength: 128, data: 'x' }],
    frames,
    events,
    inspectionStatus: { level: 'supported', reasons: [] }
  };
}

test('describeWebGlCapture strips blob payloads into ids', () => {
  const view = describeWebGlCapture(
    packageFor([command('bufferData', [{ blob: 'b1' }])], [])
  );
  assert.equal(view.blobCount, 1);
  assert.equal(view.blobBytes, 128);
  assert.deepEqual(view.commands[0].args, [{ blob: 'b1' }]);
  assert.equal(view.context.width, 64);
});

test('summarizeCommand describes op, arguments, and failed commands', () => {
  const summary = summarizeCommand(command('drawArrays', [4, 0, 96]));
  assert.equal(summary.summary, 'drawArrays 4 0 96');
  assert.equal(summary.commandIndex, 0);

  const failed = summarizeCommand({ commandIndex: 2, op: 'drawElements', failed: 'command', error: 'boom' });
  assert.equal(failed.summary, 'drawElements [failed: command]');
  assert.equal(failed.error, 'boom');
});

test('isDrawOp detects draw commands', () => {
  assert.equal(isDrawOp('drawArrays'), true);
  assert.equal(isDrawOp('drawElementsInstanced'), true);
  assert.equal(isDrawOp('clear'), false);
});

test('event classification gives EIDs only to significant GPU operations', () => {
  assert.equal(webGlEventKind('drawElements'), 'draw');
  assert.equal(webGlEventKind('clearBufferfv'), 'clear');
  assert.equal(webGlEventKind('blitFramebuffer'), 'blit');
  assert.equal(webGlEventKind('copyBufferSubData'), 'copy');
  assert.equal(webGlEventKind('uniformMatrix4fv'), null);
  assert.equal(webGlEventKind('bindTexture'), null);
});

test('preview selection avoids a trailing clear event', () => {
  const events = [
    { eid: 1, kind: 'draw' },
    { eid: 2, kind: 'blit' },
    { eid: 3, kind: 'clear' }
  ];
  assert.equal(preferredPreviewEvent(events).eid, 2);
  assert.equal(preferredPreviewEvent([{ eid: 4, kind: 'clear' }]).eid, 4);
});

test('event indexes preserve per-object EIDs', () => {
  const commands = [
    command('drawArrays', [4, 0, 3], { object: { uuid: 'mesh-1' } }),
    command('drawElements', [4, 6, 5123, 0], { object: { uuid: 'mesh-1' } }),
    command('clear', [0x4000]),
    command('drawArrays', [4, 0, 3], { object: { uuid: 'mesh-2' } })
  ];
  const frames = [
    { frameId: 'frame:1', startCommandIndex: 0, endCommandIndex: 3, commandCount: 3 },
    { frameId: 'frame:2', startCommandIndex: 3, endCommandIndex: 4, commandCount: 1 }
  ];
  const events = [
    { eid: 1, commandIndex: 0, frameId: 'frame:1', kind: 'draw', op: 'drawArrays', label: 'mesh-1' },
    { eid: 2, commandIndex: 1, frameId: 'frame:1', kind: 'draw', op: 'drawElements', label: 'mesh-1' },
    { eid: 3, commandIndex: 3, frameId: 'frame:2', kind: 'draw', op: 'drawArrays', label: 'mesh-2' }
  ];
  const view = describeWebGlCapture(packageFor(commands, frames, events));
  const eventIndex = buildEventIndex(view);
  assert.deepEqual([...eventIndex.byObjectUuid.get('mesh-1')], [1, 2]);
  assert.deepEqual([...eventIndex.byObjectUuid.get('mesh-2')], [3]);
});
