/**
 * Simple WebSocket Connection Test
 * 
 * Test basic WebSocket connection between browser and Node.js without DHT complexity
 * 
 * Usage: node test/hybrid/simple-websocket-test.js
 */

// Node.js imports (simulating browser environment)
import WebSocket from 'ws';
import { WebSocketServer } from 'ws';

// Set up WebSocket global
global.WebSocket = WebSocket;

// DHT imports
import { WebRTCManager } from '../../src/network/WebRTCManager.js';
import { DHTNodeId } from '../../src/core/DHTNodeId.js';

class SimpleWebSocketTest {
  constructor() {
    this.server = null;
    this.browserWebRTC = null;
    this.serverPort = 0;
  }

  async runTest() {
    console.log('🔗 Simple WebSocket Connection Test');
    console.log('=================================\n');

    try {
      // Step 1: Create WebSocket server
      await this.createWebSocketServer();
      
      // Step 2: Create browser WebRTC manager
      await this.createBrowserWebRTC();
      
      // Step 3: Test WebSocket connection
      await this.testWebSocketConnection();
      
      console.log('✅ All tests passed! WebSocket connections working correctly.');
      
    } catch (error) {
      console.error('❌ Test failed:', error);
      console.error('Stack:', error.stack);
    } finally {
      await this.cleanup();
    }
  }

  async createWebSocketServer() {
    console.log('📝 Step 1: Creating WebSocket Server');
    console.log('-----------------------------------');

    return new Promise((resolve, reject) => {
      this.server = new WebSocketServer({ port: 0 });
      
      this.server.on('listening', () => {
        const address = this.server.address();
        this.serverPort = address.port;
        console.log(`🚀 WebSocket server listening on port ${this.serverPort}`);
        
        // Set up connection handler
        this.server.on('connection', (ws, request) => {
          console.log('📥 Incoming connection from:', request.socket.remoteAddress);
          
          ws.on('message', (data) => {
            try {
              const message = JSON.parse(data.toString());
              console.log('📨 Server received:', message.type, message);
              
              if (message.type === 'handshake') {
                ws.send(JSON.stringify({
                  type: 'handshake_response',
                  peerId: 'test-server-node',
                  success: true
                }));
              } else if (message.type === 'test_message') {
                console.log('✅ Server received test message:', message.content);
                ws.send(JSON.stringify({
                  type: 'test_response',
                  content: 'Hello back from server!'
                }));
              }
            } catch (error) {
              console.error('❌ Error parsing message:', error);
            }
          });
          
          ws.on('close', () => {
            console.log('🔌 Server connection closed');
          });
          
          ws.on('error', (error) => {
            console.error('❌ Server WebSocket error:', error);
          });
        });
        
        resolve();
      });
      
      this.server.on('error', reject);
    });
  }

  async createBrowserWebRTC() {
    console.log('\n📝 Step 2: Creating Browser WebRTCManager');
    console.log('----------------------------------------');

    // Create a fake browser node ID
    const browserSeed = new Uint8Array(20);
    browserSeed.set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    const browserNodeId = new DHTNodeId(browserSeed);
    
    this.browserWebRTC = new WebRTCManager({
      timeout: 10000
    });
    
    this.browserWebRTC.initialize(browserNodeId.toString());
    
    console.log('✅ Browser WebRTCManager initialized');
    console.log(`   Node ID: ${browserNodeId.toString().substring(0, 16)}...`);
  }

  async testWebSocketConnection() {
    console.log('\n📝 Step 3: Testing WebSocket Connection');
    console.log('--------------------------------------');

    const websocketAddress = `ws://localhost:${this.serverPort}`;
    const targetPeerId = 'test-server-node';
    
    console.log(`🔌 Connecting to WebSocket server at ${websocketAddress}`);
    
    // Test the WebSocket connection
    const ws = await this.browserWebRTC.createWebSocketConnection(targetPeerId, websocketAddress);
    
    console.log('✅ WebSocket connection established');
    console.log(`   Connection type: WebSocket`);
    console.log(`   Status: ${this.browserWebRTC.isConnected(targetPeerId) ? 'Connected' : 'Disconnected'}`);
    
    // Test message sending
    console.log('\n📤 Testing message sending...');
    
    let messageReceived = false;
    
    // Set up message handler
    this.browserWebRTC.on('message', ({ peerId, message }) => {
      if (message.type === 'test_response') {
        console.log('📨 Browser received response:', message.content);
        messageReceived = true;
      }
    });
    
    // Send test message
    await this.browserWebRTC.sendMessage(targetPeerId, {
      type: 'test_message',
      content: 'Hello from browser via WebSocket!',
      timestamp: Date.now()
    });
    
    // Wait for response
    await this.delay(1000);
    
    if (messageReceived) {
      console.log('✅ Message exchange successful');
    } else {
      throw new Error('No response received from server');
    }
  }

  async cleanup() {
    console.log('\n🧹 Cleaning up...');
    
    if (this.browserWebRTC) {
      this.browserWebRTC.destroy();
      console.log('✅ Browser WebRTCManager destroyed');
    }
    
    if (this.server) {
      this.server.close(() => {
        console.log('✅ WebSocket server closed');
      });
    }
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Main execution
async function main() {
  const test = new SimpleWebSocketTest();
  await test.runTest();
}

main().catch(error => {
  console.error('💥 Test crashed:', error);
  process.exit(1);
});