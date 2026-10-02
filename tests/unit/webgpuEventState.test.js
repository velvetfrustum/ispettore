import test from 'node:test';
import assert from 'node:assert/strict';
import { describeWebGpuEvent } from '../../src/inspection/webgpu/eventState.js';
import { encodeBinaryBlob } from '../../src/shared/capture/blobs.js';

function command(op, args = [], resultId = null) {
  return { op, argTypes: args.map(() => 'descriptor'), args, resultId, failed: null, error: null, durationMs: 0 };
}

const ref = (id) => ({ ref: id });

function capturePackage() {
  const vertices = new Float32Array([0, 1, 2, 3, 4, 5, 6, 7, 8]).buffer;
  const uniforms = new Float32Array([0.5, 0.25, 1, 1]);
  const blobs = [encodeBinaryBlob('blob-1', vertices), encodeBinaryBlob('blob-2', uniforms)];
  const commands = [
    command('createBuffer', [{ size: 36, usage: 0x28, mappedAtCreation: true }], 'vb'),
    command('mappedWrite', [ref('vb'), 0, { blob: 'blob-1' }]),
    command('createBuffer', [{ label: 'uniforms', size: 16, usage: 0x48 }], 'ub'),
    command('writeBuffer', [ref('ub'), 0, { blob: 'blob-2' }]),
    command('createShaderModule', [{ label: 'shader', code: '@vertex fn vs() {}\n@fragment fn fs() {}\n@compute @workgroup_size(64) fn sim() {}' }], 'module'),
    command('createBindGroupLayout', [{ entries: [{ binding: 0, visibility: 0x1 | 0x4, buffer: { type: 'uniform' } }] }], 'bgl'),
    command('createPipelineLayout', [{ bindGroupLayouts: [ref('bgl')] }], 'layout'),
    command('createBindGroup', [{ layout: ref('bgl'), entries: [{ binding: 0, resource: { buffer: ref('ub') } }] }], 'bg'),
    command('createRenderPipeline', [{
      label: 'triangle',
      layout: ref('layout'),
      vertex: { module: ref('module'), entryPoint: 'vs', buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] }] },
      fragment: { module: ref('module'), entryPoint: 'fs', targets: [{ format: 'bgra8unorm' }] },
      primitive: { topology: 'triangle-list', cullMode: 'back' }
    }], 'rp'),
    command('createComputePipeline', [{ layout: ref('layout'), compute: { module: ref('module'), entryPoint: 'sim' } }], 'cp'),
    command('configure', [{ format: 'bgra8unorm' }]),
    command('getCurrentTexture', [], 'canvas'),
    command('createView', [ref('canvas'), {}], 'view'),
    command('beginRenderPass', [{ colorAttachments: [{ view: ref('view'), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }] }], 'pass'),
    command('setPipeline', [ref('rp')]),
    command('setBindGroup', [0, ref('bg')]),
    command('setVertexBuffer', [0, ref('vb')]),
    command('draw', [3, 1, 0, 0]),
    command('renderPass.end'),
    command('beginComputePass', [{ label: 'sim-pass' }], 'cpass'),
    command('setPipeline', [ref('cp')]),
    command('setBindGroup', [0, ref('bg')]),
    command('dispatchWorkgroups', [4, 1, 1]),
    command('computePass.end'),
    command('writeBuffer', [ref('ub'), 0, { blob: 'blob-2' }])
  ];
  return { commands, blobs };
}

test('a WebGPU draw is rebuilt from descriptors, with vertex data from the mapped upload', () => {
  const details = describeWebGpuEvent(capturePackage(), 17);
  assert.equal(details.kind, 'render');
  assert.equal(details.command.help, 'https://developer.mozilla.org/en-US/docs/Web/API/GPURenderPassEncoder/draw');
  assert.deepEqual(details.command.arguments.map(({ name }) => name), ['vertexCount', 'instanceCount', 'firstVertex', 'firstInstance']);
  assert.equal(details.pipeline.label, 'triangle');
  const attribute = details.vertexInput.vertexBuffers[0].attributes[0];
  assert.deepEqual(attribute.sample.map(({ value }) => value), [[0, 1, 2], [3, 4, 5], [6, 7, 8]]);
  assert.equal(details.vertexShader.entryPoint, 'vs');
  assert.deepEqual(details.vertexShader.bindGroups[0].entries[0].words, [0.5, 0.25, 1, 1]);
  assert.equal(details.fragmentShader.bindGroups.length, 0, 'the uniform layout is not visible to the fragment stage');
  assert.equal(details.rasterizer.cullMode, 'back');
  assert.equal(details.output.colorAttachments[0].canvas, true);
  assert.equal(details.output.colorAttachments[0].format, 'bgra8unorm');
});

test('a WebGPU dispatch is described as a compute stage with its workgroup size', () => {
  const details = describeWebGpuEvent(capturePackage(), 22);
  assert.equal(details.kind, 'compute');
  assert.equal(details.pass.label, 'sim-pass');
  assert.equal(details.computeShader.entryPoint, 'sim');
  assert.equal(details.computeShader.workgroupSize, '64');
  assert.deepEqual(details.computeShader.arguments, { workgroupCountX: 4, workgroupCountY: 1, workgroupCountZ: 1 });
  assert.equal(details.computeShader.bindGroups.length, 1);
});

test('a bind group entry may name a GPUBuffer directly instead of a buffer binding', () => {
  const capture = capturePackage();
  capture.commands[7] = command('createBindGroup', [{ layout: ref('bgl'), entries: [{ binding: 0, resource: ref('ub') }] }], 'bg');
  const entry = describeWebGpuEvent(capture, 17).vertexShader.bindGroups[0].entries[0];
  assert.equal(entry.kind, 'buffer');
  assert.equal(entry.label, 'uniforms');
  assert.deepEqual(entry.words, [0.5, 0.25, 1, 1]);
});

test('writes outside a pass run no pipeline stage', () => {
  const details = describeWebGpuEvent(capturePackage(), 24);
  assert.equal(details.kind, 'other');
  assert.equal(details.command.help, 'https://developer.mozilla.org/en-US/docs/Web/API/GPUQueue/writeBuffer');
});

test('pre-frame descriptors resolve without a command prefix and unknown buffer contents stay unavailable', () => {
  const capture = capturePackage();
  capture.resources = Object.fromEntries(capture.commands.slice(0, 13).filter((command) => command.resultId).map((command) => [command.resultId, { op: command.op, args: command.args }]));
  capture.context = { configuration: { format: 'bgra8unorm' } };
  capture.commands = capture.commands.slice(13);
  const details = describeWebGpuEvent(capture, 4);
  assert.equal(details.pipeline.label, 'triangle');
  assert.match(details.vertexShader.source, /@vertex/);
  assert.equal(details.vertexInput.vertexBuffers[0].attributes[0].sample, null);
  assert.equal(details.vertexShader.bindGroups[0].entries[0].words, null);
});

test('partial uploads never invent zero-filled buffer samples, and dispatches invalidate storage samples', () => {
  const capture = capturePackage();
  capture.commands[18] = command('writeBuffer', [ref('ub'), 0, { blob: 'blob-2' }, 0, 1]);
  capture.commands.splice(3, 1, command('setPipeline'));
  const partial = describeWebGpuEvent(capture, 22);
  assert.deepEqual(partial.computeShader.bindGroups[0].entries[0].words, [0.5]);
  capture.commands[2].args[0].usage |= 0x80;
  capture.commands[23] = command('dispatchWorkgroups', [2]);
  const modified = describeWebGpuEvent(capture, 23);
  assert.equal(modified.computeShader.bindGroups[0].entries[0].words, null);
});
