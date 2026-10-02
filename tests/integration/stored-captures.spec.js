import { test, expect } from './fixtures.js';
import { openDemo, refreshScene, expandStoredCaptures } from './helpers.js';

function minimalPackage(label) {
  return {
    schema: 'ispettore-webgl-capture',
    version: 1,
    context: { api: 'webgl', width: 1, height: 1, attributes: {}, resizes: [] },
    commands: [{ op: 'clear', argTypes: ['number'], args: [0x4000], resultId: null, failed: null, error: null }],
    blobs: [],
    frames: [
      { frameId: 'frame:1', label, kind: 'animation-frame', startCommandIndex: 0, endCommandIndex: 1, commandCount: 1, blobCount: 0, byteSize: 1 }
    ],
    events: [{ eid: 1, commandIndex: 0, frameId: 'frame:1', kind: 'clear', op: 'clear', label: 'clear' }],
    inspectionStatus: { level: 'supported', reasons: [] }
  };
}

test('Delete all captures asks for a second click, then empties the stored list', async ({
  context,
  extensionId,
  panelPage,
  extensionWorker,
  demoPage
}) => {
  await openDemo(demoPage, 'webgl-simple');
  await refreshScene(panelPage, extensionWorker, demoPage);

  const hostPage = await context.newPage();
  await hostPage.goto(`chrome-extension://${extensionId}/inspection/webgl/host.html`);
  for (const label of ['first', 'second']) {
    const imported = await hostPage.evaluate((capture) => window.__ISPETTORE_WEBGL_INSPECTOR__.importCapture(capture), minimalPackage(label));
    expect(imported.ok).toBe(true);
  }
  await hostPage.close();

  await panelPage.locator('#mode-captures').click();
  await expandStoredCaptures(panelPage);
  const items = panelPage.locator('#stored-captures-list .stored-item');
  await expect(items).toHaveCount(2);
  const deleteAll = panelPage.locator('#stored-delete-all');
  await expect(deleteAll).toBeVisible();

  await deleteAll.click();
  await expect(deleteAll).toHaveText('Confirm: delete 2 capture(s)');
  await expect(items).toHaveCount(2);

  await deleteAll.click();
  await expect(panelPage.locator('#status')).toContainText('Deleted all 2 stored capture(s)');
  await expect(items).toHaveCount(0);
  await expect(deleteAll).toBeHidden();
});
