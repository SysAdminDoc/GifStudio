import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.e2e.mjs',
  outputDir: join(tmpdir(), 'gifstudio-playwright-results'),
  fullyParallel: true,
  workers: 4,
  forbidOnly: true,
  retries: process.env.CI ? 1 : 0,
  reporter: 'line',
  expect: {
    timeout: 10_000
  },
  use: {
    baseURL: 'http://127.0.0.1:18766',
    browserName: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 900 }
  },
  webServer: {
    command: 'node scripts/serve.mjs',
    url: 'http://127.0.0.1:18766',
    reuseExistingServer: false,
    timeout: 15_000
  }
});
