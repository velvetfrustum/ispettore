import { test, expect } from './fixtures.js';
import { clickPanelButton, expectNonBlankPreview, getPreviewStats, openDemo } from './helpers.js';

// threejs.org's "materials - normalmap - object space" never calls requestAnimationFrame: it
// renders once on load, then synchronously from OrbitControls 'change' and window 'resize'
// handlers. Capture used to wait for an animation frame that never came and time out.
test('Capture frame succeeds on a page that only renders synchronously from event handlers', async ({
  panelPage,
  extensionWorker,
  demoPage
}) => {
  test.setTimeout(90000);
  await openDemo(demoPage, 'webgl-render-on-demand-sync');
  await demoPage.waitForTimeout(1000);

  await panelPage.locator('#mode-frame').click();
  await clickPanelButton(panelPage, extensionWorker, demoPage, '#frame-refresh');
  await expect(panelPage.locator('#status')).toContainText(/Found 1 context\(s\)/);
  await clickPanelButton(panelPage, extensionWorker, demoPage, '#frame-store');
  await expect(panelPage.locator('#status')).toContainText(/Captured frame/, { timeout: 20000 });

  await expect(panelPage.locator('#frame-event-list .range-item').first()).toBeVisible();
  await expect(panelPage.locator('#frame-event-list .range-kind', { hasText: 'draw' }).first()).toBeVisible();
  await expect(panelPage.locator('#frame-event-list')).toContainText('SyncDemandKnot');
  await expect(panelPage.locator('.frame-region-name').first()).toContainText('on-demand render');
  const preview = panelPage.locator('.preview-color-img');
  await expect(preview).toBeVisible({ timeout: 20000 });
  expectNonBlankPreview(await getPreviewStats(preview));
  const stripTitle = await panelPage.locator('#frame-strip-title').textContent();
  const totalMs = Number(stripTitle?.match(/([\d.]+) ms/)?.[1]);
  expect(totalMs).toBeLessThan(1000);
});

test('Capture frame reports a stale page script instead of waiting for a frame it cannot record', async ({
  panelPage,
  extensionWorker,
  demoPage
}) => {
  await openDemo(demoPage, 'webgl-render-on-demand-sync');
  await demoPage.evaluate(() => {
    globalThis.__ISPETTORE_BUILD_ID = 'previous-build';
  });

  await panelPage.locator('#mode-frame').click();
  await clickPanelButton(panelPage, extensionWorker, demoPage, '#frame-refresh');
  await expect(panelPage.locator('#status')).toContainText('older Ispettore page script');
  await clickPanelButton(panelPage, extensionWorker, demoPage, '#frame-store');
  await expect(panelPage.locator('#status')).toContainText('reload the page, then capture again', { timeout: 5000 });
});
