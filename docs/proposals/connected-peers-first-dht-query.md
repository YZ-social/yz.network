# Proposal: Connected-Peers-First DHT Query Strategy

## Status
**Proposed** - 2025-01-02

## Problem Statement

Browser onboarding is failing with "findNode timeout - taking too long" errors. Investigation revealed that the bridge node's `findNode()` operation times out after 10 seconds because:

1. Bridge has 14+ peers in routing table but only 2-3 active connections
2. `findNode()` queries disconnected peers from routing table
3. Each disconnected peer query times out after 10 seconds
4. Total query time exceeds the 10-second timeout in `handleGetOnboardingPeer()`

**Root Cause**: DHT queries assume routing table entries are connected, but background maintenance hasn't established connections fast enough.

## Proposed Solution

**Prioritize active connections over routing table entries during DHT lookups.**

### Implementation Strategy

1. **Filter candidates by connection status** before each query iteration
2. **Query connected peers first** (up to α = 3 peers)
3. **Fall back to disconnected peers** only if insufficient connected candidates
4. **Use differentiated timeouts**:
   - Connected peers: 10s (conservative, should respond in <100ms)
   - Disconnected peers: 3s (covers connection establishment + query)
5. **Accept one extra hop** as acceptable trade-off for avoiding timeouts

### Key Insight

**Neighborhood connectivity in Kademlia**: Nodes in the same K-bucket likely share many connections due to address-space locality. Therefore:
- Querying a **connected nearby peer** returns results in <100ms
- Waiting for **disconnected closer peer** timeout takes 10s
- **Extra hop cost** (20-50ms) << **timeout cost** (10s) = **200x-500x faster**

## Comparison with Production DHT Implementations

### IPFS/libp2p DHT (go-libp2p-kad-dht)

**Connection Model**: Persistent TCP/QUIC connections

**Strategy**:
- Maintains separate pools: `queryPeers` (active) vs `unqueriedPeers` (candidates)
- Queries connected peers first via `GetClosestPeers()`
- Only attempts new connections when connected pool exhausted

**Timeouts**:
- Connected peers: **5s**
- Disconnected peers: **15s** (connection + query)
- Parallel queries with context cancellation

**Performance**:
- Typical query: **<500ms** (3 hops, all connected)
- Cold start: **2-5s** (includes connection establishments)
- Network: **1M+ nodes**

**Code Pattern**:
```go
connectedPeers := filterConnected(candidates)
disconnectedPeers := filterDisconnected(candidates)

queryPeers(connectedPeers[:alpha])

if len(connectedPeers) < alpha {
    dialAndQuery(disconnectedPeers[:needed])
}
```

---

### BitTorrent DHT (Mainline DHT)

**Connection Model**: Stateless UDP (no persistent connections)

**Strategy**:
- Categorizes nodes: **"good"** (recently seen), **"questionable"** (15min old), **"bad"** (failed)
- Only queries "good" nodes during lookups
- Aggressive **2-second timeout** per query
- 8 parallel queries

**Node State Machine**:
```
good → questionable → bad
 ↑          ↓          ↓
 └── response ────────┘ (remove)
```

**Performance**:
- Typical query: **<1s** (parallel, 2s timeout)
- Network: **20M+ nodes** (largest public DHT)
- Optimized for **high churn**

**Mapping to Your Approach**:
- BitTorrent "good" = Your "connected"
- BitTorrent "questionable" = Your "disconnected"

---

### Ethereum Discovery v5 (discv5)

**Connection Model**: Stateless UDP

**Strategy**:
- Uses **"live nodes first"** strategy
- Maintains **LIFO queue** of recently active nodes
- Queries live nodes exclusively until queue exhausted
- Very aggressive **500ms timeout**

**Live Node Definition**:
- Successful PONG/FINDNODE within last **12 hours**
- Active TCP/UDP connection established

**Performance**:
- Typical query: **<300ms** (parallel queries)
- Network: **~10K nodes**
- Optimized for **low latency** (blockchain consensus)

**Unique Features**:
- Adaptive timeout: 500ms baseline, increases if >30% timeout
- Connection pooling for UDP socket reuse

---

## Comparison Matrix

| Feature | IPFS/libp2p | BitTorrent DHT | Ethereum discv5 | **Proposed** |
|---------|-------------|----------------|-----------------|--------------|
| **Connection Model** | TCP/QUIC | UDP | UDP | WebSocket/WebRTC |
| **"Active" Definition** | Connected | Recent responder (15min) | Recent responder (12h) | Connected |
| **Query Parallelism** | α=3 sequential | 8 parallel | 3 parallel | α=3 sequential |
| **Connected Timeout** | 5s | 2s | 500ms | **10s** |
| **Disconnected Timeout** | 15s | N/A (skip) | N/A (skip) | **3s** |
| **Fallback Strategy** | Dial + query | Query next "good" | Query routing table | Query disconnected |
| **Network Size** | 1M+ | 20M+ | 10K | 15-1000 |
| **Typical Query Time** | <500ms | <1s | <300ms | **<500ms** (target) |

## Why This Approach Fits

### Similarities to Industry Best Practices
1. ✅ Prioritize active connections (all three do this)
2. ✅ Shorter timeouts for fast failure
3. ✅ Accept extra hop trade-off

### Justified Differences

**1. Conservative 10s timeout for connected peers**
- IPFS: 5s, BitTorrent: 2s, Ethereum: 500ms
- **Justified**: WebRTC can have variable latency, higher timeout is safer
- **Low risk**: Connected peers respond in <100ms, timeout rarely hit

**2. 3s timeout for disconnected peers**
- IPFS: 15s, BitTorrent/Ethereum: Skip entirely
- **Justified**: Smaller network, worth trying disconnected peers
- **Benefit**: More resilient to partial network partitions

**3. Sequential iteration (α=3)**
- IPFS: Sequential, BitTorrent/Ethereum: Parallel
- **Justified**: Smaller network, lower overhead, easier debugging

## Implementation Details

### Modified findNode Algorithm

```javascript
async findNode(targetId, options = {}) {
  let candidates = getRoutingTablePeers();
  let queried = new Set();
  let closest = [];

  while (needMoreResults()) {
    // 1. FILTER BY CONNECTION STATUS
    const connected = candidates.filter(p =>
      !queried.has(p) && isConnected(p)
    );
    const disconnected = candidates.filter(p =>
      !queried.has(p) && !isConnected(p)
    );

    // 2. PRIORITIZE CONNECTED PEERS
    let toQuery = connected.slice(0, alpha);

    // 3. FALLBACK TO DISCONNECTED IF NEEDED
    if (toQuery.length < alpha) {
      toQuery.push(...disconnected.slice(0, alpha - toQuery.length));
    }

    if (toQuery.length === 0) break;

    // 4. QUERY WITH APPROPRIATE TIMEOUTS
    for (const peer of toQuery) {
      const timeout = isConnected(peer) ? 10000 : 3000;
      try {
        const response = await queryPeer(peer, timeout);
        candidates.push(...response.peers);
        closest = updateClosest(closest, response.peers);
      } catch (error) {
        // Query failed, continue to next peer
      }
      queried.add(peer);
    }
  }

  return closest;
}
```

### Helper Method: isConnected()

```javascript
isConnected(peerId) {
  const node = this.routingTable.getNode(peerId);
  if (!node) return false;

  // Check if node has active connection manager with open connection
  return node.connectionManager?.isConnected() || false;
}
```

### Query Method with Timeout

```javascript
async queryPeer(peerId, timeout) {
  const node = this.routingTable.getNode(peerId);
  const actualTimeout = node?.isConnected() ? 10000 : 3000;

  return await this.sendRequestWithResponse(
    peerId,
    { type: 'find_node', target: targetId },
    actualTimeout
  );
}
```

## Expected Performance Improvement

### Current State (bridge-node-2)
- 14 peers in routing table
- 2-3 active connections
- Query hits 10s timeout on disconnected peers
- **Total time: 10s (timeout)**

### After Implementation
- First iteration queries 2-3 connected peers → <100ms
- Connected peers return neighbors → likely includes closer nodes
- **Total time: <500ms** (3-5 iterations, all connected)

**Performance gain: 20x faster**

## Risks and Mitigations

### Risk 1: Extra Hop Adds Latency
- **Impact**: Low - one extra hop = 20-50ms
- **Mitigation**: Acceptable vs 10s timeout savings

### Risk 2: Incomplete Results
- **Impact**: Low - neighborhood connectivity ensures coverage
- **Mitigation**: Fallback to disconnected peers if needed

### Risk 3: Network Partitions
- **Impact**: Medium - might miss nodes in disconnected partition
- **Mitigation**: 3s timeout still allows disconnected peer queries

## Success Metrics

1. **Browser onboarding success rate**: >95% (currently 0%)
2. **Average findNode time**: <500ms (currently 10s timeout)
3. **findNode completion rate**: >99% (currently timeouts)

## Testing Plan

1. **Unit tests**: Mock connected/disconnected peer scenarios
2. **Integration tests**: Multi-node network with partial connectivity
3. **Production validation**: Monitor bridge logs for findNode timing
4. **Stress test**: 1000-node network with varying connection rates

## Rollout Plan

1. Implement changes in `KademliaDHT.findNode()`
2. Add logging for connected vs disconnected peer queries
3. Deploy to staging (bridge-node-1, bridge-node-2)
4. Test browser onboarding (5 attempts minimum)
5. Monitor logs for performance metrics
6. Deploy to production if success rate >95%

## References

- [IPFS DHT Implementation](https://github.com/libp2p/go-libp2p-kad-dht)
- [BitTorrent DHT Protocol](http://www.bittorrent.org/beps/bep_0005.html)
- [Ethereum Discovery v5 Spec](https://github.com/ethereum/devp2p/blob/master/discv5/discv5.md)
- [Original Kademlia Paper](https://pdos.csail.mit.edu/~petar/papers/maymounkov-kademlia-lncs.pdf)

## Related Issues

- Browser onboarding timeout: "findNode timeout - taking too long"
- Background maintenance not establishing connections fast enough
- Routing table entries without active connections

## Author

Implementation based on production DHT analysis and industry best practices (IPFS, BitTorrent, Ethereum).
