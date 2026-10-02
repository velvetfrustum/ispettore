import { test, expect } from './fixtures.js';
import { openDemo, captureWebGpuFrame } from './helpers.js';
import { describeWebGpuEvent } from '../../src/inspection/webgpu/eventState.js';

test.use({ webgpu: true });

async function captureAndInspect(demoPage, context, extensionId, slug) {
  await demoPage.setViewportSize({ width: 320, height: 240 });
  await openDemo(demoPage, slug);
  const gpuSupported = await demoPage.evaluate(() => Boolean(navigator.gpu));
  test.skip(!gpuSupported, 'WebGPU is not supported by this Chromium environment');
  await demoPage.waitForFunction(() => (window.__ISPETTORE__?.getWebGpuJournalSummary?.()[0]?.submissionCount ?? 0) > 2);
  const capture = await captureWebGpuFrame(demoPage);
  const host = await context.newPage();
  await host.goto(`chrome-extension://${extensionId}/inspection/webgpu/host.html`);
  const draw = capture.events.find((event) => event.kind === 'draw');
  const inspected = await host.evaluate(
    async ({ serialized, eid }) => {
       navigator.gpu.requestAdapter = () => { throw new Error('Inspection must not request a GPU'); };
       const result = await window.__ISPETTORE_WEBGPU_INSPECTOR__.inspect(serialized, { eid: eid });
      return { ok: result.ok, range: result.color?.range, level: result.inspectionStatus?.level, reasons: result.inspectionStatus?.reasons };
    },
    { serialized: capture, eid: draw.eid }
  );
  await host.close();
  return { capture, draw, inspected };
}

test('webgpu-rotating-cube captures a live cube and describes its draw', async ({ demoPage, context, extensionId }) => {
  const { capture, draw, inspected } = await captureAndInspect(demoPage, context, extensionId, 'webgpu-rotating-cube');
  expect(inspected.ok).toBe(true);
  expect(inspected.level, inspected.reasons.join('\n')).not.toBe('unsupported');
  expect(inspected.range).toBeGreaterThan(50);

  const details = describeWebGpuEvent(capture, draw.commandIndex);
  expect(details.kind).toBe('render');
  expect(details.vertexInput.arguments.vertexCount).toBe(36);
  expect(details.vertexInput.vertexBuffers[0].attributes.map((attribute) => attribute.format)).toEqual(['float32x4', 'float32x2']);
  expect(details.vertexInput.vertexBuffers[0].attributes[0].sample).toBeNull();
  expect(details.vertexShader.source).toContain('modelViewProjectionMatrix');
  expect(details.vertexShader.bindGroups[0].entries[0].words).toHaveLength(16);
  expect(details.output.depthStencil.depthCompare).toBe('less');
});

test('webgpu-compute-boids captures a live image and describes its dispatch as a compute stage', async ({ demoPage, context, extensionId }) => {
  const { capture, draw, inspected } = await captureAndInspect(demoPage, context, extensionId, 'webgpu-compute-boids');
  expect(inspected.ok).toBe(true);
  expect(inspected.level, inspected.reasons.join('\n')).not.toBe('unsupported');
  expect(inspected.range).toBeGreaterThan(50);

  const dispatch = capture.events.find((event) => event.kind === 'dispatch');
  const compute = describeWebGpuEvent(capture, dispatch.commandIndex);
  expect(compute.kind).toBe('compute');
  expect(compute.computeShader.workgroupSize).toBe('64');
  expect(compute.computeShader.arguments.workgroupCountX).toBe(Math.ceil(1500 / 64));
  expect(compute.computeShader.bindGroups[0].entries.map((entry) => entry.binding)).toEqual([0, 1, 2]);

  const render = describeWebGpuEvent(capture, draw.commandIndex);
  expect(render.vertexInput.arguments).toMatchObject({ vertexCount: 3, instanceCount: 1500 });
  expect(render.vertexInput.vertexBuffers.map((slot) => slot.stepMode)).toEqual(['instance', 'vertex']);
});

test('webgpu-compute is raw WebGPU: no three.js, a visible particle draw, and a described dispatch', async ({ demoPage, context, extensionId }) => {
  const pageErrors = [];
  demoPage.on('pageerror', (error) => pageErrors.push(error.message));
  const { capture, inspected } = await captureAndInspect(demoPage, context, extensionId, 'webgpu-compute');
  expect(await demoPage.evaluate(() => Boolean(window.THREE))).toBe(false);
  expect(pageErrors).toEqual([]);
  expect(inspected.ok).toBe(true);
  expect(inspected.level, inspected.reasons.join('\n')).not.toBe('unsupported');
  expect(inspected.range).toBeGreaterThan(50);

  const dispatch = capture.events.find((event) => event.kind === 'dispatch');
  const compute = describeWebGpuEvent(capture, dispatch.commandIndex);
  expect(compute.kind).toBe('compute');
  expect(compute.pass.label).toBe('particle-sim');
  expect(compute.computeShader.workgroupSize).toBe('64');
  expect(compute.computeShader.arguments.workgroupCountX).toBe(8192 / 64);
});
