import { test, expect } from './fixtures.js';
import { openDemo, armWebGlAndWaitForFrame } from './helpers.js';

const DEMO_ORDER = [
  'webgl-simple',
  'webgl-instanced',
  'webgl-postprocess',
  'webgl-depth-texture',
  'webgl-dof2',
  'webgl-afterimage',
  'webgl-gpgpu'
];

const TEMPORAL_DEMOS = ['webgl-afterimage', 'webgl-gpgpu'];

async function captureBoundedFrame(demoPage) {
  const target = await armWebGlAndWaitForFrame(demoPage);
  return demoPage.evaluate(
    ({ contextId, frameId }) => window.__ISPETTORE__.getWebGlJournalPackage(contextId, frameId),
    target
  );
}

for (const slug of DEMO_ORDER) {
  test(`${slug} single-frame capture is small, bounded, and inspects via baked previews`, async ({
    context,
    extensionId,
    demoPage
  }) => {
    // Previews and command details are read back per event; under SwiftShader a heavy dof2
    // frame (~200 events) alone takes 30-40 s, so the default 45 s budget is too tight.
    test.setTimeout(120000);
    await openDemo(demoPage, slug);
    const capture = await captureBoundedFrame(demoPage);

    expect(capture).not.toBeNull();
    // Spector-style bounded capture (docs/PLAN.md, Phase 9): the package always covers
    // exactly the one armed frame, however long the page had already been running.
    expect(capture.commands.length).toBeGreaterThan(10);
    expect(capture.context.recordedFromContextCreation).toBe(true);
    expect(capture.frames).toHaveLength(1);
    expect(capture.commands).toHaveLength(capture.frames[0].endCommandIndex);
    expect(capture.events.length).toBeGreaterThan(1);

    const inspectionPage = await context.newPage();
    await inspectionPage.goto(`chrome-extension://${extensionId}/inspection/webgl/host.html`);
    const { first, second } = await inspectionPage.evaluate((serialized) => {
      const api = window.__ISPETTORE_WEBGL_INSPECTOR__;
      return { first: api.inspect(serialized), second: api.inspect(serialized) };
    }, capture);
    await inspectionPage.close();

    expect(first.selectedCommandIndex).toBe(capture.commands.length - 1);
    expect(first.inspectionStatus.level, first.inspectionStatus.reasons.join('\n')).not.toBe('unsupported');
    expect(first.width).toBeGreaterThan(0);
    expect(first.height).toBeGreaterThan(0);
    expect(first.color.range).toBeGreaterThan(10);
    // The lookup is a pure read of already-baked data, so it is trivially repeatable.
    expect(second).toEqual(first);
  });
}

for (const slug of TEMPORAL_DEMOS) {
  test(`${slug}: two separate bounded captures each reflect their own live moment`, async ({
    context,
    extensionId,
    demoPage
  }) => {
    await openDemo(demoPage, slug);

    // Live capture never reconstructs state (docs/PLAN.md, "Why we pivoted away from
    // isolated replay") — each capture just reads back whatever the GPU actually holds at
    // that moment, so two captures of a temporally-evolving demo (ping-pong buffers,
    // accumulation, etc.) should show two different results with no special handling.
    const captureA = await captureBoundedFrame(demoPage);
    await demoPage.waitForTimeout(300);
    const captureB = await captureBoundedFrame(demoPage);

    expect(captureA).not.toBeNull();
    expect(captureB).not.toBeNull();

    const inspectionPage = await context.newPage();
    await inspectionPage.goto(`chrome-extension://${extensionId}/inspection/webgl/host.html`);
    const verdict = await inspectionPage.evaluate(
      ({ a, b }) => {
        const api = window.__ISPETTORE_WEBGL_INSPECTOR__;
        return { a: api.inspect(a), b: api.inspect(b) };
      },
      { a: captureA, b: captureB }
    );
    await inspectionPage.close();

    expect(verdict.a.inspectionStatus.level, verdict.a.inspectionStatus.reasons.join('\n')).not.toBe('unsupported');
    expect(verdict.b.inspectionStatus.level, verdict.b.inspectionStatus.reasons.join('\n')).not.toBe('unsupported');
    expect(verdict.a.color.range).toBeGreaterThan(10);
    expect(verdict.b.color.range).toBeGreaterThan(10);
    expect(verdict.a.color.hash).not.toBe(verdict.b.color.hash);
  });
}

test('a capture from a long-running page still resolves every resource it references', async ({ demoPage }) => {
  test.setTimeout(60_000);
  await openDemo(demoPage, 'webgl-simple');

  // Let the page run unrecorded for a while first — under bounded capture, this is the
  // normal case (a demo can run for as long as it likes before anyone presses Capture),
  // and every resource it set up along the way must still resolve once armed.
  await demoPage.waitForTimeout(3000);

  const capture = await captureBoundedFrame(demoPage);
  // Most of this resource's referenced buffers/textures/programs were created well before
  // arm() (during the unrecorded 3s above), so their `createX` commands are correctly absent
  // from this bounded package — what must still hold is that every reference to them still
  // resolves (the live object registry survives across the whole context lifetime, not just
  // the recording window; see commandJournal.js's `!recording` bookkeeping branch).
  const referenceFailures = capture.commands.filter((command) => command.failed === 'reference');

  expect(capture.context.recordedFromContextCreation).toBe(true);
  expect(referenceFailures).toEqual([]);
  expect(capture.inspectionStatus.level, capture.inspectionStatus.reasons.join('\n')).not.toBe('unsupported');
});
