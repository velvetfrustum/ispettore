import { test, expect } from './fixtures.js';
import { clickPanelButton, refreshScene } from './helpers.js';

const DEMO_ORIGIN = 'http://127.0.0.1:8765';

// Mirrors threejs.org's examples gallery, which embeds every demo inside a same-origin
// <iframe id="viewer"> rather than rendering it in the tab's top frame — the WebGL2 context
// and THREE.Scene only exist inside that iframe. chrome.scripting.executeScript defaults to
// frameId 0 (the top frame) unless told otherwise, so background.js must target every frame
// in the tab, not just the top one, to find them.
test('context list and scene overview see a demo rendered inside a same-origin iframe', async ({
  panelPage,
  extensionWorker,
  demoPage
}) => {
  await demoPage.goto(`${DEMO_ORIGIN}/webgl-instancing-scatter-framed/`);

  await clickPanelButton(panelPage, extensionWorker, demoPage, '#frame-refresh');
  await expect(panelPage.locator('#status')).toContainText(/Found \d+ context\(s\)/, { timeout: 15000 });
  await expect(panelPage.locator('#frame-context option')).toHaveCount(1);

  await refreshScene(panelPage, extensionWorker, demoPage);
  await panelPage.locator('#mode-overview').click();
  await expect(panelPage.locator('.scene-root')).toContainText('2000 instances', { timeout: 15000 });

  await panelPage.locator('#resources-section summary').click();
  await panelPage.locator('.resource-tabs [data-resource="models"]').click();
  await expect(panelPage.locator('#model-list .model-item')).toContainText(['Flower.glb']);
});
