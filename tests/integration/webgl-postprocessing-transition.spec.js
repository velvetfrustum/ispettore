import { test, expect } from './fixtures.js';
import { clickPanelButton } from './helpers.js';

const DEMO_ORIGIN = 'http://127.0.0.1:8765';

// Mirrors threejs.org's "postprocessing - transition" example. Its GUI calls .listen() on
// two controls, which spins up its own independent requestAnimationFrame polling loop
// alongside the renderer's own animation loop — the first regression test this repo has for
// a page with more than one rAF-driven callback (see commandJournal.js's markFrameEnd fix).
test('capturing a frame succeeds on a demo whose GUI runs its own requestAnimationFrame loop', async ({
  panelPage,
  extensionWorker,
  demoPage
}) => {
  await demoPage.goto(`${DEMO_ORIGIN}/webgl-postprocessing-transition/`);

  await clickPanelButton(panelPage, extensionWorker, demoPage, '#frame-refresh');
  await expect(panelPage.locator('#status')).toContainText(/Found \d+ context\(s\)/, { timeout: 15000 });

  await clickPanelButton(panelPage, extensionWorker, demoPage, '#frame-store');
  await expect(panelPage.locator('#status')).toContainText(/Captured frame/, { timeout: 30000 });
});
