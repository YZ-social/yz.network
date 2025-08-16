/**
 * Node.js to Node.js WebSocket DHT Test
 * 
 * Test pure Node.js DHT connections over WebSocket transport
 * This focuses on getting actual DHT connections working between Node.js peers
 * 
 * Prerequisites:
 * - Bootstrap server must be running: npm run bootstrap:genesis
 * 
 * Usage: node test/nodejs/nodejs-websocket-dht-test.js
 */

import { NodeDHTClient } from '../../src/node/NodeDHTClient.js';

class NodeJSWebSocketDHTTest {
  constructor() {
    this.genesisClient = null;
    this.secondClient = null;
    this.testResults = {
      genesisStart: false,
      secondStart: false,
      invitation: false,
      dhtConnection: false,
      dhtOperations: false
    };
  }

  async runTest() {
    console.log('🔗 Node.js to Node.js WebSocket DHT Test');
    console.log('========================================\\n');

    try {
      // Test 1: Start Genesis Node.js Client
      await this.testGenesisStart();
      
      // Test 2: Start Second Node.js Client
      await this.testSecondStart();
      
      // Test 3: Invitation Process
      await this.testInvitation();
      
      // Test 4: Verify DHT Connection
      await this.testDHTConnection();
      
      // Test 5: Test DHT Operations
      await this.testDHTOperations();
      
      // Print results
      this.printResults();
      
    } catch (error) {
      console.error('❌ Test failed:', error);
      console.error('Stack:', error.stack);
    } finally {
      await this.cleanup();
    }
  }

  async testGenesisStart() {
    console.log('📝 Test 1: Genesis Node.js Client');
    console.log('--------------------------------');

    try {
      this.genesisClient = new NodeDHTClient({
        bootstrapServers: ['ws://localhost:8080'],
        port: 0 // Random port
      });

      const startInfo = await this.genesisClient.start();
      
      console.log(`✅ Genesis Node.js client started`);
      console.log(`   Node ID: ${startInfo.nodeId.substring(0, 16)}...`);
      console.log(`   WebSocket: ${startInfo.listeningAddress}`);
      console.log(`   Genesis status: Should be true\\n`);

      this.testResults.genesisStart = true;
      
    } catch (error) {
      console.error(`❌ Genesis start failed: ${error.message}\\n`);
      throw error;
    }
  }

  async testSecondStart() {
    console.log('📝 Test 2: Second Node.js Client');
    console.log('-------------------------------');

    try {
      this.secondClient = new NodeDHTClient({
        bootstrapServers: ['ws://localhost:8080'],
        port: 0 // Random port
      });

      const startInfo = await this.secondClient.start();
      
      console.log(`✅ Second Node.js client started`);
      console.log(`   Node ID: ${startInfo.nodeId.substring(0, 16)}...`);
      console.log(`   WebSocket: ${startInfo.listeningAddress}`);
      console.log(`   Genesis status: Should be false\\n`);

      this.testResults.secondStart = true;
      
    } catch (error) {
      console.error(`❌ Second start failed: ${error.message}\\n`);
      throw error;
    }
  }

  async testInvitation() {
    console.log('📝 Test 3: Node.js → Node.js Invitation');
    console.log('--------------------------------------');

    try {
      const secondNodeId = this.secondClient.getStats().nodeId;
      
      console.log(`🎫 Genesis inviting Second Node.js client:`);
      console.log(`   Target: ${secondNodeId.substring(0, 16)}...`);
      
      // Send invitation
      const success = await this.genesisClient.inviteNewClient(secondNodeId);
      
      if (success) {
        console.log(`✅ Invitation sent successfully`);
        
        // Wait for invitation processing and connection
        console.log(`⏳ Waiting for WebSocket connection to establish...`);
        await this.delay(5000);
        
        this.testResults.invitation = true;
      } else {
        console.error(`❌ Failed to send invitation`);
      }
      
    } catch (error) {
      console.error(`❌ Invitation failed: ${error.message}\\n`);
    }
  }

  async testDHTConnection() {
    console.log('\\n📝 Test 4: DHT Connection Verification');
    console.log('--------------------------------------');

    try {
      // Check Genesis client connections
      const genesisStats = this.genesisClient.getStats();
      const genesisConnections = genesisStats.connections.connectedPeers.length;
      
      console.log(`📊 Genesis client:`);
      console.log(`   Connected peers: ${genesisConnections}`);
      console.log(`   Peer IDs:`, genesisStats.connections.connectedPeerIds);
      console.log(`   DHT routing table size: ${genesisStats.dht.routingTableSize}`);
      
      // Check Second client connections  
      const secondStats = this.secondClient.getStats();
      const secondConnections = secondStats.connections.connectedPeers.length;
      
      console.log(`📊 Second client:`);
      console.log(`   Connected peers: ${secondConnections}`);
      console.log(`   Peer IDs:`, secondStats.connections.connectedPeerIds);
      console.log(`   DHT routing table size: ${secondStats.dht.routingTableSize}`);
      
      // Verify mutual connection
      if (genesisConnections > 0 && secondConnections > 0) {
        console.log(`✅ DHT connections established`);
        console.log(`   Genesis ↔ Second: Both clients have peer connections`);
        this.testResults.dhtConnection = true;
      } else {
        console.error(`❌ DHT connections not established`);
        console.log(`   Genesis connections: ${genesisConnections}`);
        console.log(`   Second connections: ${secondConnections}`);
      }
      
    } catch (error) {
      console.error(`❌ Connection verification failed: ${error.message}\\n`);
    }
  }

  async testDHTOperations() {
    console.log('\\n📝 Test 5: DHT Operations');
    console.log('-------------------------');

    if (!this.testResults.dhtConnection) {
      console.log('⏭️ Skipping DHT operations test - no connections established');
      return;
    }

    try {
      // Test store operation
      console.log(`📤 Genesis storing data in DHT...`);
      const testKey = 'test-key-' + Date.now();
      const testValue = { message: 'Hello from Genesis!', timestamp: Date.now() };
      
      await this.genesisClient.store(testKey, testValue);
      console.log(`✅ Data stored: ${testKey}`);
      
      // Wait a bit for replication
      await this.delay(2000);
      
      // Test get operation from Second client
      console.log(`📥 Second client retrieving data from DHT...`);
      const retrievedValue = await this.secondClient.get(testKey);
      
      if (retrievedValue && retrievedValue.message === testValue.message) {
        console.log(`✅ Data successfully retrieved by Second client`);
        console.log(`   Retrieved: ${JSON.stringify(retrievedValue)}`);
        this.testResults.dhtOperations = true;
      } else {
        console.error(`❌ Data retrieval failed or data mismatch`);
        console.log(`   Expected: ${JSON.stringify(testValue)}`);
        console.log(`   Got: ${JSON.stringify(retrievedValue)}`);
      }
      
    } catch (error) {
      console.error(`❌ DHT operations failed: ${error.message}\\n`);
    }
  }

  printResults() {
    console.log('\\n📋 Node.js WebSocket DHT Test Results');
    console.log('=====================================');
    
    const results = [
      { name: 'Genesis Start', passed: this.testResults.genesisStart },
      { name: 'Second Start', passed: this.testResults.secondStart },
      { name: 'Invitation', passed: this.testResults.invitation },
      { name: 'DHT Connection', passed: this.testResults.dhtConnection },
      { name: 'DHT Operations', passed: this.testResults.dhtOperations }
    ];

    for (const result of results) {
      const status = result.passed ? '✅ PASS' : '❌ FAIL';
      console.log(`${status} - ${result.name}`);
    }

    const passedTests = results.filter(r => r.passed).length;
    const totalTests = results.length;
    const successRate = (passedTests / totalTests * 100).toFixed(1);

    console.log(`\\n📊 Overall: ${passedTests}/${totalTests} tests passed (${successRate}%)`);

    if (passedTests === totalTests) {
      console.log('🎉 All tests passed! Node.js WebSocket DHT connections working perfectly.');
      console.log('🔗 Ready to integrate Browser hybrid connections next.');
    } else if (this.testResults.dhtConnection) {
      console.log('🔄 DHT connections working but some operations failed.');
    } else {
      console.log('⚠️ DHT connections not established - need to debug connection issues.');
      
      if (this.testResults.invitation) {
        console.log('💡 Invitations working but connections failing after handshake');
      }
    }
  }

  async cleanup() {
    console.log('\\n🧹 Cleaning up...');
    
    if (this.secondClient) {
      try {
        await this.secondClient.stop();
        console.log('✅ Second Node.js client stopped');
      } catch (error) {
        console.error('❌ Error stopping second client:', error.message);
      }
    }

    if (this.genesisClient) {
      try {
        await this.genesisClient.stop();
        console.log('✅ Genesis Node.js client stopped');
      } catch (error) {
        console.error('❌ Error stopping genesis client:', error.message);
      }
    }
    
    console.log('✅ Cleanup complete');
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Main execution
async function main() {
  const test = new NodeJSWebSocketDHTTest();
  await test.runTest();
}

main().catch(error => {
  console.error('💥 Test crashed:', error);
  process.exit(1);
});