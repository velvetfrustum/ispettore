import { test, expect } from './fixtures.js';
import { openDemo, armWebGlAndWaitForFrame } from './helpers.js';

async function captureBoundedFrame(demoPage) {
  const target = await armWebGlAndWaitForFrame(demoPage);
  return demoPage.evaluate(
    ({ contextId, frameId }) => window.__ISPETTORE__.getWebGlJournalPackage(contextId, frameId),
    target
  );
}

test('live captures separate animation frames from inspectable GPU events', async ({
  context,
  extensionId,
  demoPage
}) => {
  await openDemo(demoPage, 'webgl-simple');
  const capture = await captureBoundedFrame(demoPage);
  expect(capture).not.toBeNull();
  expect(capture.frames.length).toBeGreaterThan(0);
  expect(capture.frames.some((frame) => frame.kind === 'animation-frame')).toBe(true);
  expect(capture.events.length).toBeGreaterThan(capture.frames.length);
  expect(capture.context.recordedFromContextCreation).toBe(true);

  for (const frame of capture.frames) {
    expect(frame.endCommandIndex).toBeLessThanOrEqual(capture.commands.length);
    expect(frame.commandCount).toBe(frame.endCommandIndex - frame.startCommandIndex);
    expect(frame.prefix.commandCount).toBe(frame.endCommandIndex);
    expect(frame.byteSize).toBeGreaterThan(0);
  }

  const inspectionPage = await context.newPage();
  await inspectionPage.goto(`chrome-extension://${extensionId}/inspection/webgl/host.html`);
  const result = await inspectionPage.evaluate((serialized) => {
    const api = window.__ISPETTORE_WEBGL_INSPECTOR__;
    const chosen = [...serialized.events].reverse().find((event) => event.kind === 'draw') ?? serialized.events.at(-1);
    const byEid = api.inspect(serialized, { eid: chosen.eid });
    const byIndex = api.inspect(serialized, { commandIndex: chosen.commandIndex });
    return { chosen, byEid, byIndex };
  }, capture);
  await inspectionPage.close();

  expect(result.chosen).toBeTruthy();
  expect(result.byEid.selectedCommandIndex).toBe(result.chosen.commandIndex);
  expect(result.byEid.selectedCommandIndex).toBe(result.byIndex.selectedCommandIndex);
  expect(result.byEid.color).toEqual(result.byIndex.color);
  expect(['supported', 'degraded']).toContain(result.byEid.inspectionStatus.level);
  expect(result.byEid.color.range).toBeGreaterThan(10);
});

test('inspection lookups for every event are stable under random-order access, without touching the live page', async ({
  context,
  extensionId,
  demoPage
}) => {
  await openDemo(demoPage, 'webgl-simple');
  const capture = await captureBoundedFrame(demoPage);

  const inspectionPage = await context.newPage();
  await inspectionPage.goto(`chrome-extension://${extensionId}/inspection/webgl/host.html`);

  const verdict = await inspectionPage.evaluate((serialized) => {
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
    // Every inspect() call is an independent lookup against already-baked data (docs/PLAN.md,
    // Phase 9) — there is no session state to seek through, so visiting events in reverse
    // order must agree exactly with visiting them in forward order.
    const forward = serialized.events.map((event) => api.inspect(serialized, { eid: event.eid }).color);
    const backward = [...serialized.events].reverse().map((event) => api.inspect(serialized, { eid: event.eid }).color);
    backward.reverse();
    return {
      touched,
      inspectedEvents: forward.length,
      match: JSON.stringify(forward) === JSON.stringify(backward)
    };
  }, capture);
  await inspectionPage.close();

  expect(verdict.touched).toEqual([]);
  expect(verdict.inspectedEvents).toBe(capture.events.length);
  expect(verdict.match).toBe(true);
});
