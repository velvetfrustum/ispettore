import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WEBGL_API_SPEC } from '../../src/backend/webgl/intercept/apiSpec.js';
import { installWebGlContextWrappers } from '../../src/backend/webgl/intercept/contextWrappers.js';

describe('WebGL API specification', () => {
  it('defines unique methods with resource categories and reference metadata', () => {
    const names = WEBGL_API_SPEC.map((descriptor) => descriptor.name);
    assert.equal(new Set(names).size, names.length);
    assert.ok(names.length > 200);
    for (const required of [
      'createShader',
      'bufferData',
      'clear',
      'drawArrays',
      'drawElementsInstanced',
      'texImage3D',
      'transformFeedbackVaryings',
      'waitSync'
    ]) {
      assert.equal(names.includes(required), true, `Missing ${required}`);
    }

    const byName = Object.fromEntries(WEBGL_API_SPEC.map((descriptor) => [descriptor.name, descriptor]));
    assert.equal(byName.createTexture.category, 'resource');
    assert.equal(byName.createTexture.resultKind, 'texture');
    assert.deepEqual(byName.bindBuffer.argResourceIndexes, [1]);
    assert.deepEqual(byName.framebufferTexture2D.argResourceIndexes, [3]);
    assert.deepEqual(byName.framebufferTextureLayer.argResourceIndexes, [2]);
    assert.deepEqual(byName.getUniformLocation.argResourceIndexes, [0]);
    assert.equal(byName.deleteTexture.category, 'resource-delete');
    assert.equal(byName.readPixels.category, 'readback');
    assert.equal(byName.getBufferSubData.category, 'readback');
  });
});

describe('WebGL context wrappers', () => {
  it('generates wrappers from the specification and snapshots mutable inputs before execution', () => {
    const calls = [];
    const source = new Float32Array([1, 2, 3]);
    const context = {
      bufferData(target, data, usage) {
        data[0] = 99;
        return `${target}:${usage}`;
      }
    };

    const controller = installWebGlContextWrappers(context, {
      onCommand: (command) => calls.push(command)
    });
    const result = context.bufferData(1, source, 2);

    assert.equal(result, '1:2');
    assert.deepEqual(controller.wrappedMethods, ['bufferData']);
    assert.equal(source[0], 99);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].descriptor.name, 'bufferData');
    assert.equal(calls[0].captureError, null);
    assert.deepEqual(calls[0].args.types, ['number', 'typed-array:Float32Array', 'number']);
    assert.deepEqual(Array.from(calls[0].args.values[1]), [1, 2, 3]);
  });

  it('does not double-wrap contexts and can restore native methods', () => {
    let nativeCalls = 0;
    const context = {
      clear(mask) {
        nativeCalls++;
        return mask;
      }
    };
    const original = context.clear;
    const first = installWebGlContextWrappers(context);
    const second = installWebGlContextWrappers(context);

    assert.equal(second, first);
    assert.equal(context.clear(7), 7);
    assert.equal(nativeCalls, 1);
    first.uninstall();
    assert.equal(context.clear, original);
  });

  it('rejects a second installation with different recorder options', () => {
    const context = { clear() {} };
    installWebGlContextWrappers(context, { onCommand() {} });
    assert.throws(
      () => installWebGlContextWrappers(context, { onCommand() {} }),
      /different options/
    );
  });

  it('keeps command order and invalidates capture when argument snapshots fail', () => {
    const commands = [];
    const errors = [];
    const context = {
      bufferData() {
        return 'native-result';
      }
    };
    const controller = installWebGlContextWrappers(context, {
      snapshotArguments() {
        throw new Error('unsupported argument');
      },
      onCommand: (command) => commands.push(command),
      onCaptureError: (failure) => errors.push(failure)
    });

    assert.equal(context.bufferData(1, new Uint8Array([1]), 2), 'native-result');
    assert.equal(commands.length, 1);
    assert.equal(commands[0].descriptor.name, 'bufferData');
    assert.equal(commands[0].args, null);
    assert.equal(commands[0].captureError.stage, 'arguments');
    assert.equal(controller.valid, false);
    assert.equal(controller.failures.length, 1);
    assert.equal(errors.length, 1);
  });

  it('rejects unsupported object inputs but accepts declared WebGL object references', () => {
    const commands = [];
    const context = {
      texImage2D() {},
      bindTexture() {}
    };
    const controller = installWebGlContextWrappers(context, {
      onCommand: (command) => commands.push(command)
    });

    context.texImage2D(0, 0, 0, 0, 0, { image: true });
    context.bindTexture(0, { texture: true });

    assert.equal(commands[0].captureError.stage, 'arguments');
    assert.match(commands[0].captureError.error.message, /unsupported object argument/);
    assert.equal(commands[1].captureError, null);
    assert.equal(controller.valid, false);
  });

  it('reports instrumentation failures without changing native behavior', () => {
    const errors = [];
    const context = {
      drawArrays() {
        return 'native-result';
      }
    };
    installWebGlContextWrappers(context, {
      onCommand() {
        throw new Error('recorder failed');
      },
      onCaptureError: (failure) => errors.push(failure)
    });

    assert.equal(context.drawArrays(4, 0, 3), 'native-result');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].stage, 'command');
    assert.equal(errors[0].descriptor.name, 'drawArrays');
  });

  it('skips snapshots and journal callbacks while capture is suppressed', () => {
    let snapshotCalls = 0;
    let commandCalls = 0;
    const context = { clear: (mask) => mask };
    installWebGlContextWrappers(context, {
      shouldCapture: () => false,
      snapshotArguments(args) {
        snapshotCalls++;
        return args;
      },
      onCommand() {
        commandCalls++;
      }
    });

    assert.equal(context.clear(1), 1);
    assert.equal(snapshotCalls, 0);
    assert.equal(commandCalls, 0);
  });
});
