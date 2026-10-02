import { test, expect } from './fixtures.js';
import { openDemo, armWebGlAndWaitForFrame } from './helpers.js';

test('DoF2 inspection of intermediate EIDs produces non-empty images', async ({
  demoPage,
  context,
  extensionId
}) => {
  // A dof2 frame has ~200 events whose previews and details are read back one by one; under
  // SwiftShader that alone takes 30-40 s.
  test.setTimeout(120000);
  await openDemo(demoPage, 'webgl-dof2');

  const target = await armWebGlAndWaitForFrame(demoPage);
  const capture = await demoPage.evaluate(
    ({ contextId, frameId }) => window.__ISPETTORE__.getWebGlJournalPackage(contextId, frameId),
    target
  );

  expect(capture).toBeTruthy();
  expect(capture.events.length).toBeGreaterThan(10);

  const inspectionPage = await context.newPage();
  await inspectionPage.goto(`chrome-extension://${extensionId}/inspection/webgl/host.html`);

  const inspectionResults = await inspectionPage.evaluate(async (serialized) => {
    const api = window.__ISPETTORE_WEBGL_INSPECTOR__;
    const drawEvents = serialized.events.filter((e) => e.kind === 'draw');
    // Test early draw (in pass 1: scene to half-float color RT)
    const firstDraw = drawEvents[0];
    const midDraw = drawEvents[Math.floor(drawEvents.length / 2)];
    const lastDraw = drawEvents[drawEvents.length - 1];

    const r1 = api.inspect(serialized, { eid: firstDraw.eid });
    const r2 = api.inspect(serialized, { eid: midDraw.eid });
    const r3 = api.inspect(serialized, { eid: lastDraw.eid });

    return {
      firstDraw: { eid: firstDraw.eid, ...r1 },
      midDraw: { eid: midDraw.eid, ...r2 },
      lastDraw: { eid: lastDraw.eid, ...r3 }
    };
  }, capture);

  await inspectionPage.close();

  // Verify that all EIDs produce non-empty images
  expect(inspectionResults.firstDraw.color.range).toBeGreaterThan(0);
  expect(inspectionResults.midDraw.color.range).toBeGreaterThan(0);
  expect(inspectionResults.lastDraw.color.range).toBeGreaterThan(0);
});

