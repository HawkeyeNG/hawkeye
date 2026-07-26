// Playwright config for the Hawkeye UI guards.
//
// Serves app/ as plain static files and stubs every /api/** call (see
// helpers.js), so runs are deterministic and never depend on the live site or
// the backend being up. python3 is preinstalled on GitHub's ubuntu runners, so
// there's nothing to install for the server.
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: '.',
  timeout: 60_000,
  fullyParallel: false,          // viewport tests resize the same page
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'report' }]],
  // Screenshots differ between a dev machine and the runner (fonts, GPU), so
  // baselines must be generated ON the runner — see the workflow's
  // update_snapshots input. A small ratio absorbs antialiasing noise.
  expect: {
    toHaveScreenshot: { maxDiffPixelRatio: 0.012, animations: 'disabled', caret: 'hide' },
  },
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'python3 -m http.server 4173 --directory ../../app',
    url: 'http://127.0.0.1:4173/index.html',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
