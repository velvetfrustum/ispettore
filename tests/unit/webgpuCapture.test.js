import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getWebGpuContextId,
  registerWebGpuObject,
  resolveWebGpuObjectId
} from '../../src/backend/webgpu/capture/objectRegistry.js';
import { createWebGpuDeviceJournal } from '../../src/backend/webgpu/capture/deviceJournal.js';
import { installWebGpuCapture } from '../../src/backend/webgpu/capture/installWebGpuCapture.js';
import { serializeWebGpuJournal } from '../../src/backend/webgpu/serialize/serializeJournal.js';
import { validateWebGpuPackage, createWebGpuPackage } from '../../src/inspection/webgpu/package.js';
import { createWebGpuEvents, webGpuEventKind } from '../../src/inspection/webgpu/events.js';
import { decodeBinaryBlob } from '../../src/shared/capture/blobs.js';

describe('WebGPU object registry', () => {
  it('assigns stable per-device ids that are never reused', () => {
    const deviceA = {};
    const deviceB = {};
    const buffer = {};
    const id = registerWebGpuObject(deviceA, buffer, 'buffer');
    assert.match(id, /^gpuctx-\d+:buffer-\d+$/);
    assert.equal(resolveWebGpuObjectId(deviceA, buffer), id);
    assert.equal(resolveWebGpuObjectId(deviceB, buffer), null);
    assert.notEqual(getWebGpuContextId(deviceA), getWebGpuContextId(deviceB));
    const replacement = {};
    const secondId = registerWebGpuObject(deviceA, replacement, 'buffer');
    assert.notEqual(secondId, id);
  });

  it('rejects registering non-objects and duplicates', () => {
    const device = {};
    assert.throws(() => registerWebGpuObject(device, null, 'buffer'), /created objects/);
    const object = {};
    registerWebGpuObject(device, object, 'buffer');
    assert.throws(() => registerWebGpuObject(device, object, 'buffer'), /already registered/);
  });
});

describe('WebGPU device journal', () => {
  function fakeDevice() {
    return { features: new Set(['f']), limits: { maxBindGroups: 4 } };
  }

  it('marks animation frames with exact command indexes and discards empty frames', () => {
    const journal = createWebGpuDeviceJournal(fakeDevice());
    journal.arm();
    journal.markFrameStart({ frameId: 'frame:1', kind: 'animation-frame' });
    journal.record({ op: 'createBuffer' });
    journal.record({ op: 'writeBuffer' });
    journal.markFrameEnd();

    journal.markFrameStart({ frameId: 'frame:2', kind: 'animation-frame' });
    journal.markFrameEnd();

    assert.deepEqual(
      journal.frames.map((frame) => ({ start: frame.startCommandIndex, end: frame.endCommandIndex })),
      [{ start: 0, end: 2 }]
    );
    for (const command of journal.commands) {
      assert.equal(typeof command.durationMs, 'number');
      assert.ok(command.durationMs >= 0);
    }
  });

  it('requires a frame id for a range start', () => {
    const journal = createWebGpuDeviceJournal(fakeDevice());
    assert.throws(() => journal.markFrameStart({ label: 'x' }), /frame id/);
  });

  it('records failures with a stage and reason', () => {
    const journal = createWebGpuDeviceJournal(fakeDevice());
    journal.arm();
    journal.markFrameStart({ frameId: 'failure' });
    journal.recordFailure('executeBundles', 'unsupported', 'not reconstructible');
    assert.equal(journal.commands[0].failed, 'unsupported');
    assert.match(journal.commands[0].error, /not reconstructible/);
    assert.deepEqual(journal.commands[0].args, []);
  });
});

function makeFakePass(log, kind) {
  const pass = {};
  for (const name of ['setPipeline', 'setBindGroup', 'setVertexBuffer', 'setIndexBuffer']) {
    pass[name] = (...args) => log.push([`${kind}:${name}`, args]);
  }
  for (const name of ['draw', 'drawIndexed', 'dispatchWorkgroups']) {
    pass[name] = (...args) => log.push([`${kind}:${name}`, args]);
  }
  pass.executeBundles = (bundles) => log.push([`${kind}:executeBundles`, [bundles]]);
  pass.end = () => log.push([`${kind}:end`, []]);
  return pass;
}

function makeFakeEncoder(log) {
  return {
    beginRenderPass(descriptor) {
      log.push(['beginRenderPass', [descriptor]]);
      return makeFakePass(log, 'render');
    },
    beginComputePass(descriptor) {
      log.push(['beginComputePass', [descriptor]]);
      return makeFakePass(log, 'compute');
    },
    copyBufferToBuffer(...args) {
      log.push(['copyBufferToBuffer', args]);
    },
    executeBundles(bundles) {
      log.push(['encoder:executeBundles', [bundles]]);
    },
    writeTimestamp() {},
    finish() {
      return { commandBuffer: true };
    }
  };
}

function makeFakeGpu() {
  const log = [];
  const view = { isView: true };
  let currentTexture = { isCanvasTexture: true };
  const encoder = makeFakeEncoder(log);
  const device = {
    features: new Set(),
    limits: { maxBindGroups: 4 },
    queue: {
      submit(commandBuffers) {
        log.push(['submit', [commandBuffers]]);
      },
      writeBuffer(buffer, offset, data) {
        log.push(['writeBuffer', [buffer, offset, data]]);
      },
      writeTexture(destination, data, layout, size) {
        log.push(['writeTexture', [destination, data, layout, size]]);
      }
    },
    createBuffer(descriptor) {
      return {
        descriptor,
        usage: descriptor.usage ?? 0,
        mapState: descriptor.mappedAtCreation ? 'mapped' : 'unmapped',
        getMappedRange() {
          return new ArrayBuffer(16);
        },
        unmap() {
          this.mapState = 'unmapped';
        }
      };
    },
    createTexture: (descriptor) => ({
      descriptor,
      createView(desc) {
        log.push(['createView', [desc]]);
        return { isView: true, descriptor: desc };
      }
    }),
    createSampler: (descriptor) => ({ descriptor }),
    createShaderModule: (descriptor) => ({ descriptor, code: descriptor.code }),
    createBindGroupLayout: (d) => ({ d }),
    createPipelineLayout: (d) => ({ d }),
    createBindGroup: (d) => ({ d }),
    createQuerySet: (d) => ({ d }),
    createRenderPipeline(descriptor) {
      return {
        descriptor,
        getBindGroupLayout(index) {
          log.push(['getBindGroupLayout', [index]]);
          return { index };
        }
      };
    },
    createComputePipeline(descriptor) {
      return { descriptor, getBindGroupLayout: () => ({}) };
    },
    createCommandEncoder() {
      return encoder;
    },
    destroy() {}
  };
  const adapter = {
    info: { vendor: 'test' },
    requestDevice: async () => device
  };
  const gpu = {
    requestAdapter: async () => adapter
  };
  return { gpu, device, adapter, log, view, canvasContext: {
    configure: (descriptor) => log.push(['configure', [descriptor]]),
    getCurrentTexture: () => currentTexture
  } };
}

async function capturedJournal(t, run) {
  const fake = makeFakeGpu();
  const journals = [];
  const capture = installWebGpuCapture({
    gpu: fake.gpu,
    shouldCapture: () => true,
    onJournal: (journal) => journals.push(journal)
  });
  t.fake = fake;
  await run(fake, capture, () => {
    assert.ok(journals.length >= 1, 'device was never captured');
    return journals[0];
  });
  t.captureApi = capture;
  assert.equal(journals.length, 1);
  return journals[0];
}

describe('installWebGpuCapture', () => {
  it('is inert when no WebGPU root is available', () => {
    const capture = installWebGpuCapture({ gpu: null, shouldCapture: () => true });
    assert.doesNotThrow(() => capture.observeCanvasContext({}));
  });

  it('records device resources, uploads, passes, submits, and canvas configuration in order', async (t) => {
    const journal = await capturedJournal(t, async (fake, api, getJournal) => {
      const device = await fake.gpu.requestAdapter().then((adapter) => adapter.requestDevice());
      api.observeCanvasContext(fake.canvasContext);
      fake.canvasContext.configure({
        device,
        format: 'bgra8unorm',
        alphaMode: 'opaque',
        usage: 0x10
      });

      getJournal().arm();
      getJournal().markFrameStart({ frameId: 'frame:1:1', kind: 'animation-frame' });
      const texture = device.createTexture({ size: [4, 4] });
      const view = texture.createView ? texture.createView() : { isView: true };
      void view;
      const buffer = device.createBuffer({ size: 16, usage: 0x20 });
      device.queue.writeBuffer(buffer, 0, new Float32Array([1, 2, 3, 4]));
      const module_ = device.createShaderModule({ code: 'fn main() {}' });
      void module_;
      const pipeline = device.createRenderPipeline({ vertex: { module: 'shader' }, fragment: {} });
      pipeline.getBindGroupLayout(0);
      const sampler = device.createSampler({});
      void sampler;
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({ colorAttachments: [] });
      pass.setPipeline(pipeline);
      pass.setVertexBuffer(0, buffer);
      pass.draw(3);
      pass.end();
      const commandBuffer = encoder.finish();
      device.queue.submit([commandBuffer]);
      getJournal().markFrameEnd();

      fake.canvasContext.getCurrentTexture();
    });

    const ops = journal.commands.map((command) => command.op);
    assert.deepEqual(ops.slice(0, 9), [
      'createTexture',
      'createView',
      'createBuffer',
      'writeBuffer',
      'createShaderModule',
      'createRenderPipeline',
      'getBindGroupLayout',
      'createSampler',
      'createCommandEncoder'
    ]);
    assert.deepEqual(ops.slice(-4), ['draw', 'renderPass.end', 'finish', 'submit']);

    const createViewCommand = journal.commands.find((command) => command.op === 'createView');
    assert.ok(createViewCommand);
    assert.equal(createViewCommand.argTypes[0], 'descriptor');
    assert.match(createViewCommand.args[0].ref, /:texture-/);

    const getBindGroupLayoutCommand = journal.commands.find((command) => command.op === 'getBindGroupLayout');
    assert.ok(getBindGroupLayoutCommand);
    assert.equal(getBindGroupLayoutCommand.argTypes[0], 'descriptor');
    assert.match(getBindGroupLayoutCommand.args[0].ref, /:renderPipeline-/);
    assert.equal(getBindGroupLayoutCommand.args[1], 0);

    const writeBufferCommand = journal.commands.find((command) => command.op === 'writeBuffer');
    assert.equal(writeBufferCommand.argTypes[0], 'resource');
    assert.equal(writeBufferCommand.argTypes[2], 'typed-array:Float32Array');
    assert.ok(writeBufferCommand.args[2] instanceof Float32Array);

    const frame = journal.frames[0];
    assert.equal(frame.startCommandIndex, 0);
    assert.equal(frame.commandCount, ops.length);
    assert.equal(journal.configuration.format, 'bgra8unorm');
  });

  it('snapshots mappedAtCreation contents written after getMappedRange, at unmap', async (t) => {
    const journal = await capturedJournal(t, async (fake, _capture, getJournal) => {
      const device = await fake.gpu.requestAdapter().then((adapter) => adapter.requestDevice());
      getJournal().arm();
      getJournal().markFrameStart({ frameId: 'mapped' });
      const buffer = device.createBuffer({ size: 8, usage: 0x28, mappedAtCreation: true });
      new Float32Array(buffer.getMappedRange()).set([1.5, -2, 3, 4]);
      buffer.unmap();
      void getJournal;
    });
    const mappedWrite = journal.commands.find((command) => command.op === 'mappedWrite');
    assert.ok(mappedWrite, 'expected a mappedWrite record');
    assert.equal(mappedWrite.argTypes[2], 'array-buffer');
    assert.ok(mappedWrite.args[2] instanceof ArrayBuffer);
    assert.deepEqual(Array.from(new Float32Array(mappedWrite.args[2])), [1.5, -2, 3, 4]);
  });

  it('records unsupported operations as failed commands with loud reasons', async (t) => {
    const journal = await capturedJournal(t, async (fake, api, getJournal) => {
      const device = await fake.gpu.requestAdapter().then((adapter) => adapter.requestDevice());
      getJournal().arm();
      getJournal().markFrameStart({ frameId: 'unsupported' });
      const encoder = device.createCommandEncoder();
      encoder.writeTimestamp();
      const pass = encoder.beginRenderPass({});
      pass.executeBundles([]);
    });
    const failed = journal.commands.filter((command) => command.failed === 'unsupported');
    assert.deepEqual(failed.map((command) => command.op), ['writeTimestamp', 'executeBundles']);
  });

  it('stops recording when shouldCapture returns false', async (t) => {
    const fake = makeFakeGpu();
    let capturing = false;
    const journals = [];
    const capture = installWebGpuCapture({
      gpu: fake.gpu,
      shouldCapture: () => capturing,
      onJournal: (journal) => journals.push(journal)
    });
    const device = await fake.gpu.requestAdapter().then((adapter) => adapter.requestDevice());
    device.createBuffer({ size: 4 });
    capturing = true;
    journals[0].arm();
    journals[0].markFrameStart({ frameId: 'record' });
    device.createBuffer({ size: 8 });
    assert.equal(journals[0].commands.length, 1);
    void capture;
  });
});

describe('serializeWebGpuJournal', () => {
  it('produces a valid package with blobs, frames, events, and honest inspectionStatus', async (t) => {
    const journal = await capturedJournal(t, async (fake, api, getJournal) => {
      const device = await fake.gpu.requestAdapter().then((adapter) => adapter.requestDevice());
      api.observeCanvasContext(fake.canvasContext);
      fake.canvasContext.configure({ device, format: 'rgba8unorm', alphaMode: 'opaque' });
      const buffer = device.createBuffer({ size: 16, usage: 0x20 });
      getJournal().arm();
      getJournal().markFrameStart({ frameId: 'frame:1:1', kind: 'animation-frame' });
      device.queue.writeBuffer(buffer, 0, new Uint8Array([9, 8, 7, 6]));
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({});
      pass.drawIndexed(6);
      pass.end();
      device.queue.submit([encoder.finish()]);
      getJournal().markFrameEnd();
    });

    const capture = serializeWebGpuJournal(journal);
    validateWebGpuPackage(capture);
    assert.equal(capture.schema, 'ispettore-webgpu-capture');
    assert.equal(capture.version, 2);
    assert.equal(capture.context.api, 'webgpu');
    assert.equal(capture.context.recordedFromContextCreation, false);
    assert.equal(capture.inspectionStatus.level, 'degraded');

    assert.equal(capture.blobs.length, 1);
    assert.deepEqual([...decodeBinaryBlob(capture.blobs[0])], [9, 8, 7, 6]);

    assert.equal(capture.frames.length, 1);
    assert.ok(capture.frames[0].byteSize > 0);
    assert.deepEqual(
      capture.events.map((event) => event.kind),
      ['write', 'draw']
    );
    assert.deepEqual(capture.events.map((event) => event.eid), [1, 2]);
  });

  it('marks captures with unsupported operations as unsupported', async (t) => {
    const journal = await capturedJournal(t, async (fake, api, getJournal) => {
      const device = await fake.gpu.requestAdapter().then((adapter) => adapter.requestDevice());
      getJournal().arm();
      getJournal().markFrameStart({ frameId: 'unsupported' });
      const encoder = device.createCommandEncoder();
      encoder.writeTimestamp();
      const pass = encoder.beginRenderPass({});
      pass.executeBundles([]);
      pass.draw(3);
      getJournal().markFrameEnd();
    });
    const capture = serializeWebGpuJournal(journal);
    assert.equal(capture.inspectionStatus.level, 'unsupported');
    assert.ok(capture.inspectionStatus.reasons.some((reason) => reason.includes('executeBundles')));
  });
});

describe('WebGPU events', () => {
  it('classifies significant operations and skips state-only ones', () => {
    assert.equal(webGpuEventKind('draw'), 'draw');
    assert.equal(webGpuEventKind('drawIndexedIndirect'), 'draw');
    assert.equal(webGpuEventKind('dispatchWorkgroups'), 'dispatch');
    assert.equal(webGpuEventKind('copyTextureToBuffer'), 'copy');
    assert.equal(webGpuEventKind('mappedWrite'), 'write');
    assert.equal(webGpuEventKind('clearBuffer'), 'clear');
    assert.equal(webGpuEventKind('setPipeline'), null);

    const commands = [
      { op: 'createBuffer', failed: null },
      { op: 'draw', failed: null },
      { op: 'setPipeline', failed: null },
      { op: 'copyTextureToBuffer', failed: null }
    ];
    const frames = [{ frameId: 'f', startCommandIndex: 0, endCommandIndex: 4 }];
    const events = createWebGpuEvents(commands, frames);
    assert.deepEqual(events.map((event) => [event.eid, event.kind]), [
      [1, 'draw'],
      [2, 'copy']
    ]);
  });
});

describe('WebGPU package validation', () => {
  it('rejects packages whose event kind contradicts the operation', () => {
    assert.throws(() =>
      createWebGpuPackage({
        context: { recordedFromContextCreation: true },
        commands: [{ op: 'setPipeline', argTypes: ['resource'], args: [{ ref: 'ctx:pipeline-1' }] }],
        frames: [{ frameId: 'f', startCommandIndex: 0, endCommandIndex: 1, commandCount: 1, byteSize: 4 }],
        events: [{ eid: 1, commandIndex: 0, frameId: 'f', kind: 'draw', op: 'setPipeline', label: 'x' }]
      }), /kind does not match/);
  });
});
