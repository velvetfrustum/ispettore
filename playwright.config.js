import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/integration',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: {
    timeout: 10_000
  },
  reporter: 'list',
  outputDir: 'test-results/integration',
  use: {
    screenshot: 'off',
    trace: 'off',
    video: 'off'
  },
  webServer: {
    command: 'node tools/serve-demos.mjs',
    url: 'http://127.0.0.1:8765/',
    reuseExistingServer: true,
    timeout: 10_000
  }
});
