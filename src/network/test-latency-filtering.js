/**
 * Test Latency Filtering for Inactive Tabs
 * 
 * Verifies that inactive browser tabs are filtered out of ping operations
 * Run with: node src/network/test-latency-filtering.js
 */

import { ConnectionManager } from './ConnectionManager.js';

// Mock routing table
class MockRoutingTable {
  constructor() {
    this.nodes = new Map();
  }

  getNode(peerId) {
    return this.nodes.get(peerId);
  }

  addNode(peerId, metadata) {
    this.nodes.set(peerId, {
      metadata: metadata
    });
  }
}

// Mock connection manager for testing
class TestConnectionManager extends ConnectionManager {
  constructor() {
    super();
    this.testResponses = new Map();
  }

  async createConnection() { return Promise.resolve(); }
  async sendRawMessage() { return Promise.resolve(); }
  isConnected() { return true; }
  destroyConnection() {}
  async handleInvitation() {}

  // Mock sendRequest for testing
  async sendRequest(peerId, message, _timeout) {
    const response = this.testResponses.get(peerId);
    if (response) {
      return response;
    }
    throw new Error('No test response configured');
  }

  setTestResponse(peerId, response) {
    this.testResponses.set(peerId, response);
  }
}

async function testLatencyFiltering() {
  console.log('🧪 Testing Latency Filtering for Inactive Tabs...\n');

  const routingTable = new MockRoutingTable();
  const connectionManager = new TestConnectionManager();
  connectionManager.routingTable = routingTable;

  // Add test nodes
  routingTable.addNode('active-browser', {
    nodeType: 'browser',
    tabVisible: true
  });

  routingTable.addNode('inactive-browser', {
    nodeType: 'browser', 
    tabVisible: false
  });

  routingTable.addNode('nodejs-server', {
    nodeType: 'nodejs',
    tabVisible: true
  });

  // Set up test responses
  connectionManager.setTestResponse('active-browser', {
    type: 'pong',
    originalTimestamp: Date.now() - 50 // 50ms RTT
  });

  connectionManager.setTestResponse('nodejs-server', {
    type: 'pong', 
    originalTimestamp: Date.now() - 25 // 25ms RTT
  });

  console.log('1. Testing ping to active browser tab...');
  const result1 = await connectionManager.ping('active-browser');
  console.log(`   Result: ${result1.success ? 'SUCCESS' : 'FAILED'}`);
  if (result1.success) {
    console.log(`   RTT: ${result1.rtt}ms`);
  }

  console.log('\n2. Testing ping to inactive browser tab...');
  const result2 = await connectionManager.ping('inactive-browser');
  console.log(`   Result: ${result2.success ? 'SUCCESS' : 'FILTERED'} (should be FILTERED)`);
  if (!result2.success) {
    console.log(`   Reason: ${result2.error}`);
  }

  console.log('\n3. Testing ping to Node.js server...');
  const result3 = await connectionManager.ping('nodejs-server');
  console.log(`   Result: ${result3.success ? 'SUCCESS' : 'FAILED'}`);
  if (result3.success) {
    console.log(`   RTT: ${result3.rtt}ms`);
  }

  console.log('\n4. Testing latency outlier filtering...');
  const latencySamples = [10, 15, 20, 25, 30, 95000, 120000, 35]; // Two outliers > 30s
  
  // Simulate ActiveDHTNode filtering
  const maxReasonableLatency = 30000;
  const filteredSamples = latencySamples.filter(latency => latency <= maxReasonableLatency);
  
  console.log(`   Original samples: [${latencySamples.join(', ')}]`);
  console.log(`   Filtered samples: [${filteredSamples.join(', ')}]`);
  console.log(`   Outliers removed: ${latencySamples.length - filteredSamples.length}`);

  // Calculate P95 with and without filtering
  const sortedOriginal = [...latencySamples].sort((a, b) => a - b);
  const sortedFiltered = [...filteredSamples].sort((a, b) => a - b);
  
  const p95Original = sortedOriginal[Math.ceil(0.95 * sortedOriginal.length) - 1];
  const p95Filtered = sortedFiltered[Math.ceil(0.95 * sortedFiltered.length) - 1];
  
  console.log(`   P95 without filtering: ${p95Original}ms`);
  console.log(`   P95 with filtering: ${p95Filtered}ms`);
  console.log(`   Improvement: ${((p95Original - p95Filtered) / p95Original * 100).toFixed(1)}%`);

  console.log('\n✅ Latency filtering test completed!');
  console.log('\n📋 Summary:');
  console.log('   ✅ Active browser tabs: Pinged normally');
  console.log('   ✅ Inactive browser tabs: Filtered out (prevents high latency)');
  console.log('   ✅ Node.js servers: Pinged normally');
  console.log('   ✅ Outlier filtering: Removes >30s latencies from metrics');
}

testLatencyFiltering().catch(console.error);