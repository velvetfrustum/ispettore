import { expect } from './fixtures.js';

const DEMO_ORIGIN = 'http://127.0.0.1:8765';

export async function openDemo(demoPage, slug) {
  const faults = collectPageFaults(demoPage);
  await demoPage.goto(`${DEMO_ORIGIN}/${slug}/`);
  await demoPage.waitForFunction(
    () =>
      window.__ISPETTORE__ &&
      document.querySelector('canvas')?.width > 0 &&
      document.querySelector('canvas')?.height > 0
  );
  return faults;
}

export const WEBGL_DEMOS = [
  'webgl-simple',
  'webgl-afterimage',
  'webgl-dof2',
  'webgl-gpgpu',
  'webgl-instanced',
  'webgl-postprocess',
  'webgl-depth-texture'
];

export function collectPageFaults(page) {
  const pageErrors = [];
  const failedLocal = [];
  const consoleErrors = [];

  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('requestfailed', (request) => {
    const url = request.url();
    if (!/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\//.test(url)) return;
    failedLocal.push(`${request.failure()?.errorText || 'failed'} ${url}`);
  });
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (/Failed to load|404 \(Not Found\)|Uncaught |SyntaxError/i.test(text)) {
      consoleErrors.push(text);
    }
  });

  return { pageErrors, failedLocal, consoleErrors };
}

export async function getCanvasScreenshotStats(page) {
  const buf = await page.locator('canvas').first().screenshot();
  const stats = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const width = Math.min(img.naturalWidth, 128);
    const height = Math.min(img.naturalHeight, 128);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, width, height);
    const pixels = ctx.getImageData(0, 0, width, height).data;
    let min = 255;
    let max = 0;
    let opaque = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      const luminance = (pixels[index] + pixels[index + 1] + pixels[index + 2]) / 3;
      min = Math.min(min, luminance);
      max = Math.max(max, luminance);
      if (pixels[index + 3] > 0) opaque++;
    }
    return { width, height, min, max, range: max - min, opaque };
  }, buf.toString('base64'));

  return { buf, stats };
}

/**
 * Spector-style bounded capture (docs/PLAN.md, Phase 9): nothing is recorded until armed,
 * and recording stops automatically once the next full animation frame ends. Mirrors the
 * arm → baseline → poll-for-a-new-frame sequence `src/extension/background.js` drives for
 * the real Capture button, so integration tests exercise the same lifecycle real usage does.
 */
export async function armWebGlAndWaitForFrame(demoPage, { contextId = null, timeoutMs = 15000 } = {}) {
  const baseline = await demoPage.evaluate((cid) => {
    const contexts = window.__ISPETTORE__.getWebGlJournalSummary();
    return contexts
      .filter((context) => cid == null || context.contextId === cid)
      .map((context) => [context.contextId, context.frames.filter((f) => f.kind === 'animation-frame').at(-1)?.frameId ?? null]);
  }, contextId);

  await demoPage.evaluate((cid) => window.__ISPETTORE__.armWebGlCapture(cid), contextId);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await demoPage.evaluate((baselineEntries) => {
      const baselineMap = new Map(baselineEntries);
      for (const context of window.__ISPETTORE__.getWebGlJournalSummary()) {
        const latest = context.frames.filter((f) => f.kind === 'animation-frame').at(-1);
        if (!latest) continue;
        if (latest.frameId !== (baselineMap.get(context.contextId) ?? null)) {
          return { contextId: context.contextId, frameId: latest.frameId };
        }
      }
      return null;
    }, baseline);
    if (found) return found;
    await demoPage.waitForTimeout(30);
  }
  throw new Error('Timed out waiting for the next complete WebGL animation frame after arming');
}

export async function activateDemo(extensionWorker, demoPage) {
  const demoUrl = demoPage.url();
  return extensionWorker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((candidate) => candidate.url === url);
    if (!tab?.id) throw new Error(`Could not find demo tab for ${url}`);
    await chrome.tabs.update(tab.id, { active: true });
    return tab.id;
  }, demoUrl);
}

export async function captureWebGpuFrame(demoPage) {
  const baseline = await demoPage.evaluate(() => {
    const summary = window.__ISPETTORE__.getWebGpuJournalSummary()[0];
    const result = window.__ISPETTORE__.armWebGpuCapture(summary.contextId);
    if (result.applied !== 1) throw new Error('Could not arm the WebGPU device');
    return summary.frames.at(-1)?.frameId ?? null;
  });
  await demoPage.waitForFunction((previous) => {
    const frame = window.__ISPETTORE__.getWebGpuJournalSummary()[0]?.frames.at(-1);
    return frame && frame.frameId !== previous;
  }, baseline);
  return demoPage.evaluate(() => window.__ISPETTORE__.getWebGpuJournalPackage());
}

export async function clickPanelButton(panelPage, extensionWorker, demoPage, selector) {
  await activateDemo(extensionWorker, demoPage);
  await panelPage.evaluate((buttonSelector) => {
    const button = document.querySelector(buttonSelector);
    if (!button) throw new Error(`Missing panel button ${buttonSelector}`);
    button.click();
  }, selector);
}

export async function refreshScene(panelPage, extensionWorker, demoPage) {
  await clickPanelButton(panelPage, extensionWorker, demoPage, '#ping');
  await expect(panelPage.locator('#status')).toContainText(/Scene (tree )?updated/);
}

export async function getPreviewStats(preview) {
  return preview.evaluate(async (image) => {
    if (!image.complete) await new Promise((resolve) => image.addEventListener('load', resolve));
    const width = Math.min(image.naturalWidth, 128);
    const height = Math.min(image.naturalHeight, 128);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height).data;
    let min = 255;
    let max = 0;
    let opaque = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      const luminance = (pixels[index] + pixels[index + 1] + pixels[index + 2]) / 3;
      min = Math.min(min, luminance);
      max = Math.max(max, luminance);
      if (pixels[index + 3] > 0) opaque++;
    }
    return { width, height, range: max - min, opaque };
  });
}

export function expectNonBlankPreview(stats) {
  expect(stats.width).toBeGreaterThan(0);
  expect(stats.height).toBeGreaterThan(0);
  expect(stats.opaque).toBeGreaterThan(0);
  expect(stats.range).toBeGreaterThan(10);
}

export async function expandStoredCaptures(panelPage) {
  await panelPage.evaluate(() => {
    const fold = document.getElementById('stored-captures-fold');
    if (fold) fold.open = true;
  });
}
