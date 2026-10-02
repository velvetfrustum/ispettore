import { test, expect } from './fixtures.js';
import { clickPanelButton, refreshScene } from './helpers.js';

const DEMO_ORIGIN = 'http://127.0.0.1:8765';

// Mirrors threejs.org's "instancing - scatter" example: its renderer/scene are only
// constructed inside a GLTFLoader.load() callback, so delaying that fetch reproduces a
// page whose WebGL2 context and THREE.Scene genuinely don't exist yet at refresh time.
test('context list and scene overview recover from a page whose renderer is created behind a slow GLTF load', async ({
  panelPage,
  extensionWorker,
  demoPage
}) => {
  await demoPage.route('**/models/gltf/Flower/Flower.glb', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await route.continue();
  });

  await demoPage.goto(`${DEMO_ORIGIN}/webgl-instancing-scatter/`);

  // Refresh immediately, before the delayed GLTF load (and thus the renderer/context)
  // has had a chance to resolve.
  await clickPanelButton(panelPage, extensionWorker, demoPage, '#frame-refresh');
  await expect(panelPage.locator('#status')).toContainText(/Found \d+ context\(s\)/, { timeout: 15000 });
  await expect(panelPage.locator('#frame-context option')).toHaveCount(1);

  await refreshScene(panelPage, extensionWorker, demoPage);
  await panelPage.locator('#mode-overview').click();
  await expect(panelPage.locator('.scene-root')).toContainText('2000 instances', { timeout: 15000 });
});
