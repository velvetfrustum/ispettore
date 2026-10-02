import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { serializeWebGpuJournal } from '../../src/backend/webgpu/serialize/serializeJournal.js';
import { validateWebGpuPackage } from '../../src/inspection/webgpu/package.js';
import { normalizeStoredPackage } from '../../src/extension/storage.js';
import { createWebGlPackage } from '../../src/inspection/webgl/package.js';

function command(op, args = [], argTypes = null, extra = {}) {
  return {
    op,
    argTypes: argTypes ?? args.map(() => 'number'),
    args,
    resultId: null,
    failed: null,
    error: null,
    durationMs: 0.1,
    ...extra
  };
}

function journal(commands, frames) {
  return {
    device: {},
    contextId: 'gpuctx-1',
    adapterInfo: {},
    deviceInfo: { features: [], limits: {} },
    configuration: { format: 'bgra8unorm', alphaMode: 'opaque' },
    canvas: { width: 64, height: 64 },
    commands,
    frames
  };
}

describe('WebGPU single-frame serialization', () => {
  it('serializes exactly one selected frame without a reconstruction prefix', () => {
    const capture = serializeWebGpuJournal(
      journal(
        [
          command('createBuffer', [{ size: 8, usage: 40 }], ['descriptor'], { resultId: 'gpubuf-1' }),
          command('configure', [{ device: {}, format: 'bgra8unorm' }], ['descriptor']),
          command('getCurrentTexture', [], []),
          command('beginRenderPass', [{}], ['descriptor']),
          command('draw', [3], ['number']),
          command('renderPass.end', [], []),
          command('submit', [[]], ['sequence'])
        ],
        [
          {
            frameId: 'frame:1:1',
            label: 'animation callback',
            kind: 'animation-frame',
            startCommandIndex: 2,
            endCommandIndex: 6,
            commandCount: 4
          },
          {
            frameId: 'frame:2:1',
            label: 'animation callback',
            kind: 'animation-frame',
            startCommandIndex: 6,
            endCommandIndex: 7,
            commandCount: 1
          }
        ]
      ),
      { frameId: 'frame:1:1' }
    );

    const serialized = JSON.parse(JSON.stringify(capture));
    assert.equal(serialized.schema, 'ispettore-webgpu-capture');
    assert.equal(validateWebGpuPackage(serialized), serialized);
    assert.deepEqual(
      serialized.commands.map(({ op }) => op),
      ['getCurrentTexture', 'beginRenderPass', 'draw', 'renderPass.end']
    );
    assert.equal(serialized.frames.length, 1);
    assert.equal(serialized.frames[0].frameId, 'frame:1:1');
    assert.ok(serialized.events.length >= 1);
    for (const event of serialized.events) {
      assert.equal(event.frameId, 'frame:1:1');
      assert.ok(event.commandIndex >= 0 && event.commandIndex < 4);
    }
    assert.deepEqual(
      serialized.events.map(({ eid }) => eid),
      Array.from({ length: serialized.events.length }, (_, index) => index + 1)
    );
    assert.equal(serialized.context.recordedFromContextCreation, false);
    assert.equal(serialized.context.captureMode, 'live');
  });

  it('throws when the requested frame is not in the journal', () => {
    assert.throws(
      () => serializeWebGpuJournal(journal([command('clear', [])], []), { frameId: 'missing' }),
      /not available/
    );
  });
});

describe('stored-package normalization dispatches by schema', () => {
  it('accepts WebGPU live packages and legacy packages for inspection only', () => {
    const webgpu = serializeWebGpuJournal(journal([], []));
    assert.equal(normalizeStoredPackage(webgpu), webgpu);
    const legacy = { ...webgpu, version: 1 };
    delete legacy.resources;
    assert.equal(normalizeStoredPackage(legacy), legacy);
  });

  it('validates WebGL packages through the WebGL schema', () => {
    const capture = createWebGlPackage({
      width: 1,
      height: 1,
      commands: [command('clear', [0x4000])],
      frames: [{ frameId: 'frame:1', label: 'frame', kind: 'animation-frame', startCommandIndex: 0, endCommandIndex: 1, commandCount: 1, blobCount: 0, byteSize: 1 }]
    });
    assert.equal(normalizeStoredPackage(capture), capture);
    assert.throws(() => normalizeStoredPackage({ ...capture, version: 2 }), /Unsupported WebGL/);
  });

  it('rejects unknown schemas', () => {
    assert.throws(() => normalizeStoredPackage({ schema: 'nope', version: 9 }), /Unsupported/);
  });
});
