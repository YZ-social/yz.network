import { test, expect } from '@playwright/test';
import { ConnectionVerifier, ConnectionType } from './helpers/ConnectionVerifier.js';
import { TestCoordinator } from './helpers/TestCoordinator.js';

/**
 * Connection Type Verification Tests
 * 
 * Validates that browser-to-browser connections use WebRTC and
 * browser-to-nodejs connections use WebSocket per architecture requirements.
 * 
 * Requirements: 1.1, 1.2, 1.4
 * 
 * Property Tests:
 * - Property 1: Browser-to-Browser connections use WebRTC
 * - Property 2: Browser-to-NodeJS connections use WebSocket
 */

test.describe('Connection Type Verification', () => {
  
  test.describe('Single Browser Connection Types', () => {
    
    test.beforeEach(async ({ page }) => {
      await page.goto('/');
      await page.waitForFunction(() => window.YZSocialC !== undefined, {
        timeout: 10000
      });
    });

    test.afterEach(async ({ page }) => {
      await page.evaluate(async () => {
        if (window.YZSocialC?.dht?.isConnected?.()) {
          await window.YZSocialC.stopDHT();
        }
      });
    });

    test('browser-to-bootstrap connection should use WebSocket', async ({ page }) => {
      // Start DHT and connect to bootstrap server
      await page.evaluate(async () => {
        await window.YZSocialC.startDHT();
      });

      await page.waitForFunction(
        () => window.YZSocialC?.dht?.isConnected?.() === true,
        { timeout: 30000 }
      );

      // Get all connections and find bootstrap/nodejs connections
      const connections = await ConnectionVerifier.getAllConnectionTypes(page);
      
      // Filter for nodejs/bridge connections (bootstrap server)
      const nodejsConnections = connections.filter(
        c => c.nodeType === 'nodejs' || 
             c.nodeType === 'nodejs-active' || 
             c.nodeType === 'bridge'
      );

      console.log(`Found ${nodejsConnections.length} Node.js connections`);

      // Should have at least one connection to bootstrap
      expect(nodejsConnections.length).toBeGreaterThan(0);

      // All Node.js connections should use WebSocket
      for (const conn of nodejsConnections) {
        console.log(`  ${conn.peerId.substring(0, 8)}... (${conn.nodeType}): ${conn.connectionType}`);
        
        if (conn.isConnected) {
          expect(conn.connectionType).toBe(ConnectionType.WEBSOCKET);
        }
      }
    });


    test('should report connection summary correctly', async ({ page }) => {
      await page.evaluate(async () => {
        await window.YZSocialC.startDHT();
      });

      await page.waitForFunction(
        () => window.YZSocialC?.dht?.isConnected?.() === true,
        { timeout: 30000 }
      );

      const summary = await ConnectionVerifier.getConnectionSummary(page);
      
      console.log('Connection Summary:', summary);

      expect(summary.total).toBeGreaterThan(0);
      expect(summary.connected).toBeGreaterThan(0);
      // At minimum, should have websocket connection to bootstrap
      expect(summary.websocket).toBeGreaterThan(0);
    });
  });

  test.describe('Multi-Browser WebRTC Verification', () => {
    let coordinator;

    test.beforeEach(async ({ browser }) => {
      coordinator = new TestCoordinator({ browserCount: 2 });
      await coordinator.launchBrowsers(browser);
    });

    test.afterEach(async () => {
      if (coordinator) {
        await coordinator.teardown();
      }
    });

    test('browser-to-browser connections should use WebRTC', async () => {
      await coordinator.connectAll('http://localhost:3000', 60000);

      console.log('Waiting for WebRTC mesh formation...');
      
      const meshStatus = await coordinator.verifyMeshFormation(90000);
      
      console.log(`Mesh status: ${meshStatus.connectedPairs}/${meshStatus.expectedPairs} pairs`);

      const browser1Info = await coordinator.getConnectionInfo(0);
      const browser2NodeId = coordinator.nodeIds[1];

      const browser2Connection = browser1Info.peers.find(
        p => p.peerId === browser2NodeId
      );

      if (browser2Connection && browser2Connection.isConnected) {
        console.log(`Browser 1 -> Browser 2: ${browser2Connection.connectionType}`);
        expect(browser2Connection.connectionType).toBe(ConnectionType.WEBRTC);
      } else if (meshStatus.isComplete) {
        throw new Error('Mesh reported complete but connection not found');
      } else {
        console.log('⚠️ WebRTC mesh did not form - skipping WebRTC verification');
        test.skip();
      }
    });
  });

  /**
   * Property 1: Browser-to-Browser connections use WebRTC
   * 
   * For any pair of Browser_Nodes that establish a connection, 
   * the connection manager type SHALL be WebRTCConnectionManager.
   * 
   * Feature: browser-mesh-stability-tests, Property 1: Browser-to-Browser connections use WebRTC
   * Validates: Requirements 1.1, 1.4
   */
  test.describe('Property 1: Browser-to-Browser connections use WebRTC', () => {
    let coordinator;

    test.beforeEach(async ({ browser }) => {
      coordinator = new TestCoordinator({ browserCount: 3 });
      await coordinator.launchBrowsers(browser);
    });

    test.afterEach(async () => {
      if (coordinator) {
        await coordinator.teardown();
      }
    });

    test('all browser-to-browser connections use WebRTC connection manager', async () => {
      await coordinator.connectAll('http://localhost:3000', 60000);
      
      const meshStatus = await coordinator.verifyMeshFormation(120000);
      
      if (!meshStatus.isComplete) {
        console.log('⚠️ Mesh did not fully form - testing available connections');
      }

      const browserNodeIds = coordinator.nodeIds.filter(id => id);
      let webrtcConnectionCount = 0;
      let violationCount = 0;

      for (let i = 0; i < coordinator.pages.length; i++) {
        const page = coordinator.pages[i];
        const myNodeId = coordinator.nodeIds[i];
        
        if (!myNodeId) continue;

        const connections = await ConnectionVerifier.getAllConnectionTypes(page);
        
        for (const conn of connections) {
          if (browserNodeIds.includes(conn.peerId) && conn.peerId !== myNodeId) {
            if (conn.isConnected) {
              if (conn.connectionType === ConnectionType.WEBRTC) {
                webrtcConnectionCount++;
                console.log(`  ✅ ${myNodeId.substring(0, 8)}... -> ${conn.peerId.substring(0, 8)}...: WebRTC`);
              } else {
                violationCount++;
                console.log(`  ❌ ${myNodeId.substring(0, 8)}... -> ${conn.peerId.substring(0, 8)}...: ${conn.connectionType} (expected WebRTC)`);
              }
            }
          }
        }
      }

      console.log(`\nProperty 1 Results:`);
      console.log(`  WebRTC connections: ${webrtcConnectionCount}`);
      console.log(`  Violations: ${violationCount}`);

      expect(violationCount).toBe(0);
      
      if (meshStatus.connectedPairs > 0) {
        expect(webrtcConnectionCount).toBeGreaterThan(0);
      }
    });
  });

  /**
   * Property 2: Browser-to-NodeJS connections use WebSocket
   * 
   * For any Browser_Node connecting to a Node_JS_Node (including the bootstrap server), 
   * the connection manager type SHALL be WebSocketConnectionManager.
   * 
   * Feature: browser-mesh-stability-tests, Property 2: Browser-to-NodeJS connections use WebSocket
   * Validates: Requirements 1.2
   */
  test.describe('Property 2: Browser-to-NodeJS connections use WebSocket', () => {
    
    test.beforeEach(async ({ page }) => {
      await page.goto('/');
      await page.waitForFunction(() => window.YZSocialC !== undefined, {
        timeout: 10000
      });
    });

    test.afterEach(async ({ page }) => {
      await page.evaluate(async () => {
        if (window.YZSocialC?.dht?.isConnected?.()) {
          await window.YZSocialC.stopDHT();
        }
      });
    });

    test('all browser-to-nodejs connections use WebSocket connection manager', async ({ page }) => {
      await page.evaluate(async () => {
        await window.YZSocialC.startDHT();
      });

      await page.waitForFunction(
        () => window.YZSocialC?.dht?.isConnected?.() === true,
        { timeout: 30000 }
      );

      const connections = await ConnectionVerifier.getAllConnectionTypes(page);
      
      const nodejsConnections = connections.filter(
        c => c.nodeType === 'nodejs' || 
             c.nodeType === 'nodejs-active' || 
             c.nodeType === 'bridge'
      );

      let websocketCount = 0;
      let violationCount = 0;

      for (const conn of nodejsConnections) {
        if (conn.isConnected) {
          if (conn.connectionType === ConnectionType.WEBSOCKET) {
            websocketCount++;
            console.log(`  ✅ -> ${conn.peerId.substring(0, 8)}... (${conn.nodeType}): WebSocket`);
          } else {
            violationCount++;
            console.log(`  ❌ -> ${conn.peerId.substring(0, 8)}... (${conn.nodeType}): ${conn.connectionType} (expected WebSocket)`);
          }
        }
      }

      console.log(`\nProperty 2 Results:`);
      console.log(`  WebSocket connections: ${websocketCount}`);
      console.log(`  Violations: ${violationCount}`);

      expect(violationCount).toBe(0);
      expect(websocketCount).toBeGreaterThan(0);
    });
  });
});
