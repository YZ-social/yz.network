import { test, expect } from '@playwright/test';

/**
 * Basic Functionality Tests (No DHT Network Required)
 *
 * Tests basic functionality that doesn't require a running DHT network
 */

test.describe('Basic Functionality', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');

    // Wait for YZSocialC to initialize
    await page.waitForFunction(() => window.YZSocialC !== undefined, {
      timeout: 10000
    });

    console.log('✅ YZSocialC loaded');
  });

  test('should have proper initialization', async ({ page }) => {
    // Check that YZSocialC is properly initialized
    const initStatus = await page.evaluate(() => ({
      hasYZSocialC: typeof window.YZSocialC !== 'undefined',
      hasApp: typeof window.YZSocialC?.app !== 'undefined',
      hasDHT: typeof window.YZSocialC?.dht !== 'undefined',
      hasVisualizer: typeof window.YZSocialC?.visualizer !== 'undefined',
      nodeId: window.YZSocialC?.dht?.nodeID?.toString?.() || null
    }));

    expect(initStatus.hasYZSocialC).toBe(true);
    expect(initStatus.hasApp).toBe(true);
    expect(initStatus.hasDHT).toBe(true);
    expect(initStatus.hasVisualizer).toBe(true);
    expect(initStatus.nodeId).toBeTruthy();

    console.log(`✅ Node ID: ${initStatus.nodeId?.substring(0, 8)}...`);
  });

  test('should have working utility methods', async ({ page }) => {
    // Test methods that don't require network connection
    const utilityTests = await page.evaluate(async () => {
      const results = {};

      // Test getStats (should work without connection)
      try {
        const stats = window.YZSocialC.getStats();
        results.getStats = {
          success: true,
          hasConnections: typeof stats.connections === 'object',
          hasRoutingTable: typeof stats.routingTable === 'object'
        };
      } catch (error) {
        results.getStats = { success: false, error: error.message };
      }

      // Test getPeers (should work without connection)
      try {
        const peers = window.YZSocialC.getPeers();
        results.getPeers = {
          success: true,
          isArray: Array.isArray(peers),
          count: peers.length
        };
      } catch (error) {
        results.getPeers = { success: false, error: error.message };
      }

      // Test getNodes (should work without connection)
      try {
        const nodes = window.YZSocialC.getNodes();
        results.getNodes = {
          success: true,
          isArray: Array.isArray(nodes),
          count: nodes.length
        };
      } catch (error) {
        results.getNodes = { success: false, error: error.message };
      }

      return results;
    });

    // All utility methods should work
    expect(utilityTests.getStats.success).toBe(true);
    expect(utilityTests.getPeers.success).toBe(true);
    expect(utilityTests.getNodes.success).toBe(true);

    console.log('✅ Utility methods working:', {
      peers: utilityTests.getPeers.count,
      nodes: utilityTests.getNodes.count
    });
  });

  test('should handle UI interactions', async ({ page }) => {
    // Test that UI elements are present and interactive
    const uiElements = await page.evaluate(() => ({
      hasStartButton: !!document.getElementById('start-dht'),
      hasStoreInputs: !!document.getElementById('store-key') && !!document.getElementById('store-value'),
      hasGetInput: !!document.getElementById('get-key'),
      hasInviteInput: !!document.getElementById('invite-node-id'),
      hasLogOutput: !!document.getElementById('log-output'),
      hasNodeIdDisplay: !!document.getElementById('node-id')
    }));

    expect(uiElements.hasStartButton).toBe(true);
    expect(uiElements.hasStoreInputs).toBe(true);
    expect(uiElements.hasGetInput).toBe(true);
    expect(uiElements.hasInviteInput).toBe(true);
    expect(uiElements.hasLogOutput).toBe(true);
    expect(uiElements.hasNodeIdDisplay).toBe(true);

    // Test that we can interact with inputs
    await page.fill('#store-key', 'test-key');
    await page.fill('#store-value', 'test-value');
    await page.fill('#get-key', 'test-key');

    const inputValues = await page.evaluate(() => ({
      storeKey: document.getElementById('store-key').value,
      storeValue: document.getElementById('store-value').value,
      getKey: document.getElementById('get-key').value
    }));

    expect(inputValues.storeKey).toBe('test-key');
    expect(inputValues.storeValue).toBe('test-value');
    expect(inputValues.getKey).toBe('test-key');

    console.log('✅ UI interactions working');
  });

  test('should display node information', async ({ page }) => {
    // Check that node information is displayed
    const nodeInfo = await page.evaluate(() => ({
      nodeIdText: document.getElementById('node-id')?.textContent || '',
      statusText: document.getElementById('dht-status')?.textContent || '',
      peerCountText: document.getElementById('peer-count')?.textContent || ''
    }));

    expect(nodeInfo.nodeIdText).toBeTruthy();
    expect(nodeInfo.statusText).toBeTruthy();
    expect(nodeInfo.peerCountText).toBeTruthy();

    console.log('✅ Node info displayed:', {
      nodeId: nodeInfo.nodeIdText.substring(0, 16) + '...',
      status: nodeInfo.statusText,
      peers: nodeInfo.peerCountText
    });
  });

  test('should have working test suite', async ({ page }) => {
    // Test that the organized test suite is available
    const testSuite = await page.evaluate(() => ({
      hasTests: typeof window.YZSocialC?.tests === 'object',
      hasRunAllTests: typeof window.YZSocialC?.runAllTests === 'function',
      testCategories: window.YZSocialC?.tests ? Object.keys(window.YZSocialC.tests) : []
    }));

    expect(testSuite.hasTests).toBe(true);
    expect(testSuite.hasRunAllTests).toBe(true);
    expect(testSuite.testCategories.length).toBeGreaterThan(0);

    console.log('✅ Test suite available:', testSuite.testCategories);
  });

  test('should handle identity information', async ({ page }) => {
    // Test identity-related functionality
    const identityInfo = await page.evaluate(() => {
      try {
        return {
          hasIdentityStore: typeof window.YZSocialC?.dht?.identityStore === 'object',
          hasKeyPair: typeof window.YZSocialC?.dht?.keyPair === 'object',
          nodeId: window.YZSocialC?.dht?.nodeID?.toString?.(),
          tabIdentityMode: window.YZSocialC?.dht?.identityStore?.useTabIdentity
        };
      } catch (error) {
        return { error: error.message };
      }
    });

    expect(identityInfo.error).toBeUndefined();
    expect(identityInfo.hasIdentityStore).toBe(true);
    expect(identityInfo.hasKeyPair).toBe(true);
    expect(identityInfo.nodeId).toBeTruthy();

    console.log('✅ Identity system working:', {
      nodeId: identityInfo.nodeId?.substring(0, 8) + '...',
      tabIdentity: identityInfo.tabIdentityMode
    });
  });
});