import { defineConfig, devices } from '@playwright/test';

const CHANNEL = process.env.VBW_BROWSER_CHANNEL || 'chrome';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'html-report', open: 'never' }],
  ],
  use: {
    baseURL: process.env.VBW_BASE_URL || 'http://127.0.0.1:5173',
    channel: CHANNEL,
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop-chrome', use: { ...devices['Desktop Chrome'], channel: CHANNEL } },
    {
      name: 'mobile-chrome',
      use: { ...devices['Pixel 7'], channel: CHANNEL },
      testIgnore: /contrast\.spec\.ts/,
    },
  ],
  webServer: process.env.VBW_NO_WEBSERVER
    ? undefined
    : {
        command:
          process.env.VBW_DEV_CMD ||
          'node node_modules/vite/bin/vite.js --port 5173 --strictPort',
        url: 'http://127.0.0.1:5173',
        reuseExistingServer: true,
        timeout: 60_000,
      },
});
