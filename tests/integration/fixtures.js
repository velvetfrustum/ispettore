import { test as base, chromium, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

export const test = base.extend({
  webgpu: [false, { option: true }],
  context: async ({ webgpu }, use, testInfo) => {
    const extensionPath = path.resolve('dist');
    const userDataDir = testInfo.outputPath('chromium-profile');
    await mkdir(userDataDir, { recursive: true });

    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: true,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        '--enable-webgl',
        '--enable-unsafe-webgpu',
        ...(webgpu
          ? ['--use-angle=swiftshader', '--use-vulkan=swiftshader', '--enable-features=Vulkan', '--disable-vulkan-surface']
          : ['--use-angle=swiftshader']),
        '--enable-unsafe-swiftshader'
      ]
    });
    await context.route(/^https?:\/\//, async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') {
        await route.continue();
      } else {
        await route.abort('blockedbyclient');
      }
    });

    await use(context);
    await context.close();
  },

  extensionWorker: async ({ context }, use) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker');
    await use(worker);
  },

  extensionId: async ({ extensionWorker }, use) => {
    await use(new URL(extensionWorker.url()).host);
  },

  demoPage: async ({ context }, use) => {
    const page = context.pages()[0] || (await context.newPage());
    await use(page);
  },

  panelPage: async ({ context, extensionId, demoPage }, use) => {
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/ui/index.html`);
    await panel.locator('#status').waitFor();
    await use(panel);
    await panel.close();
    await demoPage.bringToFront();
  }
});

export { expect };
