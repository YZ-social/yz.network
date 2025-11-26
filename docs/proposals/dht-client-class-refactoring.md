# DHT Client Class Hierarchy Refactoring Proposal

## Problem Statement

### Current Architecture: Organic Growth

The DHT client class hierarchy has **grown organically instead of being designed**. This has resulted in:

1. **Wrong inheritance relationships**: `PassiveBridgeNode` extends `DHTClient` instead of `NodeDHTClient`, missing critical WebSocket server setup
2. **Four-level inheritance**: `EventEmitter → DHTClient → NodeDHTClient → ActiveDHTNode` for features that should be composition
3. **Duplicate code**: PassiveBridgeNode reimplements connection manager logic that NodeDHTClient already provides
4. **Unclear separation of concerns**: Metrics, PubSub, and DHT operations mixed in single class
5. **Missing WebSocket metadata**: Bridge nodes don't advertise listening addresses, breaking browser connectivity

### Current Class Hierarchy

```
EventEmitter
└── DHTClient (251 lines) - base class, abstract template
    ├── NodeDHTClient (438 lines) - Node.js WebSocket server
    │   └── ActiveDHTNode (558 lines) - adds metrics + PubSub
    ├── BrowserDHTClient (251 lines) - browser identity + WebRTC
    └── PassiveBridgeNode (1312 lines) ❌ WRONG - should extend NodeDHTClient
```

### Critical Bug: Missing WebSocket Metadata

**File**: `src/bridge/PassiveBridgeNode.js`

**Issue**: Extends `DHTClient` instead of `NodeDHTClient`

**Symptom**: Bridge nodes don't include WebSocket addresses in bootstrap metadata, so browsers cannot connect:
```javascript
// Browser console:
📋 Received inviter metadata from 0ee32303...
   Listening address: undefined  ← PROBLEM
   Node type: bridge
```

**Root Cause**: `PassiveBridgeNode extends DHTClient` doesn't inherit `getBootstrapMetadata()` from `NodeDHTClient`:
```javascript
// NodeDHTClient.js (lines 118-128):
getBootstrapMetadata() {
  return {
    nodeType: 'nodejs',
    listeningAddress: this.connectionManager?.getServerAddress?.(),  // Missing!
    publicWssAddress: this.options.publicWssAddress,                 // Missing!
    capabilities: ['websocket', 'relay']
  };
}
```

This is the **exact same bug** we just fixed in `ActiveDHTNode`.

## What Each Class Provides

### DHTClient (251 lines) - Base Abstract Template
**Purpose**: Generic DHT initialization for all node types

**Provides**:
- Template method pattern: `start()`, `stop()`, `getStats()`
- Abstract methods: `getNodeType()`, `getCapabilities()`, `canAcceptConnections()`
- Common DHT operations: `store()`, `get()`, `inviteNewClient()`
- Bootstrap client creation hook
- Good design ✅

### NodeDHTClient (438 lines) - Node.js Server
**Purpose**: WebSocket server + Node.js-specific DHT implementation

**Provides**:
- Node.js crypto configuration (Ed25519 SHA512)
- WebSocket server initialization
- **getBootstrapMetadata()** with WebSocket addresses (CRITICAL)
- Server connection manager setup
- Node.js node ID generation (GUID + SHA1)

### ActiveDHTNode (558 lines) - Metrics + PubSub
**Purpose**: Full DHT participant with observability

**Provides**:
- HTTP metrics server (port 9090) with `/health`, `/metrics`, `/status` endpoints
- PubSub client initialization
- Wrapped DHT operations with latency tracking
- Background maintenance tasks
- Metrics collection (throughput, percentiles)

**Problem**: Mixes concerns - metrics and PubSub should be optional features, not inheritance

### BrowserDHTClient (251 lines) - Browser + Identity
**Purpose**: Browser-specific DHT client with cryptographic identity

**Provides**:
- ECDSA P-256 identity via IndexedDB
- Authentication challenge handlers (sign/verify)
- Tab-specific identity support (testing feature)
- WebRTC capabilities declaration
- Can only initiate connections (browsers can't run servers)

**Architecture**: Good separation ✅

### PassiveBridgeNode (1312 lines) - Observation + Reconnection
**Purpose**: DHT observer for network health and reconnection services

**Provides**:
- Network fingerprinting (cryptographic state hash)
- Reconnection validation logic
- Bridge authentication with bootstrap server
- Peer announcement tracking
- Genesis peer connection coordination
- Onboarding peer selection (open network mode)

**Problem**: Extends `DHTClient` but needs `NodeDHTClient` features

**Duplicate Code**: Lines 34-42 manually create connection manager that `NodeDHTClient.start()` already provides

## Rejected Solutions

### 1. Keep Current Hierarchy, Just Fix PassiveBridgeNode ❌

**Idea**: Change `PassiveBridgeNode extends DHTClient` to `PassiveBridgeNode extends NodeDHTClient`, leave everything else.

**Why Insufficient**:
- Fixes the immediate bug ✅
- But leaves underlying design problems:
  - Still have 4-level inheritance for optional features
  - ActiveDHTNode still mixes metrics + PubSub + DHT
  - Adding new features requires new subclasses (doesn't scale)
  - No way to get "NodeDHTClient with metrics but without PubSub"

**Verdict**: Good for Phase 1 quick fix, but doesn't solve architectural debt

### 2. Make Everything Extend NodeDHTClient ❌

**Idea**: Move all shared logic to NodeDHTClient, make everything extend it.

```
NodeDHTClient (everything)
├── ActiveDHTNode (metrics)
├── PassiveBridgeNode (passive mode)
└── BrowserDHTClient (browser stuff)
```

**Why Rejected**:
- BrowserDHTClient needs different crypto setup (Web Crypto API vs Node.js crypto)
- Browsers can't run WebSocket servers
- Browsers and Node.js have fundamentally different capabilities
- Violates Liskov Substitution Principle

### 3. Multiple Inheritance via Mixins ❌

**Idea**: Use JavaScript mixins for metrics, PubSub, passive mode.

```javascript
class ActiveDHTNode extends Metrics(PubSub(NodeDHTClient)) { }
```

**Why Rejected**:
- JavaScript doesn't have true multiple inheritance
- Mixin composition creates confusing method resolution order
- Hard to debug when mixins conflict
- TypeScript support is poor
- Overly complex for the problem size

### 4. Eliminate DHTClient Base Class ❌

**Idea**: Make NodeDHTClient and BrowserDHTClient independent, no shared parent.

**Why Rejected**:
- Loses polymorphism - can't treat all DHT clients uniformly
- Duplicates common logic: start/stop lifecycle, store/get operations
- Makes factory patterns harder
- DHTClient template method pattern is actually good design

## Proposed Solution: Composition Over Inheritance

### Core Principle

**Replace inheritance with composition for cross-cutting concerns:**
- Metrics: Plugin class
- PubSub: Already a separate class, just make it optional
- Passive mode: Configuration option + override
- Connection management: Already delegated to factories ✅

### Proposed Architecture

```
EventEmitter
└── DHTClient (base - abstract template)
    ├── NodeDHTClient (Node.js server capabilities)
    │   └── PassiveBridgeNode (passive mode + observation)
    └── BrowserDHTClient (browser + identity)

// Remove ActiveDHTNode entirely
// Metrics become optional plugin
```

### New Design: NodeDHTClient with Plugins

**File**: `src/node/NodeDHTClient.js`

```javascript
export class NodeDHTClient extends DHTClient {
  constructor(options = {}) {
    super(options);

    // Optional features via composition
    this.enableMetrics = options.enableMetrics || false;
    this.enablePubSub = options.enablePubSub || false;
    this.metricsPort = options.metricsPort || 9090;

    // Plugins (null if disabled)
    this.metricsCollector = null;
    this.pubsubClient = null;
  }

  async start() {
    // Standard WebSocket server setup
    await super.start();

    // Optional: Start metrics server if enabled
    if (this.enableMetrics) {
      this.metricsCollector = new MetricsCollector(this, this.metricsPort);
      await this.metricsCollector.start();
    }

    // Optional: Initialize PubSub if enabled
    if (this.enablePubSub) {
      const keyInfo = await InvitationToken.generateKeyPair();
      this.pubsubClient = new PubSubClient(this.dht, this.nodeId.toString(), keyInfo);
    }
  }

  // Wrap operations with metrics if enabled
  async store(key, value, ttl) {
    const startTime = Date.now();

    try {
      const result = await this.dht.store(key, value, ttl);

      // Record metrics if enabled
      if (this.metricsCollector) {
        this.metricsCollector.recordOperation('store', Date.now() - startTime, true);
      }

      return result;
    } catch (error) {
      if (this.metricsCollector) {
        this.metricsCollector.recordOperation('store', Date.now() - startTime, false);
      }
      throw error;
    }
  }

  async get(key) {
    const startTime = Date.now();

    try {
      const result = await this.dht.get(key);

      if (this.metricsCollector) {
        this.metricsCollector.recordOperation('get', Date.now() - startTime, true);
      }

      return result;
    } catch (error) {
      if (this.metricsCollector) {
        this.metricsCollector.recordOperation('get', Date.now() - startTime, false);
      }
      throw error;
    }
  }

  // Similar for findNode, publish, subscribe...
}
```

### Metrics Plugin

**File**: `src/metrics/MetricsCollector.js`

```javascript
import http from 'http';

export class MetricsCollector {
  constructor(dhtClient, port) {
    this.dhtClient = dhtClient;
    this.port = port;
    this.httpServer = null;

    // Metrics tracking
    this.metrics = {
      startTime: Date.now(),
      dhtStores: 0,
      dhtGets: 0,
      dhtFindNodes: 0,
      dhtStoreFails: 0,
      dhtGetFails: 0,
      storeLatencies: [],
      getLatencies: [],
      findNodeLatencies: [],
      opsLastMinute: []
    };

    this.maxLatencySamples = 100;
  }

  async start() {
    this.httpServer = http.createServer((req, res) => {
      // CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Content-Type', 'application/json');

      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }

      if (req.url === '/health') {
        this.handleHealthCheck(req, res);
      } else if (req.url === '/metrics') {
        this.handleMetrics(req, res);
      } else if (req.url === '/status') {
        this.handleStatus(req, res);
      } else {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    });

    return new Promise((resolve, reject) => {
      this.httpServer.listen(this.port, '0.0.0.0', (err) => {
        if (err) {
          reject(err);
        } else {
          console.log(`📊 Metrics server listening on port ${this.port}`);
          resolve();
        }
      });
    });
  }

  recordOperation(type, latencyMs, success) {
    // Update counters
    if (success) {
      this.metrics[`dht${type.charAt(0).toUpperCase() + type.slice(1)}s`]++;
    } else {
      this.metrics[`dht${type.charAt(0).toUpperCase() + type.slice(1)}Fails`]++;
    }

    // Record latency
    const bucket = this.metrics[`${type}Latencies`];
    if (bucket) {
      bucket.push(latencyMs);
      if (bucket.length > this.maxLatencySamples) {
        bucket.shift();
      }
    }

    // Track throughput
    this.metrics.opsLastMinute.push(Date.now());
    const oneMinuteAgo = Date.now() - 60000;
    this.metrics.opsLastMinute = this.metrics.opsLastMinute.filter(t => t > oneMinuteAgo);
  }

  handleHealthCheck(req, res) {
    const uptime = Date.now() - this.metrics.startTime;
    const connectedPeers = this.dhtClient.dht ? this.dhtClient.dht.getConnectedPeers().length : 0;

    const isHealthy = this.dhtClient.dht &&
                     (connectedPeers > 0 || uptime < 30000);

    res.writeHead(isHealthy ? 200 : 503);
    res.end(JSON.stringify({
      healthy: isHealthy,
      uptime,
      connectedPeers,
      timestamp: Date.now()
    }));
  }

  handleMetrics(req, res) {
    const metrics = this.collectMetrics();
    res.writeHead(200);
    res.end(JSON.stringify(metrics, null, 2));
  }

  handleStatus(req, res) {
    const status = {
      nodeId: this.dhtClient.nodeId.toString().substring(0, 16) + '...',
      nodeType: this.dhtClient.getNodeType(),
      capabilities: this.dhtClient.getCapabilities(),
      uptime: Date.now() - this.metrics.startTime,
      metrics: this.metrics
    };

    res.writeHead(200);
    res.end(JSON.stringify(status, null, 2));
  }

  collectMetrics() {
    const uptime = (Date.now() - this.metrics.startTime) / 1000;
    const connectedPeers = this.dhtClient.dht ? this.dhtClient.dht.getConnectedPeers().length : 0;

    return {
      node_uptime_seconds: uptime,
      dht_connected_peers: connectedPeers,
      dht_store_operations_total: this.metrics.dhtStores,
      dht_get_operations_total: this.metrics.dhtGets,
      dht_findnode_operations_total: this.metrics.dhtFindNodes,
      dht_store_failures_total: this.metrics.dhtStoreFails,
      dht_get_failures_total: this.metrics.dhtGetFails,
      dht_store_latency_p50: this.calculatePercentile(this.metrics.storeLatencies, 50),
      dht_store_latency_p95: this.calculatePercentile(this.metrics.storeLatencies, 95),
      dht_get_latency_p50: this.calculatePercentile(this.metrics.getLatencies, 50),
      operations_per_second: this.calculateOpsPerSecond()
    };
  }

  calculatePercentile(samples, percentile) {
    if (samples.length === 0) return 0;
    const sorted = [...samples].sort((a, b) => a - b);
    const index = Math.ceil((percentile / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  }

  calculateOpsPerSecond() {
    if (this.metrics.opsLastMinute.length === 0) return 0;
    return this.metrics.opsLastMinute.length / 60;
  }

  async shutdown() {
    if (this.httpServer) {
      await new Promise(resolve => this.httpServer.close(resolve));
    }
  }
}
```

### PassiveBridgeNode - Simplified

**File**: `src/bridge/PassiveBridgeNode.js`

```javascript
import { NodeDHTClient } from '../node/NodeDHTClient.js';

export class PassiveBridgeNode extends NodeDHTClient {
  constructor(options = {}) {
    super({
      ...options,
      enableMetrics: true,  // Bridges need metrics
      enablePubSub: false,  // Bridges don't need PubSub
      passiveMode: true     // Override DHT options
    });

    // Bridge-specific features
    this.bridgeAuth = options.bridgeAuth || 'default-bridge-auth-key';
    this.networkFingerprint = null;
    this.peerAnnouncements = new Map();
    this.authorizedBootstrap = new Set();
  }

  getDHTOptions() {
    return {
      ...super.getDHTOptions(),
      passiveMode: true,
      disableStorage: true,
      disableRouting: true,
      disableLookups: true
    };
  }

  // Bridge-specific observation methods
  async calculateNetworkFingerprint() { /* ... */ }
  async handleReconnectionValidation() { /* ... */ }
  async handleGenesisConnection() { /* ... */ }
  async handleGetOnboardingPeer() { /* ... */ }
}
```

### Usage Examples

```javascript
// Docker deployment with metrics
const activeNode = new NodeDHTClient({
  enableMetrics: true,
  enablePubSub: true,
  metricsPort: 9090,
  websocketPort: 8085
});

// Docker deployment without metrics (lightweight)
const lightweightNode = new NodeDHTClient({
  enableMetrics: false,
  enablePubSub: false,
  websocketPort: 8085
});

// Bridge node (automatically gets metrics)
const bridgeNode = new PassiveBridgeNode({
  bridgePort: 8083,
  bridgeAuth: process.env.BRIDGE_AUTH
});

// Browser client (unchanged)
const browserClient = new BrowserDHTClient({
  bootstrapServers: ['wss://imeyouwe.com/ws']
});
```

## Advantages

### 1. Single Responsibility Principle
- **NodeDHTClient**: WebSocket server + DHT operations
- **MetricsCollector**: Metrics collection + HTTP server
- **PubSubClient**: Pub/sub messaging
- **PassiveBridgeNode**: Network observation + reconnection

### 2. Composition Over Inheritance
```javascript
// Before (4 levels):
EventEmitter → DHTClient → NodeDHTClient → ActiveDHTNode

// After (3 levels max):
EventEmitter → DHTClient → NodeDHTClient (with plugins)
```

### 3. Flexibility
```javascript
// Want metrics without PubSub?
new NodeDHTClient({ enableMetrics: true })

// Want PubSub without metrics?
new NodeDHTClient({ enablePubSub: true })

// Want both?
new NodeDHTClient({ enableMetrics: true, enablePubSub: true })

// Current approach: MUST use ActiveDHTNode (no choice)
```

### 4. No Duplicate Code
- PassiveBridgeNode inherits WebSocket setup from NodeDHTClient
- No manual connection manager creation
- Automatic bootstrap metadata with WebSocket addresses

### 5. Testability
- Test MetricsCollector independently
- Test PubSubClient independently
- Mock plugins easily
- Unit test DHT operations without metrics overhead

### 6. Maintainability
- Each class has clear purpose
- Adding new features doesn't require new subclasses
- Easy to find code (metrics logic is in MetricsCollector, not scattered)

## Implementation Plan

### Phase 1: Quick Fix (Today) ✅

**Goal**: Fix browser connectivity by correcting PassiveBridgeNode inheritance

**Tasks**:
1. Change `PassiveBridgeNode extends DHTClient` to `PassiveBridgeNode extends NodeDHTClient`
2. Remove duplicate connection manager creation (lines 34-42)
3. Remove manual WebSocket server setup (inherited from NodeDHTClient)
4. Test browser connectivity with genesis node
5. Deploy to Oracle Cloud

**Estimated Time**: 30 minutes

**Risk**: Low - minimal code change, well-understood fix

### Phase 2: Refactor ActiveDHTNode (This Week)

**Goal**: Merge ActiveDHTNode functionality into NodeDHTClient with optional features

**Tasks**:
1. Create `src/metrics/MetricsCollector.js` plugin class
2. Add `enableMetrics` and `enablePubSub` options to NodeDHTClient
3. Move metrics wrapping logic to NodeDHTClient (store/get/findNode)
4. Update `docker-compose.production.yml` to use NodeDHTClient with options:
   ```yaml
   environment:
     - ENABLE_METRICS=true
     - ENABLE_PUBSUB=true
   ```
5. Update `src/docker/start-dht-node.js` to parse environment variables
6. Test all endpoints: `/health`, `/metrics`, `/status`
7. Verify backward compatibility with existing deployments
8. Delete `src/docker/ActiveDHTNode.js`
9. Update documentation

**Estimated Time**: 4-6 hours

**Risk**: Medium - touches production deployments, needs thorough testing

### Phase 3: Clean Up (Next Week)

**Goal**: Polish architecture and documentation

**Tasks**:
1. Review BrowserDHTClient - ensure clean separation of concerns
2. Extract common patterns to utility functions if needed
3. Update CLAUDE.md with new architecture
4. Add JSDoc comments explaining plugin pattern
5. Create migration guide for anyone using ActiveDHTNode directly

**Estimated Time**: 2-3 hours

**Risk**: Low - documentation and polish

## Migration Guide

### For Existing Code Using ActiveDHTNode

**Before**:
```javascript
import { ActiveDHTNode } from './src/docker/ActiveDHTNode.js';

const node = new ActiveDHTNode({
  websocketPort: 8085,
  metricsPort: 9090
});
await node.start();
```

**After**:
```javascript
import { NodeDHTClient } from './src/node/NodeDHTClient.js';

const node = new NodeDHTClient({
  websocketPort: 8085,
  enableMetrics: true,
  enablePubSub: true,
  metricsPort: 9090
});
await node.start();
```

### For Docker Deployments

**Before** (`docker-compose.production.yml`):
```yaml
genesis-node:
  image: itsmeront/yz-dht-node:latest
  container_name: yz-genesis-node
  command: node src/docker/start-dht-node.js  # Uses ActiveDHTNode
```

**After** (environment variables control features):
```yaml
genesis-node:
  image: itsmeront/yz-dht-node:latest
  container_name: yz-genesis-node
  command: node src/docker/start-dht-node.js  # Uses NodeDHTClient
  environment:
    - ENABLE_METRICS=true
    - ENABLE_PUBSUB=true
    - METRICS_PORT=9090
```

### Breaking Changes

**None** - This is a refactoring that maintains the same public API.

All existing functionality continues to work:
- `/health` endpoint
- `/metrics` endpoint
- `/status` endpoint
- PubSub operations
- DHT operations

## Alternatives Considered

### Keep ActiveDHTNode as Convenience Class

Instead of deleting ActiveDHTNode, make it a thin wrapper:

```javascript
export class ActiveDHTNode extends NodeDHTClient {
  constructor(options = {}) {
    super({
      ...options,
      enableMetrics: true,
      enablePubSub: true
    });
  }
}
```

**Pros**: Zero breaking changes for existing code

**Cons**: Maintains unnecessary class, doesn't simplify hierarchy

**Verdict**: Could be a temporary migration step, but eventually remove it

## Open Questions

1. **Should MetricsCollector be a separate npm package?**
   - Pro: Reusable across projects
   - Con: Adds dependency management overhead
   - **Decision**: Keep internal for now, extract later if needed

2. **Should we have MetricsCollector interface for pluggability?**
   - Could swap Prometheus, Grafana, etc.
   - Pro: Flexibility
   - Con: YAGNI (You Aren't Gonna Need It)
   - **Decision**: Single implementation for now

3. **What about PassiveBridgeNode metrics?**
   - Currently forced on (enableMetrics: true)
   - Could make optional
   - **Decision**: Keep required - bridges need health monitoring

4. **Should PubSubClient initialization be lazy?**
   - Only create when first publish/subscribe call
   - Pro: Saves resources if never used
   - Con: Adds complexity
   - **Decision**: Keep eager initialization for now

## Status

**Current Status**: Proposal stage - Phase 1 ready to implement

**Next Steps**:
1. ✅ Get approval for approach
2. ✅ Implement Phase 1 quick fix (PassiveBridgeNode inheritance)
3. ⏳ Test browser connectivity with Oracle Cloud deployment
4. ⏳ Implement Phase 2 refactoring (merge ActiveDHTNode)
5. ⏳ Update documentation

**Last Updated**: 2025-01-25

## Related Documentation

- **Design Patterns**: "Composition over Inheritance" (Gang of Four)
- **SOLID Principles**: Single Responsibility, Open/Closed
- **Martin Fowler**: "Refactoring: Improving the Design of Existing Code"
- **Plugin Architecture**: Strategy Pattern for optional features
