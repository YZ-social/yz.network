# Peer Quality Metrics in K-Bucket Routing Table

## Problem Statement

When selecting peers for onboarding new nodes or making routing decisions, we currently have no way to assess peer quality. All peers are treated equally regardless of:
- Connection stability (uptime)
- Network responsiveness (latency)
- DHT health (k-bucket fullness)
- Geographic location or connection type

This leads to suboptimal peer selection where new nodes might connect to unreliable or slow peers instead of high-quality ones.

## Solution Overview

Enhance the K-bucket routing table entries to store peer quality metrics. These metrics are:
1. **Collected locally** through normal DHT operations (ping/pong)
2. **Stored in K-bucket node metadata** alongside existing peer information
3. **Shared via protocol messages** (ping responses, findNode responses)
4. **Used for informed decisions** when selecting peers for onboarding, routing, or storage

## Architecture

### Data Model

**Enhanced DHTNode Structure:**
```javascript
// src/core/DHTNode.js

class DHTNode {
  constructor(id) {
    this.id = id;                    // Existing: Node ID
    this.metadata = {};              // Existing: Connection info, capabilities
    this.lastSeen = 0;               // Existing: Last contact timestamp
    this.connectionManager = null;   // Existing: Connection manager
    this.connection = null;          // Existing: Active connection

    // NEW: Quality metrics tracked locally
    this.stats = {
      // Stability Metrics
      uptime: 0,                     // How long this node has been online (ms)
      firstSeen: Date.now(),         // When we first discovered this node
      disconnectCount: 0,            // Number of disconnections observed
      lastDisconnect: null,          // Timestamp of last disconnect

      // Performance Metrics
      avgResponseTime: null,         // Average ping response time (ms)
      responseTimes: [],             // Last 10 response times for averaging
      lastPingTime: null,            // When we last pinged this node
      timeoutCount: 0,               // Number of ping timeouts

      // DHT Health Metrics
      kBucketFullness: 0,            // 0-1: Percentage of k-buckets filled
      routingTableSize: 0,           // Number of peers in their routing table
      dhtVersion: null,              // DHT protocol version

      // Network Metrics (optional, reported by peer)
      connectionType: null,          // 'fiber', 'cable', 'mobile', '4g', '5g', etc.
      geolocation: null,             // Country/region code (optional, privacy-aware)
      natType: null,                 // 'none', 'full-cone', 'restricted', 'symmetric'

      // Activity Metrics
      messageCount: 0,               // Total messages exchanged
      successfulLookups: 0,          // Successful findNode responses
      failedLookups: 0,              // Failed/timeout findNode requests

      // Computed Quality Score
      qualityScore: 0,               // 0-1: Composite quality metric
      lastScoreUpdate: null          // When score was last calculated
    };
  }

  /**
   * Update stats based on ping response
   */
  updateFromPingResponse(responseTime, peerStats) {
    const now = Date.now();

    // Update response time metrics
    this.stats.responseTimes.push(responseTime);
    if (this.stats.responseTimes.length > 10) {
      this.stats.responseTimes.shift(); // Keep only last 10
    }
    this.stats.avgResponseTime =
      this.stats.responseTimes.reduce((a, b) => a + b, 0) / this.stats.responseTimes.length;

    this.stats.lastPingTime = now;

    // Update from peer-reported stats
    if (peerStats) {
      this.stats.uptime = peerStats.uptime || 0;
      this.stats.kBucketFullness = peerStats.kBucketFullness || 0;
      this.stats.routingTableSize = peerStats.routingTableSize || 0;
      this.stats.connectionType = peerStats.connectionType || null;
      this.stats.geolocation = peerStats.geolocation || null;
      this.stats.natType = peerStats.natType || null;
    }

    // Recalculate quality score
    this.updateQualityScore();
  }

  /**
   * Calculate composite quality score (0-1)
   */
  updateQualityScore() {
    const now = Date.now();

    // Stability score (0-1)
    const uptimeScore = Math.min(this.stats.uptime / (24 * 60 * 60 * 1000), 1); // Max at 24h
    const stabilityScore = this.stats.disconnectCount === 0 ? 1 :
      Math.max(0, 1 - (this.stats.disconnectCount / 10)); // Penalize disconnects

    // Performance score (0-1)
    const responseScore = this.stats.avgResponseTime ?
      Math.max(0, 1 - (this.stats.avgResponseTime / 1000)) : 0.5; // Max penalty at 1s
    const reliabilityScore = this.stats.timeoutCount === 0 ? 1 :
      Math.max(0, 1 - (this.stats.timeoutCount / 10)); // Penalize timeouts

    // DHT health score (0-1)
    const dhtScore = this.stats.kBucketFullness;

    // Composite score (weighted average)
    this.stats.qualityScore = (
      uptimeScore * 0.25 +           // 25% uptime
      stabilityScore * 0.20 +        // 20% stability
      responseScore * 0.20 +         // 20% response time
      reliabilityScore * 0.15 +      // 15% reliability
      dhtScore * 0.20                // 20% DHT health
    );

    this.stats.lastScoreUpdate = now;
  }

  /**
   * Record ping timeout
   */
  recordTimeout() {
    this.stats.timeoutCount++;
    this.updateQualityScore();
  }

  /**
   * Record disconnection
   */
  recordDisconnect() {
    this.stats.disconnectCount++;
    this.stats.lastDisconnect = Date.now();
    this.updateQualityScore();
  }

  /**
   * Get exportable stats for sharing with other peers
   */
  getExportableStats() {
    return {
      uptime: this.stats.uptime,
      kBucketFullness: this.stats.kBucketFullness,
      routingTableSize: this.stats.routingTableSize,
      connectionType: this.stats.connectionType,
      geolocation: this.stats.geolocation,
      natType: this.stats.natType,
      avgResponseTime: this.stats.avgResponseTime,
      qualityScore: this.stats.qualityScore
    };
  }
}
```

### Protocol Changes

#### 1. Enhanced Ping Response

**Current ping/pong:**
```javascript
// Ping request
{
  type: 'ping',
  timestamp: 1234567890
}

// Pong response
{
  type: 'pong',
  timestamp: 1234567890
}
```

**Enhanced ping/pong with stats:**
```javascript
// Ping request (unchanged)
{
  type: 'ping',
  timestamp: 1234567890
}

// Enhanced pong response
{
  type: 'pong',
  timestamp: 1234567890,
  stats: {                           // NEW: Peer-reported stats
    uptime: 3600000,                 // 1 hour online
    kBucketFullness: 0.85,           // 85% of k-buckets filled
    routingTableSize: 45,            // 45 peers in routing table
    connectionType: 'fiber',         // Connection quality hint
    geolocation: 'US',               // Country code (optional)
    natType: 'none',                 // NAT traversal info
    dhtVersion: '1.0.0'              // Protocol version
  }
}
```

**Implementation:**
```javascript
// src/network/ConnectionManager.js (base class)

async handlePing(peerId, message) {
  const now = Date.now();
  const responseTime = now - message.timestamp;

  // Send pong with local stats
  await this.sendMessage(peerId, {
    type: 'pong',
    timestamp: message.timestamp,
    stats: this.getLocalStats()      // NEW: Include our stats
  });
}

async handlePong(peerId, message) {
  const now = Date.now();
  const responseTime = now - message.timestamp;

  // Update peer stats in routing table
  const peerNode = this.routingTable.getNode(peerId);
  if (peerNode) {
    peerNode.updateFromPingResponse(responseTime, message.stats);
  }
}

getLocalStats() {
  const uptime = Date.now() - this.startTime;
  const routingTableNodes = this.routingTable.getAllNodes();
  const kBuckets = this.routingTable.buckets;
  const filledBuckets = kBuckets.filter(b => b.size() > 0).length;

  return {
    uptime,
    kBucketFullness: filledBuckets / kBuckets.length,
    routingTableSize: routingTableNodes.length,
    connectionType: this.detectConnectionType(),
    geolocation: this.getGeolocation(),  // Optional, privacy-aware
    natType: this.detectNATType(),
    dhtVersion: '1.0.0'
  };
}
```

#### 2. Enhanced findNode Response

**Current findNode response:**
```javascript
{
  type: 'find_node_response',
  requestId: 'abc123',
  nodes: [
    {
      id: 'node1_id',
      metadata: {
        listeningAddress: 'ws://...',
        nodeType: 'browser'
      }
    }
  ]
}
```

**Enhanced findNode response with stats:**
```javascript
{
  type: 'find_node_response',
  requestId: 'abc123',
  nodes: [
    {
      id: 'node1_id',
      metadata: {
        listeningAddress: 'ws://...',
        nodeType: 'browser'
      },
      stats: {                         // NEW: Include peer stats
        uptime: 3600000,
        kBucketFullness: 0.85,
        routingTableSize: 45,
        avgResponseTime: 50,           // Our measured response time
        qualityScore: 0.82,            // Our calculated quality score
        connectionType: 'fiber',
        geolocation: 'US'
      }
    }
  ]
}
```

**Implementation:**
```javascript
// src/dht/KademliaDHT.js

async handleFindNode(peerId, message) {
  const targetId = DHTNodeId.fromHex(message.targetId);
  const closestNodes = this.routingTable.findClosestNodes(targetId, this.k);

  // Include stats for each node
  const nodesWithStats = closestNodes.map(node => ({
    id: node.id.toString(),
    metadata: node.metadata,
    stats: node.getExportableStats()  // NEW: Include peer quality stats
  }));

  await this.sendMessage(peerId, {
    type: 'find_node_response',
    requestId: message.requestId,
    nodes: nodesWithStats
  });
}
```

### Routing Table Integration

**Update RoutingTable to maintain stats:**
```javascript
// src/dht/RoutingTable.js

class RoutingTable {
  // ... existing code ...

  /**
   * Get nodes sorted by quality score
   */
  getNodesByQuality(count = 20) {
    return this.getAllNodes()
      .sort((a, b) => b.stats.qualityScore - a.stats.qualityScore)
      .slice(0, count);
  }

  /**
   * Get nodes matching quality criteria
   */
  getNodesWithMinimumQuality(minScore = 0.5, count = 20) {
    return this.getAllNodes()
      .filter(node => node.stats.qualityScore >= minScore)
      .sort((a, b) => b.stats.qualityScore - a.stats.qualityScore)
      .slice(0, count);
  }

  /**
   * Get statistics about routing table quality
   */
  getQualityStats() {
    const nodes = this.getAllNodes();
    const scores = nodes.map(n => n.stats.qualityScore);

    return {
      totalNodes: nodes.length,
      avgQuality: scores.reduce((a, b) => a + b, 0) / scores.length,
      minQuality: Math.min(...scores),
      maxQuality: Math.max(...scores),
      highQualityNodes: nodes.filter(n => n.stats.qualityScore > 0.7).length,
      lowQualityNodes: nodes.filter(n => n.stats.qualityScore < 0.3).length
    };
  }
}
```

## Use Cases

### 1. Onboarding Peer Selection

**Bridge node selects high-quality peer for new node:**
```javascript
// Future enhancement to random peer onboarding

async handleGetOnboardingPeer(bootstrapPeerId, request) {
  // Generate random ID
  const randomId = this.generateRandomNodeId();

  // Find closest peers
  const closestPeers = await this.dht.findNode(randomId);

  // Filter to high-quality peers only
  const qualityPeers = closestPeers
    .filter(peer => peer.stats && peer.stats.qualityScore > 0.5)
    .sort((a, b) => b.stats.qualityScore - a.stats.qualityScore);

  // Select best available peer
  const selectedPeer = qualityPeers[0] || closestPeers[0];

  // ... send result
}
```

### 2. Routing Decisions

**Prefer high-quality peers for message routing:**
```javascript
async routeMessage(targetId, message) {
  const closestPeers = this.routingTable.findClosestNodes(targetId, this.alpha);

  // Sort by quality score, then by distance
  const qualityPeers = closestPeers.sort((a, b) => {
    const qualityDiff = b.stats.qualityScore - a.stats.qualityScore;
    if (Math.abs(qualityDiff) > 0.2) return qualityDiff; // Significant quality difference

    // Similar quality, prefer closer
    return targetId.distanceTo(a.id) - targetId.distanceTo(b.id);
  });

  // Route through best peer
  await qualityPeers[0].sendMessage(message);
}
```

### 3. Data Replication

**Store replicas on most reliable peers:**
```javascript
async store(key, value) {
  const keyId = DHTDataID.fromString(key);
  const closestPeers = this.routingTable.findClosestNodes(keyId, this.replicateK * 2);

  // Select most reliable peers for storage
  const storagePeers = closestPeers
    .filter(peer => peer.stats.qualityScore > 0.6)  // Minimum quality
    .sort((a, b) => {
      // Prioritize: high stability + high uptime
      const stabilityA = 1 - (peer.stats.disconnectCount / 10);
      const stabilityB = 1 - (peer.stats.disconnectCount / 10);
      return stabilityB - stabilityA;
    })
    .slice(0, this.replicateK);

  // Store on selected peers
  // ...
}
```

### 4. Network Health Monitoring

**Dashboard showing network quality:**
```javascript
function getNetworkHealthReport() {
  const qualityStats = dht.routingTable.getQualityStats();

  return {
    status: qualityStats.avgQuality > 0.7 ? 'healthy' :
            qualityStats.avgQuality > 0.4 ? 'degraded' : 'unhealthy',
    metrics: {
      averageQuality: qualityStats.avgQuality,
      totalPeers: qualityStats.totalNodes,
      reliablePeers: qualityStats.highQualityNodes,
      unreliablePeers: qualityStats.lowQualityNodes
    },
    recommendations: generateHealthRecommendations(qualityStats)
  };
}
```

## Privacy Considerations

**Opt-in Sharing:**
- Geolocation is **optional** and coarse (country-level only)
- Connection type is **self-reported** and optional
- No personally identifiable information shared
- Peers can choose to omit stats from responses

**Minimal Data Collection:**
- Only aggregate metrics (no request logs, no user data)
- Stats reset on node restart (no persistent tracking)
- No cross-session correlation

**Privacy-Aware Implementation:**
```javascript
getLocalStats() {
  return {
    uptime: this.getUptime(),
    kBucketFullness: this.getKBucketFullness(),
    routingTableSize: this.getRoutingTableSize(),

    // Optional: User can disable via config
    connectionType: this.config.shareConnectionType ? this.detectConnectionType() : null,
    geolocation: this.config.shareGeolocation ? this.getCountryCode() : null,
    natType: this.config.shareNATType ? this.detectNATType() : null
  };
}
```

## Performance Impact

**Memory Overhead:**
- Per-peer stats: ~200 bytes
- 100 peers: ~20 KB
- 1000 peers: ~200 KB
- **Negligible** for modern devices

**CPU Overhead:**
- Quality score calculation: ~0.1ms per peer
- Triggered only on ping responses (~1/minute per peer)
- **Negligible** impact on performance

**Network Overhead:**
- Stats in pong response: ~100 bytes
- Stats in findNode response: ~100 bytes per node
- Typical findNode returns 20 nodes = ~2 KB additional
- **Minimal** impact (< 1% increase)

## Migration Path

**Phase 1: Backwards-Compatible Stats Collection**
- Add `stats` field to DHTNode
- Include stats in pong/findNode responses
- Old clients ignore stats field (backwards compatible)
- New clients collect and use stats

**Phase 2: Quality-Based Selection**
- Bridge nodes use quality scores for onboarding peer selection
- Clients prefer high-quality peers for routing
- Network organically improves as more nodes adopt

**Phase 3: Advanced Features**
- Network health dashboards
- Quality-based incentives (future: token rewards for high-quality peers)
- Automatic peer pruning (drop persistently low-quality peers)

## Implementation Checklist

### Core Data Structures
- [ ] Add `stats` object to DHTNode class
- [ ] Implement `updateFromPingResponse()`
- [ ] Implement `updateQualityScore()`
- [ ] Implement `recordTimeout()`
- [ ] Implement `recordDisconnect()`
- [ ] Implement `getExportableStats()`

### Protocol Updates
- [ ] Add stats to ping response (pong message)
- [ ] Update `handlePing()` to include `getLocalStats()`
- [ ] Update `handlePong()` to process peer stats
- [ ] Add stats to findNode response
- [ ] Update `handleFindNode()` to include peer stats

### Routing Table Integration
- [ ] Implement `getNodesByQuality()`
- [ ] Implement `getNodesWithMinimumQuality()`
- [ ] Implement `getQualityStats()`
- [ ] Update ping timeout handler to call `recordTimeout()`
- [ ] Update disconnect handler to call `recordDisconnect()`

### Utility Functions
- [ ] Implement `detectConnectionType()`
- [ ] Implement `getGeolocation()` (optional, privacy-aware)
- [ ] Implement `detectNATType()`
- [ ] Implement `getUptime()`
- [ ] Implement `getKBucketFullness()`

### Testing
- [ ] Unit tests for quality score calculation
- [ ] Test stats serialization/deserialization
- [ ] Test backwards compatibility (old clients ignore stats)
- [ ] Test privacy controls (opt-out of geolocation sharing)
- [ ] Integration test with quality-based peer selection

### Documentation
- [ ] Update CLAUDE.md with stats architecture
- [ ] Document privacy considerations
- [ ] Add examples to DHTNode API docs
- [ ] Create debugging guide for quality metrics

## Future Enhancements

**1. Machine Learning Quality Prediction:**
- Train model on historical peer behavior
- Predict future quality based on patterns
- Proactive peer replacement before degradation

**2. Reputation System:**
- Long-term reputation scores (persistent across sessions)
- Cryptographically signed reputation attestations
- Distributed reputation consensus

**3. Economic Incentives:**
- Token rewards for high-quality peers
- Quality-based prioritization in routing
- Marketplace for premium routing/storage services

**4. Geographic Optimization:**
- Prefer geographically close peers for latency
- Regional peer clustering
- CDN-like content distribution

**5. Adaptive Quality Thresholds:**
- Adjust minimum quality based on network health
- Higher thresholds when network is healthy
- Lower thresholds during network stress

## Questions for Discussion

1. **Quality Score Weights**: Are the proposed weights optimal?
   - 25% uptime, 20% stability, 20% response time, 15% reliability, 20% DHT health
   - Should we adjust based on use case (onboarding vs routing vs storage)?

2. **Stats Sharing**: Should stats sharing be:
   - Always enabled (current proposal)
   - Opt-in (privacy-first)
   - Opt-out (participation-first)

3. **Quality Thresholds**: What minimum quality score for:
   - Onboarding peers: 0.5? 0.6? 0.7?
   - Routing peers: 0.3? 0.5?
   - Storage peers: 0.6? 0.8?

4. **Geolocation Granularity**:
   - Country-level only (current proposal)
   - Region-level (e.g., "US-West")
   - No geolocation at all (privacy-first)

5. **Persistent Stats**: Should quality scores persist across restarts?
   - Pros: Better long-term peer selection
   - Cons: Privacy concerns, state management complexity
