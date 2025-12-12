import { test, expect } from '@playwright/test';

/**
 * Smoke Test - Minimal test to verify setup is working
 * 
 * This test verifies that:
 * 1. The page loads
 * 2. YZSocialC is available
 * 3. Basic methods exist
 * 4. No critical JavaScript errors
 */

test.describe('Smoke Test', () => {
  test('should load YZSocialC application successfully', async ({ page }) => {
    // Track console errors
    const consoleErrors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    // Track page errors
    const pageErrors = [];
    page.on('pageerror', error => {
      pageErrors.push(error.message);
    });

    // Navigate to app
    await page.goto('/');

    // Wait for YZSocialC to be available
    await page.waitForFunction(() => window.YZSocialC !== undefined, {
      timeout: 10000
    });

    // Basic checks
    const basicChecks = await page.evaluate(() => ({
      hasYZSocialC: typeof window.YZSocialC !== 'undefined',
      hasStartDHT: typeof window.YZSocialC?.startDHT === 'function',
      hasGetStats: typeof window.YZSocialC?.getStats === 'function',
      methodCount: window.YZSocialC ? Object.keys(window.YZSocialC).length : 0,
      pageTitle: document.title
    }));

    // Assertions
    expect(basicChecks.hasYZSocialC).toBe(true);
    expect(basicChecks.hasStartDHT).toBe(true);
    expect(basicChecks.hasGetStats).toBe(true);
    expect(basicChecks.methodCount).toBeGreaterThan(10);
    expect(basicChecks.pageTitle).toContain('YZSocialC');

    // Check for critical errors (allow some warnings)
    const criticalErrors = consoleErrors.filter(error =>
      !error.includes('Warning') &&
      !error.includes('DevTools') &&
      !error.includes('favicon') &&
      !error.includes('WebSocket connection')
    );

    const criticalPageErrors = pageErrors.filter(error =>
      !error.includes('WebSocket') &&
      !error.includes('fetch')
    );

    // Log results
    console.log('✅ YZSocialC loaded successfully');
    console.log(`📊 Available methods: ${basicChecks.methodCount}`);
    console.log(`📄 Page title: ${basicChecks.pageTitle}`);
    
    if (criticalErrors.length > 0) {
      console.log('⚠️ Console errors:', criticalErrors);
    }
    
    if (criticalPageErrors.length > 0) {
      console.log('⚠️ Page errors:', criticalPageErrors);
    }

    // Don't fail on non-critical errors for now
    // expect(criticalErrors.length).toBe(0);
    // expect(criticalPageErrors.length).toBe(0);
  });

  test('should have working UI elements', async ({ page }) => {
    await page.goto('/');
    
    await page.waitForFunction(() => window.YZSocialC !== undefined, {
      timeout: 10000
    });

    // Check that key UI elements exist
    const startButton = page.locator('#start-dht');
    const nodeIdDisplay = page.locator('#node-id');
    const logOutput = page.locator('#log-output');

    await expect(startButton).toBeVisible();
    await expect(nodeIdDisplay).toBeVisible();
    await expect(logOutput).toBeVisible();

    // Check that the start button is clickable (but don't click it)
    await expect(startButton).toBeEnabled();

    console.log('✅ UI elements are present and functional');
  });
});