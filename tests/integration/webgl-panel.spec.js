import { test, expect } from './fixtures.js';
import { clickPanelButton, expectNonBlankPreview, expandStoredCaptures, getPreviewStats, openDemo, refreshScene } from './helpers.js';

async function captureFrame(panelPage, extensionWorker, demoPage) {
  await clickPanelButton(panelPage, extensionWorker, demoPage, '#frame-store');
  await expect(panelPage.locator('#frame-store .capture-hourglass')).toBeVisible();
  await expect(panelPage.locator('#frame-store')).toContainText('Capturing');
  await expect(panelPage.locator('#status')).toContainText(/Captured frame/, { timeout: 120000 });
  await expect(panelPage.locator('#frame-store')).toHaveText('Capture frame');
  await panelPage.locator('#mode-captures').click();
  await expandStoredCaptures(panelPage);
  await expect(panelPage.locator('#stored-captures-list .stored-item').first()).toBeVisible();
  await panelPage.locator('#mode-frame').click();
  await expect(panelPage.locator('#frame-event-list .range-item').first()).toBeVisible({ timeout: 60000 });
  await expect.poll(() => panelPage.locator('#frame-event-list .range-item').count()).toBeGreaterThan(1);
}

test('capture panel stores, describes, inspects, filters, and diffs captures', async ({
  context,
  extensionId,
  panelPage,
  extensionWorker,
  demoPage
}) => {
  test.setTimeout(420000);
  await openDemo(demoPage, 'webgl-simple');
  await refreshScene(panelPage, extensionWorker, demoPage);

  await panelPage.locator('#mode-frame').click();
  await expect(panelPage.locator('#frame-context option')).toHaveCount(1);
  await expect(panelPage.locator('#frame-context')).not.toHaveValue('');
  await clickPanelButton(panelPage, extensionWorker, demoPage, '#frame-refresh');
  await expect(panelPage.locator('#status')).toContainText(/Found \d+ context\(s\)/);
  await expect(panelPage.locator('#frame-context option').first()).not.toContainText('300×150');

  await demoPage.waitForTimeout(3000);
  await captureFrame(panelPage, extensionWorker, demoPage);
  const storedCommandCount = (await panelPage.locator('#status').textContent())?.match(/\((\d+) commands/)?.[1];
  expect(storedCommandCount).toBeTruthy();
  // Spector-style bounded capture (docs/PLAN.md, Phase 9): the package covers exactly one
  // armed frame, so its size reflects that one frame's real command count, not context
  // lifetime — a generous ceiling here just guards against a regression back to unbounded
  // recording (which used to blow past a million commands on this same demo).
  expect(Number(storedCommandCount)).toBeLessThan(50000);
  const eventIds = await panelPage.locator('#frame-event-list .range-item').evaluateAll((items) =>
    items.map((item) => item.dataset.eid)
  );
  expect(new Set(eventIds).size).toBe(eventIds.length);
  await expect.poll(() => panelPage.locator('#frame-event-list .range-kind', { hasText: 'draw' }).count()).toBeGreaterThan(10);
  await expect(panelPage.locator('#frame-event-list')).toContainText('HeroCube');

  await panelPage.locator('#mode-captures').click();
  const latestCapture = panelPage.locator('#stored-captures-list .stored-item').first();
  await expect(latestCapture).toContainText('Latest');
  await expect(latestCapture).toContainText('Open');
  await expect(latestCapture).toContainText('127.0.0.1');
  await expect(latestCapture.locator('.stored-meta')).not.toContainText('Unknown time');
  await expect(latestCapture.locator('.stored-delete')).toBeVisible();

  await panelPage.locator('#capture-metadata-details summary').click();
  await expect(panelPage.locator('#capture-metadata')).toBeVisible();
  await expect(panelPage.locator('#capture-metadata')).toContainText('Required extensions');
  await expect(panelPage.locator('#capture-metadata .inspectionStatus')).toContainText(/supported|degraded/);
  await panelPage.locator('#capture-metadata-details summary').click();

  await panelPage.locator('#mode-frame').click();
  const colorPreview = panelPage.locator('#frame-viewport img.preview-color-img');
  await expect(colorPreview).toBeVisible();
  await expect(colorPreview).toHaveAttribute('alt', /color after CMD \d+/);
  await expect(panelPage.locator('#frame-selection-clear')).toBeVisible();
  expectNonBlankPreview(await getPreviewStats(colorPreview));

  await expect(panelPage.locator('#view-frame .inspection-tabs [role="tab"]')).toHaveText(['Color', 'Pipeline', 'Call Info']);

  await panelPage.locator('#frame-event-list .range-item', { hasText: 'draw' }).nth(1).click();
  await panelPage.locator('#view-frame .inspection-tabs [data-inspect="pipeline"]').click();
  const stages = panelPage.locator('#frame-viewport .pipeline-stage');
  await expect(stages).toHaveText(['Vertex Input', 'Vertex Shader', 'Rasterizer', 'Fragment Shader', 'Output Merger']);
  await expect(panelPage.locator('#frame-viewport .pipeline-groups')).toContainText('Vertex attributes');
  await expect(panelPage.locator('#frame-viewport .pipeline-groups')).toContainText('Vertex buffer contents');
  await panelPage.locator('[data-pipeline-stage="rasterizer"]').click();
  await expect(panelPage.locator('#frame-viewport .pipeline-groups')).toContainText('VIEWPORT');
  await panelPage.locator('[data-pipeline-stage="output-merger"]').click();
  await expect(panelPage.locator('#frame-viewport .pipeline-groups')).toContainText('Framebuffer');
  await panelPage.locator('[data-pipeline-stage="vertex-shader"]').click();
  await panelPage.locator('#frame-viewport [data-open-program][data-stage="vertex"]').click();
  await expect(panelPage.locator('.mode-nav .mode-tab-shader')).toHaveCount(1);
  await expect(panelPage.locator('.mode-nav .mode-tab-shader')).toHaveAttribute('aria-selected', 'true');
  await panelPage.locator('.mode-nav .mode-tab-close').click();
  await panelPage.locator('#mode-frame').click();

  await panelPage.locator('#frame-event-list .range-item', { hasText: 'clear' }).first().click();
  await expect(panelPage.locator('[data-pipeline-stage="vertex-input"]')).toBeDisabled();
  await expect(panelPage.locator('[data-pipeline-stage="output-merger"]')).toHaveAttribute('aria-pressed', 'true');

  await panelPage.locator('#frame-event-list .range-item', { hasText: 'draw' }).nth(1).click();
  await panelPage.locator('#view-frame .inspection-tabs [data-inspect="details"]').click();
  const detailHeadings = panelPage.locator('#frame-viewport .details-group h4');
  await expect(panelPage.locator('#view-frame .inspection-tabs [data-inspect="details"]')).toHaveText('Call Info');
  await expect(detailHeadings.first()).toHaveText('Global');
  await expect(detailHeadings).toHaveText(['Global', 'Program', 'Hints', 'Stack trace']);
  await expect(panelPage.locator('#frame-viewport .details-group').first().locator('a')).toHaveAttribute('href', /developer\.mozilla\.org/);

  await panelPage.locator('#view-frame .inspection-tabs [data-inspect="color"]').click();
  await panelPage.locator('#frame-command-list .command-summary').first().waitFor();
  const firstCommand = await panelPage.locator('#frame-command-list .command-index').first().textContent();
  await panelPage.locator('#frame-command-list li').first().click();
  await expect(colorPreview).toHaveAttribute('alt', new RegExp(`after CMD ${firstCommand.match(/\d+/)?.[0]}`));

  await refreshScene(panelPage, extensionWorker, demoPage);
  await panelPage.locator('#mode-overview').click();
  await panelPage.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('#inspector-root .tree-row'));
    const hero = rows.find((row) => row.textContent.includes('HeroCube'));
    const target = hero ?? rows.find((row) => row.textContent.includes('Mesh'));
    const button = target?.querySelector('.scene-filter');
    if (!button) throw new Error('No Mesh scene node available to filter');
    button.click();
  });
  await panelPage.locator('#mode-frame').click();
  await expect(panelPage.locator('#scene-filter-chip')).toContainText('Filtering draws for');
  await expect.poll(() => panelPage.locator('#frame-event-list .range-item').count()).toBeGreaterThan(0);
  const matching = await panelPage.locator('#frame-event-list .range-item.scene-match').count();
  const total = await panelPage.locator('#frame-event-list .range-item').count();
  expect(matching).toBe(total);
  await panelPage.locator('#scene-filter-chip button').click();
  await expect(panelPage.locator('#scene-filter-chip')).toBeHidden();

  await captureFrame(panelPage, extensionWorker, demoPage);
  await panelPage.locator('#mode-captures').click();
  await expect(panelPage.locator('#capture-diff-bar')).toBeVisible();
  await panelPage.locator('#diff-run').click();
  await expect(panelPage.locator('#capture-diff')).toContainText('Command count');
  await expect(panelPage.locator('#capture-diff')).toContainText('First divergence');
  const meld = panelPage.locator('#capture-diff .meld');
  await expect(meld).toBeVisible();
  await expect.poll(() => meld.locator('.meld-pane--a .meld-row').count()).toBeGreaterThan(0);
  await expect.poll(() => meld.locator('.meld-pane--b .meld-row').count()).toBeGreaterThan(0);
  const changeCount = Number((await meld.locator('.meld-stat--changes').textContent())?.match(/\d+/)?.[0]);
  expect(changeCount).toBeGreaterThan(0);
  await expect.poll(() => meld.locator('.meld-gutter .meld-band').count()).toBeGreaterThan(0);
  await meld.locator('.meld-next').click();
  await expect(meld.locator('.meld-pane--a .meld-chunk--current')).toHaveCount(1);
  await expect(meld.locator('.meld-pane--b .meld-chunk--current')).toHaveCount(1);

  const originalA = await panelPage.locator('#diff-capture-a').inputValue();
  const originalB = await panelPage.locator('#diff-capture-b').inputValue();
  await panelPage.locator('#diff-capture-a').selectOption(originalB);
  await panelPage.locator('#diff-capture-b').selectOption(originalA);
  await panelPage.locator('#mode-overview').click();
  await panelPage.locator('#mode-captures').click();
  await expect(panelPage.locator('#diff-capture-a')).toHaveValue(originalB);
  await expect(panelPage.locator('#diff-capture-b')).toHaveValue(originalA);

  // Select the same capture on both sides and diff in one step: a background refresh of the
  // stored list re-picks two different captures, so separate steps would race it.
  await panelPage.evaluate((captureId) => {
    document.getElementById('diff-capture-a').value = captureId;
    document.getElementById('diff-capture-b').value = captureId;
    document.getElementById('diff-run').click();
  }, originalB);
  await expect(panelPage.locator('#capture-diff .diff-message')).toContainText('same capture');
  await panelPage.locator('#diff-capture-a').selectOption(originalB);
  await panelPage.locator('#diff-capture-b').selectOption(originalA);

  const hostPage = await context.newPage();
  await hostPage.goto(`chrome-extension://${extensionId}/inspection/webgl/host.html`);
  // Remove the package without the host's index update to exercise a stale selection
  // rather than the normal delete-and-refresh workflow.
  await hostPage.evaluate((captureId) => new Promise((resolve, reject) => {
    const request = indexedDB.open('ispettore');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction('captures', 'readwrite');
      transaction.objectStore('captures').delete(captureId);
      transaction.oncomplete = () => { db.close(); resolve(); };
      transaction.onabort = () => { db.close(); reject(transaction.error); };
    };
  }), originalA);
  expect(await hostPage.evaluate((captureId) => window.__ISPETTORE_WEBGL_INSPECTOR__.getStoredCapture(captureId), originalA))
    .toMatchObject({ ok: false, error: 'Capture not found' });
  await panelPage.evaluate(({ captureIdA, captureIdB }) => {
    const selectedA = document.getElementById('diff-capture-a').value;
    const selectedB = document.getElementById('diff-capture-b').value;
    const button = document.getElementById('diff-run');
    if (selectedA !== captureIdA || selectedB !== captureIdB || button.disabled) {
      throw new Error('The stale diff selection was refreshed before the missing-capture request');
    }
    button.click();
  }, { captureIdA: originalB, captureIdB: originalA });
  await expect(panelPage.locator('#status')).toContainText('Diff failed: One of the compared captures is missing');
  await expect(panelPage.locator('#capture-diff .diff-message')).toContainText('The diff failed');
  await hostPage.close();
});

test('unsupported captures never present an apparently valid preview', async ({
  context,
  extensionId,
  panelPage,
  extensionWorker,
  demoPage
}) => {
  await openDemo(demoPage, 'webgl-simple');
  await refreshScene(panelPage, extensionWorker, demoPage);
  await panelPage.locator('#mode-frame').click();

  const unsupportedPackage = {
    schema: 'ispettore-webgl-capture',
    version: 1,
    context: {
      api: 'webgl',
      width: 64,
      height: 64,
      attributes: {},
      drawingBuffer: { width: 64, height: 64 },
      capabilities: {},
      extensions: [],
      resizes: [],
      resizeTracking: null,
      overflow: null,
      recordedFromContextCreation: true
    },
    commands: [{ op: 'clear', argTypes: ['number'], args: [0x4000], resultId: null, failed: null, error: null }],
    blobs: [],
    frames: [
      {
        frameId: 'frame:1',
        label: 'range',
        kind: 'command-range',
        startCommandIndex: 0,
        endCommandIndex: 1,
        commandCount: 1,
        blobCount: 0,
        byteSize: 1,
        prefix: { endCommandIndex: 1, commandCount: 1, byteSize: 1 }
      }
    ],
    events: [{ eid: 1, commandIndex: 0, frameId: 'frame:1', kind: 'clear', op: 'clear', label: 'clear' }],
    inspectionStatus: { level: 'unsupported', reasons: ['captured clear failed (command): boom'] }
  };

  const hostPage = await context.newPage();
  await hostPage.goto(`chrome-extension://${extensionId}/inspection/webgl/host.html`);
  const imported = await hostPage.evaluate((capture) => window.__ISPETTORE_WEBGL_INSPECTOR__.importCapture(capture), unsupportedPackage);
  expect(imported.ok).toBe(true);
  await hostPage.close();

  await panelPage.locator('#mode-overview').click();
  await panelPage.locator('#mode-captures').click();
  await expandStoredCaptures(panelPage);
  const stored = panelPage.locator('#stored-captures-list .stored-item', { hasText: imported.captureId });
  await expect(stored).toBeVisible();
  const panelErrors = [];
  const onPageError = (error) => panelErrors.push(error.message);
  const onConsole = (msg) => {
    if (msg.type() === 'error') panelErrors.push(msg.text());
  };
  panelPage.on('pageerror', onPageError);
  panelPage.on('console', onConsole);
  await stored.click();
  await expect(panelPage.locator('#frame-viewport')).toContainText('unsupported', { timeout: 10000 });
  panelPage.off('pageerror', onPageError);
  panelPage.off('console', onConsole);
  expect(panelErrors).toEqual([]);
  await panelPage.locator('#capture-metadata-details summary').click();
  await expect(panelPage.locator('#capture-metadata .inspectionStatus--unsupported')).toContainText('unsupported');
  await panelPage.locator('#capture-metadata-details summary').click();
  await expect(panelPage.locator('#frame-viewport img.preview-color-img')).toHaveCount(0);
  await stored.locator('.stored-delete').click();
  await expect(stored).toHaveCount(0);
  await expect(panelPage.locator('#status')).toContainText(`Deleted stored capture ${imported.captureId}`);
});
