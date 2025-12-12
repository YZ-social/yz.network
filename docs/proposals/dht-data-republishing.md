# DHT Data Republishing Proposal

## Problem Statement

Currently, when data is stored in the DHT, it is replicated to the k-closest nodes at store time. However, there is no mechanism to maintain this replication as nodes join, leave, or fail. Data can be lost when storing nodes go offline.

Per the Kademlia specification, stored data must be periodically republished to ensure it remains available on k nodes.

## Goals

1. Ensure stored data persists on k nodes despite network churn
2. Minimize network traffic (avoid redundant republishing)
3. Distribute republishing work across storing nodes
4. No single point of failure

## Design

### Storage Metadata

Each stored item will have local-only metadata (never replicated):

```javascript
{
  // DATA (replicated)
  key: string,
  value: any,

  // LOCAL METADATA (node-specific, never replicated)
  receivedAt: timestamp,        // When this node first received the data
  lastRefreshedAt: timestamp,   // When data was last refreshed (by any node)
  myRefreshTime: timestamp,     // Pre-calculated next refresh time for THIS node
  ttl: number,                  // Time-to-live in milliseconds
  originatedByMe: boolean       // Did this node create the data?
}
```

### Randomized Refresh Timing

To prevent all k nodes from refreshing simultaneously, each node calculates its own refresh time:

```javascript
myRefreshTime = lastRefreshedAt + ttl + random(0, spreadWindow)
```

Where:
- `ttl`: Base refresh interval (e.g., 1 hour)
- `spreadWindow`: Random spread to distribute refreshes (e.g., 5 minutes)

### The Coordination Mechanism

When Node A refreshes data:
1. A performs `findNode(key)` to discover current k-closest nodes
2. A sends `store(key, value)` to those nodes
3. Receiving nodes update their `lastRefreshedAt = now`
4. Receiving nodes recalculate `myRefreshTime`
5. When other nodes' timers fire, they see fresh `lastRefreshedAt` and skip

This achieves distributed coordination without explicit messaging:
- First node to refresh "wins"
- Others see the refresh and defer
- If winner fails, next in line takes over

### Refresh Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           TIME PROGRESSION                               │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  lastRefreshedAt              ttl expires                                │
│       │                           │                                      │
│       │                           │←──── spread window ────→│            │
│       │                           │                         │            │
│       │                     Node A: ├──*                    │            │
│       │                     Node B: ├──────*                │            │
│       │                     Node C: ├──────────*            │            │
│       │                                    │                             │
│       │                                    ▼                             │
│       │                              A refreshes                         │
│       │                              (findNode + store)                  │
│       │                                    │                             │
│       │                                    ▼                             │
│       │                         B,C receive store()                      │
│       │                         update lastRefreshedAt                   │
│       │                                    │                             │
│       │                                    ▼                             │
│       │                         B,C timers fire later                    │
│       │                         see fresh timestamp                      │
│       │                         SKIP refresh                             │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Network Probe Strategy

Since routing tables don't guarantee knowledge of k-closest nodes for distant keys, we must probe:

```javascript
async refreshStoredData(key, value) {
  // 1. Find current k-closest nodes for this key
  const kClosest = await this.findNode(key);

  // 2. Store to each (parallel, with timeout)
  const results = await Promise.allSettled(
    kClosest.map(node => this.sendStore(node.id, key, value))
  );

  // 3. Log success/failure for monitoring
  const succeeded = results.filter(r => r.status === 'fulfilled').length;
  console.log(`Refreshed ${key}: ${succeeded}/${kClosest.length} nodes`);
}
```

### Refresh Timer Implementation

```javascript
class RepublishManager {
  constructor(dht, options = {}) {
    this.dht = dht;
    this.ttl = options.ttl || 3600000;           // 1 hour default
    this.spreadWindow = options.spread || 300000; // 5 minute spread
    this.checkInterval = options.check || 60000;  // Check every minute
  }

  start() {
    this.timer = setInterval(() => this.checkRefreshes(), this.checkInterval);
  }

  stop() {
    clearInterval(this.timer);
  }

  async checkRefreshes() {
    const now = Date.now();

    for (const [key, entry] of this.dht.storage) {
      // Skip if not yet time to refresh
      if (now < entry.myRefreshTime) continue;

      // Skip if recently refreshed (another node beat us)
      if (now - entry.lastRefreshedAt < this.ttl) {
        // Recalculate our next refresh time
        entry.myRefreshTime = entry.lastRefreshedAt + this.ttl + this.randomSpread();
        continue;
      }

      // Time to refresh
      await this.refreshStoredData(key, entry.value);
      entry.lastRefreshedAt = now;
      entry.myRefreshTime = now + this.ttl + this.randomSpread();
    }
  }

  randomSpread() {
    return Math.floor(Math.random() * this.spreadWindow);
  }
}
```

### Handling Incoming Stores

When receiving a `store` request for data we already have:

```javascript
handleStoreRequest(key, value, fromPeerId) {
  const existing = this.storage.get(key);

  if (existing) {
    // Data exists - this is a refresh
    existing.lastRefreshedAt = Date.now();
    existing.myRefreshTime = existing.lastRefreshedAt + this.ttl + this.randomSpread();
    // Value should be identical, but could update if newer
  } else {
    // New data
    this.storage.set(key, {
      value,
      receivedAt: Date.now(),
      lastRefreshedAt: Date.now(),
      myRefreshTime: Date.now() + this.ttl + this.randomSpread(),
      ttl: this.defaultTTL,
      originatedByMe: false
    });
  }
}
```

### Expiration

Data that hasn't been refreshed should eventually expire:

```javascript
const expirationTime = entry.lastRefreshedAt + (entry.ttl * 2);  // 2x TTL grace period
if (Date.now() > expirationTime) {
  this.storage.delete(key);
}
```

## Configuration Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `ttl` | 3600000 (1 hour) | Base refresh interval |
| `spreadWindow` | 300000 (5 min) | Random spread to prevent simultaneous refreshes |
| `checkInterval` | 60000 (1 min) | How often to check for needed refreshes |
| `expirationMultiplier` | 2 | Data expires after TTL × this multiplier without refresh |

## Network Traffic Analysis

**Per data item per TTL period:**
- 1 node performs refresh (winner of random timing)
- 1 `findNode` query (α parallel messages × log(n) hops)
- k `store` messages

**For network with N items stored:**
- N refreshes per TTL period
- Distributed across storing nodes
- No duplicate refreshes due to coordination mechanism

**Compared to no coordination (all k nodes refresh):**
- k× reduction in `findNode` queries
- k× reduction in `store` messages
- Significant bandwidth savings

## Edge Cases

### Node Joins During Spread Window

If a new node joins and becomes one of k-closest during the spread window:
- It won't have the data yet
- First node to refresh will store to it
- Handled automatically

### All Storing Nodes Fail

If all k nodes fail before any refreshes:
- Data is lost
- This is acceptable - data has implicit TTL
- Originators should re-store important data

### Network Partition

If network partitions:
- Each partition refreshes independently
- Data stays alive in both partitions
- On merge, higher-timestamp wins (or both coexist)

### Clock Skew

Nodes may have different system times:
- Use relative timestamps (elapsed time) not absolute
- `lastRefreshedAt` is "when I received it" not "when it was sent"
- Skew affects spread window slightly but not correctness

## Optimized Design: Delegated Replication with Lightweight Verification

The basic design above works but requires each refreshing node to probe the network for k-closest nodes. This section describes an optimized approach that significantly reduces network traffic.

### Prerequisite: Active Neighborhood Maintenance

Every node must actively maintain connections to its k-closest neighbors (not just standard k-bucket maintenance):

```javascript
async maintainNeighborhood() {
  // Probe for nodes close to OUR OWN address
  const myClosest = await this.findNode(this.nodeId);

  // Ensure we're connected to all of them
  for (const node of myClosest) {
    if (!this.isConnected(node.id)) {
      await this.connect(node.id);
    }
  }

  // Split buckets if neighborhood is dense (more than k very close nodes)
  this.routingTable.splitIfNeeded(this.nodeId);
}
```

**Why this matters**: If every node knows its own k-closest neighbors, then the node closest to any key already knows the k-closest nodes for that key (they're approximately the same set).

### Delegated Replication

Instead of the initiating node finding and storing to all k nodes, delegate to the closest node:

```
Current approach (expensive):
  A → findNode(key) → discovers [B, C, D, E...k] → stores to all k

Optimized approach:
  A → findNode(key) → finds B is closest
  A → B: "replicate this key"
  B uses LOCAL routing table to store to its k-closest neighbors
  B → A: "done, stored to k nodes"
```

**Network cost reduction:**
- Current: O(k × log n) messages for findNode + k store messages
- Optimized: O(log n) messages for findNode + 1 delegate message + k local stores

### Lightweight Verification Messages

For large data, don't send the full value unless needed:

```javascript
// Replication request (small message)
{
  type: 'replicate_check',
  key: 'data:abc123',
  hash: 'sha256:9f86d08...',  // Hash of the value
  ttl: 3600000
}

// Possible responses
{ type: 'replicate_ack', status: 'have_it' }      // Has data, hash matches
{ type: 'replicate_ack', status: 'need_data' }    // Missing or hash mismatch
{ type: 'replicate_ack', status: 'stored' }       // Received and stored full data
```

### Delegated Replication Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    DELEGATED REPLICATION FLOW                            │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  1. Refresh timer fires on Node A for key X                              │
│     │                                                                    │
│     ▼                                                                    │
│  2. A does findNode(X) → finds Node B is closest to X                   │
│     │                                                                    │
│     ▼                                                                    │
│  3. A → B: { type: 'replicate_request', key: X, hash: H, value?: V }    │
│     │                                                                    │
│     ▼                                                                    │
│  4. B looks up its k-closest neighbors (LOCAL, no network probe)         │
│     B's neighbors: [C, D, E, F, G, ...]                                  │
│     │                                                                    │
│     ▼                                                                    │
│  5. B → C, D, E, F...: { type: 'replicate_check', key: X, hash: H }     │
│     │                                                                    │
│     ├──→ C has data, hash matches → responds 'have_it'                  │
│     ├──→ D has data, hash matches → responds 'have_it'                  │
│     ├──→ E missing data → responds 'need_data'                          │
│     └──→ F has data, hash mismatch → responds 'need_data'               │
│     │                                                                    │
│     ▼                                                                    │
│  6. B sends full data ONLY to E and F                                    │
│     │                                                                    │
│     ▼                                                                    │
│  7. All nodes (C, D, E, F) update lastRefreshedAt                        │
│     │                                                                    │
│     ▼                                                                    │
│  8. B → A: { type: 'replicate_response', stored: 4, needed_data: 2 }    │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Message Types

```javascript
// Request from initiator to closest node
{
  type: 'replicate_request',
  requestId: 'uuid',
  key: string,
  hash: string,           // SHA-256 of value
  value?: any,            // Optional: include if small, omit if large
  ttl: number
}

// Lightweight check from closest node to its neighbors
{
  type: 'replicate_check',
  requestId: 'uuid',
  key: string,
  hash: string,
  ttl: number
}

// Response from neighbor
{
  type: 'replicate_check_response',
  requestId: 'uuid',
  status: 'have_it' | 'need_data' | 'hash_mismatch',
  key: string
}

// Full data transfer (only when needed)
{
  type: 'replicate_data',
  requestId: 'uuid',
  key: string,
  value: any,
  hash: string,
  ttl: number
}

// Final response to initiator
{
  type: 'replicate_response',
  requestId: 'uuid',
  success: boolean,
  nodesStored: number,      // How many nodes now have the data
  nodesNeededData: number,  // How many needed full transfer
  nodesFailed: number       // How many couldn't be reached
}
```

### Bandwidth Comparison

| Scenario | Basic Design | Optimized Design |
|----------|--------------|------------------|
| Stable network (all k nodes have data) | k × sizeof(data) | k × sizeof(hash) ≈ k × 32 bytes |
| 1 node missing data | k × sizeof(data) | (k-1) × 32 bytes + 1 × sizeof(data) |
| All nodes missing | k × sizeof(data) | k × sizeof(data) (same) |
| Network probe cost | O(α × log n) per refresh | O(α × log n) once to find closest, then 0 |

For a 10KB data item with k=20:
- Basic: 200KB per refresh
- Optimized (stable): ~640 bytes per refresh (312× reduction)

### Failure Handling

**If the closest node (B) fails before completing replication:**
- Initiator A times out waiting for `replicate_response`
- A's refresh is marked incomplete
- A does NOT update its `lastRefreshedAt`
- Other storing nodes' timers will fire (random spread)
- Next node becomes initiator and retries

**If some of B's neighbors fail:**
- B reports partial success in `replicate_response`
- Data is still stored on surviving nodes
- Next refresh cycle will catch any gaps

**Self-healing properties preserved:**
- Random timing still selects one initiator
- Failures don't cause data loss (multiple nodes have it)
- Next cycle repairs any gaps

### Implementation Considerations

**When to include value in `replicate_request`:**
```javascript
const INLINE_THRESHOLD = 1024; // 1KB

if (sizeof(value) <= INLINE_THRESHOLD) {
  // Small data: include in request, saves round trip
  message.value = value;
} else {
  // Large data: let closest node request if needed
  message.value = undefined;
}
```

**Hash algorithm:**
- Use SHA-256 for integrity verification
- 32-byte hash is negligible overhead
- Provides collision resistance for data integrity

**Handling hash mismatches:**
- Could indicate corruption or concurrent update
- Always prefer fresh data from initiator
- Log for monitoring (may indicate issues)

## Future Optimizations (Deferred)

### Batched Replication

If a node stores multiple keys that map to the same closest node, batch the replication requests:

```javascript
{
  type: 'replicate_batch_request',
  items: [
    { key: 'key1', hash: 'hash1' },
    { key: 'key2', hash: 'hash2' },
    ...
  ]
}
```

### Protocol Negotiation

Nodes could advertise replication capabilities:
- Supports delegated replication: yes/no
- Supports lightweight verification: yes/no
- Max batch size

Fallback to basic design for nodes that don't support optimization.

## Implementation Plan

### Phase 1: Neighborhood Maintenance (Prerequisite)
1. Add `maintainNeighborhood()` method to KademliaDHT
2. Integrate with existing k-bucket maintenance timer
3. Implement bucket splitting for dense neighborhoods
4. Verify nodes know their k-closest neighbors

### Phase 2: Storage Metadata
1. Extend storage schema with local metadata (receivedAt, lastRefreshedAt, myRefreshTime, ttl, hash)
2. Add hash calculation on store
3. Update metadata on incoming store requests

### Phase 3: Basic Republishing (Randomized Timing)
1. Implement RepublishManager class
2. Randomized refresh timing with spread window
3. Skip refresh when lastRefreshedAt is recent
4. Integrate with KademliaDHT

### Phase 4: Delegated Replication
1. Add `replicate_request` message handler
2. Implement delegation to closest node
3. Closest node uses local routing table for k-closest

### Phase 5: Lightweight Verification
1. Add `replicate_check` message type
2. Hash comparison before full data transfer
3. Only send full data when needed

### Phase 6: Monitoring & Testing
1. Add metrics (refreshes performed, skipped, delegated, failed)
2. Logging for debugging
3. Unit tests for timing logic
4. Integration tests for multi-node refresh
5. Chaos testing (node failures during refresh)

## Open Questions

1. **Should originators refresh more frequently?** They have the authoritative copy.

2. **How to handle conflicting values?** If two nodes store different values for same key, which wins on refresh?

3. **Should TTL be per-key or global?** Some data may need longer persistence.

4. **Pub/Sub integration**: Pub/Sub data has its own TTL semantics. Should it use this system or remain separate?

## Summary

This proposal describes a DHT data republishing mechanism with three key innovations:

1. **Randomized Timing**: Only one of k nodes refreshes per cycle, coordinated implicitly through timestamps
2. **Delegated Replication**: Find closest node once, let it handle distribution using local knowledge
3. **Lightweight Verification**: Send hash first, full data only when needed

Together these reduce network traffic by orders of magnitude compared to naive republishing while maintaining data durability guarantees.
