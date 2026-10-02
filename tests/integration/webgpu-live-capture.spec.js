import { test, expect } from './fixtures.js';
import { openDemo } from './helpers.js';

test.use({ webgpu: true });

test('live pass/copy previews survive reversed submission order, export/import, and page closure', async ({ demoPage, context, extensionId }) => {
  await openDemo(demoPage, 'webgpu-selftest');
  await expect(demoPage.locator('#result')).toHaveClass('result pass');
  const capture = await demoPage.evaluate(async () => {
    const api = window.__ISPETTORE__;
    const device = window.__selftestDevice;
    const target = device.createTexture({ size: [4, 4], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    const copy = device.createTexture({ size: [4, 4], format: 'rgba8unorm', usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC });
    const view = target.createView();
    const idleBuffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST });
    const before = api.getWebGpuJournalSummary()[0].commandCount;
    for (let index = 0; index < 1000; index++) device.queue.writeBuffer(idleBuffer, 0, new Float32Array([index]));
    if (api.getWebGpuJournalSummary()[0].commandCount !== before) throw new Error('Idle commands leaked into the capture');
    api.armWebGpuCapture();
    await new Promise((resolve) => requestAnimationFrame(() => {
      const first = device.createCommandEncoder();
      const second = device.createCommandEncoder();
      first.beginRenderPass({ colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: [1, 0, 0, 1] }] }).end();
      second.beginRenderPass({ colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 1, 1] }] }).end();
      first.copyTextureToTexture({ texture: target }, { texture: copy }, [4, 4]);
      device.queue.submit([second.finish(), first.finish()]);
      resolve();
    }));
    return api.getWebGpuJournalPackage();
  });
  expect(capture.frames).toHaveLength(1);
  expect(capture.frames[0].startCommandIndex).toBe(0);
  expect(capture.commands.length).toBeLessThan(20);
  expect(capture.commands.some((command) => ['copyTextureToBuffer', 'createBuffer', 'writeBuffer'].includes(command.op))).toBe(false);
  expect(capture.events.map((event) => event.kind)).toEqual(['clear', 'clear', 'copy']);
  expect(capture.events.every((event) => capture.commands[event.commandIndex].preview?.color?.preview)).toBe(true);
  const host = await context.newPage();
  await host.goto(`chrome-extension://${extensionId}/inspection/webgpu/host.html`);
  await demoPage.close();
  const colors = await host.evaluate(async (capture) => {
    Object.defineProperty(navigator, 'gpu', { get() { throw new Error('Inspection accessed a GPU'); } });
    const api = window.__ISPETTORE_WEBGPU_INSPECTOR__;
    const stored = await api.storeCapture(capture);
    const exported = await api.exportStoredCapture(stored.captureId);
    await api.deleteStoredCapture(stored.captureId);
    const imported = await api.importCapture(exported.data);
    const pixels = [];
    for (const eid of [3, 1, 2, 1]) {
      const result = await api.inspectStored(imported.captureId, { eid: eid });
      const image = new Image();
      image.src = result.color.preview;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 4;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(image, 0, 0);
      pixels.push([...ctx.getImageData(0, 0, 1, 1).data]);
    }
    return pixels;
  }, capture);
  expect(colors).toEqual([[255, 0, 0, 255], [255, 0, 0, 255], [0, 0, 255, 255], [255, 0, 0, 255]]);
  await host.close();
});

test('an unsubmitted pass remains unavailable and is not misattributed to a later frame', async ({ demoPage }) => {
  await openDemo(demoPage, 'webgpu-selftest');
  await expect(demoPage.locator('#result')).toHaveClass('result pass');
  const result = await demoPage.evaluate(async () => {
    const device = window.__selftestDevice;
    const api = window.__ISPETTORE__;
    const texture = device.createTexture({ size: [4, 4], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT });
    const view = texture.createView();
    let buffer;
    api.armWebGpuCapture();
    await new Promise((resolve) => requestAnimationFrame(() => {
      const encoder = device.createCommandEncoder();
      encoder.beginRenderPass({ colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: [1, 0, 0, 1] }] }).end();
      buffer = encoder.finish();
      resolve();
    }));
    const first = await api.getWebGpuJournalPackage();
    device.queue.submit([buffer]);
    await device.queue.onSubmittedWorkDone();
    const after = await api.getWebGpuJournalPackage();
    return { first, after };
  });
  expect(result.after).toEqual(result.first);
  const event = result.first.events[0];
  const preview = result.first.commands[event.commandIndex].preview;
  expect(preview.color.available).toBe(false);
  expect(preview.color.reason).toContain('not submitted during the captured frame');
});

test('repeated on-demand captures contain one frame each and preserve earlier packages', async ({ demoPage }) => {
  await openDemo(demoPage, 'webgpu-selftest');
  await expect(demoPage.locator('#result')).toHaveClass('result pass');
  const captures = await demoPage.evaluate(async () => {
    const device = window.__selftestDevice;
    const api = window.__ISPETTORE__;
    const texture = device.createTexture({ size: [4, 4], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT });
    const view = texture.createView();
    const captures = [];
    for (const color of [[1, 0, 0, 1], [0, 0, 1, 1]]) {
      api.armWebGpuCapture();
      const encoder = device.createCommandEncoder();
      encoder.beginRenderPass({ colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: color }] }).end();
      device.queue.submit([encoder.finish()]);
      await Promise.resolve();
      captures.push(await api.getWebGpuJournalPackage());
    }
    return captures;
  });
  expect(captures[0].frames[0].kind).toBe('on-demand');
  expect(captures[1].frames[0].kind).toBe('on-demand');
  expect(captures[0].commands.length).toBe(captures[1].commands.length);
  expect(captures[0].frames[0].frameId).not.toBe(captures[1].frames[0].frameId);
  for (const capture of captures) {
    expect(capture.frames).toHaveLength(1);
    expect(capture.frames[0].startCommandIndex).toBe(0);
    expect(capture.commands.some((command) => command.op === 'createTexture')).toBe(false);
    expect(Object.values(capture.resources).some((resource) => resource.op === 'createTexture')).toBe(true);
  }
  const previews = captures.map((capture) => capture.commands[capture.events[0].commandIndex].preview);
  expect(previews.every((preview) => preview.color.preview)).toBe(true);
  expect(previews[0].color.hash).not.toBe(previews[1].color.hash);
});
