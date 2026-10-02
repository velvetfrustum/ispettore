import test from 'node:test';
import assert from 'node:assert/strict';
import { diffWebGlPackages } from '../../src/inspection/webgl/diff.js';

function command(op, args = []) {
  return { op, argTypes: args.map(() => 'number'), args, resultId: null, failed: null, error: null };
}

function packageFor({ commands, frames = [], events = [], context = {}, blobs = [] }) {
  return {
    schema: 'ispettore-webgl-capture',
    version: 1,
    context: { api: 'webgl', width: 64, height: 64, attributes: {}, resizes: [], ...context },
    commands,
    blobs,
    frames,
    events,
    inspectionStatus: { level: 'supported', reasons: [] }
  };
}

test('identical packages diff as equal', () => {
  const base = packageFor({ commands: [command('clear', [0x4000])] });
  const diff = diffWebGlPackages(base, { ...base, blobs: [] });
  assert.equal(diff.commands.equal, true);
  assert.equal(diff.commands.delta, 0);
  assert.equal(diff.context.equal, true);
  assert.equal(diff.commands.firstDivergenceIndex, null);
});

test('command count growth and first divergence are reported', () => {
  const a = packageFor({ commands: [command('clear', [0x4000]), command('drawArrays', [4, 0, 3])] });
  const b = packageFor({ commands: [command('clear', [0x4000]), command('drawArrays', [4, 0, 9]), command('drawArrays', [4, 3, 6])] });
  const diff = diffWebGlPackages(a, b);
  assert.equal(diff.commands.countA, 2);
  assert.equal(diff.commands.countB, 3);
  assert.equal(diff.commands.delta, 1);
  assert.equal(diff.commands.firstDivergenceIndex, 1);
  assert.equal(diff.commands.equal, false);
  const methodDelta = diff.commands.methodDelta.find((entry) => entry.key === 'drawArrays');
  assert.equal(methodDelta.count, 1);
});

test('context drift and overflow changes are captured', () => {
  const a = packageFor({
    commands: [command('clear', [0x4000])],
    context: { width: 64, height: 64, attributes: { alpha: false }, overflow: null }
  });
  const b = packageFor({
    commands: [command('clear', [0x4000])],
    context: {
      width: 128,
      height: 128,
      attributes: { alpha: true },
      overflow: { kind: 'command-count', limit: 100, captured: 101 }
    }
  });
  const diff = diffWebGlPackages(a, b);
  assert.equal(diff.context.equal, false);
  assert.equal(diff.context.widthA, 64);
  assert.equal(diff.context.widthB, 128);
  assert.deepEqual(diff.context.attributesChanged, ['alpha']);
  assert.deepEqual(diff.context.overflowA, null);
  assert.equal(diff.context.overflowB.kind, 'command-count');
});

test('event differences report added and changed EIDs', () => {
  const a = packageFor({
    commands: [command('clear', [0x4000]), command('clear', [0x4000])],
    frames: [{ frameId: 'frame:1', startCommandIndex: 0, endCommandIndex: 2, commandCount: 2 }],
    events: [{ eid: 1, commandIndex: 0, frameId: 'frame:1', kind: 'clear', op: 'clear', label: 'clear' }]
  });
  const b = packageFor({
    commands: [command('clear', [0x4000]), command('clear', [0x4000]), command('clear', [0x4000])],
    frames: [{ frameId: 'frame:1', startCommandIndex: 0, endCommandIndex: 3, commandCount: 3 }],
    events: [
      { eid: 1, commandIndex: 1, frameId: 'frame:1', kind: 'clear', op: 'clear', label: 'clear' },
      { eid: 2, commandIndex: 2, frameId: 'frame:1', kind: 'clear', op: 'clear', label: 'clear' }
    ]
  });
  const diff = diffWebGlPackages(a, b);
  assert.equal(diff.frames.countA, 1);
  assert.equal(diff.frames.countB, 1);
  assert.equal(diff.events.added.length, 1);
  assert.equal(diff.events.removed.length, 0);
  assert.equal(diff.events.changed.length, 1);
});

test('blob byte size delta is reported', () => {
  const a = packageFor({ commands: [command('clear', [0x4000])], blobs: [] });
  const b = packageFor({
    commands: [command('clear', [0x4000])],
    blobs: [{ id: 'b1', arrayType: 'Uint8Array', byteLength: 256, data: 'x' }]
  });
  const diff = diffWebGlPackages(a, b);
  assert.equal(diff.blobs.countA, 0);
  assert.equal(diff.blobs.countB, 1);
  assert.equal(diff.blobs.byteSizeB, 256);
});

test('command lines hash blob contents so identical uploads align across captures', () => {
  const blob = (id, data) => ({ id, arrayType: 'Float32Array', byteLength: 16, data });
  const a = packageFor({
    commands: [command('uniform4fv', [{ ref: 'loc-1' }, { blob: 'blob-1' }]), command('drawArrays', [4, 0, 3])],
    blobs: [blob('blob-1', 'AAAA')]
  });
  const b = packageFor({
    commands: [
      command('clear', [0x4000]),
      command('uniform4fv', [{ ref: 'loc-1' }, { blob: 'blob-7' }]),
      command('drawArrays', [4, 0, 6])
    ],
    blobs: [blob('blob-7', 'AAAA')]
  });
  const diff = diffWebGlPackages(a, b);
  assert.equal(diff.lines.a[0], diff.lines.b[1]);
  assert.match(diff.lines.a[0], /^uniform4fv\(loc-1, ‹Float32Array 16B #[0-9a-f]{8}›\)$/);
  assert.deepEqual(
    diff.lines.chunks.map((chunk) => chunk.tag),
    ['insert', 'equal', 'replace']
  );
});
