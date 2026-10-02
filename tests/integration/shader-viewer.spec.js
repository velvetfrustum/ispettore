import { test, expect } from './fixtures.js';
import { openDemo, refreshScene } from './helpers.js';

test('clicking a program opens its shader source as a closable panel tab after Captures, reused on a second click', async ({
  context,
  panelPage,
  extensionWorker,
  demoPage
}) => {
  await openDemo(demoPage, 'webgl-simple');
  await refreshScene(panelPage, extensionWorker, demoPage);

  await panelPage.locator('.resources-summary').click();
  await panelPage.locator('[data-resource="programs"]').click();
  const programItems = panelPage.locator('#program-list li.program-item--openable');
  await expect(programItems.first()).toBeVisible();
  expect(await programItems.count()).toBeGreaterThan(1);
  await expect(programItems.first()).toContainText('vertex + fragment');

  const pagesBefore = context.pages().length;
  const shaderTabs = panelPage.locator('.mode-nav .mode-tab-shader');

  await programItems.first().click();
  await expect(shaderTabs).toHaveCount(1);
  expect(context.pages().length).toBe(pagesBefore);
  await expect(shaderTabs.first()).toContainText('vertex + fragment');

  const navTabs = await panelPage.locator('.mode-nav [role="tab"]').evaluateAll((tabs) => tabs.map((tab) => tab.id));
  expect(navTabs.indexOf('mode-captures')).toBe(navTabs.length - 2);
  await expect(shaderTabs.first()).toHaveAttribute('aria-selected', 'true');

  const firstPanel = panelPage.locator('.view--shader:not([hidden])');
  await expect(firstPanel).toHaveCount(1);
  await expect(firstPanel.locator('.shader-block-title').first()).toBeVisible();
  await expect(firstPanel.locator('.shader-source code .glsl-keyword').first()).toBeVisible();
  const scroll = await firstPanel.evaluate((panel) => ({
    overflowY: getComputedStyle(panel).overflowY,
    scrollable: panel.scrollHeight > panel.clientHeight
  }));
  expect(scroll).toEqual({ overflowY: 'auto', scrollable: true });
  const firstTitle = await firstPanel.locator('.shader-title').textContent();

  await panelPage.locator('#mode-overview').click();
  await programItems.first().click();
  await expect(shaderTabs).toHaveCount(1);
  await expect(shaderTabs.first()).toHaveAttribute('aria-selected', 'true');

  await panelPage.locator('#mode-overview').click();
  await programItems.nth(1).click();
  await expect(shaderTabs).toHaveCount(2);
  await expect(shaderTabs.nth(1)).toHaveAttribute('aria-selected', 'true');
  expect(await panelPage.locator('.view--shader:not([hidden]) .shader-title').textContent()).not.toBe(firstTitle);
  expect(context.pages().length).toBe(pagesBefore);

  await panelPage.locator('.mode-nav .mode-tab-close').nth(1).click();
  await expect(shaderTabs).toHaveCount(1);
  await expect(panelPage.locator('.view--shader')).toHaveCount(1);
  await expect(shaderTabs.first()).toHaveAttribute('aria-selected', 'true');

  await panelPage.locator('.mode-nav .mode-tab-close').first().click();
  await expect(shaderTabs).toHaveCount(0);
  await expect(panelPage.locator('.view--shader')).toHaveCount(0);
  await expect(panelPage.locator('#mode-captures')).toHaveAttribute('aria-selected', 'true');
});

test('the Resources panel hides the Models and Textures tabs when there are none', async ({
  panelPage,
  extensionWorker,
  demoPage
}) => {
  await openDemo(demoPage, 'webgl-simple');
  await refreshScene(panelPage, extensionWorker, demoPage);
  await panelPage.locator('.resources-summary').click();

  const texturesTab = panelPage.locator('[data-resource="textures"]');
  const modelsTab = panelPage.locator('[data-resource="models"]');
  const programsTab = panelPage.locator('[data-resource="programs"]');
  await expect(modelsTab).toBeHidden();
  await expect(texturesTab).toBeVisible();
  await texturesTab.click();

  await demoPage.evaluate(() => {
    const original = window.__ISPETTORE__.getSnapshot;
    window.__ISPETTORE__.__originalGetSnapshot = original;
    window.__ISPETTORE__.getSnapshot = (extra) => ({ ...original(extra), textures: [] });
  });
  await refreshScene(panelPage, extensionWorker, demoPage);
  await expect(texturesTab).toBeHidden();
  await expect(programsTab).toHaveAttribute('aria-selected', 'true');
  await expect(panelPage.locator('#resource-programs')).toBeVisible();
  await expect(panelPage.locator('#resource-textures')).toBeHidden();

  await demoPage.evaluate(() => {
    window.__ISPETTORE__.getSnapshot = window.__ISPETTORE__.__originalGetSnapshot;
  });
  await refreshScene(panelPage, extensionWorker, demoPage);
  await expect(texturesTab).toHaveAttribute('aria-selected', 'true');
  await expect(panelPage.locator('#resource-textures')).toBeVisible();

  await openDemo(demoPage, 'webgl-loader-obj');
  await demoPage.waitForFunction(() => performance.getEntriesByType('resource').some((entry) => entry.name.endsWith('.obj')));
  await refreshScene(panelPage, extensionWorker, demoPage);
  await expect(modelsTab).toBeVisible();
});
