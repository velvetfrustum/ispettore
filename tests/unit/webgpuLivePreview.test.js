import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { enqueueTexturePreview } from '../../src/backend/webgpu/capture/livePreview.js';
import { createWebGpuPreviewCapture } from '../../src/backend/webgpu/spies/previewCapture.js';
import { createWebGpuDeviceJournal } from '../../src/backend/webgpu/capture/deviceJournal.js';
import { serializeWebGpuJournal } from '../../src/backend/webgpu/serialize/serializeJournal.js';
import { lookupWebGpuCapture } from '../../src/inspection/webgpu/lookup.js';

function mockImage(t) {
  let image;
  const globals = ['document', 'ImageData'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  t.after(() => {
    for (const [name, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  globalThis.document = { createElement: () => ({
    getContext: () => ({ putImageData: (value) => { image = value; } }),
    toDataURL: () => `data:image/png;base64,${image.data[0]}`
  }) };
  globalThis.ImageData = class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } };
  return () => image;
}

describe('WebGPU live readback', () => {
  it('inserts a copy synchronously but maps only after submission, handling BGRA and padded rows', async (t) => {
    const image = mockImage(t);
    const calls = [];
    const bytes = new Uint8Array(512);
    bytes.set([30, 20, 10, 0, 60, 50, 40, 128]);
    bytes.set([90, 80, 70, 255, 120, 110, 100, 255], 256);
    const raw = {
      createBuffer: ({ size, usage }) => {
        assert.equal(size, 512); assert.equal(usage, 9);
        return { mapAsync: async () => calls.push('map'), getMappedRange: () => bytes.buffer, destroy: () => calls.push('destroy') };
      },
      copyTextureToBuffer(source, target, size) {
        assert.equal(target.bytesPerRow, 256); assert.deepEqual(size, [2, 2, 1]); calls.push('copy');
      }
    };
    const job = enqueueTexturePreview({}, { width: 2, height: 2, format: 'bgra8unorm' }, raw, { alphaMode: 'opaque' });
    assert.deepEqual(calls, ['copy']);
    const preview = await job.read();
    assert.deepEqual([...image().data], [10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 100, 110, 120, 255]);
    assert.equal(preview.color.range, 110);
    assert.deepEqual(calls, ['copy', 'map', 'destroy']);
  });

  it('releases staging buffers when a copy or map fails', async () => {
    for (const failure of ['copy', 'map']) {
      let destroyed = false;
      const raw = {
        createBuffer: () => ({ mapAsync: async () => { throw new Error('map'); }, destroy: () => { destroyed = true; } }),
        copyTextureToBuffer() { if (failure === 'copy') throw new Error('copy'); }
      };
      const operation = async () => enqueueTexturePreview({}, { width: 1, height: 1, format: 'rgba8unorm' }, raw).read();
      await assert.rejects(operation, new RegExp(failure));
      assert.equal(destroyed, true);
    }
  });

  it('keeps distinct pass outputs when a later pass overwrites the same texture', async (t) => {
    mockImage(t);
    const device = { features: [], limits: {} };
    const journal = createWebGpuDeviceJournal(device);
    const preview = createWebGpuPreviewCapture(device, journal, ({ size }) => {
      const bytes = new Uint8Array(size);
      return { bytes, mapAsync: async () => {}, getMappedRange: () => bytes.buffer, destroy() {} };
    });
    const texture = { width: 1, height: 1, format: 'rgba8unorm', color: 10 };
    const view = {};
    preview.view(view, texture);
    journal.arm(); journal.markFrameStart({ frameId: 'f' });
    const encoder = { copyTextureToBuffer: ({ texture: source }, { buffer }) => { buffer.bytes.set([source.color, 0, 0, 255]); } };
    preview.encoder(encoder);
    const draws = [];
    for (const color of [10, 200]) {
      texture.color = color;
      const pass = {};
      const begin = journal.record({ op: 'beginRenderPass' });
      preview.beginPass(encoder, pass, { colorAttachments: [{ view, storeOp: 'store' }] }, begin);
      const draw = journal.record({ op: 'draw' });
      draws.push(draw);
      preview.draw(pass, draw);
      preview.endPass(pass);
    }
    const buffer = {};
    preview.finish(encoder, buffer);
    assert.ok(draws.every((draw) => draw.preview.color.available === false));
    preview.submit([buffer], journal.record({ op: 'submit' }));
    journal.markFrameEnd();
    await journal.collectPendingPreviews();
    assert.equal(draws[0].preview.color.max, 10);
    assert.equal(draws[1].preview.color.max, 200);
  });
});

describe('WebGPU bounded recording and inspection', () => {
  it('retains resource descriptors but no command history while idle; rearming replaces the frame', () => {
    const journal = createWebGpuDeviceJournal({ features: [], limits: {} });
    const shader = {};
    const pipeline = {};
    journal.registerResource('shader', shader, { op: 'createShaderModule', args: [{ code: '@vertex fn vs() {}' }] });
    journal.registerResource('pipeline', pipeline, { op: 'createRenderPipeline', args: [{ vertex: { module: { ref: 'shader' } } }] });
    for (let index = 0; index < 1000; index++) {
      journal.markFrameStart({ frameId: `idle${index}` }); journal.record({ op: 'draw' }); journal.markFrameEnd();
    }
    assert.equal(journal.commands.length, 0); assert.equal(journal.frames.length, 0);
    for (const frameId of ['first', 'second']) {
      journal.arm(); journal.markFrameStart({ frameId });
      journal.record({ op: 'setPipeline', args: [{ ref: 'pipeline' }], argTypes: ['resource'] });
      journal.record({ op: 'draw' }); journal.markFrameEnd();
      assert.equal(journal.commands.length, 2);
      assert.deepEqual(Object.keys(journal.resources).sort(), ['pipeline', 'shader']);
      assert.equal(journal.frames.length, 1); assert.equal(journal.frames[0].frameId, frameId);
    }
  });

  it('does not start mid-frame, rearms after empty callbacks, and captures on-demand work', async () => {
    const journal = createWebGpuDeviceJournal({ features: [], limits: {} });
    journal.markFrameStart({ frameId: 'old' }); journal.arm();
    journal.record({ op: 'draw' }); journal.markFrameEnd();
    assert.equal(journal.commands.length, 0);
    journal.markFrameStart({ frameId: 'empty' }); journal.markFrameEnd();
    assert.equal(journal.isArmed, true);
    journal.ensureFrame(); journal.record({ op: 'dispatchWorkgroups' });
    await Promise.resolve();
    assert.equal(journal.frames[0].kind, 'on-demand');
    assert.equal(journal.recording, false);
  });

  it('looks up previews in arbitrary order without a GPU, and never substitutes a later image for a missing event', () => {
    const journal = createWebGpuDeviceJournal({ features: [], limits: {} });
    journal.arm(); journal.markFrameStart({ frameId: 'f' });
    journal.record({ op: 'dispatchWorkgroups' });
    journal.record({ op: 'draw' });
    const draw = journal.record({ op: 'draw' });
    draw.preview = { width: 2, height: 2, color: { preview: 'data:image/png;base64,preview', hash: 123 } };
    journal.markFrameEnd();
    const capture = JSON.parse(JSON.stringify(serializeWebGpuJournal(journal)));
    assert.equal(capture.version, 2);
    assert.equal(capture.context.recordedFromContextCreation, false);
    assert.equal(capture.commands[0].op, 'dispatchWorkgroups');
    assert.equal(lookupWebGpuCapture(capture, { eid: 3 }).color.preview, draw.preview.color.preview);
    assert.match(lookupWebGpuCapture(capture, { eid: 1 }).color.reason, /Compute dispatch/);
    assert.equal(lookupWebGpuCapture(capture, { eid: 2 }).color.available, false);
    assert.equal(lookupWebGpuCapture(capture, { eid: 3 }).color.hash, 123);
    const legacy = { ...capture, version: 1, commands: capture.commands.map(({ preview, ...command }) => command) };
    assert.match(lookupWebGpuCapture(legacy, { eid: 3 }).color.reason, /older capture/);
    assert.throws(() => lookupWebGpuCapture(capture, { eid: 999 }), /not in the capture/);
  });
});
