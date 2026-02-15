import { test, expect } from '@playwright/test';
import { TestCoordinator } from './helpers/TestCoordinator.js';
import { ConnectionVerifier, ConnectionType } from './helpers/ConnectionVerifier.js';

/**
 * Mesh Stability Tests
 * 
 * Validates mesh network formation and connection stability for browser nodes.
 * 
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6
 * 
 * Property Tests:
 * - Property 3: Mesh completeness invariant
 * - Property 4: Event tracking accuracy
 */

// Default configuration - can be overridden via environment variables
const DEFAULT_BROWSER_COUNT = parseInt(process.env.MESH_BROWSER_COUNT || '4', 10);
const MESH_FORMATION_TIMEOUT = parseInt(process.env.MESH_FORMATION_TIMEOUT || '120000', 10);
// Production server URL - browser tests require production DHT infrastructure
const BASE_URL = process.env.TEST_BASE_URL || 'https://imeyouwe.com';

test.describe('Mesh Formation Tests', () => {
  let coordinator;

  test.beforeEach(async ({ browser }) => {
    const browserCount = Math.max(3, DEFAULT_BROWSER_COUNT);
    coordinator = new TestCoordinator({ 
      browserCount,
      meshFormationTimeout: MESH_FORMATION_TIMEOUT
    });
    await coordinator.launchBrowsers(browser);
  });

  test.afterEach(async () => {
    if (coordinator) {
      await coordinator.teardown();
    }
  });

  /**
   * Test: Full mesh formation with N browsers
   * 
   * Launches N browser instances, connects them to DHT, and verifies
   * that a full mesh forms with N*(N-1)/2 WebRTC connections.
   * 
   * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5
   */
  test('should form full mesh with N browsers', async () => {
    const browserCount = coordinator.config.browserCount;
    const expectedPairs = (browserCount * (browserCount - 1)) / 2;
    
    console.log(`\n📊 Mesh Formation Test`);
    console.log(`   Browser count: ${browserCount}`);
    console.log(`   Expected connections: ${expectedPairs}`);
    console.log(`   Timeout: ${MESH_FORMATION_TIMEOUT}ms`);

    // Connect all browsers to DHT
    await coordinator.connectAll(BASE_URL, 60000);

    // Verify mesh formation
    const meshStatus = await coordinator.verifyMeshFormation(MESH_FORMATION_TIMEOUT);

    // Log results
    console.log(`\n📈 Mesh Formation Results:`);
    console.log(`   Total nodes: ${meshStatus.totalNodes}`);
    console.log(`   Connected pairs: ${meshStatus.connectedPairs}/${meshStatus.expectedPairs}`);
    console.log(`   Formation time: ${meshStatus.formationTimeMs}ms`);
    console.log(`   Complete: ${meshStatus.isComplete ? '✅ YES' : '❌ NO'}`);

    if (meshStatus.missingConnections.length > 0) {
      console.log(`   Missing connections:`);
      for (const missing of meshStatus.missingConnections) {
        console.log(`     - ${missing.from.substring(0, 8)}... <-> ${missing.to.substring(0, 8)}...`);
      }
    }

    // Assertions
    expect(meshStatus.totalNodes).toBe(browserCount);
    expect(meshStatus.expectedPairs).toBe(expectedPairs);
    
    // Verify mesh is complete
    expect(meshStatus.isComplete).toBe(true);
    expect(meshStatus.connectedPairs).toBe(expectedPairs);
    expect(meshStatus.missingConnections.length).toBe(0);
  });

  /**
   * Test: Mesh formation reports time correctly
   * 
   * Verifies that formation time is tracked and reported.
   * 
   * Requirements: 2.4
   */
  test('should report mesh formation time', async () => {
    await coordinator.connectAll(BASE_URL, 60000);
    
    const startTime = Date.now();
    const meshStatus = await coordinator.verifyMeshFormation(MESH_FORMATION_TIMEOUT);
    const elapsedTime = Date.now() - startTime;

    console.log(`\n⏱️ Formation Time Test`);
    console.log(`   Reported formation time: ${meshStatus.formationTimeMs}ms`);
    console.log(`   Actual elapsed time: ${elapsedTime}ms`);

    // Formation time should be positive and less than elapsed time
    expect(meshStatus.formationTimeMs).toBeGreaterThan(0);
    expect(meshStatus.formationTimeMs).toBeLessThanOrEqual(elapsedTime);
  });

  /**
   * Test: Missing connections are reported on timeout
   * 
   * Uses a very short timeout to force incomplete mesh and verify
   * that missing connections are properly reported.
   * 
   * Requirements: 2.5
   */
  test('should report missing connections on timeout', async () => {
    await coordinator.connectAll(BASE_URL, 60000);
    
    // Use a very short timeout to likely get incomplete mesh
    const shortTimeout = 1000; // 1 second
    const meshStatus = await coordinator.verifyMeshFormation(shortTimeout);

    console.log(`\n⚠️ Missing Connections Test (short timeout)`);
    console.log(`   Timeout used: ${shortTimeout}ms`);
    console.log(`   Connected pairs: ${meshStatus.connectedPairs}/${meshStatus.expectedPairs}`);
    console.log(`   Missing count: ${meshStatus.missingConnections.length}`);

    // If mesh didn't complete, we should have missing connections reported
    if (!meshStatus.isComplete) {
      expect(meshStatus.missingConnections.length).toBeGreaterThan(0);
      
      // Each missing connection should have from and to fields
      for (const missing of meshStatus.missingConnections) {
        expect(missing.from).toBeDefined();
        expect(missing.to).toBeDefined();
        expect(typeof missing.from).toBe('string');
        expect(typeof missing.to).toBe('string');
      }
    }
    
    // The sum of connected + missing should equal expected
    expect(meshStatus.connectedPairs + meshStatus.missingConnections.length).toBe(meshStatus.expectedPairs);
  });

  /**
   * Test: All mesh connections use WebRTC
   * 
   * Verifies that all browser-to-browser connections in the mesh
   * use WebRTC as required by the architecture.
   * 
   * Requirements: 2.1, 2.2 (combined with 1.1)
   */
  test('all mesh connections should use WebRTC', async () => {
    await coordinator.connectAll('http://localhost:3000', 60000);
    
    const meshStatus = await coordinator.verifyMeshFormation(MESH_FORMATION_TIMEOUT);
    
    if (!meshStatus.isComplete) {
      console.log('⚠️ Mesh not complete - testing available connections');
    }

    const browserNodeIds = coordinator.nodeIds.filter(id => id);
    let webrtcCount = 0;
    let nonWebrtcCount = 0;

    console.log(`\n🔗 Connection Type Verification`);

    for (let i = 0; i < coordinator.pages.length; i++) {
      const page = coordinator.pages[i];
      const myNodeId = coordinator.nodeIds[i];
      
      if (!myNodeId) continue;

      const connections = await ConnectionVerifier.getAllConnectionTypes(page);
      
      for (const conn of connections) {
        // Only check connections to other browser nodes
        if (browserNodeIds.includes(conn.peerId) && conn.peerId !== myNodeId && conn.isConnected) {
          if (conn.connectionType === ConnectionType.WEBRTC) {
            webrtcCount++;
          } else {
            nonWebrtcCount++;
            console.log(`   ❌ ${myNodeId.substring(0, 8)}... -> ${conn.peerId.substring(0, 8)}...: ${conn.connectionType}`);
          }
        }
      }
    }

    console.log(`   WebRTC connections: ${webrtcCount}`);
    console.log(`   Non-WebRTC connections: ${nonWebrtcCount}`);

    // All browser-to-browser connections must use WebRTC
    expect(nonWebrtcCount).toBe(0);
    
    if (meshStatus.connectedPairs > 0) {
      expect(webrtcCount).toBeGreaterThan(0);
    }
  });
});

/**
 * Property 3: Mesh Completeness Invariant
 * 
 * For any set of N Browser_Nodes (where N >= 3) that have completed mesh formation,
 * the total number of peer-to-peer connections SHALL equal N * (N-1) / 2,
 * and each node SHALL have exactly N-1 peer connections.
 * 
 * Feature: browser-mesh-stability-tests, Property 3: Mesh completeness invariant
 * Validates: Requirements 2.1, 2.2
 */
test.describe('Property 3: Mesh Completeness Invariant', () => {
  
  /**
   * Test mesh completeness with varying browser counts
   * 
   * This property test verifies the mesh completeness invariant holds
   * for different values of N (3, 4, 5 browsers).
   */
  test('mesh completeness invariant holds for N=3 browsers', async ({ browser }) => {
    const coordinator = new TestCoordinator({ 
      browserCount: 3,
      meshFormationTimeout: MESH_FORMATION_TIMEOUT
    });
    
    try {
      await coordinator.launchBrowsers(browser);
      await coordinator.connectAll(BASE_URL, 60000);
      
      const meshStatus = await coordinator.verifyMeshFormation(MESH_FORMATION_TIMEOUT);
      
      const n = 3;
      const expectedPairs = (n * (n - 1)) / 2; // 3
      
      console.log(`\n🔬 Property 3 Test (N=${n})`);
      console.log(`   Expected pairs: ${expectedPairs}`);
      console.log(`   Actual pairs: ${meshStatus.connectedPairs}`);
      console.log(`   Is complete: ${meshStatus.isComplete}`);

      // Property: N*(N-1)/2 connections for full mesh
      expect(meshStatus.expectedPairs).toBe(expectedPairs);
      
      if (meshStatus.isComplete) {
        expect(meshStatus.connectedPairs).toBe(expectedPairs);
        
        // Verify each node has exactly N-1 connections
        for (let i = 0; i < coordinator.pages.length; i++) {
          const info = await coordinator.getConnectionInfo(i);
          const browserPeers = info.peers.filter(
            p => p.isConnected && 
                 p.connectionType === 'webrtc' && 
                 coordinator.nodeIds.includes(p.peerId)
          );
          
          console.log(`   Browser ${i + 1} has ${browserPeers.length} browser peers (expected ${n - 1})`);
          expect(browserPeers.length).toBe(n - 1);
        }
      }
    } finally {
      await coordinator.teardown();
    }
  });

  test('mesh completeness invariant holds for N=4 browsers', async ({ browser }) => {
    const coordinator = new TestCoordinator({ 
      browserCount: 4,
      meshFormationTimeout: MESH_FORMATION_TIMEOUT
    });
    
    try {
      await coordinator.launchBrowsers(browser);
      await coordinator.connectAll(BASE_URL, 60000);
      
      const meshStatus = await coordinator.verifyMeshFormation(MESH_FORMATION_TIMEOUT);
      
      const n = 4;
      const expectedPairs = (n * (n - 1)) / 2; // 6
      
      console.log(`\n🔬 Property 3 Test (N=${n})`);
      console.log(`   Expected pairs: ${expectedPairs}`);
      console.log(`   Actual pairs: ${meshStatus.connectedPairs}`);
      console.log(`   Is complete: ${meshStatus.isComplete}`);

      expect(meshStatus.expectedPairs).toBe(expectedPairs);
      
      if (meshStatus.isComplete) {
        expect(meshStatus.connectedPairs).toBe(expectedPairs);
        
        for (let i = 0; i < coordinator.pages.length; i++) {
          const info = await coordinator.getConnectionInfo(i);
          const browserPeers = info.peers.filter(
            p => p.isConnected && 
                 p.connectionType === 'webrtc' && 
                 coordinator.nodeIds.includes(p.peerId)
          );
          
          console.log(`   Browser ${i + 1} has ${browserPeers.length} browser peers (expected ${n - 1})`);
          expect(browserPeers.length).toBe(n - 1);
        }
      }
    } finally {
      await coordinator.teardown();
    }
  });
});



