import { test, expect } from './fixtures.js';
import { clickPanelButton } from './helpers.js';

const DEMO_ORIGIN = 'http://127.0.0.1:8765';

// Mirrors threejs.org's "postprocessing - transition" example, embedded the same way the
// examples gallery embeds it: inside a same-origin <iframe>. Arming used to broadcast to
// every frame in the tab (webgl-instancing-scatter-framed.spec.js fixed context/scene
// discovery the same way), including the wrapper frame that has no canvas at all, which
// logged a spurious "[ispettore] armWebGlCapture matched no WebGL2 context" warning on
// the page every time — and, worse, meant "Capture frame" had nothing guaranteeing it
// actually armed the frame that matters. Arming must target only frames the live context
// list already found.
test('capturing a frame on an iframed demo arms only the frame with a context, without a spurious warning', async ({
  panelPage,
  extensionWorker,
  demoPage
}) => {
  const pageWarnings = [];
  demoPage.on('console', (msg) => {
    if (msg.type() === 'warning' && msg.text().includes('armWebGlCapture')) pageWarnings.push(msg.text());
  });

  await demoPage.goto(`${DEMO_ORIGIN}/webgl-postprocessing-transition-framed/`);

  await clickPanelButton(panelPage, extensionWorker, demoPage, '#frame-refresh');
  await expect(panelPage.locator('#status')).toContainText(/Found \d+ context\(s\)/, { timeout: 15000 });

  await clickPanelButton(panelPage, extensionWorker, demoPage, '#frame-store');
  await expect(panelPage.locator('#status')).toContainText(/Captured frame/, { timeout: 30000 });

  expect(pageWarnings).toEqual([]);
});
