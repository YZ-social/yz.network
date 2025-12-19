/**
 * Test script to verify inactive tab filtering in connection managers
 */

import { ConnectionManager } from './ConnectionManager.js';
import { WebSocketConnectionManager } from './WebSocketConnectionManager.js';

// Mock routing table for testing
class MockRoutingTable {
  constructor() {
    this.nodes = new Map();
  }

  getNode(peerId) {
    return this.nodes.get(peerId);
  }

  addNode(peerId, metadata) {
    this.nodes.set(peerId, { metadata });
  }
}

// Mock WebSocket connection manager for testing
class TestWebSocketConnectionManager extends WebSocketConnectionManager {
  constructor(options = {}) {
    super({ ...options, localNodeType: 'nodejs', enableServer: false });
    this.mockConnected = false;
    this.mockPeerId = null;
  }

  isConnected() {
    return this.mockConnected;
  }

  async sendRawMessage(peerId, message) {
    // Mock implementation - just log the message
    console.log(`📤 Mock sending message to ${peerId}:`, message.type);
    return true;
  }

  // Mock connection setup
  mockConnect(peerId) {
    this.mockConnected = true;
    this.mockPeerId = peerId;
    this.peerId = peerId;
  }
}

async function testInactiveTabFiltering() {
  console.log('🧪 Testing inactive tab filtering in connection managers...\n');

  // Create mock routing table
  const routingTable = new MockRoutingTable();

  // Test 1: Base ConnectionManager ping filtering
  console.log('📋 Test 1: Base ConnectionManager ping filtering');
  const baseManager = new ConnectionManager({ routingTable });
  baseManager.initialize('test-node-1');

  // Add active browser tab
  const activeBrowserPeer = 'browser-active-123';
  routingTable.addNode(activeBrowserPeer, {
    nodeType: 'browser',
    tabVisible: true
  });

  // Add inactive browser tab
  const inactiveBrowserPeer = 'browser-inactive-456';
  routingTable.addNode(inactiveBrowserPeer, {
    nodeType: 'browser',
    tabVisible: false
  });

  // Add Node.js peer
  const nodejsPeer = 'nodejs-peer-789';
  routingTable.addNode(nodejsPeer, {
    nodeType: 'nodejs'
  });

  // Test pinging active browser (should work)
  console.log('  Testing ping to active browser tab...');
  const activeResult = await baseManager.ping(activeBrowserPeer);
  console.log('  Result:', activeResult.success ? 'ALLOWED' : `BLOCKED: ${activeResult.error}`);

  // Test pinging inactive browser (should be blocked)
  console.log('  Testing ping to inactive browser tab...');
  const inactiveResult = await baseManager.ping(inactiveBrowserPeer);
  console.log('  Result:', inactiveResult.success ? 'ALLOWED' : `BLOCKED: ${inactiveResult.error}`);

  // Test pinging Node.js peer (should work)
  console.log('  Testing ping to Node.js peer...');
  const nodejsResult = await baseManager.ping(nodejsPeer);
  console.log('  Result:', nodejsResult.success ? 'ALLOWED' : `BLOCKED: ${nodejsResult.error}`);

  console.log();

  // Test 2: WebSocketConnectionManager sendPingToConnectedPeer filtering
  console.log('📋 Test 2: WebSocketConnectionManager sendPingToConnectedPeer filtering');
  const wsManager = new TestWebSocketConnectionManager({ routingTable });
  wsManager.initialize('test-node-2');

  // Test with active browser tab
  console.log('  Testing sendPingToConnectedPeer with active browser tab...');
  wsManager.mockConnect(activeBrowserPeer);
  await wsManager.sendPingToConnectedPeer();
  console.log('  ✅ Active browser tab ping completed');

  // Test with inactive browser tab
  console.log('  Testing sendPingToConnectedPeer with inactive browser tab...');
  wsManager.mockConnect(inactiveBrowserPeer);
  await wsManager.sendPingToConnectedPeer();
  console.log('  ✅ Inactive browser tab ping completed (should be skipped)');

  // Test with Node.js peer
  console.log('  Testing sendPingToConnectedPeer with Node.js peer...');
  wsManager.mockConnect(nodejsPeer);
  await wsManager.sendPingToConnectedPeer();
  console.log('  ✅ Node.js peer ping completed');

  console.log();
  console.log('🎉 Inactive tab filtering tests completed!');
  console.log('📊 Expected results:');
  console.log('  - Active browser tabs: ALLOWED');
  console.log('  - Inactive browser tabs: BLOCKED (prevents high latency)');
  console.log('  - Node.js peers: ALLOWED');
}

// Run the test
testInactiveTabFiltering().catch(console.error);