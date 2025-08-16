/**
 * DHT Connection Test
 * 
 * Test actual DHT connections between Browser and Node.js clients
 * Focus on getting real peer-to-peer DHT messaging working
 * 
 * Prerequisites:
 * - Bootstrap server must be running: npm run bootstrap:genesis
 * 
 * Usage: node test/hybrid/dht-connection-test.js
 */

import { NodeDHTClient } from '../../src/node/NodeDHTClient.js';
import WebSocket from 'ws';

// Set up WebSocket global for browser simulation
global.WebSocket = WebSocket;

// DHT imports for browser simulation
import { WebRTCManager } from '../../src/network/WebRTCManager.js';
import { KademliaDHT } from '../../src/dht/KademliaDHT.js';
import { BootstrapClient } from '../../src/bootstrap/BootstrapClient.js';
import { DHTNodeId } from '../../src/core/DHTNodeId.js';
import { randomBytes } from 'crypto';

// Browser crypto setup for Node.js
global.window = global.window || {};
global.window.crypto = {
  getRandomValues: (array) => {
    const bytes = randomBytes(array.length);
    array.set(bytes);
    return array;
  },
  subtle: null // Force use of @noble/ed25519 library
};

class DHTConnectionTest {
  constructor() {
    this.nodeClient = null;
    this.browserClient = null;
    this.browserWebRTC = null;
    this.browserBootstrap = null;
    this.testResults = {
      nodeStart: false,
      browserStart: false,
      invitation: false,
      dhtConnection: false,
      dhtMessaging: false
    };
  }

  async runTest() {
    console.log('🔗 DHT Connection Test');
    console.log('======================\\n');

    try {
      // Test 1: Start Node.js DHT Client (Genesis)
      await this.testNodeStart();
      
      // Test 2: Start Browser DHT Client 
      await this.testBrowserStart();
      
      // Test 3: Invitation Process
      await this.testInvitation();
      
      // Test 4: Verify DHT Connection
      await this.testDHTConnection();
      
      // Test 5: Test DHT Messaging
      await this.testDHTMessaging();
      
      // Print results
      this.printResults();
      
    } catch (error) {
      console.error('❌ Test failed:', error);
      console.error('Stack:', error.stack);
    } finally {
      await this.cleanup();
    }
  }

  async testNodeStart() {
    console.log('📝 Test 1: Node.js DHT Client (Genesis)');
    console.log('--------------------------------------');

    try {
      this.nodeClient = new NodeDHTClient({
        bootstrapServers: ['ws://localhost:8080'],
        port: 0
      });

      const startInfo = await this.nodeClient.start();
      
      console.log(`✅ Node.js client started (Genesis)`);
      console.log(`   Node ID: ${startInfo.nodeId.substring(0, 16)}...`);
      console.log(`   WebSocket: ${startInfo.listeningAddress}\\n`);

      this.testResults.nodeStart = true;
      
    } catch (error) {
      console.error(`❌ Node start failed: ${error.message}\\n`);
      throw error;
    }
  }

  async testBrowserStart() {
    console.log('📝 Test 2: Browser DHT Client');
    console.log('----------------------------');

    try {
      // Create browser node ID
      const browserSeed = new Uint8Array(20);
      browserSeed.set([5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100]);
      const browserNodeId = new DHTNodeId(browserSeed);
      
      // Create WebRTC manager
      this.browserWebRTC = new WebRTCManager({ timeout: 15000 });
      this.browserWebRTC.initialize(browserNodeId.toString());
      
      // Create bootstrap client
      this.browserBootstrap = new BootstrapClient({
        bootstrapServers: ['ws://localhost:8080'],
        timeout: 15000
      });
      
      // Create DHT
      this.browserClient = new KademliaDHT({
        nodeId: browserNodeId,
        webrtc: this.browserWebRTC,
        bootstrap: this.browserBootstrap
      });

      // Set browser metadata
      this.browserClient.bootstrapMetadata = {
        nodeType: 'browser',
        capabilities: ['webrtc']
      };

      await this.browserClient.start();
      
      console.log(`✅ Browser client started`);
      console.log(`   Node ID: ${browserNodeId.toString().substring(0, 16)}...\\n`);

      this.testResults.browserStart = true;
      
    } catch (error) {
      console.error(`❌ Browser start failed: ${error.message}\\n`);
      throw error;
    }
  }

  async testInvitation() {
    console.log('📝 Test 3: Invitation Process');
    console.log('----------------------------');

    try {
      const browserNodeId = this.browserClient.localNodeId.toString();
      
      // Set up invitation listener
      let invitationReceived = false;
      let coordinationInfo = null;
      
      this.browserBootstrap.on('invitationReceived', (message) => {
        console.log(`📨 Browser received invitation`);
        invitationReceived = true;
        coordinationInfo = message.websocketCoordination;
        if (coordinationInfo) {
          console.log(`   WebSocket coordination: ${coordinationInfo.instructions}`);
        }
      });

      // Send invitation
      console.log(`🎫 Node.js inviting Browser...`);
      const success = await this.nodeClient.inviteNewClient(browserNodeId);
      
      if (success) {
        console.log(`✅ Invitation sent`);
        
        // Wait for invitation processing
        await this.delay(3000);
        
        if (invitationReceived) {
          console.log(`✅ Invitation received and processed`);
          this.testResults.invitation = true;
        } else {
          console.error(`❌ Invitation not received`);
        }
      } else {
        console.error(`❌ Failed to send invitation`);
      }
      
    } catch (error) {
      console.error(`❌ Invitation failed: ${error.message}\\n`);
      throw error;
    }
  }

  async testDHTConnection() {
    console.log('\\n📝 Test 4: DHT Connection Verification');
    console.log('--------------------------------------');

    try {
      // Wait a bit for connections to establish
      await this.delay(2000);
      
      // Check Node.js client connections
      const nodeStats = this.nodeClient.getStats();
      const nodeConnections = nodeStats.connections.connectedPeers.length;
      
      console.log(`📊 Node.js client connections: ${nodeConnections}`);
      console.log(`   Connected peers:`, nodeStats.connections.connectedPeerIds);
      
      // Check browser client connections
      const browserConnected = this.browserWebRTC.getConnectedPeers();
      console.log(`📊 Browser client connections: ${browserConnected.length}`);
      console.log(`   Connected peers:`, browserConnected);
      
      if (nodeConnections > 0 && browserConnected.length > 0) {
        console.log(`✅ DHT connections established`);
        this.testResults.dhtConnection = true;
      } else {
        console.error(`❌ No DHT connections found`);
        console.log(`   This indicates the WebSocket coordination didn't result in working DHT peers`);
      }
      
    } catch (error) {
      console.error(`❌ Connection verification failed: ${error.message}\\n`);
    }
  }

  async testDHTMessaging() {
    console.log('\\n📝 Test 5: DHT Messaging');
    console.log('------------------------');

    try {
      const nodeId = this.nodeClient.getStats().nodeId;
      
      // Set up message listener
      let messageReceived = false;
      this.nodeClient.websocketManager.on('message', ({ peerId, message }) => {
        if (message.type === 'dht_test') {
          console.log(`📨 Node.js received DHT test message`);
          console.log(`   From: ${peerId.substring(0, 16)}...`);
          console.log(`   Content: ${message.content}`);
          messageReceived = true;
        }
      });

      // Send test message from browser to Node.js
      console.log(`📤 Browser sending DHT test message...`);
      await this.browserWebRTC.sendMessage(nodeId, {
        type: 'dht_test',
        content: 'Hello from browser DHT client!',
        timestamp: Date.now()
      });

      // Wait for message
      await this.delay(1000);

      if (messageReceived) {
        console.log(`✅ DHT messaging working`);
        this.testResults.dhtMessaging = true;
      } else {
        console.error(`❌ No DHT message received`);
      }
      
    } catch (error) {
      console.error(`❌ DHT messaging failed: ${error.message}\\n`);
    }
  }

  printResults() {
    console.log('\\n📋 DHT Connection Test Results');
    console.log('==============================');
    
    const results = [
      { name: 'Node.js Start', passed: this.testResults.nodeStart },
      { name: 'Browser Start', passed: this.testResults.browserStart },
      { name: 'Invitation', passed: this.testResults.invitation },
      { name: 'DHT Connection', passed: this.testResults.dhtConnection },
      { name: 'DHT Messaging', passed: this.testResults.dhtMessaging }
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
      console.log('🎉 All tests passed! DHT connections working correctly.');
    } else {
      console.log('⚠️  Some tests failed - DHT connections need more work.');
      
      if (!this.testResults.dhtConnection) {
        console.log('💡 Focus on getting actual peer-to-peer DHT connections established');
      }
    }
  }

  async cleanup() {
    console.log('\\n🧹 Cleaning up...');
    
    if (this.browserWebRTC) {
      this.browserWebRTC.destroy();
    }

    if (this.browserClient) {
      await this.browserClient.stop();
    }

    if (this.nodeClient) {
      await this.nodeClient.stop();
    }
    
    console.log('✅ Cleanup complete');
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Main execution
async function main() {
  const test = new DHTConnectionTest();
  await test.runTest();
}

main().catch(error => {
  console.error('💥 Test crashed:', error);
  process.exit(1);
});