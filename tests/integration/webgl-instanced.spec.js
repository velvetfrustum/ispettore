import { test, expect } from './fixtures.js';
import { openDemo, refreshScene, armWebGlAndWaitForFrame } from './helpers.js';

test('Instanced demo keeps a large scene in a small number of GPU draws', async ({
  demoPage,
  panelPage,
  extensionWorker
}) => {
  const { pageErrors } = await openDemo(demoPage, 'webgl-instanced');
  await refreshScene(panelPage, extensionWorker, demoPage);
  await expect(panelPage.locator('.scene-root')).toContainText('InstancedScene');
  await expect(panelPage.locator('.scene-root')).toContainText('CubeInstances');
  await expect(panelPage.locator('.scene-root')).toContainText('SphereInstances');

  // Bounded capture (docs/PLAN.md, Phase 9): a package now covers exactly one armed frame,
  // not context-lifetime history — so the expected count here is "one draw per
  // InstancedMesh this frame" (CubeInstances + SphereInstances), not an accumulated count
  // across however many frames had already rendered before the journal was inspected.
  await armWebGlAndWaitForFrame(demoPage);
  const journal = await demoPage.evaluate(
    () => window.__ISPETTORE__?.getWebGlJournalSummary?.()[0]
  );
  // CubeInstances (indexed BoxGeometry) draws via drawElementsInstanced; SphereInstances
  // (IcosahedronGeometry) draws via drawArraysInstanced — both are "one draw call per
  // InstancedMesh", just under different WebGL2 entry points depending on indexing.
  const drawCount = (journal.methods.drawElementsInstanced ?? 0) + (journal.methods.drawArraysInstanced ?? 0);
  expect(drawCount).toBe(2);
  expect(pageErrors).toEqual([]);
});
