import { readFile } from 'node:fs/promises';
import { test, expect } from './fixtures.js';
import { openDemo, refreshScene } from './helpers.js';

test('Models resource tab lists the loaded OBJ file and downloads it on click', async ({
  panelPage,
  extensionWorker,
  demoPage
}) => {
  await openDemo(demoPage, 'webgl-loader-obj');
  await demoPage.waitForFunction(() => window.THREE && performance.getEntriesByType('resource').some((entry) => entry.name.endsWith('.obj')));
  await refreshScene(panelPage, extensionWorker, demoPage);

  await panelPage.locator('#resources-section summary').click();
  await panelPage.locator('.resource-tabs [data-resource="models"]').click();
  await expect(panelPage.locator('#model-count')).toHaveText('1');
  const item = panelPage.locator('#model-list .model-item');
  await expect(item).toHaveCount(1);
  await expect(item).toContainText('torus.obj');
  await expect(item.locator('.model-format')).toHaveText('OBJ');
  await expect(item.locator('.model-meta')).toContainText('Wavefront OBJ');
  await expect(panelPage.locator('#resources-summary')).toContainText('1 model(s)');

  const pageCount = panelPage.context().pages().length;

  await item.click();
  await expect(panelPage.locator('#status')).toContainText('Saved torus.obj to Downloads', { timeout: 20000 });
  const [download] = await extensionWorker.evaluate(() =>
    chrome.downloads.search({ orderBy: ['-startTime'], limit: 1 })
  );
  expect(download.state).toBe('complete');
  expect(download.url).toMatch(/\/webgl-loader-obj\/models\/torus\.obj$/);
  const saved = await readFile(download.filename, 'utf8');
  const original = await readFile(new URL('../../demos/webgl-loader-obj/models/torus.obj', import.meta.url), 'utf8');
  expect(saved).toBe(original);
  expect(await panelPage.context().pages().length).toBe(pageCount);
});

test('Models are listed even when the page runs an injected script without the model tracker', async ({
  panelPage,
  extensionWorker,
  demoPage
}) => {
  await openDemo(demoPage, 'webgl-loader-obj');
  await demoPage.waitForFunction(() => performance.getEntriesByType('resource').some((entry) => entry.name.endsWith('.obj')));
  await demoPage.evaluate(() => {
    const original = window.__ISPETTORE__.getSnapshot;
    window.__ISPETTORE__.getSnapshot = (extra) => {
      const snapshot = original(extra);
      delete snapshot.models;
      return snapshot;
    };
  });
  await refreshScene(panelPage, extensionWorker, demoPage);

  await panelPage.locator('#resources-section summary').click();
  await panelPage.locator('.resource-tabs [data-resource="models"]').click();
  await expect(panelPage.locator('#model-list .model-item')).toContainText(['torus.obj']);
});
