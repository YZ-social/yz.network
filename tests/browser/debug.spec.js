import { test, expect } from '@playwright/test';

/**
 * Debug Test - Check what's actually happening
 */

test.describe('Debug', () => {
  test('should debug what is available in the browser', async ({ page }) => {
    // Listen to console messages
    const consoleMessages = [];
    page.on('console', msg => {
      consoleMessages.push(`${msg.type()}: ${msg.text()}`);
    });

    // Listen to page errors
    const pageErrors = [];
    page.on('pageerror', error => {
      pageErrors.push(error.message);
    });

    await page.goto('/');

    // Wait a bit for everything to load
    await page.waitForTimeout(5000);

    // Check what's available in window
    const windowProperties = await page.evaluate(() => {
      return {
        hasYZSocialC: typeof window.YZSocialC !== 'undefined',
        YZSocialCType: typeof window.YZSocialC,
        YZSocialCKeys: window.YZSocialC ? Object.keys(window.YZSocialC) : null,
        windowKeys: Object.keys(window).filter(key => key.includes('YZ') || key.includes('DHT')),
        allScripts: Array.from(document.scripts).map(s => ({ src: s.src, loaded: s.readyState })),
        errors: window.errors || []
      };
    });

    console.log('=== WINDOW PROPERTIES ===');
    console.log(JSON.stringify(windowProperties, null, 2));

    console.log('=== CONSOLE MESSAGES ===');
    consoleMessages.forEach(msg => console.log(msg));

    console.log('=== PAGE ERRORS ===');
    pageErrors.forEach(error => console.log(error));

    // Check if bundle loaded
    const bundleLoaded = await page.evaluate(() => {
      const scripts = document.getElementsByTagName('script');
      for (let script of scripts) {
        if (script.src.includes('bundle')) {
          return {
            src: script.src,
            loaded: script.readyState || 'unknown'
          };
        }
      }
      return null;
    });

    console.log('=== BUNDLE STATUS ===');
    console.log(JSON.stringify(bundleLoaded, null, 2));

    // Try to access the bundle directly
    const bundleResponse = await page.evaluate(async () => {
      try {
        const scripts = document.getElementsByTagName('script');
        for (let script of scripts) {
          if (script.src.includes('bundle')) {
            const response = await fetch(script.src);
            return {
              status: response.status,
              ok: response.ok,
              size: response.headers.get('content-length')
            };
          }
        }
        return null;
      } catch (error) {
        return { error: error.message };
      }
    });

    console.log('=== BUNDLE FETCH ===');
    console.log(JSON.stringify(bundleResponse, null, 2));
  });
});