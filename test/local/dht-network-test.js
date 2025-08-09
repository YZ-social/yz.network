/**
 * Local DHT Network Test - Real Network Testing
 * 
 * This test creates a real DHT network with actual bootstrap server and WebRTC connections.
 * Run this test locally, NOT in CI/GitHub Actions.
 * 
 * Usage:
 *   node test/local/dht-network-test.js
 * 
 * Prerequisites:
 *   - Bootstrap server must be running: npm run bootstrap:genesis
 *   - Run in separate terminal from bootstrap server
 */

// Setup crypto for Node.js environment
import { createHash } from 'crypto';

// Configure Node.js globals for browser compatibility
import { randomBytes } from 'crypto';

// Setup crypto globals for Node.js
global.window = {
  crypto: {
    getRandomValues: (array) => {
      const bytes = randomBytes(array.length);
      array.set(bytes);
    },
    subtle: null // Force use of @noble/ed25519 library
  }
};

// Basic Event and EventTarget implementation for Node.js
global.Event = class Event {
  constructor(type, options = {}) {
    this.type = type;
    this.bubbles = options.bubbles || false;
    this.cancelable = options.cancelable || false;
  }
};

global.EventTarget = class EventTarget {
  constructor() {
    this.listeners = new Map();
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  removeEventListener(type, listener) {
    if (this.listeners.has(type)) {
      const listeners = this.listeners.get(type);
      const index = listeners.indexOf(listener);
      if (index > -1) listeners.splice(index, 1);
    }
  }
  dispatchEvent(event) {
    if (this.listeners.has(event.type)) {
      for (const listener of this.listeners.get(event.type)) {
        listener(event);
      }
    }
  }
};

// Configure @noble/ed25519 for Node.js
async function setupCrypto() {
  try {
    const ed25519Module = await import('@noble/ed25519');
    const ed25519 = ed25519Module.ed25519 || ed25519Module;
    
    // Set up SHA512 hash function for Node.js
    if (ed25519.etc && !ed25519.etc.sha512Sync) {
      ed25519.etc.sha512Sync = (...m) => createHash('sha512').update(Buffer.concat(m)).digest();
    }
    console.log('✅ Configured ed25519 for Node.js');
  } catch (error) {
    console.warn('⚠️  Failed to configure ed25519:', error.message);
  }
}

import { KademliaDHT } from '../../src/dht/KademliaDHT.js';
import { BootstrapClient } from '../../src/bootstrap/BootstrapClient.js';
import { WebRTCManager } from '../../src/network/WebRTCManager.js';
import { NodeWebRTCManager } from '../../src/network/NodeWebRTCManager.js';
import { DHTNodeId } from '../../src/core/DHTNodeId.js';
import { InvitationToken } from '../../src/core/InvitationToken.js';

// Test Parameters - Modify these to adjust test scale
const TEST_PARAMS = {
  NODE_COUNT: 10,           // Number of DHT nodes to create
  DATA_COUNT: 50,           // Number of key-value pairs to store
  CHECK_NODES: 5,           // Number of nodes to verify data from
  BOOTSTRAP_URL: 'ws://localhost:8080',
  CONNECTION_TIMEOUT: 30000, // 30 second timeout for connections
  STORE_DELAY: 100,         // ms between stores
  LOOKUP_TIMEOUT: 10000,    // ms timeout for lookups
  NETWORK_STABILIZE_TIME: 15000, // Time to let network stabilize
  REPLICATION_FACTOR: 3     // DHT replication factor
};

class DHTNetworkTester {
  constructor() {
    this.nodes = [];
    this.testData = [];
    this.genesisNode = null; // Reference to genesis node for invitations
    this.stats = {
      nodesCreated: 0,
      connectionsEstablished: 0,
      dataStored: 0,
      lookupSuccesses: 0,
      lookupFailures: 0
    };
  }

  async runTest() {
    console.log('🚀 Starting DHT Network Test');
    console.log(`Parameters: ${TEST_PARAMS.NODE_COUNT} nodes, ${TEST_PARAMS.DATA_COUNT} data items`);
    
    // Setup crypto for Node.js
    await setupCrypto();
    
    try {
      // Step 1: Check bootstrap server
      await this.checkBootstrapServer();
      
      // Step 2: Create DHT nodes
      await this.createNodes();
      
      // Step 3: Wait for network to stabilize
      await this.waitForNetworkStabilization();
      
      // Step 4: Store test data
      await this.storeTestData();
      
      // Step 5: Wait for replication
      await this.waitForReplication();
      
      // Step 6: Verify data reachability
      await this.verifyDataReachability();
      
      // Step 7: Print results
      this.printResults();
      
      return this.stats;
      
    } catch (error) {
      console.error('❌ Test failed:', error);
      throw error;
    } finally {
      await this.cleanup();
    }
  }

  async checkBootstrapServer() {
    console.log('\n📡 Checking bootstrap server...');
    
    const testClient = new BootstrapClient(TEST_PARAMS.BOOTSTRAP_URL);
    
    try {
      await testClient.connect();
      console.log('✅ Bootstrap server is running');
      await testClient.disconnect();
    } catch (error) {
      console.error('❌ Bootstrap server not available. Please run: npm run bootstrap:genesis');
      throw new Error('Bootstrap server required for network test');
    }
  }

  async createNodes() {
    console.log(`\n📦 Creating ${TEST_PARAMS.NODE_COUNT} DHT nodes with invitation system...`);
    
    // Step 1: Create genesis node (first node gets genesis privileges automatically)
    console.log('\n🌟 Creating genesis node...');
    const genesisNode = await this.createDHTNode(0, null, true); // isGenesis = true
    this.nodes.push(genesisNode);
    this.stats.nodesCreated++;
    console.log(`  🌟 Node 0: ${genesisNode.nodeId.toString().substring(0, 8)}... (GENESIS)`);
    
    // Wait for genesis node to fully initialize and settle (matching browser timing)
    console.log('  ⏳ Allowing genesis node to fully initialize...');
    await this.delay(5000); // Extended delay to match browser behavior
    
    // Step 2: Create remaining nodes using distributed invitation system
    for (let i = 1; i < TEST_PARAMS.NODE_COUNT; i++) {
      try {
        console.log(`\n  Creating node ${i} with distributed invitation...`);
        
        // Create new node first (it will wait for invitation)
        const node = await this.createDHTNode(i, null, false);
        
        // Wait for new node to fully start before sending invitation (matching browser timing)
        console.log(`  ⏳ Waiting for node ${i} to fully initialize before invitation...`);
        await this.delay(3000);
        
        // Select a DHT member to do the invitation (prefer nodes with fewer connections)
        // This distributes the load and avoids connection limits
        const inviterIndex = this.selectBestInviter();
        const inviterNode = this.nodes[inviterIndex];
        
        console.log(`  Node ${inviterIndex} (${inviterNode.nodeId.toString().substring(0, 8)}) inviting new node ${node.nodeId.toString().substring(0, 8)}...`);
        const invitationResult = await inviterNode.dht.inviteNewClient(node.nodeId.toString());
        
        if (invitationResult) {
          this.nodes.push(node);
          this.stats.nodesCreated++;
          console.log(`  ✅ Node ${i}: ${node.nodeId.toString().substring(0, 8)}... (invited by node ${inviterIndex})`);
        } else {
          console.log(`  ❌ Node ${i}: ${node.nodeId.toString().substring(0, 8)}... (invitation failed from node ${inviterIndex})`);
          // Clean up failed node
          await node.dht.stop();
        }
        
        // Wait for WebRTC connection to establish before adding next node (matching browser timing)
        console.log('  ⏳ Allowing WebRTC connection to fully establish...');
        await this.delay(7000); // Extended delay to ensure connection stability
        
      } catch (error) {
        console.warn(`  ❌ Failed to create node ${i}:`, error.message);
      }
    }
    
    console.log(`\n✅ Created ${this.stats.nodesCreated} nodes with distributed invitations`);
    
    // Log invitation distribution
    console.log('📊 Invitation distribution:');
    const inviterCounts = new Map();
    for (let i = 1; i < this.nodes.length; i++) {
      // For logging purposes, we'll track this in a real implementation
      console.log(`  Node ${i} invited by: random DHT member`);
    }
  }
  
  /**
   * Select the best DHT node to perform the next invitation
   * Prefers nodes with fewer connections to distribute load
   */
  selectBestInviter() {
    if (this.nodes.length === 1) {
      return 0; // Only genesis node available
    }
    
    // In a real implementation, we'd check actual connection counts
    // For now, use a simple round-robin to distribute invitations
    const inviterIndex = (this.nodes.length - 1) % this.nodes.length;
    
    // Occasionally use genesis node, but prefer newer nodes to distribute
    if (Math.random() < 0.3) {
      return 0; // Genesis node
    } else {
      return Math.floor(Math.random() * this.nodes.length);
    }
  }

  async createDHTNode(index, invitationToken = null, isGenesis = false) {
    const nodeId = new DHTNodeId();
    
    // Generate cryptographic keys for this node
    const keyInfo = await InvitationToken.generateKeyPair();
    
    // Use NodeWebRTCManager for Node.js environment (inherits all WebRTCManager logic)
    const webrtc = new NodeWebRTCManager({
      timeout: TEST_PARAMS.CONNECTION_TIMEOUT,
      maxConnections: 50
    });
    
    webrtc.initialize(nodeId);
    
    // Create bootstrap client
    const bootstrap = new BootstrapClient(TEST_PARAMS.BOOTSTRAP_URL, {
      nodeId: nodeId.toString(),
      timeout: 10000
    });
    
    // Create DHT with invitation token if provided
    const dhtConfig = {
      nodeId: nodeId,
      webrtc: webrtc,
      bootstrap: bootstrap,
      k: 20,
      alpha: 3,
      replicateK: TEST_PARAMS.REPLICATION_FACTOR
    };
    
    if (invitationToken) {
      dhtConfig.invitationToken = invitationToken;
    }
    
    const dht = new KademliaDHT(dhtConfig);
    
    // Start the DHT
    await dht.start();
    
    // Genesis peer is automatically set by bootstrap server
    if (isGenesis) {
      console.log('  🌟 Node 0 will receive genesis privileges from bootstrap server');
    }
    
    const node = {
      index: index,
      dht: dht,
      webrtc: webrtc,
      bootstrap: bootstrap,
      nodeId: nodeId,
      keyInfo: keyInfo,
      isGenesis: isGenesis
    };
    
    // Set genesis reference
    if (isGenesis) {
      this.genesisNode = node;
    }
    
    return node;
  }

  async waitForNetworkStabilization() {
    console.log(`\n⏳ Waiting ${TEST_PARAMS.NETWORK_STABILIZE_TIME/1000}s for network to stabilize...`);
    
    // Show connection progress
    const checkInterval = setInterval(() => {
      const totalConnections = this.nodes.reduce((sum, node) => {
        return sum + node.webrtc.getConnectedPeers().length;
      }, 0);
      
      const avgConnections = (totalConnections / this.nodes.length).toFixed(1);
      process.stdout.write(`\r  Connections: ${totalConnections} total, ${avgConnections} avg per node`);
    }, 2000);
    
    await this.delay(TEST_PARAMS.NETWORK_STABILIZE_TIME);
    clearInterval(checkInterval);
    console.log(); // New line
    
    // Final connection stats
    this.logNetworkStats();
  }

  async storeTestData() {
    console.log(`\n💾 Storing ${TEST_PARAMS.DATA_COUNT} data items...`);
    
    for (let i = 0; i < TEST_PARAMS.DATA_COUNT; i++) {
      const key = `test-key-${i}-${Date.now()}`;
      const value = {
        data: `test-value-${i}`,
        timestamp: Date.now(),
        random: Math.random().toString(36).substring(7)
      };
      
      // Pick a random node to store from
      const randomNode = this.nodes[Math.floor(Math.random() * this.nodes.length)];
      
      try {
        const success = await randomNode.dht.store(key, value);
        if (success) {
          this.testData.push({ key, value, storedBy: randomNode.index });
          this.stats.dataStored++;
        } else {
          console.warn(`  Failed to store ${key}`);
        }
        
        if ((i + 1) % 10 === 0) {
          console.log(`  Stored ${i + 1}/${TEST_PARAMS.DATA_COUNT} items`);
        }
        
      } catch (error) {
        console.warn(`  Error storing ${key}:`, error.message);
      }
      
      await this.delay(TEST_PARAMS.STORE_DELAY);
    }
    
    console.log(`✅ Successfully stored ${this.stats.dataStored} data items`);
  }

  async waitForReplication() {
    console.log('\n🔄 Waiting for data replication...');
    await this.delay(5000);
    
    // Check replication status
    let totalStoredItems = 0;
    this.nodes.forEach(node => {
      const localItems = node.dht.storage.size;
      totalStoredItems += localItems;
    });
    
    console.log(`  Total replicated items across all nodes: ${totalStoredItems}`);
    console.log(`  Average items per node: ${(totalStoredItems / this.nodes.length).toFixed(1)}`);
  }

  async verifyDataReachability() {
    console.log(`\n🔍 Verifying data reachability from ${TEST_PARAMS.CHECK_NODES} random nodes...`);
    
    // Select random nodes to perform checks from
    const checkNodes = this.selectRandomNodes(TEST_PARAMS.CHECK_NODES);
    console.log(`  Selected nodes: [${checkNodes.map(n => n.index).join(', ')}]`);
    
    let totalChecks = 0;
    let successfulChecks = 0;
    
    for (const checkNode of checkNodes) {
      console.log(`\n  Node ${checkNode.index} checking ${this.testData.length} keys...`);
      
      for (const data of this.testData) {
        totalChecks++;
        
        try {
          const retrievedValue = await checkNode.dht.get(data.key);
          
          if (retrievedValue && JSON.stringify(retrievedValue) === JSON.stringify(data.value)) {
            successfulChecks++;
            this.stats.lookupSuccesses++;
          } else {
            this.stats.lookupFailures++;
            console.log(`    ❌ Key ${data.key}: expected ${JSON.stringify(data.value)}, got ${JSON.stringify(retrievedValue)}`);
          }
          
        } catch (error) {
          this.stats.lookupFailures++;
          console.log(`    ❌ Key ${data.key}: lookup error - ${error.message}`);
        }
      }
      
      const nodeSuccessRate = (successfulChecks / totalChecks * 100).toFixed(1);
      console.log(`    Node ${checkNode.index} success rate: ${nodeSuccessRate}%`);
    }
    
    const overallSuccessRate = (successfulChecks / totalChecks * 100).toFixed(1);
    console.log(`\n✅ Overall success rate: ${overallSuccessRate}% (${successfulChecks}/${totalChecks})`);
  }

  selectRandomNodes(count) {
    const selected = [];
    const available = [...this.nodes];
    
    for (let i = 0; i < Math.min(count, available.length); i++) {
      const randomIndex = Math.floor(Math.random() * available.length);
      selected.push(available.splice(randomIndex, 1)[0]);
    }
    
    return selected;
  }

  logNetworkStats() {
    console.log('\n📊 Network Statistics:');
    
    let totalConnections = 0;
    let minConnections = Infinity;
    let maxConnections = 0;
    
    this.nodes.forEach((node, i) => {
      const connections = node.webrtc.getConnectedPeers().length;
      const routingTableSize = node.dht.routingTable.totalNodes;
      
      totalConnections += connections;
      minConnections = Math.min(minConnections, connections);
      maxConnections = Math.max(maxConnections, connections);
      
      if (i < 5 || connections === minConnections || connections === maxConnections) {
        console.log(`  Node ${i}: ${connections} connections, ${routingTableSize} in routing table`);
      }
    });
    
    console.log(`  Total connections: ${totalConnections}`);
    console.log(`  Average per node: ${(totalConnections / this.nodes.length).toFixed(1)}`);
    console.log(`  Min/Max: ${minConnections}/${maxConnections}`);
  }

  printResults() {
    console.log('\n📋 Final Test Results:');
    console.log('==========================================');
    console.log(`Nodes created: ${this.stats.nodesCreated}/${TEST_PARAMS.NODE_COUNT}`);
    console.log(`Data stored: ${this.stats.dataStored}/${TEST_PARAMS.DATA_COUNT}`);
    console.log(`Lookup successes: ${this.stats.lookupSuccesses}`);
    console.log(`Lookup failures: ${this.stats.lookupFailures}`);
    
    if (this.stats.lookupSuccesses + this.stats.lookupFailures > 0) {
      const successRate = (this.stats.lookupSuccesses / (this.stats.lookupSuccesses + this.stats.lookupFailures) * 100).toFixed(1);
      console.log(`Overall success rate: ${successRate}%`);
      
      if (successRate >= 90) {
        console.log('🎉 EXCELLENT - DHT network performing very well!');
      } else if (successRate >= 75) {
        console.log('✅ GOOD - DHT network performing adequately');
      } else if (successRate >= 50) {
        console.log('⚠️  FAIR - DHT network has some issues');
      } else {
        console.log('❌ POOR - DHT network has significant problems');
      }
    }
    
    console.log('==========================================');
  }

  async cleanup() {
    console.log('\n🧹 Cleaning up nodes...');
    
    const cleanupPromises = this.nodes.map(async (node, i) => {
      try {
        await node.dht.stop();
        await node.webrtc.destroy();
        await node.bootstrap.disconnect();
      } catch (error) {
        console.warn(`Error cleaning up node ${i}:`, error.message);
      }
    });
    
    await Promise.all(cleanupPromises);
    console.log('✅ Cleanup complete');
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Run the test if this file is executed directly
async function main() {
  console.log('🔧 Debug: Script starting...');
  console.log('🔧 Debug: import.meta.url:', import.meta.url);
  console.log('🔧 Debug: process.argv[1]:', process.argv[1]);
  
  // Setup crypto first
  await setupCrypto();
  
  const tester = new DHTNetworkTester();
  
  try {
    console.log('🔧 Debug: Starting test...');
    const stats = await tester.runTest();
    console.log('\n🎯 Test completed successfully!');
    console.log('Final stats:', stats);
    process.exit(0);
  } catch (error) {
    console.error('\n💥 Test failed:', error);
    console.error('Stack:', error.stack);
    process.exit(1);
  }
}

// Check if this file is being run directly
const isMain = import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
console.log('🔧 Debug: isMain check:', isMain);

if (isMain || process.argv[1].includes('dht-network-test.js')) {
  main();
}

export { DHTNetworkTester, TEST_PARAMS };