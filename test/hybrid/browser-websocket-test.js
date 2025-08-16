/**
 * Browser WebSocket Connection Test
 * 
 * Test browser WebSocket connections to Node.js DHT nodes
 * This test simulates the browser side of hybrid DHT networking
 * 
 * Prerequisites:
 * - Bootstrap server must be running: npm run bootstrap:genesis
 * - This test simulates browser WebSocket capabilities using Node.js
 * 
 * Usage:
 * node test/hybrid/browser-websocket-test.js
 */

// Node.js imports (simulating browser environment)
import WebSocket from 'ws';

// DHT imports
import { WebRTCManager } from '../../src/network/WebRTCManager.js';
import { DHTNodeId } from '../../src/core/DHTNodeId.js';
import { NodeDHTClient } from '../../src/node/NodeDHTClient.js';

// Set up WebSocket global for WebRTCManager
global.WebSocket = WebSocket;

class BrowserWebSocketTest {
  constructor() {
    this.browserWebRTC = null;
    this.nodeClient = null;
    this.testResults = {
      nodeClientStart: false,
      browserWebRTCInit: false,
      websocketConnection: false,
      dhtMessaging: false
    };
  }

  async runTest() {
    console.log('🌐 Browser WebSocket Connection Test');
    console.log('====================================\n');

    try {
      // Test 1: Start Node.js DHT Client (target for browser connection)
      await this.testNodeClientStart();
      
      // Test 2: Initialize Browser WebRTCManager
      await this.testBrowserWebRTCInit();
      
      // Test 3: Test WebSocket Connection
      await this.testWebSocketConnection();
      
      // Test 4: Test DHT Messaging
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
    console.log('📝 Test 1: Node.js DHT Client Start (WebSocket Target)');
    console.log('----------------------------------------------------');

    try {
      this.nodeClient = new NodeDHTClient({
        bootstrapServers: ['ws://localhost:8080'],
        port: 0 // Random available port
      });

      const startInfo = await this.nodeClient.start();
      
      console.log(`✅ Node.js DHT client started as WebSocket target`);
      console.log(`   Node ID: ${startInfo.nodeId.substring(0, 16)}...`);
      console.log(`   Listening: ${startInfo.listeningAddress}`);
      console.log(`   Type: ${startInfo.nodeType}\\n`);

      this.testResults.nodeClientStart = true;
      
    } catch (error) {
      console.error(`❌ Node client start failed: ${error.message}\\n`);
      throw error;
    }
  }

  async testBrowserWebRTCInit() {
    console.log('📝 Test 2: Browser WebRTCManager Initialization');
    console.log('----------------------------------------------');

    try {
      // Create a fake browser node ID
      const browserSeed = new Uint8Array(20);
      browserSeed.set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
      const browserNodeId = new DHTNodeId(browserSeed);
      
      this.browserWebRTC = new WebRTCManager({
        timeout: 15000
      });
      
      this.browserWebRTC.initialize(browserNodeId.toString());
      
      console.log(`✅ Browser WebRTCManager initialized`);
      console.log(`   Browser Node ID: ${browserNodeId.toString().substring(0, 16)}...`);
      console.log(`   WebSocket support: Available\\n`);

      this.testResults.browserWebRTCInit = true;
      
    } catch (error) {
      console.error(`❌ Browser WebRTC init failed: ${error.message}\\n`);
      throw error;
    }
  }

  async testWebSocketConnection() {
    console.log('📝 Test 3: Browser → Node.js WebSocket Connection');
    console.log('------------------------------------------------');

    try {
      const nodeStats = this.nodeClient.getStats();
      const websocketAddress = nodeStats.listeningAddress;
      const nodeId = nodeStats.nodeId;
      
      console.log(`🔌 Connecting browser to Node.js WebSocket server:`);
      console.log(`   Target: ${nodeId.substring(0, 16)}...`);
      console.log(`   Address: ${websocketAddress}`);
      
      // Test the WebSocket connection
      const ws = await this.browserWebRTC.createWebSocketConnection(nodeId, websocketAddress);
      
      console.log(`✅ Browser successfully connected to Node.js via WebSocket`);
      console.log(`   Connection type: WebSocket`);
      console.log(`   Status: ${this.browserWebRTC.isConnected(nodeId) ? 'Connected' : 'Disconnected'}`);
      
      this.testResults.websocketConnection = true;
      
    } catch (error) {
      console.error(`❌ WebSocket connection failed: ${error.message}\\n`);
      throw error;
    }
  }

  async testDHTMessaging() {
    console.log('📝 Test 4: DHT Messaging over WebSocket');
    console.log('---------------------------------------');

    try {
      const nodeStats = this.nodeClient.getStats();
      const nodeId = nodeStats.nodeId;
      
      // Set up message handler for Node.js client
      let messageReceived = false;
      this.nodeClient.websocketManager.on('message', ({ peerId, message }) => {
        if (message.type === 'test_message') {
          console.log(`📨 Node.js received message from browser: ${message.content}`);
          messageReceived = true;
        }
      });

      // Send test message from browser to Node.js
      console.log(`📤 Browser sending DHT message to Node.js...`);
      await this.browserWebRTC.sendMessage(nodeId, {
        type: 'test_message',
        content: 'Hello from browser via WebSocket!',
        timestamp: Date.now()
      });

      // Wait a bit for message processing
      await this.delay(1000);

      if (messageReceived) {
        console.log(`✅ DHT messaging over WebSocket successful`);
        console.log(`   Message flow: Browser → Node.js WebSocket → DHT protocol`);
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
    console.log('\\n📋 Browser WebSocket Connection Test Results');
    console.log('===========================================');
    
    const results = [
      { name: 'Node Client Start', passed: this.testResults.nodeClientStart },
      { name: 'Browser WebRTC Init', passed: this.testResults.browserWebRTCInit },
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
      console.log('🎉 All tests passed! Browser WebSocket connections working correctly.');
      console.log('📝 Next step: Test full hybrid DHT network with multiple nodes');
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
  const test = new BrowserWebSocketTest();
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