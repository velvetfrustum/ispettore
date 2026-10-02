import { test, expect } from './fixtures.js';
import { openDemo, refreshScene, armWebGlAndWaitForFrame } from './helpers.js';

test('Refresh overview loads the webgl-simple hierarchy', async ({
  demoPage,
  panelPage,
  extensionWorker
}) => {
  const { pageErrors } = await openDemo(demoPage, 'webgl-simple');
  await refreshScene(panelPage, extensionWorker, demoPage);
  await expect(panelPage.locator('.scene-root')).toContainText('DemoScene');
  await expect(panelPage.locator('.scene-root')).toContainText('CityGroup');
  await expect(panelPage.locator('.scene-root')).toContainText('HeroCube');
  expect(await panelPage.locator('.scene-root .tree-row').count()).toBeGreaterThan(100);
  expect(pageErrors).toEqual([]);
});

test('Live WebGL contexts record commands through the bounded capture journal', async ({ demoPage }) => {
  await openDemo(demoPage, 'webgl-simple');
  // Bounded capture (docs/PLAN.md, Phase 9): nothing is recorded until armed, and a package
  // covers exactly one frame — so setup-only calls (createProgram/createBuffer/bufferData/
  // getExtension/getUniformLocation) are correctly *absent* here: a real scene issues those
  // once at startup, long before anyone presses Capture, and only binds/uses them every
  // frame after that. What must still hold every frame is the steady-state per-draw traffic.
  await armWebGlAndWaitForFrame(demoPage);
  const journals = await demoPage.evaluate(() => window.__ISPETTORE__?.getWebGlJournalSummary?.());

  expect(journals).toHaveLength(1);
  expect(journals[0].commandCount).toBeGreaterThan(100);
  expect(journals[0].wrappedMethodCount).toBeGreaterThan(200);
  expect(journals[0].methods.drawElements).toBeGreaterThan(0);
  expect(journals[0].methods.useProgram).toBeGreaterThan(0);
  expect(journals[0].methods.bindVertexArray).toBeGreaterThan(0);
  expect(journals[0].methods.uniformMatrix4fv).toBeGreaterThan(0);
  expect(journals[0].failedMethods).toEqual({});
  expect(journals[0].valid).toBe(journals[0].failureCount === 0);

  const failureReasons = journals[0].failureReasons;
  expect(Object.keys(failureReasons)).toEqual(Object.keys(journals[0].failedMethods));
  for (const reasons of Object.values(failureReasons)) {
    expect(reasons.every((reason) => typeof reason === 'string' && reason.length > 0)).toBe(true);
  }

  const contextInfo = journals[0].contextInfo;
  expect(contextInfo.attributes).toBeTruthy();
  expect(contextInfo.attributes.antialias).toBe(false);
  expect(contextInfo.attributes.preserveDrawingBuffer).toBe(true);
  expect(contextInfo.drawingBufferWidth).toBeGreaterThan(0);
  expect(contextInfo.drawingBufferHeight).toBeGreaterThan(0);
  expect(contextInfo.canvasWidth).toBe(contextInfo.drawingBufferWidth);
  expect(contextInfo.canvasHeight).toBe(contextInfo.drawingBufferHeight);
  expect(contextInfo.limits.MAX_TEXTURE_SIZE).toBeGreaterThan(0);
  expect(contextInfo.limits.MAX_3D_TEXTURE_SIZE).toBeGreaterThan(0);
  expect(contextInfo.limits.MAX_ARRAY_TEXTURE_LAYERS).toBeGreaterThan(0);
  expect(contextInfo.limits.MAX_COLOR_ATTACHMENTS).toBeGreaterThan(0);
  expect(Array.isArray(contextInfo.supportedExtensions)).toBe(true);
  expect(contextInfo.resizeTracking).toEqual({
    complete: true,
    trackedProperties: ['width', 'height']
  });
  expect(journals[0].resizes.length).toBeGreaterThanOrEqual(1);
  for (const resize of journals[0].resizes) {
    expect(resize.commandIndex).toBeGreaterThanOrEqual(0);
    expect(resize.canvasWidth).toBeGreaterThan(0);
    expect(resize.canvasHeight).toBeGreaterThan(0);
    expect(resize.drawingBufferWidth).toBeGreaterThan(0);
    expect(resize.drawingBufferHeight).toBeGreaterThan(0);
  }

  const signatures = journals[0].signatures;
  expect(signatures.drawElements).toEqual(['number,number,number,number']);
  expect(signatures.uniformMatrix4fv.every((signature) => signature.startsWith('resource,'))).toBe(true);
  const recordedTypes = new Set(Object.values(signatures).flatMap((list) => list.join(',').split(',')));
  expect(recordedTypes.has('object')).toBe(false);
  expect(recordedTypes.has('undefined')).toBe(false);

  const debuggerPollution = await demoPage.evaluate(() => {
    const before = window.__ISPETTORE__.getWebGlJournalSummary()[0];
    window.__ISPETTORE__.getSnapshot({ includeFullPreview: false });
    const after = window.__ISPETTORE__.getWebGlJournalSummary()[0];
    const changedMethods = Object.keys(after.methods).filter(
      (method) => after.methods[method] !== (before.methods[method] ?? 0)
    );
    return { before: before.commandCount, after: after.commandCount, changedMethods };
  });
  expect(debuggerPollution.changedMethods).toEqual([]);
  expect(debuggerPollution.after).toBe(debuggerPollution.before);
});
