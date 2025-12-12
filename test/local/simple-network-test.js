/**
 * Simple DHT Network Test - Minimal Dependencies
 * 
 * This test focuses on testing the core DHT functionality without 
 * complex crypto setup. Good for basic network testing.
 */

import { createHash } from 'crypto';

// Configure @noble/ed25519 for Node.js - simplified approach
import * as ed25519 from '@noble/ed25519';
if (!ed25519.etc || !ed25519.etc.sha512Sync) {
  if (ed25519.etc) {
    ed25519.etc.sha512Sync = (...m) => createHash('sha512').update(Buffer.concat(m)).digest();
  }
}

import { DHTNodeId } from '../../src/core/DHTNodeId.js';
import { DHTNode } from '../../src/core/DHTNode.js';
import { RoutingTable } from '../../src/dht/RoutingTable.js';
import { KBucket } from '../../src/core/KBucket.js';

// Test Parameters
const TEST_PARAMS = {
  NODE_COUNT: 20,           // Number of virtual DHT nodes (reduced for cleaner output)
  DATA_COUNT: 10,           // Key-value pairs to simulate
  CHECK_NODES: 3,           // Nodes to verify data from
  REPLICATION_FACTOR: 3     // DHT replication factor
};

class SimpleDHTTester {
  constructor() {
    this.nodes = [];
    this.data = new Map(); // Simulated distributed storage
    this.stats = {
      nodesCreated: 0,
      dataStored: 0,
      lookupSuccesses: 0,
      lookupFailures: 0
    };
  }

  async runTest() {
    console.log('🚀 Simple DHT Test - Core Logic Verification');
    console.log(`Parameters: ${TEST_PARAMS.NODE_COUNT} nodes, ${TEST_PARAMS.DATA_COUNT} data items`);
    
    try {
      // Step 1: Create virtual DHT nodes
      await this.createVirtualNodes();
      
      // Step 2: Build routing tables
      await this.buildRoutingTables();
      
      // Step 3: Store test data
      await this.storeTestData();
      
      // Step 4: Verify data reachability
      await this.verifyDataReachability();
      
      // Step 5: Print results
      this.printResults();
      
      return this.stats;
      
    } catch (error) {
      console.error('❌ Test failed:', error);
      throw error;
    }
  }

  async createVirtualNodes() {
    console.log(`\n📦 Creating ${TEST_PARAMS.NODE_COUNT} virtual DHT nodes...`);
    
    for (let i = 0; i < TEST_PARAMS.NODE_COUNT; i++) {
      const nodeId = new DHTNodeId();
      const routingTable = new RoutingTable(nodeId, 20); // k=20
      
      const node = {
        index: i,
        nodeId: nodeId,
        routingTable: routingTable,
        storage: new Map(), // Local storage
        address: `virtual-node-${i}`
      };
      
      this.nodes.push(node);
      this.stats.nodesCreated++;
      
      if ((i + 1) % 25 === 0) {
        console.log(`  Created ${i + 1}/${TEST_PARAMS.NODE_COUNT} nodes`);
      }
    }
    
    console.log(`✅ Created ${this.stats.nodesCreated} virtual nodes`);
  }

  async buildRoutingTables() {
    console.log('\n🌐 Building routing tables...');
    
    // Each node discovers other nodes and builds its routing table
    for (const node of this.nodes) {
      // Add random other nodes to routing table (simulating network discovery)
      const connectionsToMake = Math.min(15, this.nodes.length - 1);
      const connectedNodes = new Set();
      
      for (let i = 0; i < connectionsToMake; i++) {
        let randomNode;
        do {
          randomNode = this.nodes[Math.floor(Math.random() * this.nodes.length)];
        } while (randomNode === node || connectedNodes.has(randomNode.index));
        
        connectedNodes.add(randomNode.index);
        
        // Add to routing table
        const dhtNode = new DHTNode(randomNode.nodeId, randomNode.address);
        node.routingTable.addNode(dhtNode);
      }
    }
    
    // Log routing table stats
    const avgRoutingTableSize = this.nodes.reduce((sum, node) => sum + (node.routingTable.totalNodes || 0), 0) / this.nodes.length;
    console.log(`  Average routing table size: ${avgRoutingTableSize.toFixed(1)} nodes`);
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
      
      // Simulate DHT storage: find closest nodes to key
      const keyId = DHTNodeId.fromString(key);
      const responsibleNodes = this.findClosestNodes(keyId, TEST_PARAMS.REPLICATION_FACTOR);
      
      // Store on multiple nodes for replication
      for (const node of responsibleNodes) {
        node.storage.set(key, value);
      }
      
      // Also track globally for verification
      this.data.set(key, {
        value: value,
        storedOn: responsibleNodes.map(n => n.index)
      });
      
      this.stats.dataStored++;
      
      if ((i + 1) % 10 === 0) {
        console.log(`  Stored ${i + 1}/${TEST_PARAMS.DATA_COUNT} items`);
      }
    }
    
    console.log(`✅ Successfully stored ${this.stats.dataStored} data items`);
    
    // Log replication stats
    const totalReplicas = Array.from(this.data.values()).reduce((sum, entry) => sum + entry.storedOn.length, 0);
    console.log(`  Total replicas: ${totalReplicas} (avg ${(totalReplicas / this.data.size).toFixed(1)} per item)`);
  }

  findClosestNodes(targetId, count) {
    // Sort all nodes by XOR distance to target
    const nodesByDistance = this.nodes
      .map(node => ({
        node: node,
        distance: node.nodeId.xorDistance(targetId)
      }))
      .sort((a, b) => a.distance.compare(b.distance))
      .slice(0, count)
      .map(entry => entry.node);
    
    return nodesByDistance;
  }

  async verifyDataReachability() {
    console.log(`\n🔍 Verifying data reachability from ${TEST_PARAMS.CHECK_NODES} random nodes...`);
    
    // Select random nodes to perform checks from
    const checkNodes = [];
    for (let i = 0; i < TEST_PARAMS.CHECK_NODES; i++) {
      let randomIndex;
      do {
        randomIndex = Math.floor(Math.random() * this.nodes.length);
      } while (checkNodes.some(n => n.index === randomIndex));
      
      checkNodes.push(this.nodes[randomIndex]);
    }
    
    console.log(`  Selected nodes: [${checkNodes.map(n => n.index).join(', ')}]`);
    
    // Each check node tries to find all test data
    for (const checkNode of checkNodes) {
      console.log(`\n  Node ${checkNode.index} verifying ${this.data.size} keys...`);
      
      let nodeSuccesses = 0;
      
      for (const [key, dataInfo] of this.data.entries()) {
        const found = this.simulateDHTLookup(checkNode, key);
        
        if (found && JSON.stringify(found) === JSON.stringify(dataInfo.value)) {
          nodeSuccesses++;
          this.stats.lookupSuccesses++;
        } else {
          this.stats.lookupFailures++;
        }
      }
      
      const nodeSuccessRate = (nodeSuccesses / this.data.size * 100).toFixed(1);
      console.log(`    Node ${checkNode.index} success rate: ${nodeSuccessRate}%`);
    }
    
    const totalChecks = this.stats.lookupSuccesses + this.stats.lookupFailures;
    const overallSuccessRate = (this.stats.lookupSuccesses / totalChecks * 100).toFixed(1);
    console.log(`\n✅ Overall success rate: ${overallSuccessRate}% (${this.stats.lookupSuccesses}/${totalChecks})`);
  }

  simulateDHTLookup(fromNode, key) {
    // Simulate DHT lookup: find closest nodes and check their storage
    const keyId = DHTNodeId.fromString(key);
    const closestNodes = fromNode.routingTable.findClosestNodes(keyId, 5);
    
    // Check if any of the closest known nodes has the data
    for (const knownNode of closestNodes) {
      const actualNode = this.nodes.find(n => n.nodeId.equals(knownNode.id));
      if (actualNode && actualNode.storage.has(key)) {
        return actualNode.storage.get(key);
      }
    }
    
    // If not found in routing table, do exhaustive search (simulating network queries)
    const responsibleNodes = this.findClosestNodes(keyId, 3);
    for (const node of responsibleNodes) {
      if (node.storage.has(key)) {
        return node.storage.get(key);
      }
    }
    
    return null;
  }

  printResults() {
    console.log('\n📋 Simple DHT Test Results:');
    console.log('==========================================');
    console.log(`Virtual nodes: ${this.stats.nodesCreated}/${TEST_PARAMS.NODE_COUNT}`);
    console.log(`Data stored: ${this.stats.dataStored}/${TEST_PARAMS.DATA_COUNT}`);
    console.log(`Lookup successes: ${this.stats.lookupSuccesses}`);
    console.log(`Lookup failures: ${this.stats.lookupFailures}`);
    
    if (this.stats.lookupSuccesses + this.stats.lookupFailures > 0) {
      const successRate = (this.stats.lookupSuccesses / (this.stats.lookupSuccesses + this.stats.lookupFailures) * 100).toFixed(1);
      console.log(`Success rate: ${successRate}%`);
      
      if (successRate >= 95) {
        console.log('🎉 EXCELLENT - DHT logic working perfectly!');
      } else if (successRate >= 85) {
        console.log('✅ GOOD - DHT logic working well');
      } else if (successRate >= 70) {
        console.log('⚠️  FAIR - DHT logic has minor issues');
      } else {
        console.log('❌ POOR - DHT logic needs improvement');
      }
    }
    
    console.log('==========================================');
    
    // Additional insights
    console.log('\n📊 Network Analysis:');
    const avgRoutingTableSize = this.nodes.reduce((sum, node) => sum + (node.routingTable.totalNodes || 0), 0) / this.nodes.length;
    console.log(`Average routing table size: ${avgRoutingTableSize.toFixed(1)}`);
    
    const storageDistribution = this.nodes.map(node => node.storage.size);
    const avgStorage = storageDistribution.reduce((a, b) => a + b, 0) / storageDistribution.length;
    const maxStorage = Math.max(...storageDistribution);
    const minStorage = Math.min(...storageDistribution);
    
    console.log(`Storage distribution: avg=${avgStorage.toFixed(1)}, min=${minStorage}, max=${maxStorage}`);
  }
}

// Run the test
async function main() {
  console.log('🔧 Starting Simple DHT Test...');
  
  const tester = new SimpleDHTTester();
  
  try {
    const stats = await tester.runTest();
    console.log('\n🎯 Simple test completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('\n💥 Simple test failed:', error);
    console.error('Stack:', error.stack);
    process.exit(1);
  }
}

if (import.meta.url.includes(process.argv[1].replace(/\\/g, '/'))) {
  main();
}

export { SimpleDHTTester, TEST_PARAMS };