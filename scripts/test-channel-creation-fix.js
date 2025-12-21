#!/usr/bin/env node

/**
 * Test Channel Creation Fix
 * 
 * Tests if the DHT message flooding fix resolves channel creation timeouts.
 */

import { NodeDHTClient } from '../src/NodeDHTClient.js';
import { PubSubClient } from '../src/pubsub/PubSubClient.js';

class ChannelCreationTest {
  constructor() {
    this.dhtClient = null;
    this.pubsubClient = null;
  }

  async start() {
    console.log('🧪 Testing Channel Creation Fix...');
    
    try {
      // Create DHT client with the new reduced intervals
      console.log('📡 Connecting to DHT with reduced maintenance intervals...');
      this.dhtClient = new NodeDHTClient({
        bootstrapServers: ['wss://imeyouwe.com/bootstrap'],
        // The new intervals should be applied automatically from the fix
      });

      await this.dhtClient.start();
      console.log('✅ DHT client connected');

      // Wait for connections to establish
      console.log('⏳ Waiting for DHT connections to establish...');
      await new Promise(resolve => setTimeout(resolve, 10000));

      const connectedPeers = this.dhtClient.dht.getConnectedPeers();
      console.log(`📊 Connected to ${connectedPeers.length} DHT peers`);

      if (connectedPeers.length < 3) {
        console.warn('⚠️ Low peer count - channel creation may still fail');
      }

      // Create PubSub client
      console.log('🔗 Creating PubSub client...');
      this.pubsubClient = new PubSubClient(this.dhtClient.dht);

      // Test channel creation
      console.log('📺 Testing channel creation...');
      const channelId = `test-channel-${Date.now()}`;
      
      const startTime = Date.now();
      try {
        const result = await this.pubsubClient.subscribe(channelId);
        const duration = Date.now() - startTime;
        
        console.log(`✅ Channel creation SUCCESS in ${duration}ms!`);
        console.log(`   Channel: ${channelId}`);
        console.log(`   Coordinator: ${result.coordinatorNode}`);
        console.log(`   Historical messages: ${result.historicalMessages}`);
        
        // Test message sending
        console.log('📤 Testing message sending...');
        const messageResult = await this.pubsubClient.publish(channelId, {
          text: 'Test message from channel creation fix test',
          timestamp: Date.now()
        });
        
        console.log(`✅ Message sent successfully: ${messageResult.messageId.substring(0, 8)}...`);
        
        return true;
        
      } catch (error) {
        const duration = Date.now() - startTime;
        console.error(`❌ Channel creation FAILED after ${duration}ms: ${error.message}`);
        
        if (error.message.includes('timeout')) {
          console.log('💡 Timeout suggests DHT nodes are still overloaded or unresponsive');
          console.log('   - Check if all Oracle nodes have been restarted with the fix');
          console.log('   - Run the node health check script to identify problematic nodes');
        }
        
        return false;
      }

    } catch (error) {
      console.error('❌ Test failed:', error);
      return false;
    } finally {
      if (this.pubsubClient) {
        // Clean up subscriptions
        try {
          await this.pubsubClient.unsubscribeAll();
        } catch (e) {
          // Ignore cleanup errors
        }
      }
      
      if (this.dhtClient) {
        await this.dhtClient.stop();
      }
    }
  }
}

// Run the test
const test = new ChannelCreationTest();
test.start().then(success => {
  if (success) {
    console.log('\n🎉 CHANNEL CREATION FIX SUCCESSFUL!');
    console.log('   The DHT message flooding fix has resolved the timeout issues.');
  } else {
    console.log('\n❌ CHANNEL CREATION STILL FAILING');
    console.log('   Additional investigation may be needed.');
    console.log('   Run the diagnostic scripts to identify remaining issues.');
  }
  process.exit(success ? 0 : 1);
}).catch(error => {
  console.error('Test crashed:', error);
  process.exit(1);
});