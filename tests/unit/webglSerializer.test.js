import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decodeWebGlBlob } from '../../src/inspection/webgl/package.js';
import { serializeWebGlJournal } from '../../src/backend/webgl/serialize/serializeJournal.js';

function createJournal(commands = [], { contextInfo = {}, resizes = [] } = {}) {
  return {
    contextInfo: {
      attributes: { alpha: false, antialias: false, preserveDrawingBuffer: true },
      drawingBufferWidth: 64,
      drawingBufferHeight: 64,
      canvasWidth: 64,
      canvasHeight: 64,
      limits: { MAX_TEXTURE_SIZE: 16384 },
      supportedExtensions: ['EXT_color_buffer_float'],
      resizeTracking: { complete: true, trackedProperties: ['width', 'height'] },
      ...contextInfo
    },
    resizes,
    commands
  };
}

const command = (op, argTypes, args, extra = {}) => ({ op, argTypes, args, resultId: null, failed: null, error: null, ...extra });

describe('WebGL journal serializer', () => {
  it('encodes typed-array inputs as immutable blobs', () => {
    const positions = new Float32Array([-1, -1, 1, -1, 0, 1]);
    const package_ = serializeWebGlJournal(
      createJournal([
        command('createBuffer', ['resource'], ['ref-buffer']),
        command('bufferData', ['number', 'typed-array:Float32Array', 'number'], [0x8892, positions, 0x88e4])
      ])
    );

    positions.fill(0);
    const serialized = JSON.parse(JSON.stringify(package_));
    assert.equal(serialized.schema, 'ispettore-webgl-capture');
    assert.equal(serialized.version, 1);
    assert.equal(serialized.commands[1].args[1].blob, 'blob-1');
    assert.equal(serialized.blobs[0].arrayType, 'Float32Array');
    assert.deepEqual(Array.from(decodeWebGlBlob(serialized.blobs[0])), [-1, -1, 1, -1, 0, 1]);
  });

  it('encodes DataView and bare buffer inputs with inspection-safe types', () => {
    const dataView = new DataView(new Uint8Array([1, 2, 3, 4]).buffer, 1, 2);
    const arrayBuffer = new Uint8Array([5, 6, 7]).buffer;
    const sharedSnapshot = new Uint8Array([8, 9]).buffer;
    const package_ = serializeWebGlJournal(
      createJournal([
        command('bufferData', ['number', 'data-view', 'number'], [0x8892, dataView, 0x88e4]),
        command('bufferSubData', ['number', 'number', 'array-buffer'], [0x8892, 0, arrayBuffer]),
        command('bufferSubData', ['number', 'number', 'shared-array-buffer'], [0x8892, 0, sharedSnapshot])
      ])
    );

    assert.equal(Object.prototype.toString.call(decodeWebGlBlob(package_.blobs[0])), '[object DataView]');
    assert.equal(Object.prototype.toString.call(decodeWebGlBlob(package_.blobs[1])), '[object ArrayBuffer]');
    assert.equal(Object.prototype.toString.call(decodeWebGlBlob(package_.blobs[2])), '[object ArrayBuffer]');
    assert.deepEqual(Array.from(new Uint8Array(decodeWebGlBlob(package_.blobs[0]).buffer)), [2, 3]);
    assert.deepEqual(Array.from(new Uint8Array(decodeWebGlBlob(package_.blobs[1]))), [5, 6, 7]);
    assert.deepEqual(Array.from(new Uint8Array(decodeWebGlBlob(package_.blobs[2]))), [8, 9]);
  });

  it('preserves resource references and inline sequences', () => {
    const package_ = serializeWebGlJournal(
      createJournal([
        command('getUniformLocation', ['resource', 'string'], [{ ref: 'p:program-1' }, 'opacity']),
        command('uniform4fv', ['resource', 'sequence'], [{ ref: 'p:uniform-1' }, [1, 2, 3, 4]])
      ])
    );

    assert.deepEqual(package_.commands[0].args, [{ ref: 'p:program-1' }, 'opacity']);
    assert.deepEqual(package_.commands[1].args[1], [1, 2, 3, 4]);
    assert.equal(package_.blobs.length, 0);
  });

  it('normalizes DOM image uploads to the pixel-array overload', () => {
    const pixels = new Uint8ClampedArray(16);
    const package_ = serializeWebGlJournal(
      createJournal([
        command(
          'texImage2D',
          ['number', 'number', 'number', 'number', 'number', 'image-source'],
          [0x0de1, 0, 0x1908, 0x1908, 0x1401, { kind: 'HTMLCanvasElement', width: 2, height: 2, depth: 1, pixels }]
        )
      ])
    );

    const serialized = JSON.parse(JSON.stringify(package_));
    const normalized = serialized.commands[0];
    assert.deepEqual(normalized.argTypes, [
      'number',
      'number',
      'number',
      'number',
      'number',
      'number',
      'number',
      'number',
      'image-source'
    ]);
    assert.deepEqual(normalized.args.slice(0, 8), [0x0de1, 0, 0x1908, 2, 2, 0, 0x1908, 0x1401]);
    assert.match(normalized.args[8].blob, /^blob-/);
    assert.equal(serialized.blobs[0].arrayType, 'Uint8ClampedArray');
    assert.equal(normalized.failed, null);
  });

  it('preserves failed capture commands with an explicit inspectionStatus level', () => {
    const package_ = serializeWebGlJournal(
      createJournal([
        command('drawArrays', ['number', 'number', 'number'], [4, 0, 3]),
        command('texImage2D', null, null, { failed: 'arguments', error: 'unreadable image source' })
      ])
    );

    assert.equal(package_.commands[1].failed, 'arguments');
    // A failed capture command never invalidates the already-baked live previews (docs/PLAN.md,
    // Phase 9) — it only means the raw command log has a gap, hence 'degraded' not 'unsupported'.
    assert.equal(package_.inspectionStatus.level, 'degraded');
    assert.ok(package_.inspectionStatus.reasons.some((reason) => reason.includes('texImage2D')));
  });

  it('maps context info into the package context', () => {
    const package_ = serializeWebGlJournal(
      createJournal([command('clear', ['number'], [0x4000])], {
        resizes: [{ commandIndex: 0, canvasWidth: 128, canvasHeight: 96, drawingBufferWidth: 128, drawingBufferHeight: 96 }]
      })
    );

    assert.equal(package_.context.api, 'webgl');
    assert.equal(package_.context.width, 64);
    assert.equal(package_.context.height, 64);
    assert.deepEqual(package_.context.attributes, { alpha: false, antialias: false, preserveDrawingBuffer: true });
    assert.deepEqual(package_.context.capabilities, { MAX_TEXTURE_SIZE: 16384 });
    assert.deepEqual(package_.context.extensions, ['EXT_color_buffer_float']);
    assert.deepEqual(package_.context.resizes, [
      { commandIndex: 0, canvasWidth: 128, canvasHeight: 96, drawingBufferWidth: 128, drawingBufferHeight: 96 }
    ]);
    assert.deepEqual(package_.inspectionStatus, { level: 'supported', reasons: [] });
  });

  it('does not penalize inspectionStatus for incomplete resize tracking (live-baked previews already reflect each resize)', () => {
    const package_ = serializeWebGlJournal(
      createJournal([], {
        contextInfo: { resizeTracking: { complete: false, trackedProperties: [] } }
      })
    );

    assert.equal(package_.inspectionStatus.level, 'supported');
  });

  it('carries Three.js semantic annotations through serialization on draw commands', () => {
    const semantic = {
      object: { uuid: 'obj-1', name: 'Mesh (1)', type: 'Mesh', summary: 'BoxGeometry' },
      material: { label: 'MeshStandardMaterial', type: 'MeshStandardMaterial', index: 3, transparent: false },
      program: { ref: 'p:program-1', label: 'program-1' },
      textures: [{ ref: 't:tex-1', target: 0x0de1, width: 64, height: 64, label: 'map' }],
      pass: { index: 0, name: 'scene', kind: 'scene', role: 'renderTarget', renderTarget: 'rt-1' }
    };
    const package_ = serializeWebGlJournal(
      createJournal([
        command('clear', ['number'], [0x4000]),
        command('drawArrays', ['number', 'number', 'number'], [4, 0, 3], { semantic })
      ])
    );

    assert.equal(package_.commands[0].semantic, null);
    assert.deepEqual(package_.commands[1].semantic, semantic);
  });

  it('drops semantic annotations from failed commands', () => {
    const package_ = serializeWebGlJournal(
      createJournal([
        command('drawArrays', ['number', 'number', 'number'], [4, 0, 3], { semantic: { object: { uuid: 'obj-1', name: 'Mesh', type: 'Mesh' } } }),
        command('drawElements', null, null, { failed: 'arguments', error: 'unreadable' })
      ])
    );

    assert.deepEqual(package_.commands[0].semantic, { object: { uuid: 'obj-1', name: 'Mesh', type: 'Mesh' } });
    assert.equal(package_.commands[1].semantic, undefined);
  });

  it('reuses an incremental cache so repeated stores stay stable and cheap', () => {
    const journal = createJournal([
      command('bufferData', ['number', 'typed-array:Float32Array', 'number'], [0x8892, new Float32Array([1, 2, 3]), 0x88e4]),
      command('clear', ['number'], [0x4000])
    ]);
    const cache = {};

    const first = serializeWebGlJournal(journal, { cache });
    assert.equal(cache.count, 2);
    assert.equal(first.commands[0].args[1].blob, 'blob-1');

    journal.commands.push(
      command('bufferData', ['number', 'typed-array:Float32Array', 'number'], [0x8892, new Float32Array([9, 8]), 0x88e4])
    );

    const second = serializeWebGlJournal(journal, { cache });
    assert.equal(cache.count, 3);
    assert.equal(second.commands.length, 3);
    assert.equal(second.commands[0].args[1].blob, 'blob-1');
    assert.equal(second.commands[1].args[0], 0x4000);
    assert.equal(second.commands[2].args[1].blob, 'blob-2');
    assert.equal(second.blobs.length, 2);

    const fresh = serializeWebGlJournal(journal);
    assert.deepEqual(JSON.parse(JSON.stringify(second)), JSON.parse(JSON.stringify(fresh)));
  });

  it('serializes exactly one selected frame and stops its reconstruction prefix at that boundary', () => {
    const journal = createJournal(
      [
        command('createBuffer', [], [], { resultId: 'ctx-1:buffer-1' }),
        command('clear', ['number'], [0x4000]),
        command('drawArrays', ['number', 'number', 'number'], [4, 0, 3]),
        command('clear', ['number'], [0x4000]),
        command('drawArrays', ['number', 'number', 'number'], [4, 0, 3])
      ],
      {
        resizes: [
          { commandIndex: 2, canvasWidth: 64, canvasHeight: 64 },
          { commandIndex: 3, canvasWidth: 128, canvasHeight: 96 }
        ]
      }
    );
    journal.frames = [
      { frameId: 'frame:1:1', label: 'animation callback', kind: 'animation-frame', startCommandIndex: 1, endCommandIndex: 3 },
      { frameId: 'frame:1:2', label: 'animation callback', kind: 'animation-frame', startCommandIndex: 3, endCommandIndex: 5 }
    ];

    const package_ = serializeWebGlJournal(journal, { frameId: 'frame:1:1' });

    assert.equal(package_.commands.length, 3);
    assert.deepEqual(package_.commands.map(({ op }) => op), ['createBuffer', 'clear', 'drawArrays']);
    assert.equal(package_.frames.length, 1);
    assert.equal(package_.frames[0].frameId, 'frame:1:1');
    assert.equal(package_.frames[0].prefix.commandCount, 3);
    assert.deepEqual(package_.events.map(({ eid, commandIndex, kind }) => ({ eid, commandIndex, kind })), [
      { eid: 1, commandIndex: 1, kind: 'clear' },
      { eid: 2, commandIndex: 2, kind: 'draw' }
    ]);
    assert.deepEqual(package_.context.resizes.map(({ commandIndex }) => commandIndex), [2]);
  });

  it('never populates the checkpoint field (retired with prefix compaction, docs/PLAN.md Phase 9)', () => {
    const journal = createJournal([command('clear', ['number'], [0x4000])]);
    assert.equal(serializeWebGlJournal(journal).checkpoint, null);
  });

  it('shifts range and resize indexes for an evicted rolling window', () => {
    const journal = createJournal(
      [
        command('clear', ['number'], [0x4000]),
        command('clear', ['number'], [0x4000]),
        command('drawArrays', ['number', 'number', 'number'], [4, 0, 3])
      ],
      {
        resizes: [
          { commandIndex: 1, canvasWidth: 128, canvasHeight: 96, drawingBufferWidth: 128, drawingBufferHeight: 96 }
        ]
      }
    );
    journal.frames = [
      { frameId: 'frame:1:1', label: 'anim', kind: 'animation-frame', startCommandIndex: 1, endCommandIndex: 3 }
    ];
    journal.evictedCommandCount = 1;

    const package_ = serializeWebGlJournal(journal);
    assert.deepEqual(package_.frames[0], {
      ...package_.frames[0],
      startCommandIndex: 0,
      endCommandIndex: 2
    });
    assert.equal(package_.frames[0].commandCount, 2);
    assert.equal(package_.frames[0].prefix.endCommandIndex, 2);
    assert.deepEqual(package_.context.resizes[0].commandIndex, 0);
    assert.equal(package_.context.recordedFromContextCreation, false);
    assert.equal(package_.inspectionStatus.level, 'degraded');
    assert.ok(
      package_.inspectionStatus.reasons.some((reason) => reason.includes('dropped the first 1 command'))
    );
  });

  it('invalidates the incremental cache when the journal window evicts', () => {
    const journal = createJournal([
      command('bufferData', ['number', 'typed-array:Float32Array', 'number'], [0x8892, new Float32Array([1, 2, 3]), 0x88e4]),
      command('clear', ['number'], [0x4000])
    ]);
    const cache = {};

    const first = serializeWebGlJournal(journal, { cache });
    assert.equal(cache.count, 2);
    assert.equal(first.commands[0].args[1].blob, 'blob-1');

    journal.commands.shift();
    journal.evictedCommandCount = 1;

    const second = serializeWebGlJournal(journal, { cache });
    assert.equal(cache.count, 1);
    assert.equal(cache.evictedCommandCount, 1);
    assert.equal(second.commands[0].args[0], 0x4000);
    assert.equal(second.commands[0].failed, null);
    assert.equal(second.commands[0].semantic, null);

    const fresh = serializeWebGlJournal(journal);
    assert.deepEqual(JSON.parse(JSON.stringify(second)), JSON.parse(JSON.stringify(fresh)));
  });
});
