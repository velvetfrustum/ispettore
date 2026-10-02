import { test, expect } from './fixtures.js';
import { openDemo, armWebGlAndWaitForFrame } from './helpers.js';

async function captureBoundedFrame(demoPage) {
  const target = await armWebGlAndWaitForFrame(demoPage);
  return demoPage.evaluate(
    ({ contextId, frameId }) => window.__ISPETTORE__.getWebGlJournalPackage(contextId, frameId),
    target
  );
}

async function inspectInHost(context, extensionId, capture) {
  const inspectionPage = await context.newPage();
  await inspectionPage.goto(`chrome-extension://${extensionId}/inspection/webgl/host.html`);
  const result = await inspectionPage.evaluate((serialized) => {
    const api = window.__ISPETTORE_WEBGL_INSPECTOR__;
    return { first: api.inspect(serialized), second: api.inspect(serialized) };
  }, capture);
  await inspectionPage.close();
  return result;
}

for (const slug of ['webgl-simple', 'webgl-instanced']) {
  test(`${slug} captures and inspects a full journal frame in a fresh context`, async ({
    context,
    extensionId,
    demoPage
  }) => {
    await openDemo(demoPage, slug);

    const capture = await captureBoundedFrame(demoPage);
    expect(capture).not.toBeNull();
    // Bounded capture (docs/PLAN.md, Phase 9): one frame's command count now scales with
    // that demo's real per-frame GL traffic, not accumulated history — webgl-instanced sets
    // its scene up once and re-binds/draws only 2 InstancedMeshes + a floor each frame, so
    // its bounded package is legitimately small (~20 commands), unlike webgl-simple's (~700+).
    expect(capture.commands.length).toBeGreaterThan(10);

    const { first, second } = await inspectInHost(context, extensionId, capture);

    expect(first.selectedCommandIndex).toBe(capture.commands.length - 1);
    expect(first.color.range).toBeGreaterThan(10);
    expect(['supported', 'degraded']).toContain(first.inspectionStatus.level);
    expect(first.width).toBeGreaterThan(0);
    expect(first.height).toBeGreaterThan(0);
    expect(second).toEqual(first);
  });
}

test('inspection never touches the live page backend or Three.js', async ({ context, extensionId, demoPage }) => {
  await openDemo(demoPage, 'webgl-simple');
  const capture = await captureBoundedFrame(demoPage);

  const inspectionPage = await context.newPage();
  await inspectionPage.goto(`chrome-extension://${extensionId}/inspection/webgl/host.html`);

  const verdict = await inspectionPage.evaluate(async (serialized) => {
    const touched = [];
    for (const [name] of [
      ['THREE', 'Inspection accessed Three.js'],
      ['__ISPETTORE__', 'Inspection accessed the live page backend']
    ]) {
      Object.defineProperty(window, name, {
        configurable: true,
        get() {
          touched.push(name);
          throw new Error(`Inspection accessed ${name}`);
        }
      });
    }
    const api = window.__ISPETTORE_WEBGL_INSPECTOR__;
    const result = api.inspect(serialized);
    return { touched, result };
  }, capture);

  expect(verdict.touched).toEqual([]);
  expect(verdict.result.inspectionStatus.level).not.toBe('unsupported');
  await inspectionPage.close();
});