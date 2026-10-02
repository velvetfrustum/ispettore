import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createWebGlPackage,
  decodeWebGlBlob,
  encodeWebGlBlob,
  validateWebGlPackage
} from '../../src/inspection/webgl/package.js';

describe('WebGL capture package', () => {
  it('copies mutable typed-array data into a JSON-safe blob', () => {
    const source = new Float32Array([-1, -1, 1, -1, 0, 1]);
    const blob = encodeWebGlBlob('positions', source);
    source.fill(0);

    const serialized = JSON.parse(JSON.stringify(blob));
    assert.deepEqual(Array.from(decodeWebGlBlob(serialized)), [-1, -1, 1, -1, 0, 1]);
  });

  it('round-trips DataView, ArrayBuffer, and SharedArrayBuffer blobs', () => {
    const viewBuffer = new ArrayBuffer(6);
    new Uint8Array(viewBuffer).set([9, 8, 7, 6, 5, 4]);
    const dataView = new DataView(viewBuffer, 1, 4);
    const decodedView = decodeWebGlBlob(JSON.parse(JSON.stringify(encodeWebGlBlob('view', dataView))));
    assert.equal(Object.prototype.toString.call(decodedView), '[object DataView]');
    assert.deepEqual(Array.from(new Uint8Array(decodedView.buffer)), [8, 7, 6, 5]);

    const buffer = new Uint8Array([1, 2, 3]).buffer;
    const decodedBuffer = decodeWebGlBlob(JSON.parse(JSON.stringify(encodeWebGlBlob('buffer', buffer))));
    assert.equal(Object.prototype.toString.call(decodedBuffer), '[object ArrayBuffer]');
    assert.deepEqual(Array.from(new Uint8Array(decodedBuffer)), [1, 2, 3]);

    const shared = new SharedArrayBuffer(3);
    new Uint8Array(shared).set([4, 5, 6]);
    const decodedShared = decodeWebGlBlob(JSON.parse(JSON.stringify(encodeWebGlBlob('shared', shared))));
    assert.equal(Object.prototype.toString.call(decodedShared), '[object SharedArrayBuffer]');
    assert.deepEqual(Array.from(new Uint8Array(decodedShared)), [4, 5, 6]);
  });

  it('does not trust a typed array constructor property', () => {
    const source = new Uint16Array([4, 8]);
    source.constructor = Uint8Array;
    const blob = encodeWebGlBlob('values', source);
    assert.equal(blob.arrayType, 'Uint16Array');
    assert.deepEqual(Array.from(decodeWebGlBlob(blob)), [4, 8]);
  });

  it('creates and validates a versioned WebGL package', () => {
    const capture = createWebGlPackage({
      width: 64,
      height: 64,
      attributes: { antialias: false },
      commands: [
        { op: 'clear', argTypes: ['number'], args: [0x4000], resultId: null, failed: null, error: null }
      ],
      blobs: []
    });

    assert.equal(capture.schema, 'ispettore-webgl-capture');
    assert.equal(capture.version, 1);
    assert.equal(capture.checkpoint, null);
    assert.equal(capture.context.api, 'webgl');
    const serialized = JSON.parse(JSON.stringify(capture));
    assert.equal(validateWebGlPackage(serialized), serialized);
  });

  it('rejects unsupported package versions and duplicate blobs', () => {
    assert.throws(
      () =>
        validateWebGlPackage({
          schema: 'ispettore-webgl-capture',
          version: 2,
          context: { api: 'webgl', width: 1, height: 1 },
          commands: [],
          blobs: []
        }),
      /Unsupported/
    );

    assert.throws(
      () =>
        validateWebGlPackage({
          schema: 'ispettore-webgl-capture',
          version: 1,
          context: { api: 'webgl', width: 1, height: 1 },
          commands: [{ op: 'clear', argTypes: ['number'], args: [0x4000], failed: 'arguments' }],
          blobs: [],
          frames: [],
          events: []
        }),
      /error/
    );

    const blob = encodeWebGlBlob('same', new Uint8Array([1]));
    assert.throws(
      () =>
        createWebGlPackage({
          width: 1,
          height: 1,
          commands: [],
          blobs: [blob, blob]
        }),
      /unique/
    );

    assert.throws(
      () =>
        createWebGlPackage({
          width: 1,
          height: 1,
          commands: [
            { op: 'clearColor', argTypes: ['number'], args: [0, 0, 0, 1], failed: null, error: null }
          ]
        }),
      /equal length/
    );

    assert.throws(
      () =>
        createWebGlPackage({
          width: 1,
          height: 1,
          context: { resizes: [{ commandIndex: 1, drawingBufferWidth: 2, drawingBufferHeight: 2 }] },
          commands: []
        }),
      /ordered and in range/
    );

    assert.throws(
      () =>
        createWebGlPackage({
          width: 1,
          height: 1,
          context: { overflow: { kind: 'command-count', limit: -1, captured: 0 } },
          commands: []
        }),
      /overflow status/
    );

    assert.throws(
      () =>
        createWebGlPackage({
          width: 1,
          height: 1,
          context: { overflow: { kind: 'bytes', limit: 2, captured: 1 } },
          commands: []
        }),
      /overflow status/
    );
  });

  it('accepts a valid buffer checkpoint and rejects malformed ones', () => {
    const blob = encodeWebGlBlob('checkpoint-blob-1', new Uint8Array([1, 2, 3, 4]));
    const command = { op: 'clear', argTypes: ['number'], args: [0x4000], resultId: null, failed: null, error: null };

    const capture = createWebGlPackage({
      width: 1,
      height: 1,
      commands: [command],
      blobs: [blob],
      checkpoint: {
        commandIndex: 0,
        resourceKinds: ['buffer'],
        complete: false,
        reasons: [],
        buffers: [{ id: 'ctx-1:buffer-1', byteLength: 4, blob: 'checkpoint-blob-1' }]
      }
    });
    assert.equal(capture.checkpoint.buffers.length, 1);

    assert.throws(
      () =>
        createWebGlPackage({
          width: 1,
          height: 1,
          commands: [command],
          blobs: [blob],
          checkpoint: {
            commandIndex: 0,
            buffers: [{ id: 'ctx-1:buffer-1', byteLength: 4, blob: 'does-not-exist' }]
          }
        }),
      /unknown blob/
    );

    assert.throws(
      () =>
        createWebGlPackage({
          width: 1,
          height: 1,
          commands: [command],
          blobs: [blob],
          checkpoint: {
            commandIndex: 99,
            buffers: [{ id: 'ctx-1:buffer-1', byteLength: 4, blob: 'checkpoint-blob-1' }]
          }
        }),
      /checkpoint command index/
    );
  });

  it('rejects duplicate EIDs and event indexes outside their frame', () => {
    const frame = {
      frameId: 'frame:1',
      label: 'animation callback',
      kind: 'animation-frame',
      startCommandIndex: 0,
      endCommandIndex: 1,
      commandCount: 1,
      blobCount: 0,
      byteSize: 1
    };
    const command = { op: 'clear', argTypes: ['number'], args: [0x4000], failed: null, error: null };
    const event = { eid: 1, commandIndex: 0, frameId: 'frame:1', kind: 'clear', op: 'clear', label: 'clear' };

    assert.throws(
      () => createWebGlPackage({ width: 1, height: 1, commands: [command], frames: [frame], events: [event, event] }),
      /EIDs/
    );
    assert.throws(
      () => createWebGlPackage({
        width: 1,
        height: 1,
        commands: [command],
        frames: [frame],
        events: [event, { ...event, eid: 2 }]
      }),
      /ordered/
    );
    assert.throws(
      () => createWebGlPackage({
        width: 1,
        height: 1,
        commands: [command],
        frames: [frame],
        events: [{ ...event, commandIndex: 1 }]
      }),
      /inside their frame/
    );
  });
});
