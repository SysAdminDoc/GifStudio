import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.e2e.mjs',
  outputDir: join(tmpdir(), 'gifstudio-playwright-results'),
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  forbidOnly: true,
  retries: process.env.CI ? 1 : 0,
  reporter: 'line',
  expect: {
    timeout: 10_000
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    {
      name: 'firefox',
      testIgnore: '**/storage.e2e.mjs',
      use: {
        browserName: 'firefox',
        launchOptions: {
          firefoxUserPrefs: {
            'gfx.webrender.force-disabled': true,
            'layers.acceleration.disabled': true
          }
        }
      }
    },
    { name: 'webkit', use: { browserName: 'webkit' } }
  ],
  use: {
    baseURL: 'http://127.0.0.1:18766',
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
