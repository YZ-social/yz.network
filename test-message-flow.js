/**
 * Message Flow Diagnostic Test
 *
 * This script tests the complete message delivery pipeline:
 * 1. WebSocket receives message → WebSocketConnectionManager.handleMessage()
 * 2. ConnectionManager emits 'data' event
 * 3. DHTNode.messageHandler receives via callback
 * 4. DHTNode calls this.onMessage callback
 * 5. RoutingTable forwards to DHT via this.onNodeAdded callback
 * 6. DHT processes message
 *
 * CRITICAL ARCHITECTURE:
 * - WebSocketConnectionManager handles WebSocket 'message' events (lines 656, 677 in WebSocketConnectionManager.js)
 * - Calls this.handleMessage(peerId, message) (inherited from ConnectionManager base class)
 * - DHTNode sets up its own message handler (lines 142-157 in DHTNode.js)
 * - DHTNode requires this.onMessage callback to be set (line 152)
 * - RoutingTable sets this callback in handlePeerConnected (line 632 in RoutingTable.js)
 * - RoutingTable forwards to DHT via this.onNodeAdded callback
 *
 * POTENTIAL FAILURE POINTS:
 * 1. DHTNode.onMessage callback not set → messages received but not forwarded
 * 2. RoutingTable.onNodeAdded callback not set → messages reach node but not DHT
 * 3. Timing: Callback set AFTER messages arrive → race condition
 * 4. WebSocket event handler not attached → messages never reach connection manager
 */

import { WebSocketConnectionManager } from './src/network/WebSocketConnectionManager.js';
import { RoutingTable } from './src/dht/RoutingTable.js';
import { DHTNode } from './src/core/DHTNode.js';
import { DHTNodeId } from './src/core/DHTNodeId.js';
import { EventEmitter } from 'events';

console.log('🧪 === MESSAGE FLOW DIAGNOSTIC TEST ===\n');

// Create mock WebSocket that simulates incoming messages
class MockWebSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1; // OPEN
  }

  send(data) {
    console.log(`📤 MockWebSocket.send() called with:`, JSON.parse(data).type);
  }

  close() {
    console.log(`🔌 MockWebSocket.close() called`);
  }
}

// Test 1: Verify WebSocket message handler attachment
async function test1_WebSocketHandlerAttachment() {
  console.log('\n📝 TEST 1: WebSocket Message Handler Attachment');
  console.log('================================================');

  const localNodeId = new DHTNodeId();
  const peerNodeId = new DHTNodeId();
  const manager = new WebSocketConnectionManager({
    localNodeId: localNodeId.toString(),
    localNodeType: 'nodejs',
    serverMode: 'client'
  });

  // Initialize manager
  await manager.initialize(localNodeId.toString());

  const mockWs = new MockWebSocket();
  const peerId = peerNodeId.toString();

  // Simulate setupConnection being called
  console.log('🔧 Calling setupConnection...');

  let messageReceived = false;
  manager.on('data', ({ peerId: receivedPeerId, data }) => {
    console.log(`✅ ConnectionManager emitted 'data' event for ${receivedPeerId.substring(0, 8)}: ${data.type}`);
    messageReceived = true;
  });

  // Manually call setupConnection to set up handlers
  manager.peerId = peerId;
  manager.connection = mockWs;
  manager.connectionState = 'connected';

  // Attach WebSocket message handler (this is what setupConnection does)
  mockWs.on('message', (data) => {
    try {
      const dataString = typeof data === 'string' ? data : data.toString();
      const message = JSON.parse(dataString);
      console.log(`📨 WebSocket 'message' event fired: ${message.type}`);
      manager.handleMessage(peerId, message);
    } catch (error) {
      console.error(`❌ Error parsing message:`, error);
    }
  });

  // Simulate incoming message
  console.log('📨 Simulating WebSocket message event...');
  mockWs.emit('message', JSON.stringify({ type: 'test_message', data: 'hello' }));

  setTimeout(() => {
    if (messageReceived) {
      console.log('✅ TEST 1 PASSED: WebSocket message handler working\n');
    } else {
      console.log('❌ TEST 1 FAILED: Message not received by ConnectionManager\n');
    }
  }, 100);
}

// Test 2: Verify DHTNode callback chain
async function test2_DHTNodeCallbackChain() {
  console.log('\n📝 TEST 2: DHTNode Callback Chain');
  console.log('====================================');

  const nodeId = new DHTNodeId();
  const node = new DHTNode(nodeId);
  const mockWs = new MockWebSocket();
  const mockManager = new EventEmitter();
  mockManager.isConnected = () => true;
  mockManager.sendMessage = async () => {};

  console.log('🔧 Setting up node with connection...');
  node.setupConnection(mockManager, mockWs);

  let callbackCalled = false;
  console.log('🔧 Setting onMessage callback...');
  node.setMessageCallback((peerId, data) => {
    console.log(`✅ DHTNode.onMessage callback fired for ${peerId.substring(0, 8)}: ${data.type}`);
    callbackCalled = true;
  });

  // Simulate message event
  console.log('📨 Simulating message event on connection...');
  mockWs.emit('message', { data: JSON.stringify({ type: 'test_message', data: 'hello' }) });

  setTimeout(() => {
    if (callbackCalled) {
      console.log('✅ TEST 2 PASSED: DHTNode callback chain working\n');
    } else {
      console.log('❌ TEST 2 FAILED: DHTNode.onMessage callback not called\n');
    }
  }, 100);
}

// Test 3: Verify RoutingTable callback setup
async function test3_RoutingTableCallbackSetup() {
  console.log('\n📝 TEST 3: RoutingTable Callback Setup');
  console.log('=========================================');

  const localNodeId = new DHTNodeId();
  const peerNodeId = new DHTNodeId();
  const routingTable = new RoutingTable(localNodeId);

  let dhtMessageReceived = false;

  // Set up the DHT callback (this is what KademliaDHT does)
  console.log('🔧 Setting onNodeAdded callback (simulating DHT setup)...');
  routingTable.onNodeAdded = (eventType, data) => {
    console.log(`✅ RoutingTable.onNodeAdded callback fired: ${eventType}`, data);
    if (eventType === 'message') {
      dhtMessageReceived = true;
    }
  };

  const mockWs = new MockWebSocket();
  const mockManager = new EventEmitter();
  mockManager.isConnected = () => true;
  mockManager.sendMessage = async () => {};

  // Simulate handlePeerConnected being called
  console.log('🔧 Calling handlePeerConnected...');
  routingTable.handlePeerConnected(peerNodeId.toString(), mockWs, mockManager, true, {});

  // Get the node and simulate message
  const node = routingTable.getNode(peerNodeId.toString());
  if (node) {
    console.log('📨 Simulating message on node...');
    mockWs.emit('message', { data: JSON.stringify({ type: 'test_message', data: 'hello' }) });
  } else {
    console.log('❌ Node not found in routing table');
  }

  setTimeout(() => {
    if (dhtMessageReceived) {
      console.log('✅ TEST 3 PASSED: RoutingTable → DHT callback working\n');
    } else {
      console.log('❌ TEST 3 FAILED: Message did not reach DHT callback\n');
    }
  }, 100);
}

// Test 4: Complete end-to-end flow
async function test4_EndToEndFlow() {
  console.log('\n📝 TEST 4: Complete End-to-End Message Flow');
  console.log('==============================================');

  const localNodeId = new DHTNodeId();
  const peerNodeId = new DHTNodeId();

  // Create routing table
  const routingTable = new RoutingTable(localNodeId);

  let messageReachedDHT = false;
  routingTable.onNodeAdded = (eventType, data) => {
    if (eventType === 'message') {
      console.log(`✅ [DHT] Received message: ${data.data.type}`);
      messageReachedDHT = true;
    }
  };

  // Create connection manager
  const manager = new WebSocketConnectionManager({
    localNodeId: localNodeId.toString(),
    localNodeType: 'nodejs',
    serverMode: 'client',
    routingTable: routingTable
  });
  await manager.initialize(localNodeId.toString());

  // Create mock WebSocket
  const mockWs = new MockWebSocket();
  const peerId = peerNodeId.toString();

  // Set up the connection using routing table (this is what happens in production)
  console.log('🔧 Setting up connection via routing table...');
  await routingTable.handlePeerConnected(peerId, mockWs, manager, true, {});

  // Verify node was created
  const node = routingTable.getNode(peerId);
  if (!node) {
    console.log('❌ Node not created in routing table');
    return;
  }

  console.log('✅ Node created in routing table');
  console.log(`   - Has connectionManager: ${!!node.connectionManager}`);
  console.log(`   - Has connection: ${!!node.connection}`);
  console.log(`   - Event handlers setup: ${node.eventHandlersSetup}`);
  console.log(`   - Has onMessage callback: ${!!node.onMessage}`);

  // Now set up WebSocket handlers (this is what setupConnection does)
  mockWs.on('message', (data) => {
    try {
      const dataString = typeof data === 'string' ? data : data.toString();
      const message = JSON.parse(dataString);
      console.log(`📨 [WebSocket] Message event: ${message.type}`);
      manager.handleMessage(peerId, message);
    } catch (error) {
      console.error(`❌ Error parsing message:`, error);
    }
  });

  // Send test message
  console.log('📨 Sending test message through WebSocket...');
  mockWs.emit('message', JSON.stringify({
    type: 'create_invitation_for_peer',
    targetPeer: localNodeId.toString(),
    targetNodeId: 'test123',
    fromBridge: peerId
  }));

  setTimeout(() => {
    if (messageReachedDHT) {
      console.log('\n✅ TEST 4 PASSED: Complete message flow working!\n');
    } else {
      console.log('\n❌ TEST 4 FAILED: Message did not reach DHT\n');
      console.log('Debugging info:');
      console.log(`   - Node exists: ${!!node}`);
      console.log(`   - Node.onMessage set: ${!!node?.onMessage}`);
      console.log(`   - RoutingTable.onNodeAdded set: ${!!routingTable.onNodeAdded}`);
    }
  }, 200);
}

// Run all tests
(async () => {
  await test1_WebSocketHandlerAttachment();
  await new Promise(resolve => setTimeout(resolve, 200));

  await test2_DHTNodeCallbackChain();
  await new Promise(resolve => setTimeout(resolve, 200));

  await test3_RoutingTableCallbackSetup();
  await new Promise(resolve => setTimeout(resolve, 200));

  await test4_EndToEndFlow();
  await new Promise(resolve => setTimeout(resolve, 300));

  console.log('\n🎯 === TEST SUITE COMPLETE ===\n');
  process.exit(0);
})();
