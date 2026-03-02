import { test, expect } from '@playwright/test';

/**
 * WebRTC Two-Browser Connection Test
 * 
 * This test verifies that two browsers can discover each other and form
 * a WebRTC connection. It uses a sequential approach:
 * 1. Connect Browser A, wait for it to stabilize
 * 2. Connect Browser B
 * 3. Wait for them to discover each other via DHT
 * 4. Verify WebRTC connection forms
 */

const BASE_URL = 'https://imeyouwe.com';
const STABILIZATION_TIME = 30000; // 30s for browser to stabilize in network
const DISCOVERY_TIME = 60000; // 60s for browsers to discover each other
const WEBRTC_FORMATION_TIME = 30000; // 30s for WebRTC to form after discovery

test.describe('WebRTC Two-Browser Connection', () => {
  
  test('two browsers should form WebRTC connection', async ({ browser }) => {
    // Create two browser contexts
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    
    let browserANodeId = null;
    let browserBNodeId = null;
    
    try {
      // Step 1: Connect Browser A
      console.log('🚀 Step 1: Connecting Browser A...');
      await pageA.goto(BASE_URL);
      await pageA.waitForFunction(() => window.YZSocialC !== undefined, { timeout: 10000 });
      
      // Start DHT on Browser A
      const startedA = await pageA.evaluate(async () => {
        await window.YZSocialC.startDHT();
        return window.YZSocialC.dht?.isStarted;
      });
      expect(startedA).toBe(true);
      
      browserANodeId = await pageA.evaluate(() => window.YZSocialC.dht?.localNodeId?.toString());
      console.log(`✅ Browser A connected: ${browserANodeId?.substring(0, 8)}...`);
      
      // Wait for Browser A to stabilize in the network
      console.log(`⏳ Waiting ${STABILIZATION_TIME/1000}s for Browser A to stabilize...`);
      await pageA.waitForTimeout(STABILIZATION_TIME);
      
      // Check Browser A's routing table
      const routingInfoA = await pageA.evaluate(() => ({
        routingTableSize: window.YZSocialC.dht?.routingTable?.totalNodes || 0,
        connectedPeers: window.YZSocialC.dht?.getConnectedPeers()?.length || 0
      }));
      console.log(`📊 Browser A: ${routingInfoA.connectedPeers} connected, ${routingInfoA.routingTableSize} in routing table`);
      
      // Step 2: Connect Browser B
      console.log('🚀 Step 2: Connecting Browser B...');
      await pageB.goto(BASE_URL);
      await pageB.waitForFunction(() => window.YZSocialC !== undefined, { timeout: 10000 });
      
      // Start DHT on Browser B
      const startedB = await pageB.evaluate(async () => {
        await window.YZSocialC.startDHT();
        return window.YZSocialC.dht?.isStarted;
      });
      expect(startedB).toBe(true);
      
      browserBNodeId = await pageB.evaluate(() => window.YZSocialC.dht?.localNodeId?.toString());
      console.log(`✅ Browser B connected: ${browserBNodeId?.substring(0, 8)}...`);
      
      // Step 3: Wait for discovery
      console.log(`⏳ Waiting ${DISCOVERY_TIME/1000}s for browsers to discover each other...`);
      
      // Poll for discovery
      const discoveryStart = Date.now();
      let browserAFoundB = false;
      let browserBFoundA = false;
      
      while (Date.now() - discoveryStart < DISCOVERY_TIME) {
        // Check if Browser A has Browser B in routing table
        const aHasB = await pageA.evaluate((bNodeId) => {
          const node = window.YZSocialC.dht?.routingTable?.getNode(bNodeId);
          return !!node;
        }, browserBNodeId);
        
        // Check if Browser B has Browser A in routing table
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
        
        await pageA.waitForTimeout(2000); // Check every 2 seconds
      }
      
      // Log discovery status
      const discoveryStatus = await Promise.all([
        pageA.evaluate(() => ({
          routingTableSize: window.YZSocialC.dht?.routingTable?.totalNodes || 0,
          connectedPeers: window.YZSocialC.dht?.getConnectedPeers()?.length || 0,
          browserPeers: window.YZSocialC.dht?.routingTable?.getAllNodes()
            .filter(n => n.metadata?.nodeType === 'browser').length || 0
        })),
        pageB.evaluate(() => ({
          routingTableSize: window.YZSocialC.dht?.routingTable?.totalNodes || 0,
          connectedPeers: window.YZSocialC.dht?.getConnectedPeers()?.length || 0,
          browserPeers: window.YZSocialC.dht?.routingTable?.getAllNodes()
            .filter(n => n.metadata?.nodeType === 'browser').length || 0
        }))
      ]);
      
      console.log(`📊 Browser A: ${discoveryStatus[0].connectedPeers} connected, ${discoveryStatus[0].routingTableSize} routing, ${discoveryStatus[0].browserPeers} browser peers`);
      console.log(`📊 Browser B: ${discoveryStatus[1].connectedPeers} connected, ${discoveryStatus[1].routingTableSize} routing, ${discoveryStatus[1].browserPeers} browser peers`);
      
      // Step 4: Manually trigger connection attempt from Browser A to Browser B
      console.log(`🔧 Step 4: Manually triggering WebRTC connection from A to B...`);
      
      // First, let's see what Browser A knows about Browser B
      const browserADebug = await pageA.evaluate((bNodeId) => {
        const dht = window.YZSocialC.dht;
        const routingNode = dht?.routingTable?.getNode(bNodeId);
        const connectedPeers = dht?.getConnectedPeers() || [];
        return {
          hasInRouting: !!routingNode,
          metadata: routingNode?.metadata || null,
          nodeType: routingNode?.metadata?.nodeType,
          canAccept: routingNode?.metadata?.canAcceptConnections,
          connectedPeers: connectedPeers,
          isConnected: connectedPeers.includes(bNodeId)
        };
      }, browserBNodeId);
      
      console.log(`📊 Browser A's view of Browser B:`, JSON.stringify(browserADebug, null, 2));
      
      // If Browser A doesn't have Browser B in routing table, do a DHT lookup
      if (!browserADebug.hasInRouting) {
        console.log(`🔍 Browser A doesn't have Browser B - triggering DHT findNode lookup...`);
        const lookupResult = await pageA.evaluate(async (bNodeId) => {
          try {
            // Trigger a findNode to discover Browser B
            const nodes = await window.YZSocialC.dht.findNode(bNodeId);
            const foundB = nodes.some(n => n.id?.toString() === bNodeId || n === bNodeId);
            const routingNode = window.YZSocialC.dht?.routingTable?.getNode(bNodeId);
            return { 
              success: true, 
              nodesFound: nodes.length,
              foundB: foundB,
              nowInRouting: !!routingNode,
              error: null 
            };
          } catch (err) {
            return { success: false, error: err.message };
          }
        }, browserBNodeId);
        console.log(`📊 DHT lookup result: ${JSON.stringify(lookupResult)}`);
        
        // Wait a bit for routing table to update
        await pageA.waitForTimeout(2000);
        
        // Check again
        const browserADebug2 = await pageA.evaluate((bNodeId) => {
          const dht = window.YZSocialC.dht;
          const routingNode = dht?.routingTable?.getNode(bNodeId);
          return {
            hasInRouting: !!routingNode,
            metadata: routingNode?.metadata || null
          };
        }, browserBNodeId);
        console.log(`📊 Browser A's view of Browser B after lookup:`, JSON.stringify(browserADebug2, null, 2));
      }
      
      // Manually trigger connection from A to B
      const browserAHasB = await pageA.evaluate((bNodeId) => {
        return !!window.YZSocialC.dht?.routingTable?.getNode(bNodeId);
      }, browserBNodeId);
      
      if (browserAHasB) {
        console.log(`🚀 Triggering connectToPeer from Browser A to Browser B...`);
        const connectResult = await pageA.evaluate(async (bNodeId) => {
          try {
            const result = await window.YZSocialC.dht.connectToPeer(bNodeId);
            return { success: result, error: null };
          } catch (err) {
            return { success: false, error: err.message };
          }
        }, browserBNodeId);
        console.log(`📊 Connect result: ${JSON.stringify(connectResult)}`);
      } else {
        console.log(`❌ Browser A still doesn't have Browser B in routing table - cannot connect`);
      }
      
      // Wait for WebRTC connection to form
      console.log(`⏳ Waiting ${WEBRTC_FORMATION_TIME/1000}s for WebRTC connection...`);
      const webrtcStart = Date.now();
      let webrtcConnected = false;
      
      while (Date.now() - webrtcStart < WEBRTC_FORMATION_TIME) {
        // Check if Browser A is connected to Browser B via WebRTC
        const aConnectedToB = await pageA.evaluate((bNodeId) => {
          const connectedPeers = window.YZSocialC.dht?.getConnectedPeers() || [];
          return connectedPeers.includes(bNodeId);
        }, browserBNodeId);
        
        // Check if Browser B is connected to Browser A via WebRTC
        const bConnectedToA = await pageB.evaluate((aNodeId) => {
          const connectedPeers = window.YZSocialC.dht?.getConnectedPeers() || [];
          return connectedPeers.includes(aNodeId);
        }, browserANodeId);
        
        if (aConnectedToB || bConnectedToA) {
          console.log(`✅ WebRTC connection formed after ${(Date.now() - webrtcStart)/1000}s`);
          console.log(`   A→B: ${aConnectedToB}, B→A: ${bConnectedToA}`);
          webrtcConnected = true;
          break;
        }
        
        // Log progress every 5 seconds
        if ((Date.now() - webrtcStart) % 5000 < 2000) {
          const debugA = await pageA.evaluate((bNodeId) => {
            const dht = window.YZSocialC.dht;
            const peerNode = dht?.peerNodes?.get(bNodeId);
            const routingNode = dht?.routingTable?.getNode(bNodeId);
            return {
              hasPeerNode: !!peerNode,
              hasRoutingNode: !!routingNode,
              hasConnectionManager: !!peerNode?.connectionManager || !!routingNode?.connectionManager,
              connectionManagerType: peerNode?.connectionManager?.constructor?.name || routingNode?.connectionManager?.constructor?.name,
              connectionState: peerNode?.connectionManager?.connectionState || routingNode?.connectionManager?.connectionState
            };
          }, browserBNodeId);
          console.log(`🔍 Browser A WebRTC state for B: ${JSON.stringify(debugA)}`);
        }
        
        await pageA.waitForTimeout(2000);
      }
      
      // Final status
      const finalStatus = await Promise.all([
        pageA.evaluate((bNodeId) => {
          const connectedPeers = window.YZSocialC.dht?.getConnectedPeers() || [];
          const routingNode = window.YZSocialC.dht?.routingTable?.getNode(bNodeId);
          return {
            connectedToBrowser: connectedPeers.includes(bNodeId),
            hasBrowserInRouting: !!routingNode,
            totalConnected: connectedPeers.length
          };
        }, browserBNodeId),
        pageB.evaluate((aNodeId) => {
          const connectedPeers = window.YZSocialC.dht?.getConnectedPeers() || [];
          const routingNode = window.YZSocialC.dht?.routingTable?.getNode(aNodeId);
          return {
            connectedToBrowser: connectedPeers.includes(aNodeId),
            hasBrowserInRouting: !!routingNode,
            totalConnected: connectedPeers.length
          };
        }, browserANodeId)
      ]);
      
      console.log(`📊 Final Status:`);
      console.log(`   Browser A: connected=${finalStatus[0].totalConnected}, hasB=${finalStatus[0].hasBrowserInRouting}, connectedToB=${finalStatus[0].connectedToBrowser}`);
      console.log(`   Browser B: connected=${finalStatus[1].totalConnected}, hasA=${finalStatus[1].hasBrowserInRouting}, connectedToA=${finalStatus[1].connectedToBrowser}`);
      
      // Assert WebRTC connection formed
      expect(webrtcConnected).toBe(true);
      
    } finally {
      // Cleanup
      await pageA.evaluate(() => window.YZSocialC?.stopDHT?.()).catch(() => {});
      await pageB.evaluate(() => window.YZSocialC?.stopDHT?.()).catch(() => {});
      await contextA.close();
      await contextB.close();
    }
  });
});
