import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WEBGL_API_SPEC } from '../../src/backend/webgl/intercept/apiSpec.js';
import { snapshotWebGlArguments } from '../../src/backend/webgl/capture/snapshotArguments.js';

const SPEC = Object.fromEntries(WEBGL_API_SPEC.map((descriptor) => [descriptor.name, descriptor]));

const snapshot = (name, args) => snapshotWebGlArguments({}, args, SPEC[name], null);

describe('WebGL overloaded signatures', () => {
  it('separates same-arity bufferData overloads by argument type', () => {
    const allocate = snapshot('bufferData', [0x8892, 1024, 0x88e4]);
    const upload = snapshot('bufferData', [0x8892, new Float32Array([1, 2]), 0x88e4]);

    assert.deepEqual(allocate.types, ['number', 'number', 'number']);
    assert.deepEqual(upload.types, ['number', 'typed-array:Float32Array', 'number']);
  });

  it('separates texImage2D overloads by arity', () => {
    const pixels = snapshot('texImage2D', [0x0de1, 0, 0x1908, 2, 2, 0, 0x1908, 0x1401, new Uint8Array(16)]);
    const pixelBufferOffset = snapshot('texImage2D', [0x0de1, 0, 0x1908, 2, 2, 0, 0x1908, 0x1401, 64]);

    assert.equal(pixels.types.length, 9);
    assert.equal(pixels.types[8], 'typed-array:Uint8Array');
    assert.equal(pixelBufferOffset.types.length, 9);
    assert.equal(pixelBufferOffset.types[8], 'number');
  });

  it('separates sequence and typed-array uniform overloads', () => {
    const sequence = snapshot('uniform4fv', [null, [1, 2, 3, 4]]);
    const typed = snapshot('uniform4fv', [null, new Float32Array([1, 2, 3, 4])]);
    const ranged = snapshot('uniform4fv', [null, new Float32Array([1, 2, 3, 4]), 0, 4]);

    assert.equal(sequence.types[1], 'sequence');
    assert.equal(typed.types[1], 'typed-array:Float32Array');
    assert.deepEqual(ranged.types, ['null', 'typed-array:Float32Array', 'number', 'number']);
  });

  it('keeps null and undefined distinguishable', () => {
    const { types, values } = snapshot('bindBuffer', [0x8892, null, undefined]);

    assert.deepEqual(types, ['number', 'null', 'undefined']);
    assert.equal(values[1], null);
    assert.equal(values[2], undefined);
  });

  it('records the exact typed-array constructor of each input', () => {
    const views = [
      new Int8Array(1),
      new Uint8ClampedArray(1),
      new Int16Array(1),
      new Uint32Array(1),
      new Float32Array(1)
    ];

    const types = views.map((view) => snapshot('bufferSubData', [0x8892, 0, view]).types[2]);
    assert.deepEqual(types, [
      'typed-array:Int8Array',
      'typed-array:Uint8ClampedArray',
      'typed-array:Int16Array',
      'typed-array:Uint32Array',
      'typed-array:Float32Array'
    ]);
  });

  it('ignores a reassigned constructor when copying and tagging views', () => {
    const view = new Float32Array([1, 2, 3]);
    view.constructor = Array;

    const { values, types } = snapshot('bufferData', [0x8892, view, 0x88e4]);

    assert.equal(types[1], 'typed-array:Float32Array');
    assert.deepEqual(Array.from(values[1]), [1, 2, 3]);
    assert.equal(values[1].constructor, Float32Array);
  });
});

describe('WebGL synchronous input copies', () => {
  it('copies only the viewed range of a shared backing buffer', () => {
    const backing = new Float32Array([1, 2, 3, 4, 5, 6]);
    const view = backing.subarray(2, 5);

    const { values, types } = snapshot('bufferData', [0x8892, view, 0x88e4]);
    backing.fill(0);

    assert.equal(types[1], 'typed-array:Float32Array');
    assert.deepEqual(Array.from(values[1]), [3, 4, 5]);
    assert.equal(values[1].byteOffset, 0);
    assert.equal(values[1].buffer.byteLength, 12);
    assert.notEqual(values[1].buffer, backing.buffer);
  });

  it('copies a DataView range and leaves the source independent', () => {
    const buffer = new ArrayBuffer(16);
    const view = new DataView(buffer, 4, 8);
    view.setFloat64(0, 2.5);

    const { values, types } = snapshot('bufferData', [0x8892, view, 0x88e4]);
    view.setFloat64(0, 9.5);

    assert.equal(types[1], 'data-view');
    assert.equal(values[1].byteLength, 8);
    assert.equal(values[1].getFloat64(0), 2.5);
  });

  it('copies a bare ArrayBuffer input', () => {
    const buffer = new ArrayBuffer(4);
    new Uint8Array(buffer).set([1, 2, 3, 4]);

    const { values, types } = snapshot('bufferData', [0x8892, buffer, 0x88e4]);
    new Uint8Array(buffer).set([9, 9, 9, 9]);

    assert.equal(types[1], 'array-buffer');
    assert.deepEqual(Array.from(new Uint8Array(values[1])), [1, 2, 3, 4]);
  });

  it('copies views over a SharedArrayBuffer into an independent buffer', () => {
    const shared = new SharedArrayBuffer(8);
    const view = new Uint8Array(shared);
    view.set([1, 2, 3, 4, 5, 6, 7, 8]);

    const { values, types } = snapshot('bufferData', [0x8892, view, 0x88e4]);
    view.fill(0);

    assert.equal(types[1], 'typed-array:Uint8Array');
    assert.deepEqual(Array.from(values[1]), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(Object.prototype.toString.call(values[1].buffer), '[object ArrayBuffer]');
  });

  it('copies a bare SharedArrayBuffer input', () => {
    const shared = new SharedArrayBuffer(4);
    new Uint8Array(shared).set([4, 3, 2, 1]);

    const { values, types } = snapshot('bufferData', [0x8892, shared, 0x88e4]);
    new Uint8Array(shared).fill(0);

    assert.equal(types[1], 'shared-array-buffer');
    assert.deepEqual(Array.from(new Uint8Array(values[1])), [4, 3, 2, 1]);
  });

  it('copies sequence inputs and rejects non-primitive elements', () => {
    const source = [1, 2, 3];
    const { values, types } = snapshot('uniform3fv', [null, source]);
    source[0] = 99;

    assert.equal(types[1], 'sequence');
    assert.deepEqual(values[1], [1, 2, 3]);
    assert.throws(() => snapshot('uniform3fv', [null, [1, {}, 3]]), /unsupported object element/);
  });

  it('rejects inputs backed by a detached buffer', () => {
    const buffer = new ArrayBuffer(8);
    const view = new Uint8Array(buffer);
    structuredClone(buffer, { transfer: [buffer] });

    assert.throws(() => snapshot('bufferData', [0x8892, view, 0x88e4]), /detached buffer/);
    assert.throws(() => snapshot('bufferData', [0x8892, buffer, 0x88e4]), /detached buffer/);
  });

  it('records readback destinations as metadata without copying their contents', () => {
    const destination = new Uint8Array(64);
    const { values, types } = snapshot('readPixels', [0, 0, 4, 4, 0x1908, 0x1401, destination]);

    assert.equal(types[6], 'readback-destination');
    assert.deepEqual(values[6], { arrayType: 'Uint8Array', byteLength: 64 });
    assert.equal(ArrayBuffer.isView(values[6]), false);
  });

  it('records getBufferSubData destinations as readback metadata too', () => {
    const destination = new Float32Array(8);
    const { values, types } = snapshot('getBufferSubData', [0x8892, 0, destination, 0, 8]);

    assert.deepEqual(types, ['number', 'number', 'readback-destination', 'number', 'number']);
    assert.deepEqual(values[2], { arrayType: 'Float32Array', byteLength: 32 });
  });

  it('keeps the readPixels pixel-buffer-offset overload numeric', () => {
    const { types } = snapshot('readPixels', [0, 0, 4, 4, 0x1908, 0x1401, 128]);
    assert.equal(types[6], 'number');
  });

  it('passes declared resource arguments through without copying', () => {
    const program = { program: true };
    const { values, types } = snapshot('getUniformLocation', [program, 'opacity']);

    assert.deepEqual(types, ['resource', 'string']);
    assert.equal(values[0], program);
  });

  it('rejects unsupported objects at non-resource positions', () => {
    assert.throws(
      () => snapshot('texImage2D', [0x0de1, 0, 0x1908, 0x1908, 0x1401, { image: true }]),
      /unsupported object argument at index 5/
    );
  });

  it('canonicalizes a readable image source into pixel bytes', () => {
    const image = { width: 2, height: 2, [Symbol.toStringTag]: 'HTMLCanvasElement' };
    const previousDocument = globalThis.document;
    globalThis.document = {
      createElement() {
        return {
          getContext() {
            return {
              drawImage() {},
              getImageData() {
                return {
                  data: new Uint8ClampedArray([
                    255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255
                  ])
                };
              }
            };
          }
        };
      }
    };
    try {
      const { values, types } = snapshot('texImage2D', [0x0de1, 0, 0x1908, 0x1908, 0x1401, image]);

      assert.equal(types[5], 'image-source');
      assert.equal(values[5].kind, 'HTMLCanvasElement');
      assert.equal(values[5].width, 2);
      assert.equal(values[5].height, 2);
      assert.deepEqual(
        Array.from(values[5].pixels),
        [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]
      );
    } finally {
      globalThis.document = previousDocument;
    }
  });

  it('bakes flip and premultiply into image-source pixels', () => {
    const image = { width: 1, height: 2, [Symbol.toStringTag]: 'HTMLCanvasElement' };
    const previousDocument = globalThis.document;
    globalThis.document = {
      createElement() {
        return {
          getContext() {
            return {
              drawImage() {},
              getImageData() {
                return { data: new Uint8ClampedArray([100, 50, 20, 128, 10, 20, 30, 255]) };
              }
            };
          }
        };
      }
    };
    try {
      const { values } = snapshotWebGlArguments(
        {},
        [0x0de1, 0, 0x8c43, 0x1908, 0x1401, image],
        SPEC.texImage2D,
        (pname) => pname === 0x9240 || pname === 0x9241
      );

      assert.deepEqual(Array.from(values[5].pixels), [10, 20, 30, 255, 50, 25, 10, 128]);
    } finally {
      globalThis.document = previousDocument;
    }
  });

  it('rejects DOM uploads whose format cannot be represented by captured RGBA8 bytes', () => {
    const image = { width: 1, height: 1, [Symbol.toStringTag]: 'HTMLCanvasElement' };
    assert.throws(
      () => snapshot('texImage2D', [0x0de1, 0, 0x1907, 0x1907, 0x1401, image]),
      /requires RGBA\/UNSIGNED_BYTE/
    );
    assert.throws(
      () => snapshot('texImage3D', [0x806f, 0, 0x1908, 1, 1, 1, 0, 0x1908, 0x1401, image]),
      /overload is unsupported/
    );
  });

  it('rejects unreadable image sources as failed uploads', () => {
    const image = { width: 2, height: 2, [Symbol.toStringTag]: 'HTMLImageElement' };
    const previousDocument = globalThis.document;
    globalThis.document = {
      createElement() {
        return {
          getContext() {
            return {
              drawImage() {
                throw new Error('tainted canvas');
              },
              getImageData() {
                throw new Error('tainted canvas');
              }
            };
          }
        };
      }
    };
    try {
      assert.throws(
        () => snapshot('texImage2D', [0x0de1, 0, 0x1908, 0x1908, 0x1401, image]),
        /not readable/
      );
    } finally {
      globalThis.document = previousDocument;
    }
  });
});
