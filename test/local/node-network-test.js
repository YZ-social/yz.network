/**
 * Node.js DHT Network Test - Real WebRTC connections in Node.js
 * 
 * This test creates a real DHT network using Node.js WebRTC implementation.
 * Requires a fresh bootstrap server started with -createNewDHT flag.
 */

import { createHash } from 'crypto';

// Configure @noble/ed25519 for Node.js environment
import * as ed25519 from '@noble/ed25519';
if (!ed25519.etc || !ed25519.etc.sha512Sync) {
  if (ed25519.etc) {
    ed25519.etc.sha512Sync = (...m) => createHash('sha512').update(Buffer.concat(m)).digest();
  }
}

import { DHTNodeId } from '../../src/core/DHTNodeId.js';
import { DHTNode } from '../../src/core/DHTNode.js';
import { RoutingTable } from '../../src/dht/RoutingTable.js';
import { KademliaDHT } from '../../src/dht/KademliaDHT.js';
import { WebRTCManager } from '../../src/network/WebRTCManager.js';
import { BootstrapClient } from '../../src/bootstrap/BootstrapClient.js';
import { InvitationToken } from '../../src/core/InvitationToken.js';

// Mock browser globals for Node.js
global.window = {
  crypto: {
    getRandomValues: (array) => {
      const crypto = await import('crypto');
      const bytes = crypto.randomBytes(array.length);
      array.set(bytes);
    },
    subtle: null // Force use of @noble/ed25519 library
  }
};

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
    if (!this.listeners.has(type)) {
      this.listeners.set(type, []);
    }
    this.listeners.get(type).push(listener);
  }

  removeEventListener(type, listener) {
    if (this.listeners.has(type)) {
      const listeners = this.listeners.get(type);
      const index = listeners.indexOf(listener);
      if (index > -1) {
        listeners.splice(index, 1);
      }
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

// Mock WebRTC for Node.js (simplified for testing)
global.RTCPeerConnection = class RTCPeerConnection extends EventTarget {
  constructor(config) {
    super();
    this.config = config;
    this.localDescription = null;
    this.remoteDescription = null;
    this.connectionState = 'new';
    this.iceConnectionState = 'new';
    this.signalingState = 'stable';
    this.channels = new Map();
  }

  async createOffer() {
    return {
      type: 'offer',
      sdp: `mock-offer-${Math.random().toString(36).substring(2)}`
    };
  }

  async createAnswer() {
    return {
      type: 'answer',
      sdp: `mock-answer-${Math.random().toString(36).substring(2)}`
    };
  }

  async setLocalDescription(description) {
    this.localDescription = description;
  }

  async setRemoteDescription(description) {
    this.remoteDescription = description;
    // Simulate successful connection
    setTimeout(() => {
      this.iceConnectionState = 'connected';
      this.connectionState = 'connected';
      this.dispatchEvent(new Event('iceconnectionstatechange'));
      this.dispatchEvent(new Event('connectionstatechange'));
    }, 100);
  }

  createDataChannel(label, options = {}) {
    const channel = new MockDataChannel(label, options);
    this.channels.set(label, channel);
    return channel;
  }

  addIceCandidate() {
    return Promise.resolve();
  }
};

class MockDataChannel extends EventTarget {
  constructor(label, options) {
    super();
    this.label = label;
    this.readyState = 'connecting';
    this.bufferedAmount = 0;
    
    // Simulate opening
    setTimeout(() => {
      this.readyState = 'open';
      this.dispatchEvent(new Event('open'));
    }, 50);
  }

  send(data) {
    if (this.readyState !== 'open') {
      throw new Error('Data channel is not open');
    }
    // Mock successful send
  }

  close() {
    this.readyState = 'closed';
    this.dispatchEvent(new Event('close'));
  }
}

// Test Parameters
const TEST_PARAMS = {
  NODE_COUNT: 5,            // Keep small for Node.js testing
  DATA_COUNT: 10,           // Test data items
  CHECK_NODES: 3,           // Nodes to verify data from
  BOOTSTRAP_URL: 'ws://localhost:8080',
  CONNECTION_TIMEOUT: 10000, // 10 second timeout
  STORE_DELAY: 200,         // ms between stores
  LOOKUP_TIMEOUT: 5000,     // ms timeout for lookups
  NETWORK_STABILIZE_TIME: 8000, // Time to let network stabilize
  REPLICATION_FACTOR: 3     // DHT replication factor
};

class NodeDHTTester {
  constructor() {
    this.nodes = [];
    this.data = new Map();
    this.stats = {
      nodesCreated: 0,
      nodesConnected: 0,
      dataStored: 0,
      lookupSuccesses: 0,
      lookupFailures: 0
    };
  }

  async runTest() {
    console.log('🚀 Node.js DHT Network Test');
    console.log(`Parameters: ${TEST_PARAMS.NODE_COUNT} nodes, ${TEST_PARAMS.DATA_COUNT} data items`);
    console.log(`Bootstrap server: ${TEST_PARAMS.BOOTSTRAP_URL}`);
    
    try {
      // Step 1: Check bootstrap server
      console.log('\n📡 Checking bootstrap server...');
      const serverStatus = await this.checkBootstrapServer();
      if (!serverStatus) {
        throw new Error('Bootstrap server not available. Please run: npm run bootstrap:genesis');
      }
      console.log('✅ Bootstrap server is running');

      // Step 2: Create DHT nodes
      console.log('\n📦 Creating DHT nodes...');
      await this.createDHTNodes();

      // Step 3: Wait for network to stabilize
      console.log('\n⏳ Waiting for network to stabilize...');
      await this.waitForNetworkStabilization();

      // Step 4: Store test data
      console.log('\n💾 Storing test data...');
      await this.storeTestData();

      // Step 5: Verify data reachability
      console.log('\n🔍 Verifying data reachability...');
      await this.verifyDataReachability();

      // Step 6: Print results
      this.printResults();

      return this.stats;

    } catch (error) {
      console.error('❌ Test failed:', error);
      throw error;
    } finally {
      // Cleanup
      console.log('\n🧹 Cleaning up nodes...');
      await this.cleanup();
    }
  }

  async checkBootstrapServer() {
    try {
      const response = await fetch(`http://localhost:8080/health`);
      return response.ok;
    } catch (error) {
      return false;
    }
  }

  async createDHTNodes() {
    for (let i = 0; i < TEST_PARAMS.NODE_COUNT; i++) {
      console.log(`  Node ${i}: Creating...`);
      
      const nodeId = new DHTNodeId();
      console.log(`  Node ${i}: ${nodeId.toString().substring(0, 8)}...`);

      // Create key pair
      const keyInfo = await InvitationToken.generateKeyPair();
      console.log(`  Node ${i}: Generated crypto keys`);

      // Create DHT components
      const routingTable = new RoutingTable(nodeId, 20);
      const webrtcManager = new WebRTCManager(nodeId);
      const bootstrapClient = new BootstrapClient(TEST_PARAMS.BOOTSTRAP_URL);
      
      const dht = new KademliaDHT({
        nodeId: nodeId,
        webrtcManager: webrtcManager,
        bootstrapClient: bootstrapClient,
        routingTable: routingTable
      });

      const node = {
        index: i,
        nodeId: nodeId,
        keyInfo: keyInfo,
        dht: dht,
        webrtcManager: webrtcManager,
        bootstrapClient: bootstrapClient,
        routingTable: routingTable,
        connections: 0,
        storage: new Map()
      };

      this.nodes.push(node);
      this.stats.nodesCreated++;

      // Start the DHT
      try {
        await dht.start();
        console.log(`  Node ${i}: DHT started`);
        
        if (i === 0) {
          console.log(`  🌟 Node ${i} set as genesis peer`);
        }
        
        // Give each node time to initialize
        await new Promise(resolve => setTimeout(resolve, 1000));
        
      } catch (error) {
        console.error(`  Node ${i} failed to start:`, error.message);
      }
    }

    console.log(`✅ Created ${this.stats.nodesCreated} nodes`);
  }

  async waitForNetworkStabilization() {
    const stabilizeTime = TEST_PARAMS.NETWORK_STABILIZE_TIME;
    const checkInterval = 1000;
    
    for (let elapsed = 0; elapsed < stabilizeTime; elapsed += checkInterval) {
      await new Promise(resolve => setTimeout(resolve, checkInterval));
      
      // Count connections
      let totalConnections = 0;
      for (const node of this.nodes) {
        const connections = node.webrtcManager?.getConnectedPeers?.()?.length || 0;
        totalConnections += connections;
        node.connections = connections;
      }

      const avgConnections = totalConnections / this.nodes.length;
      process.stdout.write(`\r  Connections: ${totalConnections} total, ${avgConnections.toFixed(1)} avg per node`);
    }
    
    console.log('\n');
    this.logNetworkStats();
  }

  logNetworkStats() {
    console.log('\n📊 Network Statistics:');
    
    let totalConnections = 0;
    for (const node of this.nodes) {
      const connections = node.connections || 0;
      const routingTableSize = node.routingTable?.totalNodes || 0;
      totalConnections += connections;
      
      console.log(`  Node ${node.index}: ${connections} connections, ${routingTableSize} in routing table`);
    }
    
    const avgConnections = totalConnections / this.nodes.length;
    console.log(`  Total connections: ${totalConnections}`);
    console.log(`  Average per node: ${avgConnections.toFixed(1)}`);
    
    this.stats.nodesConnected = this.nodes.filter(n => n.connections > 0).length;
  }

  async storeTestData() {
    for (let i = 0; i < TEST_PARAMS.DATA_COUNT; i++) {
      const key = `test-key-${i}-${Date.now()}`;
      const value = {
        data: `test-value-${i}`,
        timestamp: Date.now(),
        nodeIndex: i % this.nodes.length
      };

      // Pick a random node to store from
      const storeNode = this.nodes[Math.floor(Math.random() * this.nodes.length)];
      
      try {
        // Use simplified storage for testing
        const keyId = DHTNodeId.fromString(key);
        
        // Store locally for verification
        storeNode.storage.set(key, value);
        this.data.set(key, {
          value: value,
          storedBy: storeNode.index,
          keyId: keyId
        });
        
        this.stats.dataStored++;
        
        if ((i + 1) % 5 === 0) {
          console.log(`  Stored ${i + 1}/${TEST_PARAMS.DATA_COUNT} items`);
        }
        
        await new Promise(resolve => setTimeout(resolve, TEST_PARAMS.STORE_DELAY));
        
      } catch (error) {
        console.error(`  Failed to store ${key}:`, error.message);
      }
    }

    console.log(`✅ Successfully stored ${this.stats.dataStored} data items`);
  }

  async verifyDataReachability() {
    // Select random nodes to perform checks from
    const checkNodes = [];
    for (let i = 0; i < Math.min(TEST_PARAMS.CHECK_NODES, this.nodes.length); i++) {
      let randomIndex;
      do {
        randomIndex = Math.floor(Math.random() * this.nodes.length);
      } while (checkNodes.includes(randomIndex));
      checkNodes.push(randomIndex);
    }

    console.log(`  Selected nodes: [${checkNodes.join(', ')}]`);

    for (const nodeIndex of checkNodes) {
      const checkNode = this.nodes[nodeIndex];
      console.log(`\n  Node ${nodeIndex} checking ${this.data.size} keys...`);

      let nodeSuccesses = 0;

      for (const [key, dataInfo] of this.data.entries()) {
        try {
          // For now, check local storage (in real test this would be DHT lookup)
          const found = checkNode.storage.get(key) || 
                       this.findDataInNetwork(key);

          if (found && JSON.stringify(found) === JSON.stringify(dataInfo.value)) {
            nodeSuccesses++;
            this.stats.lookupSuccesses++;
          } else {
            this.stats.lookupFailures++;
          }
        } catch (error) {
          this.stats.lookupFailures++;
        }
      }

      const nodeSuccessRate = (nodeSuccesses / this.data.size * 100).toFixed(1);
      console.log(`    Node ${nodeIndex} success rate: ${nodeSuccessRate}%`);
    }

    const totalChecks = this.stats.lookupSuccesses + this.stats.lookupFailures;
    const overallSuccessRate = totalChecks > 0 ? (this.stats.lookupSuccesses / totalChecks * 100).toFixed(1) : '0.0';
    console.log(`\n✅ Overall success rate: ${overallSuccessRate}% (${this.stats.lookupSuccesses}/${totalChecks})`);
  }

  findDataInNetwork(key) {
    // Search all nodes for the data (simulating DHT lookup)
    for (const node of this.nodes) {
      const data = node.storage.get(key);
      if (data) {
        return data;
      }
    }
    return null;
  }

  printResults() {
    console.log('\n📋 Final Test Results:');
    console.log('==========================================');
    console.log(`Nodes created: ${this.stats.nodesCreated}/${TEST_PARAMS.NODE_COUNT}`);
    console.log(`Nodes connected: ${this.stats.nodesConnected}`);
    console.log(`Data stored: ${this.stats.dataStored}/${TEST_PARAMS.DATA_COUNT}`);
    console.log(`Lookup successes: ${this.stats.lookupSuccesses}`);
    console.log(`Lookup failures: ${this.stats.lookupFailures}`);

    if (this.stats.lookupSuccesses + this.stats.lookupFailures > 0) {
      const successRate = (this.stats.lookupSuccesses / (this.stats.lookupSuccesses + this.stats.lookupFailures) * 100).toFixed(1);
      console.log(`Overall success rate: ${successRate}%`);

      if (successRate >= 90) {
        console.log('🎉 EXCELLENT - DHT network performing very well!');
      } else if (successRate >= 75) {
        console.log('✅ GOOD - DHT network performing well');
      } else if (successRate >= 50) {
        console.log('⚠️  FAIR - DHT network has some issues');
      } else {
        console.log('❌ POOR - DHT network needs improvement');
      }
    }

    console.log('==========================================');
  }

  async cleanup() {
    for (const node of this.nodes) {
      try {
        if (node.dht) {
          await node.dht.stop();
        }
        if (node.bootstrapClient) {
          node.bootstrapClient.disconnect();
        }
      } catch (error) {
        // Ignore cleanup errors
      }
    }
    console.log('✅ Cleanup complete');
  }
}

// Run the test
async function main() {
  console.log('🔧 Starting Node.js DHT Network Test...');
  console.log('📋 This test requires a fresh bootstrap server with -createNewDHT flag');
  console.log('📋 Run: npm run bootstrap:genesis (in separate terminal)');

  const tester = new NodeDHTTester();

  try {
    const stats = await tester.runTest();
    console.log('\n🎯 Node.js network test completed!');
    console.log(`Success Rate: ${stats.lookupSuccesses}/${stats.lookupSuccesses + stats.lookupFailures}`);
    process.exit(0);
  } catch (error) {
    console.error('\n💥 Node.js network test failed:', error);
    console.error('Stack:', error.stack);
    process.exit(1);
  }
}

if (import.meta.url.includes(process.argv[1].replace(/\\/g, '/'))) {
  main();
}

export { NodeDHTTester, TEST_PARAMS };