/**
 * Invitation-Based WebSocket Test
 * 
 * Test WebSocket coordination through bootstrap server during invitation process
 * This test simulates the full invitation flow with WebSocket coordination
 * 
 * Prerequisites:
 * - Bootstrap server must be running: npm run bootstrap:genesis
 * 
 * Usage: node test/hybrid/invitation-websocket-test.js
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
import { InvitationToken } from '../../src/core/InvitationToken.js';

// Browser crypto setup for Node.js
import { randomBytes } from 'crypto';

global.window = global.window || {};
global.window.crypto = {
  getRandomValues: (array) => {
    const bytes = randomBytes(array.length);
    array.set(bytes);
    return array;
  },
  subtle: null // Force use of @noble/ed25519 library
};

class InvitationWebSocketTest {
  constructor() {
    this.nodeClient = null;
    this.browserClient = null;
    this.testResults = {
      nodeClientStart: false,
      browserClientStart: false,
      invitationSent: false,
      websocketConnection: false,
      dhtMessaging: false
    };
  }

  async runTest() {
    console.log('🎫 Invitation-Based WebSocket Coordination Test');
    console.log('==============================================\\n');

    try {
      // Test 1: Start Node.js DHT Client (will become Genesis)
      await this.testNodeClientStart();
      
      // Test 2: Start Browser DHT Client (simulated)
      await this.testBrowserClientStart();
      
      // Test 3: Send invitation from Node.js to Browser
      await this.testInvitationProcess();
      
      // Test 4: Verify WebSocket connection established
      await this.testWebSocketConnection();
      
      // Test 5: Test DHT messaging over WebSocket
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

  async testNodeClientStart() {
    console.log('📝 Test 1: Node.js DHT Client Start (Genesis)');
    console.log('--------------------------------------------');

    try {
      this.nodeClient = new NodeDHTClient({
        bootstrapServers: ['ws://localhost:8080'],
        port: 0 // Random available port
      });

      const startInfo = await this.nodeClient.start();
      
      console.log(`✅ Node.js DHT client started as Genesis`);
      console.log(`   Node ID: ${startInfo.nodeId.substring(0, 16)}...`);
      console.log(`   Listening: ${startInfo.listeningAddress}`);
      console.log(`   Type: ${startInfo.nodeType}\\n`);

      this.testResults.nodeClientStart = true;
      
    } catch (error) {
      console.error(`❌ Node client start failed: ${error.message}\\n`);
      throw error;
    }
  }

  async testBrowserClientStart() {
    console.log('📝 Test 2: Browser DHT Client Start (Simulated)');
    console.log('----------------------------------------------');

    try {
      // Create a simulated browser client
      const browserSeed = new Uint8Array(20);
      browserSeed.set([2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 38, 40]);
      const browserNodeId = new DHTNodeId(browserSeed);
      
      // Create WebRTC manager for browser
      this.browserWebRTC = new WebRTCManager({
        timeout: 15000
      });
      this.browserWebRTC.initialize(browserNodeId.toString());
      
      // Create bootstrap client for browser
      this.browserBootstrap = new BootstrapClient({
        bootstrapServers: ['ws://localhost:8080'],
        timeout: 15000
      });
      
      // Create DHT for browser
      this.browserClient = new KademliaDHT({
        nodeId: browserNodeId,
        webrtc: this.browserWebRTC,
        bootstrap: this.browserBootstrap,
        k: 20,
        alpha: 3,
        replicateK: 3
      });

      // Set browser metadata
      this.browserClient.bootstrapMetadata = {
        nodeType: 'browser',
        capabilities: ['webrtc']
      };

      // Start browser DHT (will connect to bootstrap and wait for invitation)
      await this.browserClient.start();
      
      console.log(`✅ Browser DHT client started and waiting for invitation`);
      console.log(`   Node ID: ${browserNodeId.toString().substring(0, 16)}...`);
      console.log(`   Type: browser\\n`);

      this.testResults.browserClientStart = true;
      
    } catch (error) {
      console.error(`❌ Browser client start failed: ${error.message}\\n`);
      throw error;
    }
  }

  async testInvitationProcess() {
    console.log('📝 Test 3: Invitation Process with WebSocket Coordination');
    console.log('-------------------------------------------------------');

    try {
      const browserNodeId = this.browserClient.localNodeId.toString();
      
      console.log(`🎫 Node.js Genesis inviting Browser to join DHT:`);
      console.log(`   Target: ${browserNodeId.substring(0, 16)}...`);
      
      // Listen for invitation received on browser side
      let invitationReceived = false;
      let websocketCoordination = null;
      
      this.browserBootstrap.on('invitationReceived', (invitationMessage) => {
        console.log(`📨 Browser received invitation with coordination info:`);
        console.log('   Invitation from:', invitationMessage.fromPeer.substring(0, 16) + '...');
        if (invitationMessage.websocketCoordination) {
          console.log('   WebSocket coordination:', invitationMessage.websocketCoordination.instructions);
          websocketCoordination = invitationMessage.websocketCoordination;
        }
        invitationReceived = true;
      });

      // Send invitation from Node.js to Browser
      const success = await this.nodeClient.inviteNewClient(browserNodeId);
      
      if (success) {
        console.log(`✅ Invitation sent successfully`);
        
        // Wait a bit for invitation to be received
        await this.delay(2000);
        
        if (invitationReceived && websocketCoordination) {
          console.log(`✅ Invitation received with WebSocket coordination`);
          console.log(`   Instructions: ${websocketCoordination.instructions}`);
          this.testResults.invitationSent = true;
        } else {
          console.error(`❌ Invitation not received or missing WebSocket coordination`);
        }
      } else {
        console.error(`❌ Failed to send invitation`);
      }
      
    } catch (error) {
      console.error(`❌ Invitation process failed: ${error.message}\\n`);
      throw error;
    }
  }

  async testWebSocketConnection() {
    console.log('\\n📝 Test 4: WebSocket Connection Establishment');
    console.log('--------------------------------------------');

    try {
      // Simulate browser connecting to Node.js WebSocket server
      const nodeStats = this.nodeClient.getStats();
      const websocketAddress = nodeStats.listeningAddress;
      const nodeId = nodeStats.nodeId;
      
      console.log(`🔌 Browser connecting to Node.js WebSocket server:`);
      console.log(`   Target: ${nodeId.substring(0, 16)}...`);
      console.log(`   Address: ${websocketAddress}`);
      
      // Use browser WebRTC manager to connect to Node.js WebSocket server
      const ws = await this.browserWebRTC.createWebSocketConnection(nodeId, websocketAddress);
      
      console.log(`✅ Browser successfully connected to Node.js via WebSocket`);
      console.log(`   Connection established through invitation coordination`);
      
      this.testResults.websocketConnection = true;
      
    } catch (error) {
      console.error(`❌ WebSocket connection failed: ${error.message}\\n`);
      throw error;
    }
  }

  async testDHTMessaging() {
    console.log('\\n📝 Test 5: DHT Messaging over WebSocket');
    console.log('---------------------------------------');

    try {
      const nodeStats = this.nodeClient.getStats();
      const nodeId = nodeStats.nodeId;
      
      // Set up message handler for Node.js client
      let messageReceived = false;
      this.nodeClient.websocketManager.on('message', ({ peerId, message }) => {
        if (message.type === 'invitation_test') {
          console.log(`📨 Node.js received invitation test message from browser`);
          console.log(`   Content: ${message.content}`);
          messageReceived = true;
        }
      });

      // Send test message from browser to Node.js
      console.log(`📤 Browser sending DHT message to Node.js via invitation-coordinated WebSocket...`);
      await this.browserWebRTC.sendMessage(nodeId, {
        type: 'invitation_test',
        content: 'DHT messaging via invitation-coordinated WebSocket!',
        timestamp: Date.now()
      });

      // Wait a bit for message processing
      await this.delay(1000);

      if (messageReceived) {
        console.log(`✅ DHT messaging successful over invitation-coordinated WebSocket`);
        this.testResults.dhtMessaging = true;
      } else {
        console.error(`❌ Message was not received by Node.js client`);
      }
      
    } catch (error) {
      console.error(`❌ DHT messaging failed: ${error.message}\\n`);
      throw error;
    }
  }

  printResults() {
    console.log('\\n📋 Invitation WebSocket Coordination Test Results');
    console.log('================================================');
    
    const results = [
      { name: 'Node Client Start', passed: this.testResults.nodeClientStart },
      { name: 'Browser Client Start', passed: this.testResults.browserClientStart },
      { name: 'Invitation Process', passed: this.testResults.invitationSent },
      { name: 'WebSocket Connection', passed: this.testResults.websocketConnection },
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
      console.log('🎉 All tests passed! Invitation-based WebSocket coordination working correctly.');
      console.log('🔗 Bootstrap server successfully coordinated WebSocket connections during invitations');
    } else {
      console.log('⚠️  Some tests failed. Check the output above for details.');
    }
  }

  async cleanup() {
    console.log('\\n🧹 Cleaning up...');
    
    if (this.browserWebRTC) {
      try {
        this.browserWebRTC.destroy();
        console.log('✅ Browser WebRTCManager destroyed');
      } catch (error) {
        console.error('❌ Error destroying browser WebRTCManager:', error.message);
      }
    }

    if (this.browserClient) {
      try {
        await this.browserClient.stop();
        console.log('✅ Browser DHT client stopped');
      } catch (error) {
        console.error('❌ Error stopping browser DHT client:', error.message);
      }
    }

    if (this.nodeClient) {
      try {
        await this.nodeClient.stop();
        console.log('✅ Node.js DHT client stopped');
      } catch (error) {
        console.error('❌ Error stopping Node.js DHT client:', error.message);
      }
    }
  }

  // Helper method to wait
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Main execution
async function main() {
  const test = new InvitationWebSocketTest();
  await test.runTest();
}

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('\\n🛑 Received SIGTERM, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\\n🛑 Received SIGINT, shutting down gracefully...');
  process.exit(0);
});

main().catch(error => {
  console.error('💥 Test crashed:', error);
  process.exit(1);
});