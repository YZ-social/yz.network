/**
 * Basic DHT Concept Test
 * 
 * A minimal test that validates the core DHT concepts:
 * - Node ID generation and XOR distance
 * - Data key hashing and closest node selection
 * - Distributed storage and retrieval simulation
 * 
 * This test doesn't require real networking and validates the mathematical
 * foundations of the DHT algorithm.
 */

import { DHTNodeId } from '../../src/core/DHTNodeId.js';

describe('Basic DHT Concept', () => {

  // Test Parameters - easily adjustable
  const TEST_PARAMS = {
    NODE_COUNT: 100,          // Virtual DHT nodes
    DATA_COUNT: 50,           // Data items to store
    CHECK_NODES: 10,          // Nodes to verify from
    REPLICATION_FACTOR: 3,    // How many nodes store each item
    MAX_LOOKUP_HOPS: 5        // Max hops in DHT lookup simulation
  };

  test('should validate DHT algorithm with virtual network', () => {
    console.log('🚀 Basic DHT Concept Test');
    console.log(`Creating ${TEST_PARAMS.NODE_COUNT} nodes, storing ${TEST_PARAMS.DATA_COUNT} items`);

    // Step 1: Create virtual DHT nodes
    console.log('\n📦 Creating virtual nodes...');
    const nodes = [];
    for (let i = 0; i < TEST_PARAMS.NODE_COUNT; i++) {
      nodes.push({
        id: i,
        nodeId: new DHTNodeId(),
        storage: new Map()
      });
    }
    console.log(`✅ Created ${nodes.length} virtual nodes`);
    
    // Assert nodes were created
    expect(nodes.length).toBe(TEST_PARAMS.NODE_COUNT);
    expect(nodes[0]).toHaveProperty('nodeId');
    expect(nodes[0]).toHaveProperty('storage');

    // Step 2: Store test data using DHT principles
    console.log('\n💾 Storing test data...');
    const testData = [];

    for (let i = 0; i < TEST_PARAMS.DATA_COUNT; i++) {
      const key = `test-key-${i}`;
      const value = `test-value-${i}-${Math.random().toString(36)}`;
      
      // Hash the key to get its DHT location
      const keyId = DHTNodeId.fromString(key);
      
      // Find the closest nodes to this key using XOR distance
      const nodeDistances = nodes.map(node => ({
        node: node,
        distance: keyId.xorDistance(node.nodeId)
      }));
      
      // Sort by distance (closest first)
      nodeDistances.sort((a, b) => a.distance.compare(b.distance));
      
      // Store on the closest REPLICATION_FACTOR nodes
      const responsibleNodes = nodeDistances.slice(0, TEST_PARAMS.REPLICATION_FACTOR);
      
      for (const {node} of responsibleNodes) {
        node.storage.set(key, value);
      }
      
      testData.push({
        key,
        value, 
        keyId,
        storedOn: responsibleNodes.map(r => r.node.id)
      });
    }

    console.log(`✅ Stored ${testData.length} items`);
    
    // Assert data was stored correctly
    expect(testData.length).toBe(TEST_PARAMS.DATA_COUNT);
    expect(testData[0]).toHaveProperty('key');
    expect(testData[0]).toHaveProperty('value');
    expect(testData[0]).toHaveProperty('keyId');
    expect(testData[0].storedOn.length).toBe(TEST_PARAMS.REPLICATION_FACTOR);

    // Step 3: Analyze storage distribution
    const storageStats = nodes.map(node => node.storage.size);
    const totalStored = storageStats.reduce((a, b) => a + b, 0);
    const avgItemsPerNode = totalStored / nodes.length;
    const maxItems = Math.max(...storageStats);
    const minItems = Math.min(...storageStats);

    console.log(`📊 Storage distribution: avg=${avgItemsPerNode.toFixed(1)}, min=${minItems}, max=${maxItems}`);
    
    // Assert storage distribution is reasonable
    expect(totalStored).toBe(TEST_PARAMS.DATA_COUNT * TEST_PARAMS.REPLICATION_FACTOR);
    expect(avgItemsPerNode).toBeGreaterThan(0);
    expect(maxItems).toBeGreaterThanOrEqual(minItems);

    // Step 4: Test DHT lookups from random nodes
    console.log('\n🔍 Testing DHT lookups...');

    const checkNodes = [];
    for (let i = 0; i < TEST_PARAMS.CHECK_NODES; i++) {
      const randomIndex = Math.floor(Math.random() * nodes.length);
      if (!checkNodes.includes(randomIndex)) {
        checkNodes.push(randomIndex);
      }
    }

    console.log(`Selected nodes [${checkNodes.join(', ')}] for testing`);

    let totalLookups = 0;
    let successfulLookups = 0;
    let totalHops = 0;

    for (const nodeIndex of checkNodes) {
      const queryNode = nodes[nodeIndex];
      
      console.log(`\n  Node ${nodeIndex} testing ${testData.length} lookups...`);
      
      let nodeSuccesses = 0;
      
      for (const data of testData) {
        totalLookups++;
        
        // Simulate DHT lookup: find closest known node to key
        const result = simulateDHTLookup(queryNode, data.keyId, data.key, nodes);
        
        if (result.found && result.value === data.value) {
          successfulLookups++;
          nodeSuccesses++;
        }
        
        totalHops += result.hops;
      }
      
      const nodeSuccessRate = (nodeSuccesses / testData.length * 100).toFixed(1);
      console.log(`    Success rate: ${nodeSuccessRate}%`);
    }

    // Step 5: Calculate and display results
    const overallSuccessRate = (successfulLookups / totalLookups * 100).toFixed(1);
    const avgHops = (totalHops / totalLookups).toFixed(1);

    console.log('\n📋 DHT Test Results:');
    console.log('==========================================');
    console.log(`Nodes: ${nodes.length}`);
    console.log(`Data items: ${testData.length}`);
    console.log(`Total lookups: ${totalLookups}`);
    console.log(`Successful lookups: ${successfulLookups}`);
    console.log(`Success rate: ${overallSuccessRate}%`);
    console.log(`Average lookup hops: ${avgHops}`);
    console.log(`Storage efficiency: ${(totalStored / testData.length).toFixed(1)}x replication`);

    if (overallSuccessRate >= 95) {
      console.log('🎉 EXCELLENT - DHT algorithm working perfectly!');
    } else if (overallSuccessRate >= 85) {
      console.log('✅ GOOD - DHT algorithm working well');
    } else if (overallSuccessRate >= 70) {
      console.log('⚠️  FAIR - DHT algorithm has some issues');
    } else {
      console.log('❌ POOR - DHT algorithm needs improvement');
    }

    console.log('==========================================');
    
    // Assert the DHT algorithm is working properly
    expect(totalLookups).toBeGreaterThan(0);
    expect(successfulLookups).toBeGreaterThan(0);
    expect(parseFloat(overallSuccessRate)).toBeGreaterThanOrEqual(85); // Should have at least 85% success rate
    expect(parseFloat(avgHops)).toBeLessThanOrEqual(TEST_PARAMS.MAX_LOOKUP_HOPS);
    
    console.log('\n🎯 DHT concept test completed with proper assertions!');
  });

  /**
   * Simulate a DHT lookup from a query node
   */
  function simulateDHTLookup(queryNode, targetKeyId, key, allNodes) {
    let currentNode = queryNode;
    let hops = 0;
    const visitedNodes = new Set();
    
    while (hops < TEST_PARAMS.MAX_LOOKUP_HOPS) {
      hops++;
      visitedNodes.add(currentNode.id);
      
      // Check if current node has the data
      if (currentNode.storage.has(key)) {
        return {
          found: true,
          value: currentNode.storage.get(key),
          hops: hops
        };
      }
      
      // Find closest node to target (simulate routing table lookup)
      const unvisitedNodes = allNodes.filter(node => !visitedNodes.has(node.id));
      
      if (unvisitedNodes.length === 0) {
        // No more nodes to check
        break;
      }
      
      // Find closest unvisited node
      let closestNode = null;
      let closestDistance = null;
      
      for (const node of unvisitedNodes) {
        const distance = targetKeyId.xorDistance(node.nodeId);
        
        if (!closestDistance || distance.compare(closestDistance) < 0) {
          closestDistance = distance;
          closestNode = node;
        }
      }
      
      // Move to the closest node
      if (closestNode) {
        currentNode = closestNode;
      } else {
        break;
      }
    }
    
    return {
      found: false,
      value: null,
      hops: hops
    };
  }
});