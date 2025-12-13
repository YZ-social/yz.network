import { test, expect } from '@playwright/test';

/**
 * Basic DHT Functionality Tests
 *
 * Tests core DHT operations in the browser:
 * 1. DHT initialization and connection
 * 2. Basic store/get operations
 * 3. Network connectivity
 */

test.describe('Basic DHT Functionality', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to app
    await page.goto('/');

    // Wait for YZSocialC to initialize
    await page.waitForFunction(() => window.YZSocialC !== undefined, {
      timeout: 10000
    });

    console.log('✅ YZSocialC loaded');
  });

  test.afterEach(async ({ page }) => {
    // Clean up - stop DHT if running
    await page.evaluate(async () => {
      if (window.YZSocialC?.dht?.isConnected?.()) {
        await window.YZSocialC.stopDHT();
      }
    });
  });

  test('should initialize and connect to DHT network', async ({ page }) => {
    // Start DHT
    await page.evaluate(async () => {
      await window.YZSocialC.startDHT();
    });

    // Wait for DHT connection
    await page.waitForFunction(() =>
      window.YZSocialC?.dht?.isConnected?.() === true,
      { timeout: 30000 }
    );

    // Verify connection
    const isConnected = await page.evaluate(() =>
      window.YZSocialC.dht.isConnected()
    );

    expect(isConnected).toBe(true);

    // Get node ID
    const nodeId = await page.evaluate(() =>
      window.YZSocialC.getNodeId()
    );

    expect(nodeId).toBeTruthy();
    expect(typeof nodeId).toBe('string');
    expect(nodeId.length).toBeGreaterThan(0);

    console.log(`✅ DHT connected with Node ID: ${nodeId.substring(0, 8)}...`);
  });

  test('should perform basic store and get operations', async ({ page }) => {
    // Start DHT
    await page.evaluate(async () => {
      await window.YZSocialC.startDHT();
    });

    // Wait for connection
    await page.waitForFunction(() =>
      window.YZSocialC?.dht?.isConnected?.() === true,
      { timeout: 30000 }
    );

    // Store a value
    const testKey = `test-key-${Date.now()}`;
    const testValue = `test-value-${Math.random()}`;

    console.log(`📝 Storing: ${testKey} = ${testValue}`);

    const storeResult = await page.evaluate(async ({ key, value }) => {
      try {
        await window.YZSocialC.testStore(key, value);
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }, { key: testKey, value: testValue });

    expect(storeResult.success).toBe(true);

    // Wait a moment for storage to propagate
    await page.waitForTimeout(2000);

    // Retrieve the value
    console.log(`📖 Retrieving: ${testKey}`);

    const getResult = await page.evaluate(async (key) => {
      try {
        const value = await window.YZSocialC.testGet(key);
        return { success: true, value };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }, testKey);

    expect(getResult.success).toBe(true);
    expect(getResult.value).toBe(testValue);

    console.log(`✅ Retrieved: ${testKey} = ${getResult.value}`);
  });

  test('should show network statistics', async ({ page }) => {
    // Start DHT
    await page.evaluate(async () => {
      await window.YZSocialC.startDHT();
    });

    // Wait for connection
    await page.waitForFunction(() =>
      window.YZSocialC?.dht?.isConnected?.() === true,
      { timeout: 30000 }
    );

    // Get network stats
    const stats = await page.evaluate(() =>
      window.YZSocialC.getStats()
    );

    expect(stats).toBeTruthy();
    expect(typeof stats).toBe('object');

    // Check for expected stats properties
    expect(stats).toHaveProperty('connections');
    expect(stats).toHaveProperty('routingTable');

    console.log('📊 Network Stats:', {
      connections: stats.connections?.total || 0,
      routingTableSize: stats.routingTable?.size || 0
    });

    // Should have meaningful connection stats (not just undefined/null)
    expect(stats.connections).toBeTruthy();
    expect(typeof stats.connections.total).toBe('number');
  });

  test('should handle multiple DHT operations', async ({ page }) => {
    // Start DHT
    await page.evaluate(async () => {
      await window.YZSocialC.startDHT();
    });

    // Wait for connection
    await page.waitForFunction(() =>
      window.YZSocialC?.dht?.isConnected?.() === true,
      { timeout: 30000 }
    );

    // Perform multiple store operations
    const operations = [];
    for (let i = 0; i < 5; i++) {
      const key = `multi-test-${i}-${Date.now()}`;
      const value = `value-${i}-${Math.random()}`;
      operations.push({ key, value });
    }

    console.log(`📝 Storing ${operations.length} key-value pairs...`);

    // Store all values
    const storeResults = await page.evaluate(async (ops) => {
      const results = [];
      for (const op of ops) {
        try {
          await window.YZSocialC.testStore(op.key, op.value);
          results.push({ success: true, key: op.key });
        } catch (error) {
          results.push({ success: false, key: op.key, error: error.message });
        }
      }
      return results;
    }, operations);

    // All stores should succeed
    storeResults.forEach(result => {
      expect(result.success).toBe(true);
    });

    // Wait for propagation
    await page.waitForTimeout(3000);

    // Retrieve all values
    console.log(`📖 Retrieving ${operations.length} values...`);

    const getResults = await page.evaluate(async (ops) => {
      const results = [];
      for (const op of ops) {
        try {
          const value = await window.YZSocialC.testGet(op.key);
          results.push({ success: true, key: op.key, value, expected: op.value });
        } catch (error) {
          results.push({ success: false, key: op.key, error: error.message });
        }
      }
      return results;
    }, operations);

    // All gets should succeed and return correct values
    getResults.forEach(result => {
      expect(result.success).toBe(true);
      expect(result.value).toBe(result.expected);
    });

    console.log(`✅ All ${operations.length} operations completed successfully`);
  });

  test('should handle DHT restart', async ({ page }) => {
    // Start DHT
    await page.evaluate(async () => {
      await window.YZSocialC.startDHT();
    });

    // Wait for connection
    await page.waitForFunction(() =>
      window.YZSocialC?.dht?.isConnected?.() === true,
      { timeout: 30000 }
    );

    const firstNodeId = await page.evaluate(() =>
      window.YZSocialC.getNodeId()
    );

    console.log(`✅ First connection: ${firstNodeId.substring(0, 8)}...`);

    // Stop DHT
    await page.evaluate(async () => {
      await window.YZSocialC.stopDHT();
    });

    // Verify disconnected
    const isDisconnected = await page.evaluate(() =>
      !window.YZSocialC.dht?.isConnected?.()
    );

    expect(isDisconnected).toBe(true);

    console.log('🛑 DHT stopped');

    // Restart DHT
    await page.evaluate(async () => {
      await window.YZSocialC.startDHT();
    });

    // Wait for reconnection
    await page.waitForFunction(() =>
      window.YZSocialC?.dht?.isConnected?.() === true,
      { timeout: 30000 }
    );

    const secondNodeId = await page.evaluate(() =>
      window.YZSocialC.getNodeId()
    );

    console.log(`✅ Reconnected: ${secondNodeId.substring(0, 8)}...`);

    // Node ID should be the same (persistent identity)
    expect(secondNodeId).toBe(firstNodeId);
  });
});