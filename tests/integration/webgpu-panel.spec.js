import { test, expect } from './fixtures.js';
import { clickPanelButton, expectNonBlankPreview, getPreviewStats, openDemo } from './helpers.js';

test.use({ webgpu: true });

test('WebGPU compute capture displays an image in the panel and supports event selection', async ({
  demoPage, panelPage, extensionWorker
}) => {
  test.setTimeout(90000);
  await demoPage.setViewportSize({ width: 320, height: 240 });
  await panelPage.addInitScript(() => {
    if (navigator.gpu) {
      navigator.gpu.requestAdapter = () => { throw new Error('Stored previews must not request a GPU during inspection'); };
    }
  });
  await openDemo(demoPage, 'webgpu-compute');
  await demoPage.waitForFunction(() => (window.__ISPETTORE__?.getWebGpuJournalSummary?.()[0]?.submissionCount ?? 0) > 3);
  expect(await demoPage.evaluate(() => window.__ISPETTORE__.getWebGpuJournalSummary()[0].commandCount)).toBe(0);
  await clickPanelButton(panelPage, extensionWorker, demoPage, '#mode-frame');
  await clickPanelButton(panelPage, extensionWorker, demoPage, '#frame-refresh');
  await expect(panelPage.locator('#frame-context')).not.toHaveValue('');
  await clickPanelButton(panelPage, extensionWorker, demoPage, '#frame-store');
  await expect(panelPage.locator('#status')).toContainText('Captured frame', { timeout: 30000 });
  await expect(panelPage.locator('#frame-event-list .range-item').first()).toBeVisible();
  const host = panelPage.frames().find((frame) => frame.url().endsWith('/inspection/webgpu/host.html'));
  const baked = await host.evaluate(async () => {
    const api = window.__ISPETTORE_WEBGPU_INSPECTOR__;
    const { captures } = await api.listStoredCaptures();
    const { capture } = await api.getStoredCapture(captures[0].captureId);
    return capture.commands.findLast((command) => command.op === 'draw')?.preview;
  });
  expect(baked?.reasons ?? []).toEqual([]);
  expect(baked).toMatchObject({ color: { preview: expect.stringMatching(/^data:image\/png;base64,/) } });
  const preview = panelPage.locator('#frame-viewport img.preview-color-img');
  await expect(preview).toBeVisible({ timeout: 35000 });
  expectNonBlankPreview(await getPreviewStats(preview));
  const canvasSize = await demoPage.locator('canvas').evaluate((canvas) => [canvas.width, canvas.height]);
  expect(await preview.evaluate((image) => [image.naturalWidth, image.naturalHeight])).toEqual(canvasSize);
  const imageSource = await preview.getAttribute('src');
  await demoPage.goto('about:blank');
  await panelPage.locator('#frame-event-list .range-item', { hasText: 'dispatch' }).click();
  await expect(panelPage.locator('#frame-viewport')).toContainText('Compute dispatch output');
  await panelPage.locator('[data-inspect="pipeline"]').click();
  await expect(panelPage.locator('#frame-viewport')).toContainText('Compute Shader');
  await panelPage.locator('[data-inspect="color"]').click();
  await panelPage.locator('#frame-event-list .range-item', { hasText: 'draw' }).last().click();
  await expect(preview).toBeVisible({ timeout: 10000 });
  await expect(preview).toHaveAttribute('src', imageSource);
  expectNonBlankPreview(await getPreviewStats(preview));
  const exported = await host.evaluate(async () => {
    const api = window.__ISPETTORE_WEBGPU_INSPECTOR__;
    const { captures } = await api.listStoredCaptures();
    return api.exportStoredCapture(captures[0].captureId);
  });
  await panelPage.locator('#stored-import-file').setInputFiles({
    name: 'webgpu-live-capture.json', mimeType: 'application/json', buffer: Buffer.from(exported.data)
  });
  await expect(panelPage.locator('#status')).toContainText('Imported capture');
  await expect(preview).toHaveAttribute('src', imageSource);
});
