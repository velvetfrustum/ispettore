import { test, expect } from './fixtures.js';
import { openDemo, armWebGlAndWaitForFrame } from './helpers.js';

async function storeFirstAnimationFrame(demoPage) {
  const target = await armWebGlAndWaitForFrame(demoPage, { timeoutMs: 12_000 });
  return demoPage.evaluate(
    ({ contextId, frameId }) => window.__ISPETTORE__.storeWebGlFrame(contextId, frameId),
    target
  );
}

test('stored captures export, re-import with a fresh id, and reject invalid packages', async ({
  context,
  extensionId,
  demoPage
}) => {
  test.setTimeout(120_000);
  await openDemo(demoPage, 'webgl-simple');

  const stored = await storeFirstAnimationFrame(demoPage);
  expect(stored.ok).toBe(true);
  expect(stored.captureId).toBeTruthy();
  expect(stored.serializeMs).toBeGreaterThanOrEqual(0);
  expect(stored.byteSize).toBeGreaterThan(0);

  const hostPage = await context.newPage();
  await hostPage.goto(`chrome-extension://${extensionId}/inspection/webgl/host.html`);
  const api = (expression, arg) => hostPage.evaluate(expression, arg);

  const exported = await api(async (captureId) => {
    const result = await window.__ISPETTORE_WEBGL_INSPECTOR__.exportStoredCapture(captureId);
    if (!result.ok) return result;
    const parsed = JSON.parse(result.data);
    return { ...result, version: parsed.version, schema: parsed.schema };
  }, stored.captureId);
  expect(exported.ok).toBe(true);
  expect(exported.schema).toBe('ispettore-webgl-capture');
  expect(exported.version).toBe(1);
  expect(exported.meta.byteSize).toBeGreaterThan(0);

  const removed = await api(
    (captureId) => window.__ISPETTORE_WEBGL_INSPECTOR__.deleteStoredCapture(captureId),
    stored.captureId
  );
  expect(removed.removed).toBe(true);

  const reimported = await api(
    (data) => window.__ISPETTORE_WEBGL_INSPECTOR__.importCapture(data),
    exported.data
  );
  expect(reimported.ok).toBe(true);
  expect(reimported.captureId).not.toBe(stored.captureId);

  const listed = await api(() => window.__ISPETTORE_WEBGL_INSPECTOR__.listStoredCaptures());
  expect(listed.captures.some((capture) => capture.captureId === reimported.captureId)).toBe(true);

  const inspected = await api(async (captureId) => {
    const record = await window.__ISPETTORE_WEBGL_INSPECTOR__.getStoredCapture(captureId);
    if (!record.ok) return record;
    return window.__ISPETTORE_WEBGL_INSPECTOR__.inspect(record.capture, {
      commandIndex: record.capture.commands.length - 1
    });
  }, reimported.captureId);
  expect(inspected.error).toBeUndefined();
  expect(inspected.selectedCommandIndex).toBeGreaterThan(0);
  expect(inspected.color.range).toBeGreaterThan(10);
  expect(inspected.inspectionStatus.level).not.toBe('unsupported');

  const corruptPackages = [
    ['not json', '{definitely not'],
    ['unknown version', JSON.stringify({ ...JSON.parse(exported.data), version: 99 })],
    ['missing body', JSON.stringify({})]
  ];
  for (const [label, data] of corruptPackages) {
    const rejected = await api(
      (text) => window.__ISPETTORE_WEBGL_INSPECTOR__.importCapture(text),
      data
    );
    expect(rejected.ok, `${label} import must be rejected`).toBe(false);
    expect(typeof rejected.error).toBe('string');
  }

  const stillListed = await api(() => window.__ISPETTORE_WEBGL_INSPECTOR__.listStoredCaptures());
  expect(stillListed.captures.some((capture) => capture.captureId === reimported.captureId)).toBe(
    true
  );

  const cleaned = await api(
    (captureId) => window.__ISPETTORE_WEBGL_INSPECTOR__.deleteStoredCapture(captureId),
    reimported.captureId
  );
  expect(cleaned.removed).toBe(true);
  await hostPage.close();
});
