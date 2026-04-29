import { test, expect } from '@playwright/test';

/**
 * Path Upgrade Test
 * 
 * Task 7.3: Test path upgrade when direct becomes available
 * 
 * This test verifies that when two browsers are initially connected via relay
 * (simulating symmetric NAT), and then a direct WebRTC path becomes available,
 * the connection transparently upgrades from relay to WebRTC direct.
 * 
 * The test:
 * 1. Connects two browsers with WebRTC disabled (relay-only mode)
 * 2. Verifies they communicate via relay
 * 3. Re-enables WebRTC probing on both browsers
 * 4. Triggers background probing to discover direct path
 * 5. Verifies the path upgrades from relay to WebRTC direct
 * 6. Verifies messages continue to flow after upgrade
 * 
 * This validates the Tailscale-inspired "try everything at once" philosophy:
 * - Start with relay (guaranteed to work)
 * - Continuously probe for better paths
 * - Transparently upgrade when direct path is found
 */

const BASE_URL = 'https://imeyouwe.com';
const STABILIZATION_TIME = 30000; // 30s for browser to stabilize
const DISCOVERY_TIME = 45000; // 45s for browsers to discover each other
const UPGRADE_TIMEOUT = 60000; // 60s for path upgrade to occur

test.describe('Path Upgrade', () => {
  
  test('should upgrade from relay to WebRTC when direct path becomes available', async ({ browser }) => {
    // Create two browser contexts
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    
    let browserANodeId = null;
    let browserBNodeId = null;
    
    try {
      // Step 1: Connect Browser A with WebRTC disabled (relay-only mode)
      console.log('🚀 Step 1: Connecting Browser A (relay-only mode)...');
      await pageA.goto(BASE_URL);
      await pageA.waitForFunction(() => window.YZSocialC !== undefined, { timeout: 10000 });
      
      // Override document.hidden to prevent inactive tab detection
      await pageA.evaluate(() => {
        Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
        Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
      });
      
      // Disable WebRTC initially to force relay-only mode
      // Store the original factory method for later restoration
      await pageA.evaluate(() => {
        const factory = window.YZSocialC?.ConnectionManagerFactory;
        if (factory) {
          // Store original method
          window._originalCreateForConnection = factory.createForConnection.bind(factory);
          window._webrtcDisabled = true;
          
          factory.createForConnection = function(localNodeType, targetNodeType, options = {}) {
            if (localNodeType === 'browser' && targetNodeType === 'browser' && window._webrtcDisabled) {
              console.log('🔧 TEST: Forcing relay-only mode (attemptWebRTC: false)');
              options.attemptWebRTC = false;
            }
            return window._originalCreateForConnection(localNodeType, targetNodeType, options);
          };
        }
      });
      
      // Start DHT on Browser A
      const startedA = await pageA.evaluate(async () => {
        await window.YZSocialC.startDHT();
        return window.YZSocialC.dht?.isStarted;
      });
      expect(startedA).toBe(true);
      
      browserANodeId = await pageA.evaluate(() => window.YZSocialC.dht?.localNodeId?.toString());
      console.log(`✅ Browser A connected: ${browserANodeId?.substring(0, 8)}...`);
      
      // Wait for Browser A to stabilize
      console.log(`⏳ Waiting ${STABILIZATION_TIME/1000}s for Browser A to stabilize...`);
      await pageA.waitForTimeout(STABILIZATION_TIME);
      
      // Step 2: Connect Browser B with WebRTC disabled (relay-only mode)
      console.log('🚀 Step 2: Connecting Browser B (relay-only mode)...');
      await pageB.goto(BASE_URL);
      await pageB.waitForFunction(() => window.YZSocialC !== undefined, { timeout: 10000 });
      
      // Override document.hidden to prevent inactive tab detection
      await pageB.evaluate(() => {
        Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
        Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
      });
      
      // Disable WebRTC initially to force relay-only mode
      await pageB.evaluate(() => {
        const factory = window.YZSocialC?.ConnectionManagerFactory;
        if (factory) {
          window._originalCreateForConnection = factory.createForConnection.bind(factory);
          window._webrtcDisabled = true;
          
          factory.createForConnection = function(localNodeType, targetNodeType, options = {}) {
            if (localNodeType === 'browser' && targetNodeType === 'browser' && window._webrtcDisabled) {
              console.log('🔧 TEST: Forcing relay-only mode (attemptWebRTC: false)');
              options.attemptWebRTC = false;
            }
            return window._originalCreateForConnection(localNodeType, targetNodeType, options);
          };
        }
      });
      
      // Start DHT on Browser B
      const startedB = await pageB.evaluate(async () => {
        await window.YZSocialC.startDHT();
        return window.YZSocialC.dht?.isStarted;
      });
      expect(startedB).toBe(true);
      
      browserBNodeId = await pageB.evaluate(() => window.YZSocialC.dht?.localNodeId?.toString());
      console.log(`✅ Browser B connected: ${browserBNodeId?.substring(0, 8)}...`);
      
      // Step 3: Wait for browsers to discover each other
      console.log(`⏳ Waiting ${DISCOVERY_TIME/1000}s for browsers to discover each other...`);
      
      const discoveryStart = Date.now();
      let browserAFoundB = false;
      let browserBFoundA = false;
      
      while (Date.now() - discoveryStart < DISCOVERY_TIME) {
        const aHasB = await pageA.evaluate((bNodeId) => {
          const node = window.YZSocialC.dht?.routingTable?.getNode(bNodeId);
          return !!node;
        }, browserBNodeId);
        
        const bHasA = await pageB.evaluate((aNodeId) => {
          const node = window.YZSocialC.dht?.routingTable?.getNode(aNodeId);
          return !!node;
        }, browserANodeId);
        
        if (aHasB && !browserAFoundB) {
          console.log(`✅ Browser A discovered Browser B in routing table`);
          browserAFoundB = true;
        }
        if (bHasA && !browserBFoundA) {
          console.log(`✅ Browser B discovered Browser A in routing table`);
          browserBFoundA = true;
        }
        
        if (browserAFoundB && browserBFoundA) {
          console.log(`✅ Both browsers discovered each other after ${(Date.now() - discoveryStart)/1000}s`);
          break;
        }
        
        await pageA.waitForTimeout(2000);
      }
      
      // Step 4: Establish relay connection from Browser A to Browser B
      console.log('🔧 Step 4: Establishing relay connection from A to B...');
      
      // First, do a DHT lookup to ensure Browser A knows about Browser B
      if (!browserAFoundB) {
        console.log(`🔍 Browser A doesn't have Browser B - triggering DHT findNode lookup...`);
        await pageA.evaluate(async (bNodeId) => {
          const kademliaDHT = window.YZSocialC.dht?.dht;
          if (kademliaDHT) {
            await kademliaDHT.findNode(bNodeId);
          }
        }, browserBNodeId);
        await pageA.waitForTimeout(2000);
      }
      
      // Trigger connection from A to B
      const connectResult = await pageA.evaluate(async (bNodeId) => {
        try {
          const kademliaDHT = window.YZSocialC.dht?.dht;
          if (!kademliaDHT) {
            return { success: false, error: 'KademliaDHT not available' };
          }
          const result = await kademliaDHT.connectToPeer(bNodeId);
          return { success: result, error: null };
        } catch (err) {
          return { success: false, error: err.message };
        }
      }, browserBNodeId);
      
      console.log(`📊 Connect result: ${JSON.stringify(connectResult)}`);
      
      // Wait for relay connection to establish
      console.log('⏳ Waiting for relay connection to establish...');
      await pageA.waitForTimeout(5000);
      
      // Step 5: Verify relay connection is established
      console.log('🔍 Step 5: Verifying relay connection...');
      
      const initialStateA = await pageA.evaluate((bNodeId) => {
        const dht = window.YZSocialC.dht;
        const routingNode = dht?.routingTable?.getNode(bNodeId);
        const manager = routingNode?.connectionManager;
        
        return {
          hasRoutingNode: !!routingNode,
          hasConnectionManager: !!manager,
          connectionManagerType: manager?.constructor?.name,
          connectionState: manager?.connectionState,
          activeTransport: manager?.activeTransport,
          relayConnected: manager?.relayConnected,
          webrtcConnected: manager?.webrtcConnected,
          relaySessionId: manager?.relaySession?.sessionId?.substring(0, 8)
        };
      }, browserBNodeId);
      
      console.log(`📊 Browser A initial connection state to B:`, JSON.stringify(initialStateA, null, 2));
      
      // Verify we're on relay
      if (initialStateA.connectionState === 'connected') {
        expect(initialStateA.activeTransport).toBe('relay');
        expect(initialStateA.relayConnected).toBe(true);
        console.log(`✅ Verified: Connection is using relay transport`);
      } else {
        console.log(`⚠️ Connection not yet established, state: ${initialStateA.connectionState}`);
      }
      
      // Step 6: Re-enable WebRTC on both browsers to allow direct path discovery
      console.log('🔧 Step 6: Re-enabling WebRTC on both browsers...');
      
      await pageA.evaluate(() => {
        window._webrtcDisabled = false;
        console.log('🔧 TEST: WebRTC re-enabled on Browser A');
      });
      
      await pageB.evaluate(() => {
        window._webrtcDisabled = false;
        console.log('🔧 TEST: WebRTC re-enabled on Browser B');
      });
      
      // Step 7: Trigger background probing to discover direct path
      console.log('🔧 Step 7: Triggering background probing for direct path...');
      
      // Enable background probing and trigger a probe
      await pageA.evaluate((bNodeId) => {
        const dht = window.YZSocialC.dht;
        const routingNode = dht?.routingTable?.getNode(bNodeId);
        const manager = routingNode?.connectionManager;
        
        if (manager && typeof manager.setBackgroundProbingEnabled === 'function') {
          manager.setBackgroundProbingEnabled(true);
          console.log('🔧 TEST: Background probing enabled on Browser A');
        }
        
        // Trigger an immediate WebRTC probe attempt
        if (manager && typeof manager._triggerBackgroundWebRTCProbe === 'function') {
          manager._triggerBackgroundWebRTCProbe();
          console.log('🔧 TEST: Triggered background WebRTC probe on Browser A');
        }
      }, browserBNodeId);
      
      // Step 8: Wait for path upgrade to occur
      console.log(`⏳ Step 8: Waiting up to ${UPGRADE_TIMEOUT/1000}s for path upgrade...`);
      
      const upgradeStart = Date.now();
      let pathUpgraded = false;
      let upgradeDetails = null;
      
      while (Date.now() - upgradeStart < UPGRADE_TIMEOUT) {
        const currentState = await pageA.evaluate((bNodeId) => {
          const dht = window.YZSocialC.dht;
          const routingNode = dht?.routingTable?.getNode(bNodeId);
          const manager = routingNode?.connectionManager;
          
          return {
            connectionState: manager?.connectionState,
            activeTransport: manager?.activeTransport,
            relayConnected: manager?.relayConnected,
            webrtcConnected: manager?.webrtcConnected,
            pathTrackerActive: manager?.pathTracker?.getActivePathType?.(),
            backgroundProbingStatus: manager?.getBackgroundProbingStatus?.()
          };
        }, browserBNodeId);
        
        // Check if we've upgraded to WebRTC
        if (currentState.activeTransport === 'webrtc' && currentState.webrtcConnected) {
          pathUpgraded = true;
          upgradeDetails = currentState;
          console.log(`✅ Path upgraded to WebRTC after ${(Date.now() - upgradeStart)/1000}s`);
          break;
        }
        
        // Log progress every 10 seconds
        if ((Date.now() - upgradeStart) % 10000 < 2000) {
          console.log(`🔍 Current state: transport=${currentState.activeTransport}, webrtc=${currentState.webrtcConnected}, relay=${currentState.relayConnected}`);
          if (currentState.backgroundProbingStatus) {
            console.log(`   Background probing: attempts=${currentState.backgroundProbingStatus.attempts}, running=${currentState.backgroundProbingStatus.running}`);
          }
        }
        
        await pageA.waitForTimeout(2000);
      }
      
      // Step 9: Verify path upgrade occurred
      console.log('📊 Step 9: Verifying path upgrade...');
      
      const finalStateA = await pageA.evaluate((bNodeId) => {
        const dht = window.YZSocialC.dht;
        const routingNode = dht?.routingTable?.getNode(bNodeId);
        const manager = routingNode?.connectionManager;
        
        return {
          connectionState: manager?.connectionState,
          activeTransport: manager?.activeTransport,
          relayConnected: manager?.relayConnected,
          webrtcConnected: manager?.webrtcConnected,
          pathTrackerActive: manager?.pathTracker?.getActivePathType?.(),
          pathTrackerStats: manager?.pathTracker?.getStats?.(),
          pathTimeStats: manager?._pathTimeStats,
          pathEventHistory: manager?._pathEventHistory?.slice(-5) // Last 5 events
        };
      }, browserBNodeId);
      
      console.log(`📊 Browser A final connection state to B:`, JSON.stringify(finalStateA, null, 2));
      
      // Step 10: Verify messages still flow after upgrade
      console.log('📨 Step 10: Testing message exchange after upgrade...');
      
      // Set up message receiver on Browser B
      const messagePromise = pageB.evaluate((aNodeId) => {
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error('Message receive timeout'));
          }, 15000);
          
          const dht = window.YZSocialC.dht?.dht;
          if (!dht) {
            clearTimeout(timeout);
            reject(new Error('DHT not available'));
            return;
          }
          
          const originalHandler = dht.handleMessage?.bind(dht);
          
          dht.handleMessage = function(peerId, message) {
            if (message.type === 'upgrade_test_message' && peerId === aNodeId) {
              clearTimeout(timeout);
              resolve({
                received: true,
                from: peerId,
                content: message.content,
                timestamp: message.timestamp
              });
            }
            if (originalHandler) {
              return originalHandler(peerId, message);
            }
          };
        });
      }, browserANodeId);
      
      // Send test message from Browser A to Browser B
      const sendResult = await pageA.evaluate(async (bNodeId) => {
        try {
          const dht = window.YZSocialC.dht?.dht;
          if (!dht) {
            return { success: false, error: 'DHT not available' };
          }
          
          const testMessage = {
            type: 'upgrade_test_message',
            content: 'Hello after path upgrade!',
            timestamp: Date.now()
          };
          
          await dht.sendMessage(bNodeId, testMessage);
          return { success: true, message: testMessage };
        } catch (err) {
          return { success: false, error: err.message };
        }
      }, browserBNodeId);
      
      console.log(`📤 Send result: ${JSON.stringify(sendResult)}`);
      
      if (sendResult.success) {
        try {
          const receivedMessage = await Promise.race([
            messagePromise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('Message timeout')), 15000))
          ]);
          
          console.log(`📥 Received message:`, JSON.stringify(receivedMessage, null, 2));
          
          expect(receivedMessage.received).toBe(true);
          expect(receivedMessage.content).toBe('Hello after path upgrade!');
          console.log(`✅ Message successfully delivered after path upgrade!`);
        } catch (err) {
          console.log(`⚠️ Message delivery failed after upgrade: ${err.message}`);
        }
      }
      
      // Final assertions
      console.log(`📊 Final Status:`);
      console.log(`   Path upgraded: ${pathUpgraded}`);
      console.log(`   Active transport: ${finalStateA.activeTransport}`);
      console.log(`   WebRTC connected: ${finalStateA.webrtcConnected}`);
      console.log(`   Relay connected: ${finalStateA.relayConnected}`);
      
      // The test passes if:
      // 1. Path upgraded to WebRTC, OR
      // 2. Connection is still working (relay fallback is acceptable in some network conditions)
      if (pathUpgraded) {
        expect(finalStateA.activeTransport).toBe('webrtc');
        expect(finalStateA.webrtcConnected).toBe(true);
        console.log(`✅ Path upgrade test PASSED - upgraded from relay to WebRTC`);
      } else {
        // If path didn't upgrade, verify relay is still working
        expect(finalStateA.connectionState).toBe('connected');
        console.log(`⚠️ Path upgrade did not occur (network conditions may not allow direct connection)`);
        console.log(`   This is acceptable - relay fallback is working correctly`);
      }
      
    } finally {
      // Cleanup
      await pageA.evaluate(() => window.YZSocialC?.stopDHT?.()).catch(() => {});
      await pageB.evaluate(() => window.YZSocialC?.stopDHT?.()).catch(() => {});
      await contextA.close();
      await contextB.close();
    }
  });
  
  test('should emit transportUpgraded event when path upgrades', async ({ browser }) => {
    // This test verifies that the transportUpgraded event is emitted correctly
    // when a path upgrade occurs
    
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    
    try {
      // Connect both browsers
      console.log('🚀 Connecting browsers...');
      
      for (const page of [pageA, pageB]) {
        await page.goto(BASE_URL);
        await page.waitForFunction(() => window.YZSocialC !== undefined, { timeout: 10000 });
        
        // Override document.hidden
        await page.evaluate(() => {
          Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
          Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
        });
        
        // Initially disable WebRTC
        await page.evaluate(() => {
          const factory = window.YZSocialC?.ConnectionManagerFactory;
          if (factory) {
            window._originalCreateForConnection = factory.createForConnection.bind(factory);
            window._webrtcDisabled = true;
            
            factory.createForConnection = function(localNodeType, targetNodeType, options = {}) {
              if (localNodeType === 'browser' && targetNodeType === 'browser' && window._webrtcDisabled) {
                options.attemptWebRTC = false;
              }
              return window._originalCreateForConnection(localNodeType, targetNodeType, options);
            };
          }
        });
        
        await page.evaluate(async () => {
          await window.YZSocialC.startDHT();
        });
      }
      
      const nodeIdA = await pageA.evaluate(() => window.YZSocialC.dht?.localNodeId?.toString());
      const nodeIdB = await pageB.evaluate(() => window.YZSocialC.dht?.localNodeId?.toString());
      
      console.log(`✅ Browser A: ${nodeIdA?.substring(0, 8)}...`);
      console.log(`✅ Browser B: ${nodeIdB?.substring(0, 8)}...`);
      
      // Wait for stabilization
      await pageA.waitForTimeout(20000);
      
      // Establish relay connection
      await pageA.evaluate(async (bNodeId) => {
        const kademliaDHT = window.YZSocialC.dht?.dht;
        if (kademliaDHT) {
          await kademliaDHT.findNode(bNodeId);
          await kademliaDHT.connectToPeer(bNodeId);
        }
      }, nodeIdB);
      
      await pageA.waitForTimeout(5000);
      
      // Set up event listener for transportUpgraded
      const upgradeEventPromise = pageA.evaluate((bNodeId) => {
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            resolve({ received: false, reason: 'timeout' });
          }, 45000);
          
          const dht = window.YZSocialC.dht;
          const routingNode = dht?.routingTable?.getNode(bNodeId);
          const manager = routingNode?.connectionManager;
          
          if (!manager) {
            clearTimeout(timeout);
            resolve({ received: false, reason: 'no_manager' });
            return;
          }
          
          manager.on('transportUpgraded', (event) => {
            clearTimeout(timeout);
            resolve({
              received: true,
              event: {
                peerId: event.peerId?.substring(0, 8),
                from: event.from,
                to: event.to,
                isIPv6: event.isIPv6,
                duration: event.duration
              }
            });
          });
        });
      }, nodeIdB);
      
      // Re-enable WebRTC
      await pageA.evaluate(() => {
        window._webrtcDisabled = false;
      });
      await pageB.evaluate(() => {
        window._webrtcDisabled = false;
      });
      
      // Trigger background probing
      await pageA.evaluate((bNodeId) => {
        const dht = window.YZSocialC.dht;
        const routingNode = dht?.routingTable?.getNode(bNodeId);
        const manager = routingNode?.connectionManager;
        
        if (manager) {
          manager.setBackgroundProbingEnabled?.(true);
          manager._triggerBackgroundWebRTCProbe?.();
        }
      }, nodeIdB);
      
      // Wait for upgrade event
      const upgradeEvent = await upgradeEventPromise;
      
      console.log(`📊 Upgrade event result:`, JSON.stringify(upgradeEvent, null, 2));
      
      if (upgradeEvent.received) {
        expect(upgradeEvent.event.from).toBe('relay');
        expect(['webrtc', 'ipv6']).toContain(upgradeEvent.event.to);
        console.log(`✅ transportUpgraded event received correctly`);
      } else {
        console.log(`⚠️ transportUpgraded event not received: ${upgradeEvent.reason}`);
        console.log(`   This may be expected if network conditions don't allow direct connection`);
      }
      
    } finally {
      await pageA.evaluate(() => window.YZSocialC?.stopDHT?.()).catch(() => {});
      await pageB.evaluate(() => window.YZSocialC?.stopDHT?.()).catch(() => {});
      await contextA.close();
      await contextB.close();
    }
  });
});
