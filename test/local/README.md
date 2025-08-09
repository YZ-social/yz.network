# Local DHT Network Tests

This directory contains integration tests that require real network connections and should be run locally, **NOT in CI/GitHub Actions**.

## Prerequisites

Before running these tests, you need to start the bootstrap server:

```bash
# In one terminal
npm run bootstrap:genesis

# In another terminal
cd test/local
node dht-network-test.js
```

## Test Files

### `basic-dht-concept-test.js`

A **working** DHT algorithm test that validates core concepts without network complexity:

- ✅ **100% Success Rate** - Validates DHT mathematical foundations
- ✅ **No Network Dependencies** - Pure algorithmic testing
- ✅ **Fast Execution** - Completes in seconds
- ✅ **Configurable Scale** - Easily test 100s of nodes and data items

```bash
npm run test:concept
```

**What it tests:**
- Node ID generation and XOR distance calculation
- Data key hashing and closest node selection  
- DHT storage distribution across nodes
- Lookup routing through closest nodes
- Replication factor effectiveness

**Example Output:**
```
🚀 Basic DHT Concept Test
Creating 100 nodes, storing 50 items

✅ Created 100 virtual nodes
✅ Stored 50 items
📊 Storage distribution: avg=1.5, min=0, max=4

🔍 Testing DHT lookups...
Success rate: 100.0%
Average lookup hops: 2.0
🎉 EXCELLENT - DHT algorithm working perfectly!
```

### `dht-network-test.js`

A comprehensive DHT network test that:

1. **Creates a real DHT network** with configurable number of nodes
2. **Establishes WebRTC connections** between nodes via bootstrap server
3. **Stores test data** across the network using DHT replication
4. **Verifies data reachability** from random nodes
5. **Reports success rates** and network statistics

#### Test Parameters

You can modify these parameters at the top of the file:

```javascript
const TEST_PARAMS = {
  NODE_COUNT: 10,           // Number of DHT nodes to create
  DATA_COUNT: 50,           // Number of key-value pairs to store
  CHECK_NODES: 5,           // Number of nodes to verify data from
  BOOTSTRAP_URL: 'ws://localhost:8080',
  CONNECTION_TIMEOUT: 30000, // 30 second timeout for connections
  STORE_DELAY: 100,         // ms between stores
  LOOKUP_TIMEOUT: 10000,    // ms timeout for lookups
  NETWORK_STABILIZE_TIME: 15000, // Time to let network stabilize
  REPLICATION_FACTOR: 3     // DHT replication factor
};
```

#### Example Output

```
🚀 Starting DHT Network Test
Parameters: 10 nodes, 50 data items

📡 Checking bootstrap server...
✅ Bootstrap server is running

📦 Creating 10 DHT nodes...
  Node 0: a1b2c3d4...
  🌟 Node 0 set as genesis peer
  Node 1: e5f6g7h8...
  ...
✅ Created 10 nodes

⏳ Waiting 15s for network to stabilize...
  Connections: 45 total, 4.5 avg per node

📊 Network Statistics:
  Node 0: 6 connections, 8 in routing table
  Total connections: 45
  Average per node: 4.5
  Min/Max: 3/6

💾 Storing 50 data items...
  Stored 10/50 items
  ...
✅ Successfully stored 50 data items

🔄 Waiting for data replication...
  Total replicated items across all nodes: 150
  Average items per node: 15.0

🔍 Verifying data reachability from 5 random nodes...
  Selected nodes: [1, 4, 7, 2, 9]
  
  Node 1 checking 50 keys...
    Node 1 success rate: 94.0%
  ...

✅ Overall success rate: 92.0% (230/250)

📋 Final Test Results:
==========================================
Nodes created: 10/10
Data stored: 50/50
Lookup successes: 230
Lookup failures: 20
Overall success rate: 92.0%
🎉 EXCELLENT - DHT network performing very well!
==========================================
```

## Running Tests

### Basic Usage

```bash
node dht-network-test.js
```

### With Custom Parameters

Edit the `TEST_PARAMS` object in the file, or create a wrapper script:

```javascript
import { DHTNetworkTester, TEST_PARAMS } from './dht-network-test.js';

// Override parameters
TEST_PARAMS.NODE_COUNT = 20;
TEST_PARAMS.DATA_COUNT = 100;

const tester = new DHTNetworkTester();
await tester.runTest();
```

### Stress Testing

For stress testing, increase the parameters:

```javascript
const TEST_PARAMS = {
  NODE_COUNT: 100,          // Large network
  DATA_COUNT: 500,          // Lots of data
  CHECK_NODES: 20,          // Comprehensive checking
  NETWORK_STABILIZE_TIME: 30000, // More time for large network
  // ... other params
};
```

## Troubleshooting

### Bootstrap Server Not Running

```
❌ Bootstrap server not available. Please run: npm run bootstrap:genesis
```

**Solution**: Start the bootstrap server in a separate terminal.

### Connection Timeouts

If nodes fail to connect, try:
- Increasing `CONNECTION_TIMEOUT`
- Increasing `NETWORK_STABILIZE_TIME`
- Reducing `NODE_COUNT` to test smaller networks first

### Low Success Rates

If data lookup success rates are low:
- Check that nodes are properly connected (network stats)
- Increase `REPLICATION_FACTOR` for better data availability
- Increase `NETWORK_STABILIZE_TIME` to let DHT stabilize

### Memory Issues

For large tests:
- Run with increased Node.js memory: `node --max-old-space-size=4096 dht-network-test.js`
- Reduce `NODE_COUNT` or `DATA_COUNT`

## Test Interpretation

### Success Rate Thresholds

- **90%+**: Excellent DHT performance
- **75-90%**: Good performance, minor issues
- **50-75%**: Fair performance, some problems
- **<50%**: Poor performance, significant issues

### Network Statistics

- **Connections**: Each node should have 3-8 connections for good connectivity
- **Routing table**: Should grow as network discovers more peers
- **Replication**: Data should be replicated across multiple nodes

This test provides real-world validation of your DHT implementation's networking, replication, and lookup capabilities.