import { test, expect } from '@playwright/test';

/**
 * Tab Visibility Disconnect/Reconnect Tests
 *
 * Tests the automatic disconnect/reconnect feature that prevents
 * inactive browser tabs from being selected as onboarding helpers
 * or pub/sub initiators.
 *
 * Key behaviors tested:
 * 1. Disconnect after 30s of inactivity
 * 2. Cancel disconnect on quick tab switch (< 30s)
 * 3. Reconnect when tab becomes visible
 * 4. Preserve pub/sub subscriptions across disconnect/reconnect
 * 5. Protect connection during active reconnection
 */

test.describe('Tab Visibility Disconnect/Reconnect', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to app
    await page.goto('/');

    // Wait for YZSocialC to initialize
    await page.waitForFunction(() => window.YZSocialC !== undefined, {
      timeout: 10000
    });

    // Start DHT
    await page.evaluate(async () => {
      await window.YZSocialC.startDHT();
    });

    // Wait for DHT connection
    await page.waitForFunction(() =>
      window.YZSocialC?.dht?.isConnected?.() === true,
      { timeout: 30000 }
    );

    console.log('✅ DHT connected and ready for testing');
  });

  test.afterEach(async ({ page }) => {
    // Clean up - stop DHT
    await page.evaluate(async () => {
      if (window.YZSocialC?.dht) {
        await window.YZSocialC.stopDHT();
      }
    });
  });

  test('should disconnect after 30 seconds of inactivity', async ({ page }) => {
    // Verify initially active and connected
    let state = await page.evaluate(() => ({
      tabState: window.YZSocialC.tabState,
      isConnected: window.YZSocialC.dht?.isConnected?.()
    }));

    expect(state.tabState).toBe('active');
    expect(state.isConnected).toBe(true);

    // Simulate tab becoming hidden
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', {
        value: true,
        writable: true,
        configurable: true
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    console.log('📴 Tab hidden, waiting 31 seconds for disconnect...');

    // Wait for disconnect timer (30s + 1s buffer)
    await page.waitForTimeout(31000);

    // Verify disconnected
    state = await page.evaluate(() => ({
      tabState: window.YZSocialC.tabState,
      isConnected: window.YZSocialC.dht?.isConnected?.()
    }));

    expect(state.tabState).toBe('disconnected');
    expect(state.isConnected).toBe(false);

    console.log('✅ Tab successfully disconnected after 30s');
  });

  test('should cancel disconnect on quick tab switch', async ({ page }) => {
    // Hide tab
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', {
        value: true,
        writable: true,
        configurable: true
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    console.log('📴 Tab hidden, waiting 10 seconds...');

    // Wait 10 seconds (less than 30s disconnect timeout)
    await page.waitForTimeout(10000);

    // Show tab again
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', {
        value: false,
        writable: true,
        configurable: true
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    console.log('📱 Tab visible again after 10s');

    // Wait a bit to ensure no disconnect happens
    await page.waitForTimeout(2000);

    // Verify still connected
    const state = await page.evaluate(() => ({
      tabState: window.YZSocialC.tabState,
      isConnected: window.YZSocialC.dht?.isConnected?.(),
      hasDisconnectTimer: window.YZSocialC.disconnectTimer !== null
    }));

    expect(state.tabState).toBe('active');
    expect(state.isConnected).toBe(true);
    expect(state.hasDisconnectTimer).toBe(false);

    console.log('✅ Quick tab switch did not trigger disconnect');
  });

  test('should reconnect when tab becomes visible after disconnect', async ({ page }) => {
    // Trigger disconnect
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', {
        value: true,
        writable: true,
        configurable: true
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    console.log('📴 Tab hidden, waiting 31 seconds for disconnect...');
    await page.waitForTimeout(31000);

    // Verify disconnected
    let state = await page.evaluate(() => ({
      tabState: window.YZSocialC.tabState,
      isConnected: window.YZSocialC.dht?.isConnected?.()
    }));

    expect(state.tabState).toBe('disconnected');
    expect(state.isConnected).toBe(false);

    console.log('✅ Disconnected, now showing tab to trigger reconnect...');

    // Trigger reconnect
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', {
        value: false,
        writable: true,
        configurable: true
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    console.log('📱 Tab visible, waiting for reconnection...');

    // Wait for reconnection to complete (up to 30 seconds)
    await page.waitForFunction(() =>
      window.YZSocialC?.tabState === 'active' &&
      window.YZSocialC?.dht?.isConnected?.() === true,
      { timeout: 30000 }
    );

    // Verify reconnected
    state = await page.evaluate(() => ({
      tabState: window.YZSocialC.tabState,
      isConnected: window.YZSocialC.dht?.isConnected?.(),
      reconnectInProgress: window.YZSocialC.reconnectInProgress
    }));

    expect(state.tabState).toBe('active');
    expect(state.isConnected).toBe(true);
    expect(state.reconnectInProgress).toBe(false);

    console.log('✅ Tab successfully reconnected');
  });

  test('should preserve pub/sub subscriptions across disconnect/reconnect', async ({ page }) => {
    // Create a test channel (pub/sub subscription)
    console.log('📝 Creating test channel...');

    await page.evaluate(async () => {
      await window.YZSocialC.createChannel('test-channel-visibility');
    });

    // Verify subscription exists
    let subscriptions = await page.evaluate(() =>
      window.YZSocialC.dht?.pubsub?.getSubscriptions?.() || []
    );

    expect(subscriptions.length).toBeGreaterThan(0);
    const initialSubCount = subscriptions.length;

    console.log(`✅ Created ${initialSubCount} subscriptions`);

    // Trigger disconnect
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', {
        value: true,
        writable: true,
        configurable: true
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    console.log('📴 Tab hidden, waiting for disconnect...');
    await page.waitForTimeout(31000);

    // Verify saved subscriptions
    const savedSubCount = await page.evaluate(() =>
      window.YZSocialC.savedSubscriptions?.length || 0
    );

    expect(savedSubCount).toBe(initialSubCount);
    console.log(`💾 Saved ${savedSubCount} subscriptions`);

    // Trigger reconnect
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', {
        value: false,
        writable: true,
        configurable: true
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    console.log('📱 Tab visible, waiting for reconnection...');

    // Wait for reconnection
    await page.waitForFunction(() =>
      window.YZSocialC?.tabState === 'active',
      { timeout: 30000 }
    );

    // Verify subscriptions restored
    subscriptions = await page.evaluate(() =>
      window.YZSocialC.dht?.pubsub?.getSubscriptions?.() || []
    );

    expect(subscriptions.length).toBe(initialSubCount);

    console.log(`✅ Restored ${subscriptions.length} subscriptions`);
  });

  test('should not disconnect during active reconnection', async ({ page }) => {
    // Trigger disconnect
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', {
        value: true,
        writable: true,
        configurable: true
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    console.log('📴 Tab hidden, waiting for disconnect...');
    await page.waitForTimeout(31000);

    // Start reconnection
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', {
        value: false,
        writable: true,
        configurable: true
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    console.log('📱 Tab visible, reconnection starting...');

    // Wait a moment for reconnection to start
    await page.waitForTimeout(1000);

    // Try to hide tab again during reconnection
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', {
        value: true,
        writable: true,
        configurable: true
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    console.log('📴 Tab hidden again during reconnection...');

    // Verify disconnect was NOT scheduled (reconnectInProgress protection)
    const hasDisconnectTimer = await page.evaluate(() =>
      window.YZSocialC.disconnectTimer !== null
    );

    expect(hasDisconnectTimer).toBe(false);

    console.log('✅ Disconnect blocked during reconnection (as expected)');

    // Wait for reconnection to complete
    await page.waitForFunction(() =>
      window.YZSocialC?.reconnectInProgress === false,
      { timeout: 30000 }
    );

    console.log('✅ Reconnection completed successfully');
  });

  test('should handle multiple disconnect/reconnect cycles', async ({ page }) => {
    for (let i = 1; i <= 3; i++) {
      console.log(`\n🔄 Cycle ${i}/3`);

      // Disconnect
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', {
          value: true,
          writable: true,
          configurable: true
        });
        document.dispatchEvent(new Event('visibilitychange'));
      });

      console.log(`📴 Cycle ${i}: Tab hidden, waiting for disconnect...`);
      await page.waitForTimeout(31000);

      // Verify disconnected
      let state = await page.evaluate(() => window.YZSocialC.tabState);
      expect(state).toBe('disconnected');

      // Reconnect
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', {
          value: false,
          writable: true,
          configurable: true
        });
        document.dispatchEvent(new Event('visibilitychange'));
      });

      console.log(`📱 Cycle ${i}: Tab visible, waiting for reconnection...`);

      await page.waitForFunction(() =>
        window.YZSocialC?.tabState === 'active' &&
        window.YZSocialC?.dht?.isConnected?.() === true,
        { timeout: 30000 }
      );

      console.log(`✅ Cycle ${i}: Successfully reconnected`);
    }

    console.log('\n✅ All 3 cycles completed successfully');
  });
});
