# Sticky Pub/Sub Literature Review and Comparison

## Existing DHT-Based Pub/Sub Research

### 1. Topic-Based Systems: Scribe and Bayeux

**Overview:**
- **Scribe** (built on Pastry DHT) and **Bayeux** (built on Tapestry DHT) are the earliest and most influential DHT-based pub/sub systems
- Published in early 2000s, foundational work in the field

**Architecture:**
- **Per-topic multicast trees**: Each topic has its own broadcast tree overlaid on the DHT
- **Topic routing**: Topics are identified by IDs, rooted at the DHT node responsible for that ID (via consistent hashing)
- **Tree construction**:
  - Scribe uses **reverse path multicast** (subscribers join path to root)
  - Bayeux uses **forward path multicast** (root pushes to subscribers)
- **Delivery model**: Real-time message propagation down the multicast tree

**Key Characteristics:**
- ✅ Scalable routing: O(log N) hops for tree construction
- ✅ Efficient bandwidth: Shared tree structure (no duplicate messages)
- ✅ Fault-tolerant: DHT routing provides resilience
- ❌ No message persistence: Transient delivery only
- ❌ No history: New subscribers don't receive past messages
- ❌ Limited expressiveness: Topic names only, no content filtering

**Use Case:** Real-time event distribution (e.g., stock tickers, chat rooms where history isn't needed)

---

### 2. Content-Based Systems: Meghdoot

**Overview:**
- Built on CAN (Content Addressable Network) DHT
- One of the first content-based pub/sub systems entirely on structured overlay
- Published 2004 at Middleware conference

**Architecture:**
- **Rendezvous-based routing**: Publishers and subscribers meet at deterministic DHT locations
- **Content-based filtering**: Subscriptions specify attribute constraints (e.g., `price > 100 AND location = 'NYC'`)
- **Multi-dimensional space**: CAN divides n-dimensional space into hyper-rectangular zones
- **Filter placement**: Subscriptions stored at multiple DHT nodes based on attribute hashing

**Key Characteristics:**
- ✅ Expressive subscriptions: Complex predicates over message attributes
- ✅ Load balancing: Distributes subscriptions across many nodes
- ✅ Scalable to many topics: No per-topic overhead
- ❌ High-dimensional scalability issues: Subscriptions with many attributes require storage on many nodes
- ❌ Expensive updates: Modifying subscriptions requires contacting many nodes
- ❌ No message persistence: Transient delivery only
- ❌ No history: Messages not stored

**Use Case:** Complex filtering scenarios (e.g., stock trading with multi-attribute filters)

---

### 3. Modern Gossip-Based: GossipSub (libp2p/IPFS)

**Overview:**
- Modern pub/sub protocol used in IPFS and libp2p ecosystem
- Combines DHT for peer discovery with gossip for message propagation
- Successor to FloodSub (simpler flooding approach)

**Architecture:**
- **Gossip-based propagation**: Nodes "gossip" about messages they've seen
- **Mesh network**: Maintains partial mesh of peers for each topic
- **Message cache**: Short-term cache (`mcache`) for deduplication and gossip
- **DHT integration**: Uses Kademlia DHT for peer discovery only (not message routing)

**Key Characteristics:**
- ✅ Robust: Gossip protocol tolerates network churn
- ✅ No tree maintenance: Mesh is more resilient than tree structures
- ✅ Short-term caching: Messages cached briefly for efficiency
- ✅ Best-effort delivery: No delivery guarantees
- ❌ No persistence: Messages not stored long-term
- ❌ No history: New subscribers don't get past messages
- ❌ Higher bandwidth: Gossip creates more network traffic than trees

**Use Case:** Real-time communication in decentralized networks (IPFS file sharing announcements)

---

### 4. R-Tree Based: Distributed Content Routing

**Overview:**
- Uses spatial data structures (R-trees) for content-based routing
- Organizes peers into hierarchical spatial indexes

**Architecture:**
- **R-tree overlay**: Peers organized by content space coverage
- **Range queries**: Efficient for multi-dimensional range subscriptions
- **Routing table minimization**: Reduces false positives while avoiding false negatives

**Key Characteristics:**
- ✅ Efficient range queries: Good for spatial/numerical filters
- ✅ Adaptive indexing: R-tree adapts to data distribution
- ❌ Complex maintenance: R-tree rebalancing overhead
- ❌ No persistence: Transient only
- ❌ Limited adoption: More research prototype than deployed system

---

## Common Patterns in DHT Pub/Sub Research

### Pattern 1: Rendezvous-Based Routing

**Concept:** Publishers and subscribers meet at deterministic DHT locations (rendezvous points) based on topic/content hashing.

**How it works:**
1. Hash topic/content to get DHT key
2. Store subscriptions at nodes closest to that key
3. Publishers send messages to same DHT location
4. Rendezvous node matches messages to subscribers

**Used by:** Meghdoot, most content-based systems

---

### Pattern 2: Multicast Tree Construction

**Concept:** Build per-topic overlay trees on top of DHT for efficient message distribution.

**How it works:**
1. Topic ID hashed to find root node
2. Subscribers join tree by following DHT path to root
3. Messages propagate down tree from root

**Used by:** Scribe, Bayeux, DRScribe (improved variant)

---

### Pattern 3: Subscription Storage Strategies

**Filter-based routing:**
- Subscriptions stored at intermediate brokers
- Each broker filters messages based on local subscriptions
- Used in traditional broker-based systems

**Rendezvous-based storage:**
- Subscriptions stored at specific DHT nodes based on content hash
- No intermediate filtering, direct routing to rendezvous points
- Used in DHT-based systems like Meghdoot

---

## Critical Gap in Existing Research: Message Persistence

### The Problem

**All reviewed systems share a major limitation:**
- ❌ **No message history**: New subscribers don't receive past messages
- ❌ **Transient delivery**: Messages exist only during propagation
- ❌ **No offline tolerance**: Disconnected subscribers miss messages
- ❌ **No replay**: Can't retrieve historical events

**Why persistence is missing:**
1. **Performance focus**: Research prioritized low-latency real-time delivery
2. **Storage costs**: Storing all messages on DHT was considered expensive
3. **Complexity**: Managing expiry, garbage collection, and consistency is hard
4. **Use case assumptions**: Research assumed real-time streaming scenarios

**Limited exceptions:**
- GossipSub has short-term message cache (seconds/minutes), not true persistence
- Some systems mention "durable subscriptions" in future work, but not implemented

---

## Our Design: Sticky Pub/Sub

### How We Differ from Existing Research

| Feature                       | Scribe/Bayeux       | Meghdoot            | GossipSub          | **Our Design**                   |
|-------------------------------|---------------------|---------------------|--------------------|----------------------------------|
| **Routing**                   | Multicast trees     | Rendezvous points   | Gossip mesh        | **Rendezvous points**            |
| **Topic Model**               | Topic-based         | Content-based       | Topic-based        | **Topic-based**                  |
| **Message Persistence**       | ❌ None            | ❌ None             | ⚠️ Short cache     | **✅ Full history (sticky)**    |
| **New Subscriber History**    | ❌ No              | ❌ No               | ❌ No              | **✅ Yes (all non-expired)**    |
| **Storage**                   | DHT for routing     | DHT for subs        | No DHT             | **DHT for everything**           |
| **Expiry**                    | N/A                 | N/A                 | Fixed cache time   | **✅ Flexible TTL**              |
| **Conflict Resolution**       | Tree repair         | DHT routing         | Mesh repair        | **✅ History-based merge**       |
| **Coordinator**               | Root node (fixed)   | Rendezvous node     | No coordinator     | **✅ Replicated coordinator**    |

---

### What We Borrowed from Existing Research

**1. Rendezvous-Based Routing (from Meghdoot)**
- Store coordinator at k-closest nodes to `hash(topicID)`
- Publishers and subscribers meet at predictable DHT location
- Deterministic assignment for load balancing

**2. Topic-Based Model (from Scribe/Bayeux)**
- Simple topic IDs rather than complex content filters
- Avoids high-dimensional subscription storage problems
- Easier to implement and reason about

**3. Replication for Fault Tolerance (from DHT research generally)**
- Replicate coordinator to n nodes (like DHT key replication)
- Multiple nodes can handle subscribe/publish requests
- Survives node failures

---

### What We Innovated

**1. Message Persistence Architecture (Novel)**

**Problem:** Existing systems don't store messages
**Our Solution:** Three-tier immutable collection architecture

```
Coordinator (mutable, small)
    ↓
Collections (immutable, copy-on-write)
    ↓
Messages (immutable, separate storage)
```

**Why this works:**
- Only coordinator needs consensus (small, fast updates)
- Collections are immutable (no race conditions)
- Messages stored separately (lazy loading)
- History tracked in coordinator (efficient merging)

**Comparison to alternatives:**
- Scribe/Bayeux: Would need to store messages at tree nodes (brittle, no history)
- Meghdoot: Would need to store messages at rendezvous points (but didn't)
- GossipSub: Has message cache but not persistent (memory only, no DHT storage)

---

**2. Sticky Semantics (Novel)**

**Problem:** New subscribers miss past messages
**Our Solution:** Bootstrap subscriber flow with historical message delivery

**How it works:**
1. New subscriber joins topic
2. Coordinator loads message collection
3. Filters non-expired messages
4. Deterministically assigns messages to coordinators
5. Each coordinator delivers assigned messages

**Why existing systems couldn't do this:**
- Scribe/Bayeux: No message storage, tree-based routing incompatible
- Meghdoot: No message storage, rendezvous point is transient
- GossipSub: Short cache, not designed for history playback

---

**3. Copy-on-Write Collections (Borrowed from databases, novel in pub/sub)**

**Problem:** Concurrent updates to subscriber/message lists cause conflicts
**Our Solution:** Immutable collections + coordinator history

**How it works:**
- Never modify collections, always create new versions
- Coordinator tracks history of collection IDs
- Conflicts resolved by merging histories (set union)

**Why existing systems didn't need this:**
- Scribe/Bayeux: Tree structure handles concurrency via DHT routing
- Meghdoot: Subscriptions stored separately, no shared mutable state
- GossipSub: No persistence, so no conflict resolution needed

**Comparison to CRDTs:**
- Our approach is simpler (just track collection IDs)
- CRDTs are overkill for immutable collections
- History-based merge is sufficient for our use case

---

**4. Signature-Based Renewal (Novel in pub/sub context)**

**Problem:** Subscriptions need expiry to prevent resource leaks
**Our Solution:** Cryptographic signature-based renewal

**How it works:**
- Client signs renewal request with private key
- Coordinator verifies signature against node ID
- Timestamp prevents replay attacks
- No token storage needed

**Why existing systems didn't do this:**
- Scribe/Bayeux: Active subscriptions (tree membership), no renewal needed
- Meghdoot: Research didn't address subscription management lifecycle
- GossipSub: No subscription persistence, so no renewal

---

**5. Garbage Collection via Lazy Cleanup (Novel)**

**Problem:** Expired messages and subscriptions waste storage
**Our Solution:** Piggyback cleanup on normal operations

**How it works:**
- During subscribe/publish, check for expired entries
- Filter expired items when creating new collections
- Delete coordinator when all data expired
- No periodic scan needed

**Why existing systems didn't need this:**
- Scribe/Bayeux: No persistence, no cleanup needed
- Meghdoot: No persistence, no cleanup needed
- GossipSub: Fixed-time cache eviction, no selective expiry

---

## Academic Positioning

### Where Our Work Fits

**Research Gap We Fill:**
> "DHT-based pub/sub systems provide efficient routing but lack message persistence for offline subscribers and late joiners."

**Our Contribution:**
> "Sticky Pub/Sub: A DHT-based topic pub/sub system with message persistence via immutable collections and history-based conflict resolution."

---

### Comparison to Related Work

**Compared to Scribe/Bayeux:**
- ✅ Better: Message persistence, history for new subscribers
- ✅ Better: Simpler (no tree maintenance)
- ❌ Worse: Higher latency (DHT storage writes vs tree propagation)
- ❌ Worse: Higher storage overhead (messages stored in DHT)

**Compared to Meghdoot:**
- ✅ Better: Message persistence, simpler topic model
- ✅ Better: No high-dimensional scaling issues
- ❌ Worse: Less expressive (no content filtering)
- ≈ Similar: Rendezvous-based routing

**Compared to GossipSub:**
- ✅ Better: True persistence, full history
- ✅ Better: Guaranteed delivery (if online within TTL)
- ❌ Worse: Higher latency (DHT writes vs gossip)
- ❌ Worse: More complex (coordinator consensus)

---

### Novel Contributions Summary

1. **First DHT pub/sub system with message persistence** (to our knowledge)
2. **Three-tier immutable collection architecture** for efficient updates
3. **History-based conflict resolution** for replicated coordinators
4. **Sticky semantics** (late joiners receive history)
5. **Lazy garbage collection** without periodic scans
6. **Signature-based renewal** without token storage

---

## Open Questions and Future Research

### 1. Performance Comparison

**Question:** How does our system compare quantitatively to Scribe/GossipSub?

**Metrics to measure:**
- Message delivery latency (publish → receive)
- Storage overhead (messages stored in DHT)
- Network bandwidth (DHT operations vs gossip)
- Scalability (subscribers, messages, topics)

**Hypothesis:**
- Higher latency (DHT writes slower than gossip)
- Higher storage (full history vs transient)
- Lower bandwidth (targeted DHT vs gossip flooding)
- Better scalability (O(log N) DHT vs mesh overhead)

---

### 2. Hybrid Approaches

**Question:** Can we combine our approach with existing systems?

**Ideas:**
- **Sticky GossipSub**: Add persistence layer under GossipSub
- **Filtered Sticky Pub/Sub**: Add content filtering like Meghdoot
- **Tree + Storage**: Scribe-style trees with message persistence

**Trade-offs to explore:**
- Complexity vs performance
- Storage costs vs functionality
- Consistency guarantees vs latency

---

### 3. Optimizations

**Question:** How can we improve our design?

**Potential optimizations:**
- **Message batching**: Group multiple messages in one collection update
- **Collection pagination**: Split large collections across multiple DHT keys
- **Lazy collection loading**: Fetch only metadata, load full data on demand
- **Bloom filters**: Faster message deduplication
- **Coordinator caching**: Cache hot topics in memory

---

### 4. Alternative Storage Models

**Question:** Are there better ways to store messages?

**Alternatives to explore:**
- **IPFS/IPLD**: Store collections as content-addressed graphs
- **Merkle trees**: Efficient verification and partial fetching
- **Erasure coding**: Reduce storage overhead with redundancy
- **Tiered storage**: Hot messages in DHT, cold in archive

---

## Conclusion

### What Existing Research Does

- **Scribe/Bayeux**: Real-time topic-based pub/sub with multicast trees (no history)
- **Meghdoot**: Content-based filtering with rendezvous routing (no history)
- **GossipSub**: Robust gossip-based propagation with short cache (no persistence)

### What We Do Differently

- **Message persistence**: Store messages in DHT with flexible TTL
- **Sticky semantics**: New subscribers receive all non-expired history
- **Immutable collections**: Copy-on-write for conflict-free updates
- **History-based merging**: Simple conflict resolution via collection ID tracking
- **Lazy cleanup**: Efficient garbage collection without scans

### Why This Matters

**Use cases our design enables:**
1. **Chat rooms with history**: Late joiners see conversation context
2. **Event sourcing**: Replay events from persistent log
3. **Offline tolerance**: Fetch missed messages after reconnection
4. **Audit trails**: Messages stored with expiry for compliance
5. **Time-shifted consumption**: Subscribe now, consume later

**Research contribution:**
> We demonstrate that **message persistence is feasible** in DHT-based pub/sub systems through careful architecture (three-tier collections, immutable data, lazy cleanup), filling a critical gap in existing research.

---

## References

**Key Papers:**
- Scribe: Castro et al., "Scribe: A large-scale and decentralized application-level multicast infrastructure" (2002)
- Bayeux: Zhuang et al., "Bayeux: An architecture for scalable and fault-tolerant wide-area data dissemination" (2001)
- Meghdoot: Gupta et al., "Meghdoot: Content-Based Publish/Subscribe over P2P Networks" (2004)
- GossipSub: Protocol Labs, "GossipSub: A Secure PubSub Protocol for Unstructured, Decentralized Networks" (2019)

**DHT Foundations:**
- Pastry: Rowstron and Druschel (2001)
- Tapestry: Zhao et al. (2001)
- CAN: Ratnasamy et al. (2001)
- Kademlia: Maymounkov and Mazières (2002)
