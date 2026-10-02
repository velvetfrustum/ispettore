import { test, expect } from './fixtures.js';
import { openDemo, activateDemo, clickPanelButton } from './helpers.js';

const overviewState = (panelPage) => panelPage.locator('#inspector-root .overview-empty');

test('the Overview never opens empty and refreshes by itself when the inspected tab changes', async ({
  panelPage,
  extensionWorker,
  demoPage
}) => {
  await expect(overviewState(panelPage)).toBeVisible();

  await openDemo(demoPage, 'webgl-simple');
  await activateDemo(extensionWorker, demoPage);
  await expect(panelPage.locator('#inspector-root .scene-root')).toBeVisible({ timeout: 20000 });
  await expect(panelPage.locator('#ping')).not.toHaveClass(/panel-action--attention/);
});

test('a WebGL page without three.js opens on the Frame tab, and the Overview explains why', async ({
  panelPage,
  extensionWorker,
  demoPage
}) => {
  await openDemo(demoPage, 'webgl-be-the-sun');
  await activateDemo(extensionWorker, demoPage);
  await expect(panelPage.locator('#mode-frame')).toHaveAttribute('aria-selected', 'true', { timeout: 20000 });
  await expect(panelPage.locator('#status')).toContainText('Found 1 context(s)', { timeout: 20000 });

  await panelPage.locator('#mode-overview').click();
  const message = panelPage.locator('#inspector-root [data-overview-state="no-three"]');
  await expect(message).toContainText('WebGL 1 without three.js');
  await message.locator('[data-go-frame]').click();
  await expect(panelPage.locator('#mode-frame')).toHaveAttribute('aria-selected', 'true');
});

test('a page without any GPU context, and an outdated page script, get their own messages', async ({
  panelPage,
  extensionWorker,
  demoPage
}) => {
  await panelPage.locator('#mode-overview').click();
  await demoPage.goto('http://127.0.0.1:8765/');
  await demoPage.waitForFunction(() => window.__ISPETTORE__);
  await activateDemo(extensionWorker, demoPage);
  await expect(panelPage.locator('#inspector-root [data-overview-state="no-context"]')).toBeVisible({ timeout: 20000 });
  await expect(panelPage.locator('#ping')).toHaveClass(/panel-action--attention/);

  await openDemo(demoPage, 'webgl-be-the-sun');
  await demoPage.evaluate(() => {
    globalThis.__ISPETTORE_BUILD_ID = 'previous-build';
  });
  await clickPanelButton(panelPage, extensionWorker, demoPage, '#ping');
  await expect(panelPage.locator('#inspector-root [data-overview-state="stale"]')).toBeVisible({ timeout: 20000 });
});
