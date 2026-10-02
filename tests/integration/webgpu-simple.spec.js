import { test, expect } from './fixtures.js';
import { openDemo, captureWebGpuFrame } from './helpers.js';

test.use({ webgpu: true });

test('WebGPU selftest produces a bounded portable live capture', async ({ demoPage, context, extensionId }) => {
  await openDemo(demoPage, 'webgpu-selftest');
  await expect(demoPage.locator('#result')).toHaveClass('result pass', { timeout: 30000 });
  const capture = await demoPage.locator('#package-json').inputValue().then(JSON.parse);
  expect(capture.version).toBe(2);
  expect(capture.context.captureMode).toBe('live');
  expect(capture.frames).toHaveLength(1);
  expect(capture.frames[0].startCommandIndex).toBe(0);
  const host = await context.newPage();
  await host.goto(`chrome-extension://${extensionId}/inspection/webgpu/host.html`);
  await demoPage.close();
  const result = await host.evaluate((capture) => {
    navigator.gpu.requestAdapter = () => { throw new Error('Inspection must not request a GPU'); };
    const event = capture.events.findLast((event) => event.kind === 'draw');
    return window.__ISPETTORE_WEBGPU_INSPECTOR__.inspect(capture, { eid: event.eid });
  }, capture);
  expect(result.color.range).toBeGreaterThan(50);
  expect(result.color.preview).toMatch(/^data:image\/png;base64,/);
  await host.close();
});

test('WebGPU three.js demo captures one frame with descriptor metadata and a live image', async ({ demoPage }) => {
  test.setTimeout(90000);
  await demoPage.setViewportSize({ width: 320, height: 240 });
  await openDemo(demoPage, 'webgpu-simple');
  await demoPage.waitForFunction(() => window.__ISPETTORE__?.getWebGpuJournalSummary?.().some((entry) => entry.submissionCount > 3));
  const capture = await captureWebGpuFrame(demoPage);
  expect(capture.frames).toHaveLength(1);
  expect(capture.commands.length).toBeLessThan(5000);
  expect(capture.commands.some((command) => command.preview?.color?.range > 10)).toBe(true);
  expect(Object.values(capture.resources).some((resource) => resource.op === 'createShaderModule')).toBe(true);
  expect(capture.context.recordedFromContextCreation).toBe(false);
});
