import { test, expect } from './fixtures.js';
import { openDemo, armWebGlAndWaitForFrame, clickPanelButton } from './helpers.js';

test('webgl-be-the-sun captures a WebGL1 (regl) frame with baked previews and no GL errors', async ({ demoPage }) => {
  const glWarnings = [];
  demoPage.on('console', (message) => {
    if (/WebGL|GL_INVALID|INVALID_ENUM|INVALID_OPERATION/.test(message.text())) glWarnings.push(message.text());
  });
  const faults = await openDemo(demoPage, 'webgl-be-the-sun');
  await demoPage.mouse.move(200, 100);

  const [summary] = await demoPage.evaluate(() => window.__ISPETTORE__.getWebGlJournalSummary());
  expect(summary.contextInfo.version).toBe(1);

  const target = await armWebGlAndWaitForFrame(demoPage);
  const capture = await demoPage.evaluate(
    ({ contextId, frameId }) => window.__ISPETTORE__.getWebGlJournalPackage(contextId, frameId),
    target
  );

  expect(capture.schema).toBe('ispettore-webgl-capture');
  expect(capture.context.api).toBe('webgl');
  expect(capture.context.version).toBe(1);
  expect('MAX_3D_TEXTURE_SIZE' in capture.context.capabilities).toBe(false);
  expect(capture.inspectionStatus.level).toBe('supported');

  const draw = capture.commands.find((command) => command.op === 'drawArrays');
  expect(draw).toBeTruthy();
  expect(draw.preview.colorTarget).toBe('default');
  expect(draw.preview.color.range).toBeGreaterThan(10);
  expect(capture.events.some((event) => event.kind === 'draw')).toBe(true);
  expect(draw.details.error).toBeUndefined();
  expect(draw.details.states.map((group) => group.name)).toContain('BlendState');
  expect(draw.details.drawCall.programStatus.LINK_STATUS).toBe(true);
  expect(draw.details.drawCall.uniforms.map((uniform) => uniform.name)).toContain('uSunSize');
  expect(draw.details.drawCall.attributes[0].sample.unavailable).toMatch(/WebGL1/);
  expect(Object.keys(capture.programs)).toHaveLength(1);

  expect(glWarnings).toEqual([]);
  expect(faults.pageErrors).toEqual([]);
});

test('an outdated page script that sees no WebGL1 context is reported as stale, not as missing', async ({
  panelPage,
  extensionWorker,
  demoPage
}) => {
  await openDemo(demoPage, 'webgl-be-the-sun');
  await demoPage.evaluate(() => {
    globalThis.__ISPETTORE_BUILD_ID = 'previous-build';
    window.__ISPETTORE__.getWebGlJournalSummary = () => [];
  });

  await panelPage.locator('#mode-frame').click();
  await clickPanelButton(panelPage, extensionWorker, demoPage, '#frame-refresh');
  await expect(panelPage.locator('#status')).toContainText('older Ispettore page script', { timeout: 20000 });
});
