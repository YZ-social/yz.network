#!/usr/bin/env node

/**
 * Test Inactive Tab Detection
 * 
 * Tests the enhanced inactive tab detection and fast failure mechanisms.
 */

import { NodeDHTClient } from '../src/NodeDHTClient.js';
import { PubSubClient } from '../src/pubsub/PubSubClient.js';

class InactiveTabDetectionTest {
  constructor() {
    this.dhtClient = null;
    this.pubsubClient = null;
  }

  async start() {
    console.log('🧪 Testing Inactive Tab Detection & Fast Failure...');
    
    try {
      // Create DHT client
      console.log('📡 Connecting to DHT...');
      this.dhtClient = new NodeDHTClient({
        bootstrapServers: ['wss://imeyouwe.com/bootstrap']
      });

      await this.dhtClient.start();
      console.log('✅ DHT client connected');

      // Wait for connections
      await new Promise(resolve => setTimeout(resolve, 10000));

      const connectedPeers = this.dhtClient.dht.getConnectedPeers();
      console.log(`📊 Connected to ${connectedPeers.length} DHT peers`);

      // Test 1: Check current routing table for browser nodes
      await this.testRoutingTableBrowserNodes();

      // Test 2: Test redundant find_node queries
      await this.testRedundantQueries();

      // Test 3: Test channel creation with potential inactive tabs
      await this.testChannelCreationWithInactiveTabs();

      console.log('\n🎉 All inactive tab detection tests completed!');

    } catch (error) {
      console.error('❌ Test failed:', error);
    } finally {
      if (this.dhtClient) {
        await this.dhtClient.stop();
      }
    }
  }

  async testRoutingTableBrowserNodes() {
    console.log('\n📋 Test 1: Checking routing table for browser nodes...');
    
    const allNodes = this.dhtClient.dht.routingTable.getAllNodes();
    const browserNodes = allNodes.filter(node => 
      node.metadata?.nodeType === 'browser'
    );
    
    console.log(`   Total nodes in routing table: ${allNodes.length}`);
    console.log(`   Browser nodes: ${browserNodes.length}`);
    
    for (const node of browserNodes) {
      const peerId = node.id.toString();
      const isConnected = this.dhtClient.dht.isPeerConnected(peerId);
      const tabVisible = node.metadata?.tabVisible;
      
      console.log(`   📱 ${peerId.substring(0, 8)}... - Connected: ${isConnected}, TabVisible: ${tabVisible}`);
      
      if (tabVisible === false) {
        console.log(`      ⚡ This node should get 1s timeout in queries`);
      }
    }
  }

  async testRedundantQueries() {
    console.log('\n🔍 Test 2: Testing redundant find_node queries...');
    
    // Test the new findNodeWithRedundancy method
    const randomTarget = this.dhtClient.dht.localNodeId; // Use our own ID as target
    
    try {
      console.log('   Testing redundant find_node...');
      const startTime = Date.now();
      
      const nodes = await this.dhtClient.dht.findNodeWithRedundancy(randomTarget, {
        redundancy: 3,
        fastTimeout: 1000
      });
      
      const duration = Date.now() - startTime;
      console.log(`   ✅ Redundant find_node completed in ${duration}ms`);
      console.log(`   📊 Found ${nodes.length} nodes`);
      
      if (duration < 5000) {
        console.log(`   🚀 Fast completion suggests inactive tab handling is working`);
      } else {
        console.log(`   ⚠️ Slow completion (${duration}ms) - may indicate issues`);
      }
      
    } catch (error) {
      console.error(`   ❌ Redundant find_node failed: ${error.message}`);
    }

    // Compare with regular find_node
    try {
      console.log('   Testing regular find_node for comparison...');
      const startTime = Date.now();
      
      const nodes = await this.dhtClient.dht.findNode(randomTarget);
      
      const duration = Date.now() - startTime;
      console.log(`   ✅ Regular find_node completed in ${duration}ms`);
      console.log(`   📊 Found ${nodes.length} nodes`);
      
    } catch (error) {
      console.error(`   ❌ Regular find_node failed: ${error.message}`);
    }
  }

  async testChannelCreationWithInactiveTabs() {
    console.log('\n📺 Test 3: Testing channel creation with potential inactive tabs...');
    
    // Create PubSub client
    this.pubsubClient = new PubSubClient(this.dhtClient.dht);
    
    const channelId = `inactive-tab-test-${Date.now()}`;
    
    try {
      console.log(`   Creating channel: ${channelId}`);
      const startTime = Date.now();
      
      const result = await this.pubsubClient.subscribe(channelId);
      
      const duration = Date.now() - startTime;
      console.log(`   ✅ Channel creation completed in ${duration}ms`);
      console.log(`   📊 Coordinator: ${result.coordinatorNode}, Messages: ${result.historicalMessages}`);
      
      if (duration < 10000) {
        console.log(`   🚀 Fast channel creation suggests inactive tab fixes are working`);
      } else {
        console.log(`   ⚠️ Slow channel creation (${duration}ms) - may indicate remaining issues`);
      }
      
      // Test message sending
      console.log('   Testing message sending...');
      const messageStart = Date.now();
      
      const messageResult = await this.pubsubClient.publish(channelId, {
        text: 'Test message for inactive tab detection',
        timestamp: Date.now()
      });
      
      const messageDuration = Date.now() - messageStart;
      console.log(`   ✅ Message sent in ${messageDuration}ms: ${messageResult.messageId.substring(0, 8)}...`);
      
    } catch (error) {
      const duration = Date.now() - startTime;
      console.error(`   ❌ Channel creation failed after ${duration}ms: ${error.message}`);
      
      if (error.message.includes('timeout')) {
        console.log(`   💡 Timeout suggests some inactive tabs are still causing delays`);
        console.log(`   🔧 Check if all nodes have been updated with the inactive tab fix`);
      }
    }
  }
}

// Run the test
const test = new InactiveTabDetectionTest();
test.start().catch(console.error);