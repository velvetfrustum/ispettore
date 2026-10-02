import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createWebGlCommandJournal } from '../../src/backend/webgl/capture/commandJournal.js';

class FakeCanvas {
  constructor(width, height) {
    this._width = width;
    this._height = height;
  }

  get width() {
    return this._width;
  }

  set width(value) {
    this._width = value;
  }

  get height() {
    return this._height;
  }

  set height(value) {
    this._height = value;
  }
}

function createRichContext() {
  const canvas = new FakeCanvas(320, 240);
  return {
    canvas,
    getContextAttributes() {
      return { alpha: false, antialias: false, depth: true, preserveDrawingBuffer: true };
    },
    get drawingBufferWidth() {
      return canvas.width;
    },
    get drawingBufferHeight() {
      return canvas.height;
    },
    getSupportedExtensions() {
      return ['EXT_color_buffer_float'];
    },
    getParameter(parameter) {
      if (parameter === 0x0d33) return 16384;
      return null;
    },
    MAX_TEXTURE_SIZE: 0x0d33,
    createBuffer() {
      return {};
    },
    bindBuffer() {},
    deleteBuffer() {}
  };
}

function createFakeContext() {
  return {
    createBuffer() {
      return {};
    },
    bindBuffer() {},
    deleteBuffer() {},
    bindTexture() {},
    createTexture() {
      return {};
    },
    deleteTexture() {},
    createFramebuffer() {
      return {};
    },
    bindFramebuffer() {},
    framebufferTexture2D() {},
    deleteFramebuffer() {},
    createRenderbuffer() {
      return {};
    },
    bindRenderbuffer() {},
    framebufferRenderbuffer() {},
    deleteRenderbuffer() {}
  };
}

/** Minimal live GL surface so eager preview baking on significant commands never throws. */
function createPreviewCapableContext() {
  return {
    drawingBufferWidth: 2,
    drawingBufferHeight: 2,
    NO_ERROR: 0,
    RGBA: 0x1908,
    UNSIGNED_BYTE: 0x1401,
    getParameter() {
      return null;
    },
    getError() {
      return 0;
    },
    bindFramebuffer() {},
    bindTexture() {},
    activeTexture() {},
    readPixels(x, y, w, h, format, type, pixels) {
      pixels.fill(180);
    },
    clear() {},
    createBuffer() {
      return {};
    },
    bindBuffer() {},
    bufferData() {}
  };
}

/** Mirrors injected.js: GL calls the journal makes for itself (preview baking) are not logged. */
function createIsolatedJournal(context) {
  let suppressed = false;
  return createWebGlCommandJournal(context, {
    shouldCapture: () => !suppressed,
    runIsolated(fn) {
      const previous = suppressed;
      suppressed = true;
      try {
        return fn();
      } finally {
        suppressed = previous;
      }
    }
  });
}

/** Recording only begins at the next clean frame boundary after arm(). */
function beginFrame(journal, frameId = 'frame:1:1') {
  journal.arm();
  journal.markFrameStart({ frameId, kind: 'animation-frame' });
}

describe('WebGL command journal', () => {
  it('captures context attributes, limits, and drawing-buffer dimensions', () => {
    const context = createRichContext();
    const journal = createWebGlCommandJournal(context);

    assert.equal(journal.contextInfo.attributes.antialias, false);
    assert.equal(journal.contextInfo.attributes.preserveDrawingBuffer, true);
    assert.equal(journal.contextInfo.drawingBufferWidth, 320);
    assert.equal(journal.contextInfo.drawingBufferHeight, 240);
    assert.equal(journal.contextInfo.limits.MAX_TEXTURE_SIZE, 16384);
    assert.deepEqual(journal.contextInfo.supportedExtensions, ['EXT_color_buffer_float']);
    assert.deepEqual(journal.contextInfo.resizeTracking, {
      complete: true,
      trackedProperties: ['width', 'height']
    });
  });

  it('records nothing before arm() is called, even across frame boundaries', () => {
    const context = createRichContext();
    const journal = createWebGlCommandJournal(context);

    journal.markFrameStart({ frameId: 'frame:1:1', kind: 'animation-frame' });
    context.createBuffer();
    journal.markFrameEnd();

    assert.equal(journal.commands.length, 0);
    assert.deepEqual(journal.frames, []);
  });

  it('records canvas resizes once armed', () => {
    const context = createRichContext();
    const journal = createWebGlCommandJournal(context);
    beginFrame(journal);

    context.canvas.width = 640;
    context.createBuffer();
    context.canvas.height = 480;

    assert.deepEqual(journal.resizes, [
      {
        commandIndex: 0,
        canvasWidth: 640,
        canvasHeight: 240,
        drawingBufferWidth: 640,
        drawingBufferHeight: 240
      },
      {
        commandIndex: 1,
        canvasWidth: 640,
        canvasHeight: 480,
        drawingBufferWidth: 640,
        drawingBufferHeight: 480
      }
    ]);
    assert.deepEqual(journal.contextInfo.canvasWidth, 320);
    assert.equal(journal.commands.length, 1);
    assert.equal(journal.valid, true);
  });

  it('stops recording resizes after uninstall', () => {
    const context = createRichContext();
    const journal = createWebGlCommandJournal(context);

    journal.uninstall();
    context.canvas.width = 800;

    assert.deepEqual(journal.resizes, []);
    assert.equal(context.canvas.width, 800);
  });

  it('arm() only takes effect at the next clean frame boundary, never mid-frame', () => {
    const context = createRichContext();
    const journal = createWebGlCommandJournal(context);

    journal.markFrameStart({ frameId: 'frame:1:1', kind: 'animation-frame' });
    journal.arm();
    context.createBuffer();
    journal.markFrameEnd();

    // arm() landed mid-frame, so this frame is skipped entirely (never partially captured).
    assert.equal(journal.commands.length, 0);
    assert.deepEqual(journal.frames, []);
    assert.equal(journal.armed, true);

    journal.markFrameStart({ frameId: 'frame:1:2', kind: 'animation-frame' });
    context.createBuffer();
    journal.markFrameEnd();

    assert.equal(journal.commands.length, 1);
    assert.equal(journal.frames.length, 1);
    assert.equal(journal.frames[0].frameId, 'frame:1:2');
  });

  it('stops recording automatically once the armed frame ends, and does not resume without re-arming', () => {
    const context = createRichContext();
    const journal = createWebGlCommandJournal(context);
    beginFrame(journal, 'frame:1:1');
    context.createBuffer();
    journal.markFrameEnd();

    assert.equal(journal.recording, false);
    assert.equal(journal.commands.length, 1);

    journal.markFrameStart({ frameId: 'frame:1:2', kind: 'animation-frame' });
    context.createBuffer();
    journal.markFrameEnd();

    // No re-arm happened, so the second frame contributes nothing.
    assert.equal(journal.commands.length, 1);
    assert.equal(journal.frames.length, 1);
    assert.equal(journal.frames[0].frameId, 'frame:1:1');
  });

  it('keeps the arm token alive across a no-op frame instead of spending it on zero commands', () => {
    // A page can have more than one rAF-driven callback (e.g. a GUI's own .listen() polling
    // loop alongside the renderer's animation loop), each bracketing markFrameStart/markFrameEnd
    // against the same journal. If the callback that happens to tick right after arm() does no
    // GL work at all, that must not silently consume the capture — it has to wait for whichever
    // callback actually renders (webgl_postprocessing_transition on threejs.org: capture never
    // completed because its GUI's .listen() loop kept winning the race and spending the arm).
    const context = createRichContext();
    const journal = createWebGlCommandJournal(context);

    beginFrame(journal, 'frame:gui:1');
    // No GL calls — this stands in for an unrelated rAF callback (a GUI polling loop) that
    // ticked before the real render callback.
    journal.markFrameEnd();

    assert.equal(journal.armed, true);
    assert.equal(journal.commands.length, 0);
    assert.deepEqual(journal.frames, []);

    journal.markFrameStart({ frameId: 'frame:render:1', kind: 'animation-frame' });
    context.createBuffer();
    journal.markFrameEnd();

    assert.equal(journal.commands.length, 1);
    assert.equal(journal.frames.length, 1);
    assert.equal(journal.frames[0].frameId, 'frame:render:1');
    assert.equal(journal.armed, false);
  });

  it('captures a render-on-demand draw issued outside any animation frame once armed', async () => {
    // threejs.org webgl_materials_normalmap_object_space: no rAF loop, renderer.render() runs
    // from OrbitControls 'change' handlers, so the armed capture used to time out forever.
    const context = createPreviewCapableContext();
    const journal = createIsolatedJournal(context);
    context.createBuffer();
    context.clear(0x4000);
    await Promise.resolve();
    assert.deepEqual(journal.frames, []);
    await new Promise((resolve) => setTimeout(resolve, 1100));

    journal.arm();
    const buffer = context.createBuffer();
    context.bindBuffer(0x8892, buffer);
    context.clear(0x4000);
    assert.equal(journal.recording, true);
    await Promise.resolve();

    assert.equal(journal.recording, false);
    assert.equal(journal.armed, false);
    assert.equal(journal.frames.length, 1);
    assert.equal(journal.frames[0].kind, 'on-demand');
    assert.deepEqual(journal.commands.map((command) => command.op), ['createBuffer', 'bindBuffer', 'clear']);

    assert.ok(journal.commands[0].durationMs < 1000, 'idle time before the frame is not charged to its first command');

    context.clear(0x4000);
    await Promise.resolve();
    assert.equal(journal.frames.length, 1, 'a later on-demand draw needs a new arm()');
  });

  it('keeps the capture armed when commands outside an animation frame never draw', async () => {
    // An animated page can upload a texture from a load callback between frames; that must not
    // spend the arm token, or the capture would contain no rendering at all.
    const context = createPreviewCapableContext();
    const journal = createIsolatedJournal(context);
    journal.arm();
    context.createBuffer();
    await Promise.resolve();

    assert.equal(journal.armed, true);
    assert.equal(journal.recording, false);
    assert.deepEqual(journal.frames, []);

    journal.markFrameStart({ frameId: 'frame:1:1', kind: 'animation-frame' });
    context.clear(0x4000);
    journal.markFrameEnd();

    assert.equal(journal.frames.length, 1);
    assert.equal(journal.frames[0].frameId, 'frame:1:1');
    assert.deepEqual(journal.commands.map((command) => command.op), ['clear']);
  });

  it('each arm() captures exactly one bounded frame, discarding the previous capture', () => {
    const context = createRichContext();
    const journal = createWebGlCommandJournal(context);

    beginFrame(journal, 'frame:1:1');
    context.createBuffer();
    context.createBuffer();
    journal.markFrameEnd();
    assert.equal(journal.commands.length, 2);

    beginFrame(journal, 'frame:1:2');
    context.createBuffer();
    journal.markFrameEnd();

    assert.equal(journal.commands.length, 1);
    assert.equal(journal.frames.length, 1);
    assert.equal(journal.frames[0].frameId, 'frame:1:2');
    assert.equal(journal.evictedCommandCount, 0);
  });

  it('keeps a rolling window when maxCommands is exceeded within one armed frame', () => {
    const context = createRichContext();
    const journal = createWebGlCommandJournal(context, { maxCommands: 3 });
    beginFrame(journal);

    for (let index = 0; index < 5; index++) context.createBuffer();

    assert.equal(journal.evictedCommandCount, 2);
    assert.equal(journal.commands.length, 3);
    assert.deepEqual(journal.commands.map((entry) => entry.op), ['createBuffer', 'createBuffer', 'createBuffer']);
  });

  it('clamps the open frame range when commands are evicted before it ends', () => {
    const context = createRichContext();
    const journal = createWebGlCommandJournal(context, { maxCommands: 3 });
    beginFrame(journal);

    for (let index = 0; index < 5; index++) context.createBuffer();
    journal.markFrameEnd();

    assert.equal(journal.evictedCommandCount, 2);
    assert.deepEqual(journal.frames, [
      { frameId: 'frame:1:1', label: 'frame', kind: 'animation-frame', startCommandIndex: 2, endCommandIndex: 5, commandCount: 3 }
    ]);
  });

  it('tracks bytes retained by the rolling command window', () => {
    const context = createRichContext();
    const journal = createWebGlCommandJournal(context, { maxCommands: 2, byteBudget: 80 });
    beginFrame(journal);

    for (let index = 0; index < 4; index++) context.createBuffer();

    assert.equal(journal.commands.length, 2);
    assert.equal(journal.capturedBytes, 64);
    assert.equal(journal.overflow, null);
  });

  it('records creation, binding, and deletion with stable resource references', () => {
    const context = createFakeContext();
    const journal = createWebGlCommandJournal(context);
    beginFrame(journal);

    const buffer = context.createBuffer();
    context.bindBuffer(0x8892, buffer);
    context.deleteBuffer(buffer);

    assert.equal(journal.commands.length, 3);
    const [create, bind, del] = journal.commands;
    assert.equal(create.op, 'createBuffer');
    assert.match(create.resultId, /:buffer-1$/);
    assert.deepEqual(bind.args, [0x8892, { ref: create.resultId }]);
    assert.deepEqual(bind.argTypes, ['number', 'resource']);
    assert.deepEqual(del.args, [{ ref: create.resultId }]);
    assert.deepEqual(del.argTypes, ['resource']);
    assert.equal(journal.valid, true);
  });

  it('records the exact signature of each overloaded upload', () => {
    const context = {
      createBuffer() {
        return {};
      },
      bindBuffer() {},
      bufferData() {},
      bufferSubData() {}
    };
    const journal = createWebGlCommandJournal(context);
    beginFrame(journal);

    const source = new Float32Array([1, 2, 3, 4]);
    context.bufferData(0x8892, 64, 0x88e4);
    context.bufferData(0x8892, source, 0x88e4);
    context.bufferSubData(0x8892, 8, source, 1, 2);
    source.fill(0);

    const [allocate, upload, partial] = journal.commands;
    assert.deepEqual(allocate.argTypes, ['number', 'number', 'number']);
    assert.deepEqual(allocate.args, [0x8892, 64, 0x88e4]);
    assert.deepEqual(upload.argTypes, ['number', 'typed-array:Float32Array', 'number']);
    assert.deepEqual(Array.from(upload.args[1]), [1, 2, 3, 4]);
    assert.deepEqual(partial.argTypes, [
      'number',
      'number',
      'typed-array:Float32Array',
      'number',
      'number'
    ]);
    assert.deepEqual(Array.from(partial.args[2]), [1, 2, 3, 4]);
    assert.equal(journal.valid, true);
  });

  it('records readback destinations without copying pixel data', () => {
    const context = {
      readPixels(x, y, width, height, format, type, pixels) {
        pixels.fill(7);
      }
    };
    const journal = createWebGlCommandJournal(context);
    beginFrame(journal);

    context.readPixels(0, 0, 2, 2, 0x1908, 0x1401, new Uint8Array(16));

    const [readback] = journal.commands;
    assert.equal(readback.argTypes[6], 'readback-destination');
    assert.deepEqual(readback.args[6], { arrayType: 'Uint8Array', byteLength: 16 });
    assert.equal(journal.valid, true);
  });

  it('records a texture attached to a framebuffer via renderbuffer and texture attachments', () => {
    const context = createFakeContext();
    const journal = createWebGlCommandJournal(context);
    beginFrame(journal);

    const texture = context.createTexture();
    const framebuffer = context.createFramebuffer();
    const renderbuffer = context.createRenderbuffer();
    context.bindFramebuffer(0x8d40, framebuffer);
    context.framebufferTexture2D(0x8d40, 0x8ce0, 0x0de1, texture, 0);
    context.framebufferRenderbuffer(0x8d40, 0x8d20, 0x8d41, renderbuffer);
    context.deleteTexture(texture);
    context.deleteRenderbuffer(renderbuffer);
    context.deleteFramebuffer(framebuffer);

    const [createTexture, createFramebuffer, createRenderbuffer, , attachTexture, attachRenderbuffer] =
      journal.commands;
    assert.match(createTexture.resultId, /:texture-1$/);
    assert.match(createFramebuffer.resultId, /:framebuffer-2$/);
    assert.match(createRenderbuffer.resultId, /:renderbuffer-3$/);
    assert.deepEqual(attachTexture.args, [0x8d40, 0x8ce0, 0x0de1, { ref: createTexture.resultId }, 0]);
    assert.deepEqual(attachRenderbuffer.args, [0x8d40, 0x8d20, 0x8d41, { ref: createRenderbuffer.resultId }]);
    assert.equal(journal.valid, true);
  });

  it('never reuses an id after deletion and recreation', () => {
    const context = createFakeContext();
    const journal = createWebGlCommandJournal(context);
    beginFrame(journal);

    const first = context.createBuffer();
    context.deleteBuffer(first);
    context.createBuffer();

    const [createFirst, , createSecond] = journal.commands;
    assert.notEqual(createFirst.resultId, createSecond.resultId);
  });

  it('records program, uniform-location, and uniform update references', () => {
    const context = {
      createProgram() {
        return {};
      },
      getUniformLocation() {
        return {};
      },
      uniform1f() {}
    };
    const journal = createWebGlCommandJournal(context);
    beginFrame(journal);

    const program = context.createProgram();
    const location = context.getUniformLocation(program, 'opacity');
    context.uniform1f(location, 0.5);

    const [createProgram, getLocation, setUniform] = journal.commands;
    assert.deepEqual(getLocation.args, [{ ref: createProgram.resultId }, 'opacity']);
    assert.match(getLocation.resultId, /:uniform-location-2$/);
    assert.deepEqual(setUniform.args, [{ ref: getLocation.resultId }, 0.5]);
    assert.equal(journal.valid, true);
  });

  it('marks the journal invalid when a command references an untracked object', () => {
    const context = createFakeContext();
    const journal = createWebGlCommandJournal(context);
    beginFrame(journal);

    context.bindTexture(0x0de1, {});

    assert.equal(journal.valid, false);
    assert.equal(journal.commands[0].failed, 'reference');
    assert.match(journal.commands[0].error, /referenced an untracked or deleted WebGL object/);
    assert.equal(journal.failures[0].captureError.stage, 'reference');
  });

  it('reports unsupported object arguments with an explicit reason', () => {
    const context = {
      texImage2D() {}
    };
    const journal = createWebGlCommandJournal(context);
    beginFrame(journal);

    context.texImage2D(0x0de1, 0, 0x1908, 0x1908, 0x1401, { image: true });

    assert.equal(journal.valid, false);
    const [command] = journal.commands;
    assert.equal(command.op, 'texImage2D');
    assert.equal(command.failed, 'arguments');
    assert.match(command.error, /unsupported object argument at index 5/);
    assert.equal(command.args, null);
  });

  it('keeps isolated journals and resource ids for independently observed contexts', () => {
    const contextA = createFakeContext();
    const contextB = createFakeContext();
    const journalA = createWebGlCommandJournal(contextA);
    const journalB = createWebGlCommandJournal(contextB);
    beginFrame(journalA);
    beginFrame(journalB);

    contextA.createBuffer();
    contextB.createBuffer();

    assert.equal(journalA.commands.length, 1);
    assert.equal(journalB.commands.length, 1);
    assert.notEqual(journalA.contextId, journalB.contextId);
    assert.notEqual(journalA.commands[0].resultId, journalB.commands[0].resultId);
  });

  it('keeps resolving references to resources created before arm() (the normal case: scenes set up once at startup)', () => {
    const context = createFakeContext();
    const journal = createWebGlCommandJournal(context);

    // Created long before anyone arms a capture — exactly how a real scene's buffers,
    // textures, and programs are set up once, well before the user presses "Capture".
    const texture = context.createTexture();

    beginFrame(journal);
    context.bindTexture(0x0de1, texture);

    assert.equal(journal.valid, true);
    assert.equal(journal.commands.length, 1);
    assert.equal(journal.commands[0].failed, null);
    assert.match(journal.commands[0].args[1].ref, /:texture-1$/);
  });

  it('bakes a live preview onto significant commands (draw/clear/blit/copy) but not onto plain state commands', () => {
    const context = createPreviewCapableContext();
    const journal = createWebGlCommandJournal(context);
    beginFrame(journal);

    const buffer = context.createBuffer();
    context.bindBuffer(0x8892, buffer);
    context.clear(0x4000);

    const [, , clearCommand] = journal.commands;
    assert.equal(clearCommand.op, 'clear');
    assert.ok(clearCommand.preview, 'clear() should get a baked preview');
    assert.equal(clearCommand.preview.colorTarget, 'default');
    assert.ok(clearCommand.preview.color, 'baked preview should include a color summary');

    const [createBufferCommand, bindBufferCommand] = journal.commands;
    assert.equal(createBufferCommand.preview, undefined);
    assert.equal(bindBufferCommand.preview, undefined);
  });

  it('never logs the GL calls eager preview baking makes on its own behalf as if the app made them', () => {
    // Regression test: preview baking calls getParameter/readPixels/etc. on the same live,
    // wrapped context it is observing. Without suppression those calls recurse straight back
    // into recordCommand and flood the package with instrumentation noise instead of the
    // app's real commands (observed on webgl-simple: 15840 commands captured, ~95% of them
    // our own getParameter/getError/createQuery/readPixels calls, not the app's).
    const context = createPreviewCapableContext();
    let suppressed = false;
    const journal = createWebGlCommandJournal(context, {
      shouldCapture: () => !suppressed,
      runIsolated(fn) {
        const previous = suppressed;
        suppressed = true;
        try {
          return fn();
        } finally {
          suppressed = previous;
        }
      }
    });
    beginFrame(journal);

    context.clear(0x4000);

    assert.deepEqual(journal.commands.map((command) => command.op), ['clear']);
    assert.ok(journal.commands[0].preview?.color, 'preview baking must still have run and succeeded');
  });
});
