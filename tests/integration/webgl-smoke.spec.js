import { test, expect } from './fixtures.js';
import {
  WEBGL_DEMOS,
  expectNonBlankPreview,
  getCanvasScreenshotStats,
  openDemo
} from './helpers.js';

for (const slug of WEBGL_DEMOS) {
  test(`${slug} loads without faults and keeps a non-blank animated canvas`, async ({ demoPage }) => {
    const faults = await openDemo(demoPage, slug);
    const first = await getCanvasScreenshotStats(demoPage);
    expectNonBlankPreview(first.stats);

    await demoPage.waitForTimeout(400);
    const second = await getCanvasScreenshotStats(demoPage);
    expectNonBlankPreview(second.stats);
    expect(second.buf.equals(first.buf)).toBe(false);

    expect(faults.pageErrors).toEqual([]);
    expect(faults.failedLocal).toEqual([]);
    expect(faults.consoleErrors).toEqual([]);
  });
}
