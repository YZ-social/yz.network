import { PassiveBridgeNode } from './src/bridge/PassiveBridgeNode.js';
import { EnhancedBootstrapServer } from './src/bridge/EnhancedBootstrapServer.js';
import { NodeDHTClient } from './src/node/NodeDHTClient.js';

const MAX_CONNECTIONS = 20; // Per node, for various kinds of nodes.
const BOOTSTRAP_PORT = 8080;
const BOOTSTRAP_SERVERS = [`ws://localhost:${BOOTSTRAP_PORT}`];

function delay(ms) { // Should not need this, but I'm being conservative while figuring things out.
  return new Promise(resolve => setTimeout(resolve, ms));
}

const bridges = []; // Keeps from gc.
async function configureBridges({number = 2, listeningPort = 8083, dhtPort = 9083, auth = 'default-bridge-auth-key'} = {}) {
  console.log(`\n🌉 Starting ${number} bridge node(s)...`);

  // Start bridge nodes sequentially to ensure proper initialization
  for (let i = 0; i < number; i++) {
    const currentBridgePort = listeningPort + i;
    const currentDhtPort = dhtPort + i;

    console.log(`📍 Bridge ${i + 1}: Bridge port ${currentBridgePort}, DHT port ${currentDhtPort}`);

    const bridge = new PassiveBridgeNode({
      bridgePort: currentBridgePort,
      bridgeAuth: auth,
      maxConnections: MAX_CONNECTIONS,
      dhtOptions: {
        bootstrapServers: BOOTSTRAP_SERVERS
        // Note: PassiveBridgeNode creates its own ConnectionManager via factory
        // No need to pass webrtc parameter - it's handled internally
      },
      connectionOptions: {
        maxConnections: MAX_CONNECTIONS
      }
    });

    await bridge.start();
    bridges.push(bridge);
    testResults.infrastructure.bridges++;
    console.log(`✅ Bridge ${i + 1} started successfully`);
  }

  console.log(`✅ All ${number} bridge node(s) started\n`);
}

let server;
async function configureBootstrap({port = BOOTSTRAP_PORT, auth = 'default-bridge-auth-key'} = {}) {
  console.log(`\n🚀 Starting bootstrap server on port ${port}...`);

  // Start the bootstrap server.
  server = new EnhancedBootstrapServer({
    port,
    createNewDHT: true,
    bridgeAuth: auth,
    bridgeNodes: bridges.map(bridge => `${bridge.bridgeHost}:${bridge.bridgePort}`)
  });

  await server.start();
  testResults.infrastructure.bootstrap = true;
  console.log(`✅ Bootstrap server started on port ${port}\n`);

  return server;
}

let nodes = [];
let testResults = {
  timestamp: new Date().toISOString(),
  infrastructure: { bridges: 0, bootstrap: false, clients: 0 },
  tests: [],
  errors: []
};

async function configureNodes({number = 4} = {}) {
  console.log(`\n👥 Starting ${number} Node.js DHT client(s)...`);

  // Start a number of bots. The first is authorized as the genesis, and it invites all the rest.
  for (let i = 0; i < number; i++) {
    console.log(`📍 Starting Node.js client ${i + 1}/${number}...`);

    const client = new NodeDHTClient({bootstrapServers: BOOTSTRAP_SERVERS, port: 0});
    await client.start();

    if (nodes.length) { // First node in is authorized.
      console.log(`📨 Node 0 inviting Node ${i}...`);
      await nodes[0].inviteNewClient(client.nodeId.toString());
      await delay(2e3); // Increased delay to ensure invitation completes
    }

    nodes.push(client);
    console.log(`✅ Node.js client ${i + 1} started (ID: ${client.nodeId.toString().substring(0, 8)}...)`);

    // Add small delay between starting clients
    if (i < number - 1) {
      await delay(1e3);
    }
  }

  testResults.infrastructure.clients = nodes.length;
  console.log(`✅ All ${number} Node.js client(s) started\n`);
}

async function testDHTOperations() {
  console.log('\n🧪 Testing DHT operations...\n');

  const runTest = async (name, testFn) => {
    const startTime = Date.now();
    try {
      const result = await testFn();
      if (!result) throw new Error('test returned false');
      const duration = Date.now() - startTime;
      testResults.tests.push({ name, status: 'PASS', duration, result });
      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      testResults.tests.push({ name, status: 'FAIL', duration, error: error.message });
      throw error;
    }
  };

  try {
    // Wait for connections to stabilize
    console.log('⏳ Waiting for DHT network to stabilize...');
    await delay(15e3);

    // Test 1: Node 0 stores and retrieves
    console.log('Test 1: Node 0 storing "test-key"...');
    const test1Result = await runTest('Node 0 store/retrieve', async () => {
      await nodes[0].store('test-key', 'Hello from Node 0');
      await delay(1e3);
      const value = await nodes[0].get('test-key');
      console.log('✅ Node 0 retrieved value:', value);
      return value === 'Hello from Node 0';
    });

    // Test 2: Node 1 retrieves Node 0's data
    console.log('\nTest 2: Node 1 retrieving "test-key" (stored by Node 0)...');
    await delay(1e3);
    const test2Result = await runTest('Node 1 retrieve cross-node', async () => {
      const value = await nodes[1].get('test-key');
      console.log('✅ Node 1 retrieved value:', value);
      return value === 'Hello from Node 0';
    });

    // Test 3: Node 2 stores and retrieves
    console.log('\nTest 3: Node 2 storing "test-key2"...');
    const test3Result = await runTest('Node 2 store/retrieve', async () => {
      await nodes[2].store('test-key2', 'Hello from Node 2');
      await delay(1e3);
      const value = await nodes[2].get('test-key2');
      console.log('✅ Node 2 retrieved value:', value);
      return value === 'Hello from Node 2';
    });

    // Test 4: Node 3 retrieves Node 2's data
    console.log('\nTest 4: Node 3 retrieving "test-key2" (stored by Node 2)...');
    await delay(1e3);
    const test4Result = await runTest('Node 3 retrieve cross-node', async () => {
      const value = await nodes[3].get('test-key2');
      console.log('✅ Node 3 retrieved value:', value);
      return value === 'Hello from Node 2';
    });

    // Test 5: Check network topology
    console.log('\nTest 5: Checking network topology...');
    const topologyData = await runTest('Network topology check', async () => {
      const topology = [];
      for (let i = 0; i < nodes.length; i++) {
        const connectedPeers = nodes[i].dht.getConnectedPeers().length;
        const routingTableSize = nodes[i].dht.routingTable.getAllNodes().length;
        topology.push({ node: i, connected: connectedPeers, routing: routingTableSize });
        console.log(`Node ${i}: ${connectedPeers} connected, ${routingTableSize} in routing table`);
      }
      return topology;
    });

    console.log('\n✅ All DHT operations completed successfully!\n');
  } catch (error) {
    console.error('\n❌ DHT operation failed:', error);
    testResults.errors.push({ phase: 'testDHTOperations', error: error.message, stack: error.stack });
    throw error;
  }
}

let isCleaningUp = false;
async function cleanup() {
  if (isCleaningUp) {
    console.log('⚠️ Cleanup already in progress, please wait...');
    return false;
  }

  isCleaningUp = true;
  const cleanupStart = Date.now();
  console.log('\n🧹 Cleaning up...');

  // Helper to add timeout to async operations
  const withTimeout = (promise, timeoutMs, label) => {
    return Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`${label} timeout after ${timeoutMs}ms`)), timeoutMs)
      )
    ]);
  };

  // Stop nodes (2 seconds timeout each)
  for (let i = 0; i < nodes.length; i++) {
    try {
      console.log(`Stopping Node.js client ${i + 1}...`);
      await withTimeout(nodes[i].stop(), 2000, `Node ${i + 1} stop`);
      console.log(`✓ Node.js client ${i + 1} stopped`);
    } catch (error) {
      console.error(`⚠️ Error stopping client ${i + 1}:`, error.message);
    }
  }

  // Stop bootstrap server (2 seconds timeout)
  if (server) {
    try {
      console.log('Stopping bootstrap server...');
      await withTimeout(server.stop(), 2000, 'Bootstrap server stop');
      console.log('✓ Bootstrap server stopped');
    } catch (error) {
      console.error('⚠️ Error stopping bootstrap server:', error.message);
    }
  }

  // Stop bridge nodes (2 seconds timeout each)
  for (let i = 0; i < bridges.length; i++) {
    try {
      console.log(`Stopping bridge node ${i + 1}...`);
      await withTimeout(bridges[i].stop(), 2000, `Bridge ${i + 1} stop`);
      console.log(`✓ Bridge node ${i + 1} stopped`);
    } catch (error) {
      console.error(`⚠️ Error stopping bridge ${i + 1}:`, error.message);
    }
  }

  const cleanupDuration = Date.now() - cleanupStart;
  console.log(`✅ Cleanup complete in ${cleanupDuration}ms\n`);

  // Display test results summary
  return displayTestResults();
}

function displayTestResults() {
  console.log('\n' + '='.repeat(70));
  console.log('📊 TEST RESULTS SUMMARY');
  console.log('='.repeat(70));
  console.log(`Timestamp: ${testResults.timestamp}`);
  console.log();

  // Infrastructure summary
  console.log('🏗️  Infrastructure:');
  console.log(`   Bridge Nodes:      ${testResults.infrastructure.bridges}`);
  console.log(`   Bootstrap Server:  ${testResults.infrastructure.bootstrap ? '✓' : '✗'}`);
  console.log(`   DHT Clients:       ${testResults.infrastructure.clients}`);
  console.log();

  // Test results
  const passed = testResults.tests.filter(t => t.status === 'PASS').length;
  const failed = testResults.tests.filter(t => t.status === 'FAIL').length;
  const total = testResults.tests.length;

  console.log(`🧪 Tests: ${passed}/${total} passed, ${failed} failed`);
  console.log();

  let success = true; // If any fail, flip it false.
  if (testResults.tests.length > 0) {
    testResults.tests.forEach((test, idx) => {
      success &&= test.status;
      const icon = test.status === 'PASS' ? '✅' : '❌';
      const duration = test.duration ? `(${test.duration}ms)` : '';
      console.log(`   ${icon} ${test.name} ${duration}`);
      if (test.status === 'FAIL') {
        console.log(`      Error: ${test.error}`);
      }
    });
    console.log();
    return success;
  }

  // Network topology (if available)
  const topologyTest = testResults.tests.find(t => t.name === 'Network topology check');
  if (topologyTest && topologyTest.result) {
    console.log('🌐 Final Network Topology:');
    topologyTest.result.forEach(node => {
      console.log(`   Node ${node.node}: ${node.connected} connected, ${node.routing} in routing table`);
    });
    console.log();
  }

  // Errors
  if (testResults.errors.length > 0) {
    console.log('⚠️  Errors encountered:');
    testResults.errors.forEach((err, idx) => {
      console.log(`   ${idx + 1}. ${err.phase}: ${err.error}`);
    });
    console.log();
  }

  // Overall status
  const overallStatus = failed === 0 && testResults.errors.length === 0 ? '✅ PASSED' : '❌ FAILED';
  console.log('='.repeat(70));
  console.log(`Overall Status: ${overallStatus}`);
  console.log('='.repeat(70) + '\n');
}

async function main() {
  console.log('🎬 Starting router_claude.js test script...\n');

  try {
    // Start infrastructure
    await configureBridges();
    await delay(1e3);

    await configureBootstrap();
    await delay(5e3);

    // Start DHT clients
    await configureNodes();

    // Run tests
    await testDHTOperations();

    console.log('✅ Test script completed successfully!');
    //console.log('Press Ctrl+C to exit and cleanup...');
    process.exit(await cleanup() ? 0 : 1);  // Report and exit.
  } catch (error) {
    console.error('\n❌ Test script failed:', error);
    await cleanup();
    process.exit(1);
  }
}

// Handle cleanup on exit
process.on('SIGINT', () => {
  console.log('\n\n⚠️ Received SIGINT signal');

  // Force exit after 15 seconds if cleanup hangs
  // (4 nodes × 2s + 1 server × 2s + 2 bridges × 2s = 14s theoretical max)
  const forceExitTimer = setTimeout(() => {
    console.error('\n❌ Cleanup timeout - forcing exit');
    process.exit(1);
  }, 15000);

  cleanup().then(() => {
    clearTimeout(forceExitTimer);
    console.log('✅ Cleanup finished, exiting...');
    process.exit(0);
  }).catch((error) => {
    clearTimeout(forceExitTimer);
    console.error('❌ Cleanup error:', error);
    process.exit(1);
  });
});

process.on('SIGTERM', () => {
  console.log('\n\n⚠️ Received SIGTERM signal');

  // Force exit after 15 seconds if cleanup hangs
  // (4 nodes × 2s + 1 server × 2s + 2 bridges × 2s = 14s theoretical max)
  const forceExitTimer = setTimeout(() => {
    console.error('\n❌ Cleanup timeout - forcing exit');
    process.exit(1);
  }, 15000);

  cleanup().then(() => {
    clearTimeout(forceExitTimer);
    console.log('✅ Cleanup finished, exiting...');
    process.exit(0);
  }).catch((error) => {
    clearTimeout(forceExitTimer);
    console.error('❌ Cleanup error:', error);
    process.exit(1);
  });
});

// Run main function
main().catch(async (error) => {
  console.error('\n❌ Unhandled error in main:', error);
  await cleanup();
  process.exit(1);
});
