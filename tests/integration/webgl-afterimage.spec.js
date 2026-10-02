import { test, expect } from './fixtures.js';
import { openDemo, refreshScene } from './helpers.js';

test('Afterimage scene tree loads and the composer keeps animating over time', async ({
  demoPage,
  panelPage,
  extensionWorker
}) => {
  const { pageErrors } = await openDemo(demoPage, 'webgl-afterimage');
  await refreshScene(panelPage, extensionWorker, demoPage);
  await expect(panelPage.locator('.scene-root')).toContainText('AfterimageScene');
  await expect(panelPage.locator('.scene-root')).toContainText('SpinCube');

  const beforeCapture = await demoPage.locator('canvas').screenshot();
  await demoPage.waitForTimeout(250);
  const afterCapture = await demoPage.locator('canvas').screenshot();
  expect(afterCapture.equals(beforeCapture)).toBe(false);
  expect(pageErrors).toEqual([]);
});
