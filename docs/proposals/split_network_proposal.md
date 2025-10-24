# Network Partition Detection Proposal

## Problem Statement

### The Scenario: Network Partition (Split-Brain)

When a DHT network experiences a network partition (e.g., country-level internet disconnection), the network can split into multiple independent fragments that continue operating:

```
Time T0: Single global DHT (1,000,000 nodes)
├─ Region A: 400,000 nodes
├─ Region B: 500,000 nodes
└─ Region C: 100,000 nodes

Time T1: Region C gets disconnected (internet cable cut)
├─ Main DHT: Regions A+B (900,000 nodes) ← continues operating
└─ Isolated DHT: Region C (100,000 nodes) ← continues operating independently

Both networks:
- Accept new data (store operations)
- Process requests
- Believe they are "the real DHT"
- Have divergent state (data stored in one partition is not in the other)

Time T2: Region C reconnects
- Now we have TWO DHTs with conflicting data
- Both think they're legitimate
- Need to detect this and decide: merge or reject?
```

### Why This is Hard

**Key Challenge**: No node in a Kademlia DHT knows the global network size.

- Each node only maintains **k connections** (k=20 in our system)
- Every node reports the same k-value regardless of network size
- A 1,000,000-node network looks identical to a 100,000-node network from a single node's perspective

**What We Need**:
1. Detect when a reconnecting peer was part of an isolated partition
2. Determine which partition is the "main" network (if any)
3. Prevent isolated fragments from polluting the main network with stale data
4. Handle ambiguous cases (50/50 split) gracefully

## Rejected Solutions

### 1. Network UUID ❌

**Idea**: Generate a unique UUID when the DHT network is created, include it in all membership tokens.

**Why Rejected**: Only detects if a completely different DHT network was created. Does NOT detect partitions of the same network.

```javascript
// Both partitions have the same UUID
MainNetwork.uuid = "550e8400-e29b-41d4-a716-446655440000"
IsolatedNetwork.uuid = "550e8400-e29b-41d4-a716-446655440000"  // SAME!

// Cannot distinguish between them
```

### 2. Centralized Heartbeat Server ❌

**Idea**: External server broadcasts periodic heartbeat to all nodes. If a node stops receiving heartbeat, it knows it's disconnected.

**Why Rejected**:
- **Single point of failure** - if heartbeat server goes down, entire DHT collapses
- **Defeats decentralization** - the whole point is to avoid central dependencies
- **Scalability** - cannot broadcast to millions of nodes efficiently

```javascript
HeartbeatServer
      ↓
   [fails]
      ↓
All 1M nodes think they're disconnected
      ↓
Entire DHT collapses ❌
```

### 3. Gossip Full Peer Lists ❌

**Idea**: Each node broadcasts a sample of peers it knows, aggregate to detect consensus.

**Why Rejected**:
- **Not scalable** - with 1,000,000 nodes, even a small sample (50 peers) per node creates massive message overhead
- **Bandwidth explosion** - 1M nodes × 20 connections × 50 peer IDs = billions of messages
- **No consensus possible** - different samples will always have different hashes

```javascript
// Each node sends 50 peer IDs to 20 connections
MessageOverhead = 1,000,000 nodes × 20 peers × 50 IDs × 40 bytes
               = 40 GB of gossip data PER ROUND
```

### 4. Vector Clocks / Version Vectors ❌

**Idea**: Track causal ordering of all DHT operations using vector clocks.

**Why Rejected**:
- **Memory explosion** - must maintain a counter for EVERY node (1M entries per node)
- **Too complex** - requires tracking every DHT operation
- **Not practical** for dynamic membership

```javascript
// Each node must track version for every other node
versionVector = {
  'node000001': 1523,
  'node000002': 2041,
  // ... 1 million entries
  'node999999': 1876
}
// Memory: ~40MB per node just for vector clock
```

### 5. Merkle Tree of DHT State ❌

**Idea**: Build a blockchain-like hash chain of all DHT operations, detect fork point.

**Why Rejected**:
- **Essentially building a blockchain** - massive complexity overhead
- **Storage explosion** - must store entire operation history
- **Performance** - too slow for high-throughput DHT
- **Not designed for DHT use case** - blockchains solve different problem (Byzantine consensus)

## Proposed Solution: Hop-Based Network Size Estimation

### Core Insight

In Kademlia, lookup operations converge in **O(log₂ N)** hops, where N is the network size.

```javascript
// Small network (1,000 nodes)
findNode() converges in ~10 hops (log₂(1000) ≈ 10)

// Large network (1,000,000 nodes)
findNode() converges in ~20 hops (log₂(1,000,000) ≈ 20)

// We can estimate N from measured hop count!
estimatedSize = 2^(avgHops) × (k / alpha)
```

### Algorithm

#### Step 1: Local Network Size Estimation

Each node independently estimates network size:

```javascript
class NetworkSizeEstimator {
  async estimateNetworkSize() {
    const sampleSize = 10; // Do 10 random lookups
    const hopCounts = [];

    // Perform random lookups and track hops
    for (let i = 0; i < sampleSize; i++) {
      const randomId = DHTNodeId.random();
      const result = await this.dht.findNode(randomId, { trackHops: true });
      hopCounts.push(result.hops);
    }

    // Average hops across samples
    const avgHops = hopCounts.reduce((a, b) => a + b, 0) / hopCounts.length;

    // Estimate size: N ≈ 2^(avgHops) × (k/alpha)
    // k=20 (bucket size), alpha=3 (parallelism)
    const estimatedSize = Math.pow(2, avgHops) * (20 / 3);

    return {
      timestamp: Date.now(),
      avgHops: avgHops,
      estimatedSize: Math.round(estimatedSize),
      confidence: this.calculateConfidence(hopCounts)
    };
  }
}
```

#### Step 2: Distributed Consensus via Lightweight Gossip

Nodes exchange size estimates (just one number, not full peer lists):

```javascript
class DistributedSizeConsensus {
  async broadcastSizeEstimate() {
    const myEstimate = await this.estimator.estimateNetworkSize();

    const message = {
      type: 'network_size_estimate',
      observer: this.localNodeId,
      timestamp: Date.now(),
      estimatedSize: myEstimate.estimatedSize,
      avgHops: myEstimate.avgHops,
      confidence: myEstimate.confidence
    };

    // Send to k connected peers (only 20 messages, not millions!)
    for (const peerId of this.getConnectedPeers()) {
      await this.sendMessage(peerId, message);
    }
  }

  handleSizeEstimate(fromPeer, estimate) {
    this.peerEstimates.set(fromPeer, estimate);
    this.updateConsensus();
  }

  updateConsensus() {
    // Collect all size estimates (from 20 peers)
    const allEstimates = Array.from(this.peerEstimates.values())
      .map(e => e.estimatedSize);

    // Add our own estimate
    allEstimates.push(this.myEstimate.estimatedSize);

    // Median of all estimates (robust to outliers)
    allEstimates.sort((a, b) => a - b);
    const medianSize = allEstimates[Math.floor(allEstimates.length / 2)];

    // Round to nearest power of 2 for stability
    const roundedSize = Math.pow(2, Math.round(Math.log2(medianSize)));

    // Create consensus hash
    this.consensusHash = hash({
      networkSize: roundedSize,
      magnitude: Math.floor(Math.log10(roundedSize))
    });

    return {
      consensusHash: this.consensusHash,
      medianSize: medianSize,
      roundedSize: roundedSize
    };
  }
}
```

#### Step 3: Partition Detection on Reconnection

When a peer reconnects, compare consensus hashes:

```javascript
class PartitionDetector {
  detectPartition(peerEstimate, bridgeEstimate) {
    // Check if consensus hashes match
    if (peerEstimate.consensusHash === bridgeEstimate.consensusHash) {
      // Same network view - allow reconnection
      return { status: 'OK', confidence: 'HIGH' };
    }

    // Different consensus - check size ratio
    const peerSize = peerEstimate.roundedSize;
    const bridgeSize = bridgeEstimate.roundedSize;
    const ratio = peerSize / bridgeSize;

    // Calculate confidence intervals
    const peerConfidence = peerEstimate.confidence || 0.7;
    const bridgeConfidence = bridgeEstimate.confidence || 0.7;

    const peerMargin = peerSize * (1 - peerConfidence);
    const bridgeMargin = bridgeSize * (1 - bridgeConfidence);

    const peerRange = {
      min: peerSize - peerMargin,
      max: peerSize + peerMargin
    };
    const bridgeRange = {
      min: bridgeSize - bridgeMargin,
      max: bridgeSize + bridgeMargin
    };

    // Check if ranges overlap
    const rangesOverlap = !(peerRange.max < bridgeRange.min ||
                            bridgeRange.max < peerRange.min);

    // Decision logic based on size ratio
    if (ratio < 0.3) {
      // Peer network is <30% of bridge network
      return {
        status: 'MINORITY_PARTITION',
        confidence: 'HIGH',
        peerSize,
        bridgeSize,
        ratio,
        action: 'REJECT_OR_RESYNC',
        message: 'You are in a small isolated fragment (discard local data and resync from main network)'
      };

    } else if (ratio > 3.0) {
      // Peer network is 3x larger than bridge network
      return {
        status: 'BRIDGE_POSSIBLY_ISOLATED',
        confidence: 'MEDIUM',
        peerSize,
        bridgeSize,
        ratio,
        action: 'BRIDGE_SHOULD_VERIFY',
        message: 'Bridge node may be in isolated fragment, not the reconnecting peer'
      };

    } else if (ratio >= 0.6 && ratio <= 1.7 && !rangesOverlap) {
      // Similar sizes but different consensus
      return {
        status: 'SPLIT_BRAIN',
        confidence: 'MEDIUM',
        peerSize,
        bridgeSize,
        ratio,
        action: 'MANUAL_RESOLUTION',
        message: 'Network appears to have split into similar-sized fragments - manual merge required'
      };

    } else if (rangesOverlap) {
      // Ranges overlap but hashes differ
      return {
        status: 'UNCERTAIN',
        confidence: 'LOW',
        peerSize,
        bridgeSize,
        ratio,
        action: 'ADDITIONAL_CHECKS_NEEDED',
        message: 'Size estimates compatible but network view differs - needs additional validation'
      };

    } else {
      // Moderate size difference
      return {
        status: 'UNCERTAIN_PARTITION',
        confidence: 'LOW',
        peerSize,
        bridgeSize,
        ratio,
        action: 'REQUEST_ADDITIONAL_VALIDATION',
        message: 'Cannot determine which network is primary - needs additional validation'
      };
    }
  }
}
```

### Decision Matrix

| Peer Size | Bridge Size | Ratio | Hash Match? | Decision | Action |
|-----------|-------------|-------|-------------|----------|--------|
| 100,000 | 1,000,000 | 0.10 | No | MINORITY_PARTITION | Reject or force resync |
| 300,000 | 1,000,000 | 0.30 | No | MINORITY_PARTITION | Reject or force resync |
| 500,000 | 1,000,000 | 0.50 | No | SPLIT_BRAIN | Manual resolution required |
| 800,000 | 1,000,000 | 0.80 | No | UNCERTAIN | Additional validation |
| 950,000 | 1,000,000 | 0.95 | Yes | OK | Allow reconnection |
| 980,000 | 1,000,000 | 0.98 | No | UNCERTAIN | Additional validation (too close to call) |
| 1,000,000 | 200,000 | 5.00 | No | BRIDGE_ISOLATED | Bridge is in minority, not peer |

## Advantages of Hop-Based Approach

✅ **Scalable**: Works with 10 nodes or 10 million nodes
✅ **Lightweight**: Only broadcasts a single number (size estimate), not peer lists
✅ **Distributed**: No central authority, each node estimates independently
✅ **Partition-aware**: Different partitions will have different size estimates
✅ **Bandwidth-efficient**: Each node only sends ~20 messages (to k peers)
✅ **No external dependencies**: Purely based on DHT's own lookup behavior
✅ **Mathematically grounded**: Based on proven Kademlia O(log N) convergence properties

## Limitations and Edge Cases

### 1. Estimation Accuracy

**Issue**: Hop count can vary based on:
- Network churn (nodes joining/leaving)
- Routing table population
- Random variation in lookups

**Mitigation**:
- Take median of multiple samples (10+ lookups)
- Use confidence intervals
- Round to nearest power of 2 for stability

### 2. 50/50 Split (Split-Brain)

**Issue**: When network splits evenly (500k vs 500k), cannot determine which is "correct"

**Mitigation**:
- Detect this case explicitly (ratio 0.6-1.7)
- Return 'SPLIT_BRAIN' status
- Require manual resolution or external decision maker

### 3. Bridge Node in Minority

**Issue**: The bridge node itself might be in the isolated partition

**Mitigation**:
- Check for inverse case (ratio > 3.0)
- Return 'BRIDGE_POSSIBLY_ISOLATED' status
- Bridge should verify with other bridge nodes

### 4. Overlapping Confidence Intervals

**Issue**: Estimates might overlap even if networks are different

**Mitigation**:
- Return 'UNCERTAIN' status
- Request additional validation signals
- Could combine with other heuristics (time since last seen, etc.)

## Implementation Checklist

- [ ] Add `trackHops: true` parameter to `findNode()` method
- [ ] Create `NetworkSizeEstimator` class in `src/dht/`
- [ ] Create `DistributedSizeConsensus` class in `src/dht/`
- [ ] Add `network_size_estimate` message type to DHT protocol
- [ ] Implement periodic size estimation (every 5 minutes)
- [ ] Implement lightweight gossip of size estimates
- [ ] Add consensus hash calculation
- [ ] Update `PassiveBridgeNode.handleReconnectionValidation()` to check consensus
- [ ] Add partition detection logic with decision matrix
- [ ] Add user-facing warnings for SPLIT_BRAIN and UNCERTAIN cases
- [ ] Test with simulated partitions (disconnect nodes, measure detection)

## Future Enhancements

### Combine Multiple Signals

Instead of relying solely on size estimation, could combine:

1. **Size estimation** (from hop counts) - primary signal
2. **Time since last seen** - long absence increases partition risk
3. **Peer overlap** - sample 10 random peers from each side, check overlap
4. **Data version** - simple counter of DHT operations since last connection
5. **Multiple bridge consensus** - query 3+ bridge nodes, use majority vote

### Automatic Merge Strategies

For minority partitions, could implement:

1. **Data comparison** - check which keys differ between partitions
2. **Last-write-wins** - use timestamps to resolve conflicts
3. **Selective merge** - allow user to choose which data to keep
4. **Conflict log** - record all conflicts for manual review

### Network Health Monitoring

Track network size over time to detect slow fragmentation:

```javascript
networkSizeHistory = [
  { timestamp: T0, size: 1000000 },
  { timestamp: T1, size: 1000000 },
  { timestamp: T2, size: 900000 },  // 10% drop - investigate!
  { timestamp: T3, size: 900000 }
];
```

## Related Documentation

- **Kademlia Paper**: "Kademlia: A Peer-to-Peer Information System Based on the XOR Metric" (Maymounkov & Mazières, 2002)
  - Section on routing convergence: O(log N) hops
- **Network Partition Detection**: CAP theorem implications
- **Split-Brain Problem**: Classic distributed systems challenge

## Open Questions

1. **What confidence threshold is acceptable?** Current proposal uses 70% confidence minimum
2. **How to handle bridge node consensus?** If we have multiple bridge nodes, should they vote?
3. **Should we store partition history?** Track previous partitions to detect patterns
4. **What about malicious partitions?** Can an attacker create fake partitions to disrupt network?
5. **Merge vs reject?** Should minority partitions ever be allowed to merge, or always reject?

## Status

**Current Status**: Proposal stage - not yet implemented

**Next Steps**:
1. Validate hop-based estimation accuracy with simulations
2. Test with multi-node local network setup
3. Implement basic version for testing
4. Gather real-world data on estimation accuracy
5. Refine decision thresholds based on empirical results

**Last Updated**: 2025-01-XX
