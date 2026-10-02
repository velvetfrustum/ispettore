import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createWebGlCommandJournal } from '../../src/backend/webgl/capture/commandJournal.js';
import { extensionMethodsFor } from '../../src/backend/webgl/intercept/extensions.js';

function createFakeContext() {
  return {
    createBuffer() {
      return {};
    },
    createTexture() {
      return {};
    },
    createFramebuffer() {
      return {};
    },
    createShader() {
      return {};
    },
    getExtension(name) {
      if (name === 'WEBGL_multi_draw') {
        return {
          multiDrawArraysWEBGL() {},
          multiDrawElementsWEBGL() {}
        };
      }
      if (name === 'WEBGL_multisampled_render_to_texture') {
        return {
          framebufferTexture2DMultisampleEXT() {},
          renderbufferStorageMultisampleEXT() {}
        };
      }
      if (name === 'WEBGL_debug_shaders') {
        return {
          getTranslatedShaderSource() {
            return 'translated';
          }
        };
      }
      if (name === 'OES_texture_float_linear') {
        return {};
      }
      return null;
    }
  };
}

function beginFrame(journal, frameId = 'frame:1:1') {
  journal.arm();
  journal.markFrameStart({ frameId, kind: 'animation-frame' });
}

describe('WebGL extension interception', () => {
  it('declares the extension methods Three.js r184 can call', () => {
    const names = (extension) => extensionMethodsFor(extension).map((d) => d.name);
    assert.deepEqual(names('WEBGL_multisampled_render_to_texture'), [
      'framebufferTexture2DMultisampleEXT',
      'renderbufferStorageMultisampleEXT'
    ]);
    assert.deepEqual(names('WEBGL_multi_draw'), ['multiDrawArraysWEBGL', 'multiDrawElementsWEBGL']);
    assert.deepEqual(names('WEBGL_debug_shaders'), ['getTranslatedShaderSource']);
    assert.deepEqual(names('EXT_disjoint_timer_query_webgl2'), ['beginQueryEXT', 'endQueryEXT', 'queryCounterEXT']);
    assert.deepEqual(extensionMethodsFor('EXT_color_buffer_float'), []);
  });

  it('records getExtension enablement and wraps the returned object methods', () => {
    const context = createFakeContext();
    const journal = createWebGlCommandJournal(context);
    beginFrame(journal);

    const multiDraw = context.getExtension('WEBGL_multi_draw');
    const starts = new Int32Array([0, 4]);
    const counts = new Int32Array([3, 6]);
    multiDraw.multiDrawArraysWEBGL(0x0004, starts, 0, counts, 0, 2);
    starts.fill(0);

    const [enablement, draw] = journal.commands;
    assert.deepEqual(enablement.args, ['WEBGL_multi_draw']);
    assert.deepEqual(enablement.argTypes, ['string']);
    assert.equal(enablement.failed, null);
    assert.equal(draw.op, 'multiDrawArraysWEBGL');
    assert.deepEqual(draw.argTypes, ['number', 'typed-array:Int32Array', 'number', 'typed-array:Int32Array', 'number', 'number']);
    assert.deepEqual(Array.from(draw.args[1]), [0, 4]);
    assert.deepEqual(Array.from(draw.args[3]), [3, 6]);
    assert.equal(journal.valid, true);
  });

  it('resolves extension method resource arguments through the context registry', () => {
    const context = createFakeContext();
    const journal = createWebGlCommandJournal(context);
    beginFrame(journal);

    const texture = context.createTexture();
    const ext = context.getExtension('WEBGL_multisampled_render_to_texture');
    ext.framebufferTexture2DMultisampleEXT(0x8d40, 0x8ce0, 0x0de1, texture, 0, 4);

    const [, , attach] = journal.commands;
    assert.equal(attach.op, 'framebufferTexture2DMultisampleEXT');
    assert.deepEqual(attach.argTypes, ['number', 'number', 'number', 'resource', 'number', 'number']);
    assert.equal(attach.args[0], 0x8d40);
    assert.equal(attach.args[1], 0x8ce0);
    assert.equal(attach.args[2], 0x0de1);
    assert.match(attach.args[3].ref, /:texture-/);
    assert.equal(attach.args[3].ref, journal.commands[0].resultId);
    assert.deepEqual(attach.args.slice(4), [0, 4]);
    assert.equal(journal.valid, true);
  });

  it('keeps wrapping idempotent across repeated getExtension calls', () => {
    const context = createFakeContext();
    const journal = createWebGlCommandJournal(context);
    beginFrame(journal);

    const first = context.getExtension('WEBGL_multi_draw');
    first.multiDrawArraysWEBGL(0x0004, new Int32Array([0]), 0, new Int32Array([3]), 0, 1);
    const second = context.getExtension('WEBGL_multi_draw');
    second.multiDrawArraysWEBGL(0x0004, new Int32Array([6]), 0, new Int32Array([2]), 0, 1);

    assert.equal(journal.commands.length, 4);
    const drawOps = journal.commands.filter((command) => command.op === 'multiDrawArraysWEBGL');
    assert.equal(drawOps.length, 2);
    assert.equal(journal.valid, true);
  });

  it('records enablement-only extensions without wrapping anything', () => {
    const context = createFakeContext();
    const journal = createWebGlCommandJournal(context);
    beginFrame(journal);

    const extension = context.getExtension('OES_texture_float_linear');
    assert.deepEqual(extension, {});

    assert.equal(journal.commands.length, 1);
    assert.deepEqual(journal.commands[0].args, ['OES_texture_float_linear']);
    assert.equal(journal.valid, true);
  });

  it('records unavailable extensions as commands without crashing', () => {
    const context = createFakeContext();
    const journal = createWebGlCommandJournal(context);
    beginFrame(journal);

    assert.equal(context.getExtension('WEBGL_clip_cull_distance'), null);

    assert.equal(journal.commands.length, 1);
    assert.deepEqual(journal.commands[0].args, ['WEBGL_clip_cull_distance']);
    assert.equal(journal.valid, true);
  });

  it('records readback extension methods as readback', () => {
    const context = createFakeContext();
    const journal = createWebGlCommandJournal(context);
    beginFrame(journal);

    const extension = context.getExtension('WEBGL_debug_shaders');
    const shader = context.createShader();
    const source = extension.getTranslatedShaderSource(shader);

    const [enablement, , readback] = journal.commands;
    assert.equal(readback.op, 'getTranslatedShaderSource');
    assert.match(readback.args[0].ref, /:shader-/);
    assert.equal(source, 'translated');
    assert.equal(journal.valid, true);
  });
});