import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for YZ.Network browser testing
 *
 * Tests browser-specific features like:
 * - Tab visibility disconnect/reconnect
 * - WebRTC connection management
 * - Pub/sub subscription preservation
 * - DHT network integration
 */
export default defineConfig({
  testDir: './tests/browser',

  // Timeout for each test
  timeout: process.env.CI ? 180 * 1000 : 120 * 1000, // 3 minutes on CI, 2 minutes locally

  // Expect timeout for assertions
  expect: {
    timeout: process.env.CI ? 15000 : 10000
  },

  // Run tests in files in parallel (but not individual tests within files)
  fullyParallel: false,

  // Fail the build on CI if you accidentally left test.only in the source code
  forbidOnly: !!process.env.CI,

  // Retry on CI only
  retries: process.env.CI ? 2 : 0,

  // Opt out of parallel tests on CI for stability
  workers: process.env.CI ? 1 : undefined,

  // Reporter to use
  reporter: [
    ['html', { outputFolder: 'playwright-report' }],
    ['list'],
    ['json', { outputFile: 'test-results/results.json' }]
  ],

  // Shared settings for all the projects below
  use: {
    // Base URL to use in actions like `await page.goto('/')`
    baseURL: process.env.CI ? 'http://localhost:3000' : 'http://localhost:3000',

    // Collect trace when retrying the failed test
    trace: 'on-first-retry',

    // Screenshot on failure
    screenshot: 'only-on-failure',

    // Video on failure
    video: 'retain-on-failure',

    // Viewport size
    viewport: { width: 1280, height: 720 },

    // Ignore HTTPS errors for local development
    ignoreHTTPSErrors: true,

    // Set longer timeout for CI
    actionTimeout: process.env.CI ? 30000 : 10000,
  },

  // Configure projects for major browsers
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },

    // Firefox - may be blocked by antivirus software
    // Uncomment when antivirus exceptions are configured
    // {
    //   name: 'firefox',
    //   use: { ...devices['Desktop Firefox'] },
    // },

    // Uncomment for Safari testing (requires macOS)
    // {
    //   name: 'webkit',
    //   use: { ...devices['Desktop Safari'] },
    // },
  ],

  // Run your local dev server before starting the tests
  webServer: process.env.CI ? undefined : {
    command: 'npm run test:server',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 120 * 1000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
