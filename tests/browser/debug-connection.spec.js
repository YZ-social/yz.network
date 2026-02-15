import { test, expect } from '@playwright/test';

/**
 * Debug test to trace browser connection issues
 */
test.describe('Debug Browser Connection', () => {
  
  test('trace browser DHT startup', async ({ page }) => {
    // Set up console logging
    page.on('console', msg => {
      console.log(`[Browser Console] ${msg.type()}: ${msg.text()}`);
    });
    
    page.on('pageerror', error => {
      console.log(`[Browser Error] ${error.message}`);
      console.log(`[Browser Stack] ${error.stack}`);
    });

    await page.goto('https://imeyouwe.com');
    
    // Wait for YZSocialC to load
    await page.waitForFunction(() => window.YZSocialC !== undefined, {
      timeout: 10000
    });
    
    console.log('YZSocialC loaded, starting DHT...');
    
    // Start DHT with error handling
    const result = await page.evaluate(async () => {
      try {
        console.log('Starting DHT...');
        await window.YZSocialC.startDHT();
        console.log('DHT started successfully');
        return { success: true };
      } catch (error) {
        console.error('DHT start error:', error.message);
        console.error('Stack:', error.stack);
        return { success: false, error: error.message, stack: error.stack };
      }
    });
    
    console.log('DHT start result:', result);
    
    if (!result.success) {
      console.log('DHT failed to start:', result.error);
      console.log('Stack:', result.stack);
    }
    
    // Wait a bit to see what happens
    await page.waitForTimeout(5000);
    
    // Check connection status
    const status = await page.evaluate(() => {
      const dht = window.YZSocialC?.dht;
      if (!dht) return { hasDHT: false };
      
      // Explicitly call isConnected and log what happens
      console.log('=== EXPLICIT isConnected() CALL ===');
      console.log('dht.isConnected type:', typeof dht.isConnected);
      console.log('dht.isStarted:', dht.isStarted);
      
      let isConnectedResult = false;
      if (typeof dht.isConnected === 'function') {
        console.log('Calling dht.isConnected()...');
        isConnectedResult = dht.isConnected();
        console.log('dht.isConnected() returned:', isConnectedResult);
      } else {
        console.log('WARNING: dht.isConnected is not a function!');
        console.log('dht.isConnected value:', dht.isConnected);
      }
      
      const connectedPeers = dht.getConnectedPeers?.() || [];
      console.log('getConnectedPeers() returned:', connectedPeers.length, 'peers');
      console.log('Peer IDs:', connectedPeers.map(p => p.substring(0, 8)).join(', '));
      
      return {
        hasDHT: true,
        isStarted: dht.isStarted,
        isConnected: isConnectedResult,
        isConnectedType: typeof dht.isConnected,
        connectedPeers: connectedPeers.length,
        connectedPeerIds: connectedPeers.map(p => p.substring(0, 8)),
        routingTableSize: dht.routingTable?.getAllNodes?.()?.length || 0
      };
    });
    
    console.log('DHT Status:', status);
    
    // Wait longer to see if connection establishes
    await page.waitForTimeout(10000);
    
    const finalStatus = await page.evaluate(() => {
      const dht = window.YZSocialC?.dht;
      if (!dht) return { hasDHT: false };
      
      console.log('=== FINAL isConnected() CALL ===');
      let isConnectedResult = false;
      if (typeof dht.isConnected === 'function') {
        isConnectedResult = dht.isConnected();
        console.log('Final dht.isConnected() returned:', isConnectedResult);
      }
      
      const connectedPeers = dht.getConnectedPeers?.() || [];
      
      return {
        hasDHT: true,
        isStarted: dht.isStarted,
        isConnected: isConnectedResult,
        connectedPeers: connectedPeers.length,
        connectedPeerIds: connectedPeers.map(p => p.substring(0, 8)),
        routingTableSize: dht.routingTable?.getAllNodes?.()?.length || 0
      };
    });
    
    console.log('Final DHT Status:', finalStatus);
  });
});
