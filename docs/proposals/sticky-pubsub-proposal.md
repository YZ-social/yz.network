# Sticky Pub/Sub Protocol Proposal (Updated)

## Implementation Status

**Last Updated**: 2025-01-18
**Overall Completion**: ~70% (Core functionality complete, lifecycle features missing)
**Production Ready**: NO (Missing subscription renewal, garbage collection, comprehensive tests)

### Status Legend
- ✅ **IMPLEMENTED** - Feature fully implemented and tested
- ⚠️ **PARTIAL** - Feature partially implemented or has limitations
- ❌ **MISSING** - Feature not implemented
- 🔧 **MODIFIED** - Implementation differs from original proposal

### Quick Status Summary

| Phase | Status | Notes |
|-------|--------|-------|
| Phase 1: Core Data Structures | ✅ COMPLETE | All classes implemented with tests |
| Phase 2: Basic Pub/Sub | ✅ COMPLETE | Subscribe, publish, optimistic concurrency working |
| Phase 3: Push Delivery | ✅ COMPLETE | **2025-01-18**: Push notifications via DHT implemented |
| Phase 4: Conflict Resolution | ✅ COMPLETE | Merge logic, catastrophic recovery working |
| Phase 5: Client Recovery | ⚠️ PARTIAL | Gap detection works, deduplication missing |
| Phase 6: Garbage Collection | ❌ MISSING | **CRITICAL**: No cleanup or renewal mechanism |
| Phase 7: Testing | ⚠️ PARTIAL | Basic tests exist, comprehensive suite needed |
| Phase 8: Optimization | ⚠️ PARTIAL | Batching works, lazy loading missing |

### Critical Missing Features (Blockers for Production)

1. **❌ Subscription Renewal** (Phase 6)
   - Subscriptions expire after 1 hour
   - No signature-based renewal mechanism
   - Active subscribers get disconnected
   - **Impact**: Service disruption for long-running sessions

2. **❌ Garbage Collection** (Phase 6)
   - No proactive cleanup of expired data
   - DHT storage accumulates over time
   - No topic deletion when inactive
   - **Impact**: Resource leaks, storage bloat

3. **❌ Client-Side Deduplication** (Phase 5)
   - Push + polling can deliver duplicates
   - No message ID tracking in client
   - **Impact**: Users see duplicate messages

4. **❌ Comprehensive Test Suite** (Phase 7)
   - No explicit late-joiner tests
   - No gap detection validation
   - No chaos/failure testing
   - **Impact**: Unknown edge case behavior

### Recent Changes (2025-01-18)

**✅ Push-Based Message Delivery Implemented**:
- Created `MessageDelivery.js` with deterministic subscriber assignment
- Integrated push delivery into `PublishOperation`
- Added push message handlers in `PubSubClient`
- Messages now delivered instantly (<100ms) instead of polling delay (0-5s)
- Polling remains as fallback for reliability

**🔧 UI Fixes**:
- Fixed historical message display bug (event listeners registered before subscription)
- Fixed message ordering (now chronological by timestamp)

### Implementation Files

**Core Classes** (src/pubsub/):
- ✅ `CoordinatorObject.js` - Mutable coordinator with histories
- ✅ `CoordinatorSnapshot.js` - Linked historical snapshots
- ✅ `MessageCollection.js` - Immutable message collection
- ✅ `SubscriberCollection.js` - Immutable subscriber collection
- ✅ `Message.js` - Individual messages with signatures
- ✅ `PublishOperation.js` - Publishing with optimistic concurrency
- ✅ `SubscribeOperation.js` - Subscription and historical delivery
- ✅ `MessageDelivery.js` - **NEW**: Push notification delivery
- ✅ `PubSubClient.js` - High-level API wrapper
- ✅ `PubSubStorage.js` - DHT storage integration

**Tests** (src/pubsub/):
- ✅ `test-data-structures.js` - Unit tests for core classes
- ✅ `test-operations.js` - Integration tests for pub/sub
- ✅ `test-stress.js` - Stress testing (100 messages)
- ✅ `test-stress-batched.js` - Concurrent publisher stress test
- ⚠️ `test-dht-integration.js` - DHT integration (basic)
- ⚠️ `test-smoke.js` - Smoke tests (basic)

### Deviations from Proposal

**🔧 Push Delivery Mechanism**:
- **Proposal**: Coordinator-to-coordinator coordination protocol
- **Implementation**: Direct DHT messaging via existing `sendMessage()`
- **Reason**: Simpler, leverages existing infrastructure
- **Trade-off**: No explicit coordinator coordination, relies on deterministic assignment

**🔧 Polling as Fallback**:
- **Proposal**: Push-only delivery after Phase 3
- **Implementation**: Hybrid push + polling
- **Reason**: Reliability - push failures don't cause message loss
- **Trade-off**: Slightly higher bandwidth, but more robust

**🔧 Message Ordering**:
- **Proposal**: Sort by publisher ID then sequence
- **Implementation**: Sort by `publishedAt` timestamp
- **Reason**: Users expect chronological order across publishers
- **Trade-off**: Timestamp-based ordering less deterministic

### Next Priority Tasks

**Priority 1 - CRITICAL** (Required for Production):
1. Implement subscription renewal with signature-based auth
2. Add client-side message deduplication
3. Implement garbage collection and cleanup

**Priority 2 - HIGH** (Recommended before Production):
4. Comprehensive test suite (late joiner, gaps, chaos)
5. Push delivery retry logic
6. API documentation and examples

**Priority 3 - MEDIUM** (Performance/Scale):
7. Lazy message loading (IDs only in collections)
8. Collection pagination for large subscriber lists
9. Performance benchmarks

---

## Problem Statement

### The Need for Persistent Messaging on DHT

Traditional pub/sub systems rely on centralized message brokers (e.g., Redis, RabbitMQ, Kafka) to maintain subscriber lists and message queues. In a fully decentralized DHT network, we need a pub/sub mechanism that:

1. **Works without central servers** - All coordination via DHT storage
2. **Provides message persistence** - New subscribers receive historical messages (hence "sticky")
3. **Scales to many topics** - Support for 1000s of independent channels
4. **Handles dynamic membership** - Nodes can join/leave/disconnect at any time
5. **Tolerates network failures** - No single point of failure
6. **Handles concurrent updates** - Multiple publishers without message loss

### The Challenge: Pub/Sub on DHT is Hard

**Why This is Difficult:**

```
Traditional Pub/Sub (Centralized):
┌──────────────┐
│ Message      │ ← maintains subscriber list
│ Broker       │ ← queues messages
│ (Redis)      │ ← guarantees delivery
└──────────────┘
      ↓↓↓
   Subscribers

DHT-Based Pub/Sub:
┌──────────────┐
│  Subscriber  │ ← no central broker
└──────────────┘ ← no message queue
       ?         ← how to coordinate?
┌──────────────┐
│  Publisher   │ ← finds subscribers how?
└──────────────┘
```

**Key Problems:**
1. **Subscriber Discovery**: How does a publisher find all subscribers?
2. **Message Persistence**: Where do we store messages for new subscribers?
3. **Coordination**: How do multiple coordinators agree on state?
4. **Garbage Collection**: How do we clean up expired topics?
5. **Conflict Resolution**: What if two nodes update simultaneously?
6. **Concurrent Publishing**: How to prevent message loss with multiple publishers?

## Design Principles

Core principles guiding this solution:

1. **Immutability Where Possible**: Copy-on-write collections prevent race conditions
2. **Ephemeral Coordinators**: No persistent root node, any node can coordinate
3. **DHT-Native Storage**: Everything stored using existing DHT primitives
4. **Lazy Operations**: Cleanup/maintenance happens during normal operations
5. **Time-Based Expiry**: All data has TTL, automatic cleanup
6. **Consensus via History**: Merge conflicts using collection ID history
7. **Client-Side Recovery**: Clients detect and recover from version gaps
8. **Failure Is Not An Option**: Merge failures trigger catastrophic recovery

## Proposed Solution: Three-Tier Architecture

### Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│  COORDINATOR OBJECT (mutable, small <1KB)               │
│  Topic ID: "chat-room-42"                               │
│  Stored at: k closest nodes to hash(topic ID)           │
│─────────────────────────────────────────────────────────│
│  - Version: 142                                         │
│  - Subscriber Collection ID: "abc123..."                │
│  - Message Collection ID: "def456..."                   │
│  - Subscriber History: ["xyz789", "abc123"] (last 10)   │
│  - Message History: ["uvw456", "def456"] (last 10)      │
│  - Previous Coordinator: "snapshot-140" ← LINKED LIST   │
└─────────────────────────────────────────────────────────┘
       │                              │              │
       │                              │              └─────┐
       ▼                              ▼                    ▼
┌──────────────────────┐    ┌──────────────────────┐  ┌──────────────┐
│ SUBSCRIBER           │    │ MESSAGE              │  │ COORDINATOR  │
│ COLLECTION           │    │ COLLECTION           │  │ SNAPSHOT     │
│ (immutable)          │    │ (immutable)          │  │ (historical) │
│──────────────────────│    │──────────────────────│  │──────────────│
│ Collection ID:       │    │ Collection ID:       │  │ Version: 140 │
│   "abc123..."        │    │   "def456..."        │  │ History: []  │
│ Topic ID:            │    │ Topic ID:            │  │ Previous: ..│
│   "chat-room-42"     │    │   "chat-room-42"     │  └──────────────┘
│ Subscribers:         │    │ Messages:            │
│   - node-001         │    │   - msg-001 ─────────┼──┐
│     expiresAt: T+30m │    │     addedInVersion:  │  │
│   - node-002         │    │       142            │  │
│     expiresAt: T+30m │    │   - msg-002 ─────────┼──┼──┐
│   ...                │    │     addedInVersion:  │  │  │
│                      │    │       142            │  │  │
│ Stored at random     │    │   ...                │  │  │
│ DHT location         │    │                      │  │  │
└──────────────────────┘    │ Stored at random     │  │  │
                            │ DHT location         │  │  │
                            └──────────────────────┘  │  │
                                       │              │  │
                                       ▼              ▼  ▼
                            ┌──────────────────────────────┐
                            │ INDIVIDUAL MESSAGES          │
                            │ (immutable, can be encrypted)│
                            │──────────────────────────────│
                            │ Message ID: "msg-001"        │
                            │ Topic ID: "chat-room-42"     │
                            │ Publisher ID: "node-003"     │
                            │ Publisher Sequence: 42       │
                            │ Data: {text: "Hello!"}       │
                            │ Published At: T1             │
                            │ Expires At: T1 + 24h         │
                            │                              │
                            │ Stored at: hash(messageID)   │
                            └──────────────────────────────┘
```

### Three-Tier Structure Explained

**Tier 1: Coordinator Object (Mutable)**
- Small object (<1KB) stored at k-closest nodes to `hash(topicID)`
- Contains pointers to current subscriber/message collections
- Maintains **two separate histories**: subscriber collection IDs and message collection IDs (last 10-50 entries)
- **Links to historical snapshots** via `previousCoordinator` for deep history access
- Only this object is mutable; everything else is copy-on-write

**Tier 2: Collections (Immutable)**
- **Subscriber Collection**: List of active subscribers with expiry times
- **Message Collection**: List of message IDs with metadata (including `addedInVersion` for delta delivery)
- **Coordinator Snapshots**: Historical coordinator states for deep merge history
- Stored at random DHT locations (not predictable)
- Never modified; always copied with changes
- History tracked in coordinator object, not in collections themselves
- **Content-based TTL**: Expire when contents expire + grace period

**Tier 3: Individual Messages (Immutable)**
- Actual message payload stored separately
- **Application can encrypt data** - metadata (TTL, size, IDs) remains readable by DHT
- Enables lazy loading (fetch only needed messages)
- Each message stored at `hash(messageID)`
- Independent expiry per message
- Includes per-publisher sequence numbers for drop detection

### Why This Design?

**Advantages of Immutable Collections:**
- ✅ No race conditions on collection updates
- ✅ History tracked in coordinator for efficient merging
- ✅ Easy to verify integrity (hash of collection)
- ✅ Multiple nodes can read simultaneously without coordination

**Advantages of Small Mutable Coordinator:**
- ✅ Only one small object needs consensus
- ✅ History-based merge for conflict resolution via collection ID chains
- ✅ Predictable location (k-closest nodes to topic ID)
- ✅ Efficient updates (don't copy entire subscriber list)
- ✅ **Bounded size** via linked snapshots

**Advantages of Linked Coordinator Snapshots:**
- ✅ Coordinator stays small (<1KB) with recent history only
- ✅ Deep history available for complex merges (via lazy loading)
- ✅ Automatic cleanup via TTL on old snapshots
- ✅ Prevents unbounded coordinator growth

**Advantages of Separate Histories:**
- ✅ Track subscriber changes independently from message changes
- ✅ Simpler conflict resolution (merge histories separately)
- ✅ Clearer lineage of each collection type
- ✅ Efficient merging (don't need to reconcile operations, just collection IDs)

**Advantages of Separate Message Storage:**
- ✅ Lazy loading of messages (fetch IDs first, data on demand)
- ✅ Efficient for large messages
- ✅ Independent TTL per message
- ✅ Reduces coordinator/collection size
- ✅ **Application-level encryption** possible without affecting DHT operations

## Initiator Node Concept

### Overview

The **initiator node** is a critical concept in our protocol. When a client wants to publish or subscribe:

1. Client performs `findNode(topicID)` via DHT to get k-closest nodes
2. Client contacts the **first reachable node** from this list
3. This node becomes the **initiator** for that specific operation
4. The initiator is responsible for coordinating that pub/sub operation

**✅ ALREADY IMPLEMENTED**: DHT `findNode()` operation exists in `src/dht/KademliaDHT.js`

### Initiator Node Responsibilities

**For Subscribe Operations:**
- Load or create coordinator (if it's one of k-closest to topic)
- Update subscriber collection (copy-on-write)
- Increment coordinator version
- Replicate coordinator to other k-closest nodes
- Bootstrap subscriber with historical messages
- Coordinate with other initiators for message delivery (deterministic assignment)

**For Publish Operations:**
- Load or create coordinator
- Store message in DHT
- Update message collection (copy-on-write)
- Increment coordinator version
- Handle version conflicts (merge if concurrent updates detected)
- Replicate coordinator to other k-closest nodes
- Coordinate with other initiators for message delivery

**For Replication:**
- When initiator updates coordinator, it replicates to n other k-closest nodes
- These nodes may become initiators for future operations
- No single "master" - any k-closest node can act as initiator

### Why This Design?

**Advantages:**
- ✅ **No single point of failure**: Any k-closest node can be initiator
- ✅ **Load balanced**: Requests distributed across k-closest nodes
- ✅ **Fault tolerant**: If initiator fails, client tries next node
- ✅ **Efficient**: Initiator is always k-closest to topic (minimal DHT hops)
- ✅ **Stateless**: No permanent initiator role, ephemeral per operation

**Deterministic Assignment:**
When multiple initiators need to coordinate (e.g., delivering messages to subscribers), they use:
```javascript
function assignSubscriberToCoordinator(subscriberID, topicID, coordinatorNodes) {
  const assignmentHash = sha1(subscriberID + topicID);
  const index = parseInt(assignmentHash.substring(0, 8), 16) % coordinatorNodes.length;
  return coordinatorNodes[index];
}
```

This ensures:
- Same subscriber always assigned to same initiator (no duplicates)
- Load balanced across all k-closest nodes
- No coordination needed (all nodes compute same assignment)

## Data Structures

### Coordinator Object

```javascript
{
  topicID: string,                    // Topic identifier
  version: number,                    // Monotonic version counter
  currentSubscribers: string | null,  // DHT ID of current subscriber collection
  currentMessages: string | null,     // DHT ID of current message collection

  // Two separate histories tracking collection IDs (recent only)
  subscriberHistory: string[],        // Array of subscriber collection IDs (last 10-50)
  messageHistory: string[],           // Array of message collection IDs (last 10-50)

  // Link to historical snapshot for deep merge history
  previousCoordinator: string | null, // DHT ID of previous coordinator snapshot

  createdAt: timestamp,               // When topic was created
  lastModified: timestamp,            // Last update time

  // Channel health state
  state: string                       // 'ACTIVE' | 'RECOVERING' | 'FAILED'
}
```

**History Management:**
- Recent history (last 10-50 entries) kept in coordinator
- When coordinator grows too large, create snapshot:
  - Store full history in snapshot at random DHT location
  - Prune coordinator history to last 10 entries
  - Set `previousCoordinator` to snapshot ID
- Snapshots have TTL (1 hour after creation)
- Deep merges can lazy-load snapshot history

**Coordinator Snapshot Structure:**
```javascript
{
  version: number,                    // Snapshot version
  subscriberHistory: string[],        // Full history at snapshot time
  messageHistory: string[],           // Full history at snapshot time
  previousCoordinator: string | null, // Link to even older snapshot
  isSnapshot: true,                   // Flag for snapshot
  createdAt: timestamp,
  expiresAt: timestamp                // TTL: 1 hour
}
```

### Subscriber Collection (Immutable)

```javascript
{
  collectionID: string,              // hash(collection content)
  topicID: string,                   // Parent topic
  subscribers: [
    {
      clientID: string,              // Subscriber node ID
      subscribedAt: timestamp,       // When subscription started
      expiresAt: timestamp,          // Subscription expiry (TTL)
      lastSeenVersion: number | null,// Last coordinator version seen by subscriber
      metadata: {                    // Optional subscriber metadata
        tags?: string[],
        filters?: object
      }
    }
  ],
  version: number,                   // Matches coordinator version when created
  createdAt: timestamp,
  expiresAt: timestamp               // Content-based TTL: max(subscriber expiries) + 1 hour
}
```

### Message Collection (Immutable)

```javascript
{
  collectionID: string,              // hash(collection content)
  topicID: string,                   // Parent topic
  messages: [
    {
      messageID: string,             // DHT location of message
      addedInVersion: number,        // ← NEW: Coordinator version when added (for delta delivery)
      publishedAt: timestamp,        // Publication time
      expiresAt: timestamp,          // Message expiry
      size: number,                  // Message size in bytes (for lazy loading)
      publisherID: string,           // Publisher node ID
      publisherSequence: number,     // ← NEW: Per-publisher sequence for drop detection
      metadata: {                    // Optional message metadata
        priority?: number,
        tags?: string[]
      }
    }
  ],
  version: number,                   // Matches coordinator version when created
  createdAt: timestamp,
  expiresAt: timestamp               // Content-based TTL: max(message expiries) + 1 hour
}
```

### Individual Message

```javascript
{
  messageID: string,                 // Unique message identifier
  topicID: string,                   // Parent topic
  publisherID: string,               // ← NEW: Publisher node ID
  publisherSequence: number,         // ← NEW: Per-publisher monotonic sequence
  addedInVersion: number,            // ← NEW: Coordinator version when added
  data: any,                         // Actual message payload (can be encrypted by application)
  publishedAt: timestamp,            // Publication time
  expiresAt: timestamp,              // When message expires
  signature: string                  // Cryptographic signature (optional)
}
```

**Encryption Support:**
- `data` field can be encrypted by application before publishing
- Metadata (messageID, timestamps, size, TTL) remains unencrypted for DHT operations
- DHT nodes can enforce TTL and cleanup without decrypting payloads
- Subscribers decrypt `data` after receiving messages

## Protocol Flows

### Subscribe Flow

```
1. Client Application
   ↓ subscribe(topicID, lastSeenVersion)

2. Client performs DHT lookup
   ↓ findNode(topicID) - returns k-closest nodes
   ✅ IMPLEMENTED: KademliaDHT.findNode() in src/dht/KademliaDHT.js

3. Contact first reachable node (becomes INITIATOR)
   ↓ SUBSCRIBE message {topicID, clientID, lastSeenVersion}

4. Initiator Node
   ├─ Check: Do I have coordinator?
   │  ├─ YES → Load coordinator (I'm one of k-closest)
   │  └─ NO  → Create new coordinator
   │
   ├─ Load current subscriber collection
   │
   ├─ Create new collection (copy-on-write)
   │  ├─ Add new subscriber
   │  ├─ Set expiresAt = now + 30 minutes
   │  └─ Set lastSeenVersion = current coordinator version
   │
   ├─ Store new collection at random DHT location
   │  └─ Get new collectionID (content-based TTL)
   │  ✅ IMPLEMENTED: DHT store() in src/dht/KademliaDHT.js
   │
   ├─ Check if coordinator pruning needed
   │  └─ If too large, create snapshot and prune history
   │
   ├─ Update coordinator
   │  ├─ Increment version
   │  ├─ Set currentSubscribers = new collectionID
   │  ├─ Append to subscriberHistory: push(new collectionID)
   │  └─ Store locally
   │
   └─ Replicate coordinator to n closest nodes
      ✅ IMPLEMENTED: DHT replication via findNode() + store()

5. Bootstrap Subscriber (send historical messages)
   ├─ Load message collection from coordinator
   ├─ If lastSeenVersion provided:
   │  └─ Filter messages where addedInVersion > lastSeenVersion (delta)
   ├─ Else:
   │  └─ Send all non-expired messages (full history)
   │
   ├─ Coordinate with other initiators
   │  └─ Deterministic assignment: hash(subscriberID + topicID) % n
   └─ Deliver assigned messages to new subscriber
      ✅ IMPLEMENTED: DHT sendMessage() in ConnectionManager

6. Return to client
   └─ {success: true, version: currentVersion, expiresAt}
```

### Publish Flow with Optimistic Concurrency

```
1. Client Application
   ↓ publish(topicID, messageData)

2. Client performs DHT lookup
   ↓ findNode(topicID) - returns k-closest nodes
   ✅ IMPLEMENTED: KademliaDHT.findNode()

3. Contact first reachable node (becomes INITIATOR)
   ↓ PUBLISH message

4. Initiator Node (with retry loop)
   ├─ RETRY LOOP (infinite with exponential backoff):
   │
   ├─ Load current coordinator version
   │  ✅ IMPLEMENTED: DHT get() operation
   │
   ├─ Generate messageID = randomUUID()
   │  publisherSequence = this.getNextSequence()
   │
   ├─ Store message FIRST (survives conflicts)
   │  └─ {messageID, topicID, publisherID, publisherSequence,
   │       addedInVersion: currentVersion + 1, data, timestamps}
   │  ✅ IMPLEMENTED: DHT store() operation
   │
   ├─ Load current message collection
   │
   ├─ Create new collection (copy-on-write)
   │  └─ Add {messageID, addedInVersion: currentVersion + 1,
   │           publisherID, publisherSequence, timestamps, size}
   │
   ├─ Store new collection at random DHT location
   │  └─ Get new collectionID (content-based TTL)
   │
   ├─ Check if coordinator pruning needed
   │  └─ If too large, create snapshot and prune history
   │
   ├─ Update coordinator (with version check)
   │  ├─ Increment version: currentVersion + 1
   │  ├─ Set currentMessages = new collectionID
   │  ├─ Append to messageHistory: push(new collectionID)
   │  └─ Store with version assertion
   │
   ├─ IF VERSION CONFLICT DETECTED:
   │  ├─ Load both versions (ours and theirs)
   │  ├─ Merge message collections (union by messageID)
   │  ├─ Create unified collection with ALL messages
   │  ├─ Update coordinator with merged state
   │  └─ RETRY (continue loop)
   │
   ├─ IF MERGE FAILS:
   │  ├─ Log catastrophic error
   │  ├─ Exponential backoff
   │  ├─ After 10 failures: attempt catastrophic recovery
   │  └─ RETRY (continue loop - failure is not an option)
   │
   └─ SUCCESS → Replicate coordinator to n nodes

5. Message Delivery (if subscribers exist)
   ├─ Load subscriber collection
   ├─ Coordinate with other initiators
   │  └─ Deterministic assignment per subscriber
   └─ Each initiator delivers to assigned subscribers
      ✅ IMPLEMENTED: ConnectionManager.sendMessage()

6. Return to client
   └─ {success: true, messageID, version, deliveredTo: count}
```

**Optimistic Concurrency Details:**

```javascript
async function publishWithOptimisticConcurrency(topicID, messageData) {
  let attempt = 0;
  let backoffMs = 100;
  const MAX_BACKOFF = 30000; // 30 seconds

  while (true) {  // Infinite retry - failure is not an option
    try {
      attempt++;

      // Load current coordinator
      const coordinator = await loadCoordinator(topicID);
      const currentVersion = coordinator.version;

      // Store message FIRST (survives conflicts)
      const messageID = generateMessageID();
      const message = {
        messageID,
        topicID,
        publisherID: this.nodeID,
        publisherSequence: this.getNextSequence(),
        addedInVersion: currentVersion + 1,
        data: messageData,
        publishedAt: Date.now(),
        expiresAt: Date.now() + MESSAGE_TTL
      };
      await storeMessage(messageID, message);

      // Create new message collection
      const messageCollection = await loadCollection(coordinator.currentMessages);
      const newCollection = {
        collectionID: generateCollectionID(),
        topicID,
        messages: [
          ...messageCollection.messages,
          {
            messageID,
            addedInVersion: currentVersion + 1,
            publisherID: this.nodeID,
            publisherSequence: message.publisherSequence,
            publishedAt: message.publishedAt,
            expiresAt: message.expiresAt,
            size: JSON.stringify(message.data).length
          }
        ],
        version: currentVersion + 1,
        createdAt: Date.now()
      };

      // Store collection with content-based TTL
      const collectionTTL = Math.max(...newCollection.messages.map(m => m.expiresAt)) + 3600000;
      const newCollectionID = await storeCollection(newCollection, collectionTTL);

      // Check if pruning needed
      const updatedCoordinator = await maybePruneCoordinator({
        ...coordinator,
        version: currentVersion + 1,
        currentMessages: newCollectionID,
        messageHistory: [...coordinator.messageHistory, newCollectionID],
        lastModified: Date.now()
      });

      // Store coordinator (throws VersionConflictError if version changed)
      await storeCoordinatorWithVersionCheck(topicID, updatedCoordinator, currentVersion);

      // Success! Replicate to n nodes
      await replicateCoordinator(topicID, updatedCoordinator);
      return {success: true, messageID, version: currentVersion + 1};

    } catch (VersionConflictError) {
      // Concurrent update detected - merge and retry
      console.log(`🔄 Version conflict on attempt ${attempt}, merging...`);

      try {
        const theirCoordinator = await loadCoordinator(topicID);
        const merged = await mergeCoordinators(updatedCoordinator, theirCoordinator);
        // Retry with merged state

      } catch (MergeError) {
        // CATASTROPHIC: Merge failed
        console.error(`🚨 CATASTROPHIC: Merge failure on attempt ${attempt}`);

        if (attempt > 10) {
          // Attempt recovery
          await catastrophicRecovery(topicID);
        }

        // Exponential backoff
        await sleep(Math.min(backoffMs, MAX_BACKOFF));
        backoffMs *= 2;
      }
    }
  }
}
```

### Subscription Renewal Flow

Subscriptions expire after TTL (default 30 minutes). Clients can renew before expiry using signature-based authentication:

```
1. Client Application
   ↓ renew(topicID, newTTL) - triggered before subscription expires

2. Client signs renewal request
   ├─ Create renewal payload: {topicID, clientID, timestamp, newTTL}
   └─ Sign with node's private key: signature = sign(payload, privateKey)
   ✅ IMPLEMENTED: Ed25519 signing in src/core/InvitationToken.js

3. findNode(topicID)
   ↓ returns k-closest nodes

4. Contact first reachable node (becomes INITIATOR)
   ↓ RENEW_SUBSCRIPTION message {topicID, clientID, timestamp, newTTL, signature}

5. Initiator Node
   ├─ Verify signature
   │  ├─ Extract public key from clientID (DHT node ID)
   │  ├─ Verify signature matches payload
   │  └─ Reject if signature invalid
   │  ✅ IMPLEMENTED: Ed25519 verification in InvitationToken.js
   │
   ├─ Check timestamp freshness
   │  └─ Reject if timestamp > 5 minutes old (replay protection)
   │
   ├─ Load coordinator and subscriber collection
   │
   ├─ Find subscriber by clientID
   │  └─ Return error if not subscribed
   │
   ├─ Create new collection (copy-on-write)
   │  ├─ Update subscriber's expiresAt = now + newTTL
   │  └─ Keep all other subscriber data unchanged
   │
   ├─ Store new collection at random DHT location
   │  └─ Get new collectionID
   │
   ├─ Update coordinator
   │  ├─ Increment version
   │  ├─ Set currentSubscribers = new collectionID
   │  ├─ Append to subscriberHistory
   │  └─ Store locally
   │
   └─ Replicate coordinator to n closest nodes

6. Return to client
   └─ {success: true, newExpiresAt}
```

**Signature Verification:**
```javascript
function verifyRenewalRequest(request) {
  const {topicID, clientID, timestamp, newTTL, signature} = request;

  // Check timestamp freshness (replay protection)
  if (Date.now() - timestamp > 5 * 60 * 1000) {
    throw new Error('Renewal request expired (>5 minutes old)');
  }

  // Reconstruct payload
  const payload = `${topicID}:${clientID}:${timestamp}:${newTTL}`;

  // Extract public key from DHT node ID (clientID is derived from public key)
  const publicKey = DHTNodeId.extractPublicKey(clientID);

  // Verify signature
  // ✅ IMPLEMENTED: Ed25519 verify() in src/core/InvitationToken.js
  if (!crypto.verify(payload, signature, publicKey)) {
    throw new Error('Invalid signature - renewal request rejected');
  }

  return true;
}
```

### Client-Side Version Gap Detection

**Problem:** Subscriber reads coordinator v100, but coordinator is now v105. Subscriber missed versions 101-104.

**Solution:** Client detects gap and requests full update.

```javascript
class Subscription {
  constructor(topicID, lastSeenVersion = null) {
    this.topicID = topicID;
    this.lastSeenVersion = lastSeenVersion;
    this.receivedMessages = new Set(); // Deduplication
    this.channelState = 'ACTIVE';
  }

  async onCoordinatorUpdate(coordinator) {
    const currentVersion = coordinator.version;

    // VERSION GAP DETECTION
    if (this.lastSeenVersion !== null &&
        currentVersion > this.lastSeenVersion + 1) {
      console.log(`⚠️ Version gap detected: last=${this.lastSeenVersion}, current=${currentVersion}`);

      // Request full update from last seen version
      await this.requestFullUpdate(this.lastSeenVersion);
      return;
    }

    // Normal delta delivery
    const messages = await this.getDeltaMessages(
      coordinator,
      this.lastSeenVersion
    );

    for (const msg of messages) {
      this.handleMessage(msg);  // Deduplicates automatically
    }

    this.lastSeenVersion = currentVersion;
  }

  async requestFullUpdate(fromVersion) {
    console.log(`🔄 Requesting full update from version ${fromVersion}`);

    const coordinator = await loadCoordinator(this.topicID);
    const messageCollection = await loadCollection(coordinator.currentMessages);

    // Get all messages added after fromVersion
    const deltaMessages = messageCollection.messages.filter(
      m => m.addedInVersion > fromVersion
    );

    for (const msgMeta of deltaMessages) {
      const message = await loadMessage(msgMeta.messageID);
      this.handleMessage(message);
    }

    this.lastSeenVersion = coordinator.version;
  }

  handleMessage(message) {
    // Client-side deduplication
    if (this.receivedMessages.has(message.messageID)) {
      return; // Ignore duplicate
    }
    this.receivedMessages.add(message.messageID);
    this.onMessage(message);
  }
}

// Periodic version check
setInterval(async () => {
  const coordinator = await loadCoordinator(subscription.topicID);

  if (coordinator.version > subscription.lastSeenVersion) {
    console.log(`📥 New version available: ${coordinator.version}`);
    await subscription.onCoordinatorUpdate(coordinator);
  }
}, 5000); // Check every 5 seconds
```

### Catastrophic Recovery

**When:** Merge failures after 10 attempts indicate catastrophic errors.

**Strategy:** Infinite retry with recovery, never give up.

```javascript
const ChannelState = {
  ACTIVE: 'ACTIVE',           // Normal operation
  RECOVERING: 'RECOVERING',   // Attempting recovery
  FAILED: 'FAILED'            // Manual intervention needed
};

async function catastrophicRecovery(topicID) {
  console.log(`🔄 Starting catastrophic recovery for topic ${topicID}`);

  // Mark channel as recovering
  this.channelState.set(topicID, ChannelState.RECOVERING);

  try {
    // 1. Load coordinator from majority of k-closest nodes
    const closestNodes = await dht.findNode(topicID);
    const coordinators = await Promise.allSettled(
      closestNodes.map(nodeID => loadCoordinatorFromNode(nodeID, topicID))
    );

    // 2. Take most recent version (highest version number)
    const validCoordinators = coordinators
      .filter(r => r.status === 'fulfilled')
      .map(r => r.value);

    if (validCoordinators.length === 0) {
      throw new Error('Cannot load coordinator from any node');
    }

    const latestCoordinator = validCoordinators.reduce((a, b) =>
      a.version > b.version ? a : b
    );

    // 3. Verify collections are loadable
    await loadCollection(latestCoordinator.currentMessages);
    await loadCollection(latestCoordinator.currentSubscribers);

    // 4. Success - channel recovered
    console.log(`✅ Channel recovered, coordinator v${latestCoordinator.version}`);
    this.channelState.set(topicID, ChannelState.ACTIVE);
    return latestCoordinator;

  } catch (error) {
    // 5. Total failure - channel broken
    console.error(`💀 TOTAL FAILURE: Cannot recover topic ${topicID}`);
    console.error(`    Error: ${error.message}`);
    console.error(`    Action: Manual intervention required`);

    // 6. Enter failed mode - reject all publishes
    this.channelState.set(topicID, ChannelState.FAILED);
    throw new ChannelFailureError(
      `Topic ${topicID} is in failed state. Manual recovery required.`
    );
  }
}

// Check channel state before publishing
async function publish(topicID, messageData) {
  const state = this.channelState.get(topicID) || ChannelState.ACTIVE;

  if (state === ChannelState.FAILED) {
    throw new Error(`Topic ${topicID} is in failed state. Cannot publish.`);
  }

  if (state === ChannelState.RECOVERING) {
    throw new Error(`Topic ${topicID} is recovering. Try again later.`);
  }

  return await publishWithOptimisticConcurrency(topicID, messageData);
}
```

### Coordinator Pruning and Snapshots

```javascript
const MAX_COORDINATOR_SIZE = 1024;  // 1KB
const MAX_HISTORY_ENTRIES = 50;     // Per array
const SNAPSHOT_TTL = 3600000;       // 1 hour

async function maybePruneCoordinator(coordinator) {
  const size = JSON.stringify(coordinator).length;
  const historySize = Math.max(
    coordinator.subscriberHistory.length,
    coordinator.messageHistory.length
  );

  if (size <= MAX_COORDINATOR_SIZE && historySize <= MAX_HISTORY_ENTRIES) {
    return coordinator; // No pruning needed
  }

  console.log(`✂️ Pruning coordinator: size=${size}, historySize=${historySize}`);

  // Create snapshot of current history
  const snapshot = {
    version: coordinator.version,
    subscriberHistory: coordinator.subscriberHistory.slice(0, -10),
    messageHistory: coordinator.messageHistory.slice(0, -10),
    previousCoordinator: coordinator.previousCoordinator,
    isSnapshot: true,
    createdAt: Date.now(),
    expiresAt: Date.now() + SNAPSHOT_TTL
  };

  // Store snapshot at random DHT location
  const snapshotID = await storeSnapshot(snapshot);

  // Prune coordinator (keep last 10 entries)
  return {
    ...coordinator,
    subscriberHistory: coordinator.subscriberHistory.slice(-10),
    messageHistory: coordinator.messageHistory.slice(-10),
    previousCoordinator: snapshotID
  };
}

// Load full history for deep merges
async function loadFullHistory(coordinator, maxDepth = 5) {
  const histories = {
    subscribers: [...coordinator.subscriberHistory],
    messages: [...coordinator.messageHistory]
  };

  let current = coordinator;
  for (let i = 0; i < maxDepth && current.previousCoordinator; i++) {
    const snapshot = await loadSnapshot(current.previousCoordinator);
    histories.subscribers.unshift(...snapshot.subscriberHistory);
    histories.messages.unshift(...snapshot.messageHistory);
    current = snapshot;
  }

  return histories;
}
```

### Conflict Resolution via History with Message Union

```javascript
async function mergeCoordinators(coordA, coordB) {
  console.log(`🔀 Merging coordinators: v${coordA.version} and v${coordB.version}`);

  // Load both message collections
  const collA = await loadCollection(coordA.currentMessages);
  const collB = await loadCollection(coordB.currentMessages);

  // Union of messages by messageID (prevents message loss)
  const allMessages = new Map();
  for (const msg of collA.messages) {
    allMessages.set(msg.messageID, msg);
  }
  for (const msg of collB.messages) {
    allMessages.set(msg.messageID, msg);
  }

  // Create merged message collection
  const mergedMessages = {
    collectionID: generateCollectionID(),
    topicID: coordA.topicID,
    messages: Array.from(allMessages.values()),
    version: Math.max(coordA.version, coordB.version) + 1,
    createdAt: Date.now()
  };

  const mergedMessagesID = await storeCollection(mergedMessages);

  // Merge subscriber collections (same process)
  const subscribersA = await loadCollection(coordA.currentSubscribers);
  const subscribersB = await loadCollection(coordB.currentSubscribers);
  const allSubscribers = new Map();
  for (const sub of subscribersA.subscribers) {
    allSubscribers.set(sub.clientID, sub);
  }
  for (const sub of subscribersB.subscribers) {
    allSubscribers.set(sub.clientID, sub);
  }

  const mergedSubscribers = {
    collectionID: generateCollectionID(),
    topicID: coordA.topicID,
    subscribers: Array.from(allSubscribers.values()),
    version: Math.max(coordA.version, coordB.version) + 1,
    createdAt: Date.now()
  };

  const mergedSubscribersID = await storeCollection(mergedSubscribers);

  // Union of histories
  const subscriberHistory = Array.from(new Set([
    ...coordA.subscriberHistory,
    ...coordB.subscriberHistory,
    mergedSubscribersID
  ]));

  const messageHistory = Array.from(new Set([
    ...coordA.messageHistory,
    ...coordB.messageHistory,
    mergedMessagesID
  ]));

  // Create unified coordinator
  const unified = {
    topicID: coordA.topicID,
    version: Math.max(coordA.version, coordB.version) + 1,
    currentMessages: mergedMessagesID,
    currentSubscribers: mergedSubscribersID,
    messageHistory: messageHistory.slice(-50),  // Keep bounded
    subscriberHistory: subscriberHistory.slice(-50),
    previousCoordinator: coordA.previousCoordinator || coordB.previousCoordinator,
    lastModified: Date.now(),
    state: ChannelState.ACTIVE
  };

  console.log(`✅ Merge complete: v${unified.version} (${allMessages.size} messages, ${allSubscribers.size} subscribers)`);

  return unified;
}
```

## Content-Based TTL for Collections

```javascript
function calculateCollectionTTL(collection) {
  const GRACE_PERIOD = 3600000; // 1 hour

  if (collection.messages) {
    // Message collection TTL = max message expiry + grace period
    const maxExpiry = Math.max(...collection.messages.map(m => m.expiresAt));
    return maxExpiry + GRACE_PERIOD;
  } else if (collection.subscribers) {
    // Subscriber collection TTL = max subscriber expiry + grace period
    const maxExpiry = Math.max(...collection.subscribers.map(s => s.expiresAt));
    return maxExpiry + GRACE_PERIOD;
  }

  return Date.now() + GRACE_PERIOD; // Default
}

async function storeCollection(collection) {
  const collectionID = generateCollectionID(collection);
  const ttl = calculateCollectionTTL(collection);

  // ✅ IMPLEMENTED: DHT store with TTL in src/dht/KademliaDHT.js
  await dht.store(collectionID, collection, {expiresAt: ttl});

  return collectionID;
}
```

**Why this works:**
- Old collections expire automatically when their contents expire
- Grace period (1 hour) allows time for conflict resolution and merging
- No explicit deletion needed - DHT handles cleanup
- Prevents resource leaks from orphaned collections

## Deterministic Subscriber Assignment

To prevent duplicate message delivery, coordinators use deterministic algorithm:

```javascript
function assignSubscriberToCoordinator(subscriberID, topicID, coordinatorNodes) {
  // Hash combines both IDs to ensure same coordinator for same subscriber
  const assignmentHash = sha1(subscriberID + topicID);

  // Convert hash to index
  const index = parseInt(assignmentHash.substring(0, 8), 16) % coordinatorNodes.length;

  return coordinatorNodes[index];
}
```

**Properties:**
- ✅ Deterministic: Same subscriber always assigned to same coordinator
- ✅ Load-balanced: Subscribers distributed evenly across coordinators
- ✅ No coordination needed: All coordinators compute same assignment
- ✅ No duplicates: Each subscriber receives message exactly once

## Cryptographic Identity Requirement

### Node ID as Public Key Hash

**✅ ALREADY IMPLEMENTED** - See `src/browser/IdentityStore.js` and `src/core/DHTNodeId.js`

**Requirement:** All nodes participating in Sticky Pub/Sub MUST have cryptographic identities.

```javascript
// Node identity generation
// ✅ IMPLEMENTED in src/browser/IdentityStore.js:60-92
const keyPair = await crypto.subtle.generateKey(
  {name: "ECDSA", namedCurve: "P-256"},
  true,
  ["sign", "verify"]
);

const publicKeyJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
const publicKeyBytes = encodePublicKey(publicKeyJwk);
const nodeId = sha256(publicKeyBytes).substring(0, 40); // 160-bit Kademlia ID
// ✅ IMPLEMENTED in src/core/DHTNodeId.js:20-35
```

**Why This Is Required:**
- Subscription renewal uses signature-based authentication
- Node ID must be verifiable against public key
- Prevents identity spoofing and unauthorized renewals
- Standard pattern used by IPFS, Ethereum, etc.

---

### Bootstrap Authentication Flow

**✅ ALREADY IMPLEMENTED** - See `src/bridge/EnhancedBootstrapServer.js:827-931`

When connecting to the DHT network, nodes must prove ownership of their private key:

```
1. Client → Bootstrap: CONNECT {nodeId, publicKey}
   ✅ IMPLEMENTED: BrowserDHTClient sends metadata with publicKey

2. Bootstrap validates:
   ├─ Verify: hash(publicKey) == nodeId
   └─ If invalid → reject connection
   ✅ IMPLEMENTED: EnhancedBootstrapServer.js:853-862

3. Bootstrap → Client: CHALLENGE {nonce, timestamp}
   ✅ IMPLEMENTED: EnhancedBootstrapServer.js:864-873

4. Client signs challenge:
   ├─ payload = nonce + ":" + timestamp + ":" + nodeId
   ├─ signature = sign(payload, privateKey)
   └─ Client → Bootstrap: CHALLENGE_RESPONSE {signature}
   ✅ IMPLEMENTED: BrowserDHTClient handles auth_challenge

5. Bootstrap verifies:
   ├─ Verify signature against publicKey
   ├─ Check timestamp freshness (< 30 seconds old)
   ├─ If valid → add to DHT with verified status
   └─ If invalid → reject connection
   ✅ IMPLEMENTED: EnhancedBootstrapServer.js:875-918

6. Client receives: CONNECTION_ACCEPTED {nodeId, verified: true}
```

**Security Properties:**
- ✅ Proves client has access to private key
- ✅ Prevents replay attacks (timestamp check)
- ✅ Prevents man-in-the-middle (signature verification)
- ✅ No long-lived tokens to steal

---

### Private Key Storage

**✅ ALREADY IMPLEMENTED** - See `src/browser/IdentityStore.js`

**Browser Applications:**

Store cryptographic keys in IndexedDB for persistence:

```javascript
// Storage structure
// ✅ IMPLEMENTED: src/browser/IdentityStore.js:60-150
{
  privateKey: JWK,      // ECDSA P-256 private key
  publicKey: JWK,       // Corresponding public key
  nodeId: string,       // Derived from publicKey hash
  createdAt: timestamp,
  lastUsed: timestamp
}
```

**Recommendations:**
- ✅ IMPLEMENTED: Uses Web Crypto API (`crypto.subtle`) for key generation
- ✅ IMPLEMENTED: Stored in IndexedDB (persistent across sessions)
- Consider encryption with user password for high-security applications
- ✅ IMPLEMENTED: Export/backup functionality (`exportIdentity()` in IdentityStore.js:152-164)
- ✅ IMPLEMENTED: Never transmit private key over network

**Node.js Applications:**

Store keys in encrypted file with restricted permissions:

```javascript
// ~/.yz-network/identity.json (chmod 600)
// ✅ IMPLEMENTED: src/node/NodeDHTClient.js uses crypto module for key generation
{
  privateKey: "base64-encoded-key",
  publicKey: "base64-encoded-key",
  nodeId: "160-bit-hex-id",
  createdAt: "2025-01-24T..."
}
```

**Mobile Applications:**
- iOS: Use Keychain Services
- Android: Use Android Keystore System
- Both provide hardware-backed storage when available

---

### Identity Lifecycle

**✅ ALREADY IMPLEMENTED** - See `src/browser/IdentityStore.js:44-158`

**First Run:**
```javascript
// Generate new identity
// ✅ IMPLEMENTED: src/browser/IdentityStore.js:44-58
if (!await identityStore.exists()) {
  const identity = await generateIdentity();
  await identityStore.save(identity);
  console.log('New identity created:', identity.nodeId);
}
```

**Subsequent Runs:**
```javascript
// Load existing identity
// ✅ IMPLEMENTED: src/browser/IdentityStore.js:60-150
const identity = await identityStore.load();
await dht.connect(identity);
```

**Backup/Export:**
```javascript
// Export identity for backup
// ✅ IMPLEMENTED: src/browser/IdentityStore.js:152-164
const backup = await identityStore.export();
// backup = {privateKey, publicKey, nodeId}
// User should store securely (password manager, encrypted file)
```

**Import/Restore:**
```javascript
// Restore identity from backup
// ✅ IMPLEMENTED: src/browser/IdentityStore.js:166-191
await identityStore.import(backup);
```

---

## Testing Strategy

### Test 1: Single Publisher with Late Joiner

**Objective:** Verify message persistence and completeness.

```javascript
async function testSequentialPublish() {
  const TOTAL_MESSAGES = 1000;

  // Start publisher
  const publisher = await createDHTClient();
  const publishPromise = (async () => {
    for (let i = 0; i < TOTAL_MESSAGES; i++) {
      await publisher.publish('seq-test', {
        sequence: i,
        timestamp: Date.now()
      });
      await sleep(50); // 50ms between publishes
    }
  })();

  // Late joiner (starts after ~100 messages published)
  await sleep(5000);
  const subscriber = await createDHTClient();
  const received = [];

  await subscriber.subscribe('seq-test', {
    onMessage: (msg) => {
      received.push(msg.data.sequence);
    }
  });

  // Wait for publisher to finish
  await publishPromise;

  // Wait for final message delivery
  await sleep(5000);

  // Verify no gaps
  received.sort((a, b) => a - b);
  const gaps = [];
  for (let i = 0; i < received.length - 1; i++) {
    if (received[i+1] !== received[i] + 1) {
      gaps.push({after: received[i], before: received[i+1]});
    }
  }

  console.log(`✅ Received ${received.length}/${TOTAL_MESSAGES} messages`);
  console.log(`✅ Range: ${received[0]} to ${received[received.length-1]}`);

  if (gaps.length > 0) {
    console.error(`❌ Found ${gaps.length} gaps:`, gaps);
  } else {
    console.log(`✅ No gaps detected - perfect sequence!`);
  }
}
```

**Success Criteria:**
- ✅ All 1000 messages received
- ✅ No gaps in sequence
- ✅ Late joiner receives all messages (including those published before subscription)

### Test 2: Concurrent Publishers

**Objective:** Verify concurrent publishing without message loss.

```javascript
async function testConcurrentPublishers() {
  const NUM_PUBLISHERS = 10;
  const MESSAGES_PER_PUBLISHER = 100;
  const TOTAL_MESSAGES = 1000;

  // Create 10 publisher nodes
  const publishers = [];
  for (let i = 0; i < NUM_PUBLISHERS; i++) {
    const node = await createDHTClient();
    publishers.push({
      node,
      id: i,
      sequenceCounter: 0
    });
  }

  // Start all publishers concurrently
  const publishPromises = publishers.map(async (pub) => {
    for (let seq = 0; seq < MESSAGES_PER_PUBLISHER; seq++) {
      await pub.node.publish('concurrent-test', {
        publisherID: pub.id,
        sequence: seq,
        timestamp: Date.now()
      });

      // Random delay 10-50ms (simulates real concurrent load)
      await sleep(10 + Math.random() * 40);
    }
  });

  // Late joiner starts after ~500 messages published
  await sleep(2000);
  const subscriber = await createDHTClient();
  const received = new Map(); // publisherID -> Set of sequences

  for (let i = 0; i < NUM_PUBLISHERS; i++) {
    received.set(i, new Set());
  }

  await subscriber.subscribe('concurrent-test', {
    onMessage: (msg) => {
      const {publisherID, sequence} = msg.data;
      received.get(publisherID).add(sequence);
    }
  });

  // Wait for all publishes to complete
  await Promise.all(publishPromises);

  // Wait for final deliveries
  await sleep(5000);

  // Verify each publisher's sequence
  let totalReceived = 0;
  let totalGaps = 0;

  for (let pubID = 0; pubID < NUM_PUBLISHERS; pubID++) {
    const sequences = Array.from(received.get(pubID)).sort((a, b) => a - b);
    totalReceived += sequences.length;

    // Check for gaps
    const gaps = [];
    for (let i = 0; i < sequences.length - 1; i++) {
      if (sequences[i+1] !== sequences[i] + 1) {
        gaps.push({after: sequences[i], before: sequences[i+1]});
      }
    }

    if (gaps.length > 0) {
      console.error(`❌ Publisher ${pubID}: Found ${gaps.length} gaps:`, gaps);
      totalGaps += gaps.length;
    } else {
      console.log(`✅ Publisher ${pubID}: Received ${sequences.length}/${MESSAGES_PER_PUBLISHER} (complete)`);
    }
  }

  console.log(`\n📊 Test Results:`);
  console.log(`   Total received: ${totalReceived}/${TOTAL_MESSAGES}`);
  console.log(`   Total gaps: ${totalGaps}`);

  if (totalReceived === TOTAL_MESSAGES && totalGaps === 0) {
    console.log(`✅ PASS: All messages received, no gaps!`);
  } else {
    console.error(`❌ FAIL: Missing ${TOTAL_MESSAGES - totalReceived} messages, ${totalGaps} gaps`);
  }
}
```

**Success Criteria:**
- ✅ All 1000 messages received (100 from each of 10 publishers)
- ✅ No gaps per-publisher sequence
- ✅ Late joiner receives all messages
- ✅ No messages lost during concurrent coordinator updates
- ✅ Merge conflicts resolved correctly

### Additional Tests

**Unit Tests:**
- Coordinator serialization/deserialization
- Collection copy-on-write operations
- History array merging (union of IDs)
- Deterministic assignment algorithm
- Expiry filtering
- Coordinator pruning and snapshot creation
- Version gap detection

**Integration Tests:**
- Basic subscribe/publish flow
- Historical message delivery to new subscribers
- Concurrent updates and conflict resolution
- Subscription renewal
- Garbage collection
- Client-side version gap recovery
- Catastrophic recovery scenarios

**Performance Tests:**
- 1000 subscribers per topic
- 10,000 messages per topic
- 1000 concurrent topics
- Message delivery latency
- Coordinator replication overhead
- Merge conflict resolution time

**Chaos Tests:**
- Node failures during operations
- Network partitions
- Concurrent conflicting updates
- Clock skew between nodes
- Coordinator snapshot loading failures

## Implementation Phases

### Phase 1: Core Data Structures (2-3 days)
- [ ] Create `CoordinatorObject` class with dual histories and snapshot links
- [ ] Create `SubscriberCollection` class (immutable, content-based TTL)
- [ ] Create `MessageCollection` class (immutable, with `addedInVersion` field)
- [ ] Create `Message` class with per-publisher sequences
- [ ] Create `CoordinatorSnapshot` class for linked history
- [ ] Add DHT storage/retrieval methods (leverage existing `store()` and `get()`)
- [ ] Implement content-based TTL calculation
- [ ] Unit tests for serialization/deserialization

### Phase 2: Basic Subscribe/Publish (3-4 days)
- [ ] Implement `subscribe(topicID, clientID, lastSeenVersion)` method
- [ ] Implement `publish(topicID, messageData)` method with optimistic concurrency
- [ ] Implement coordinator creation and updates
- [ ] Implement copy-on-write collection updates
- [ ] Add coordinator replication to n nodes (leverage existing DHT replication)
- [ ] Implement coordinator pruning and snapshot creation
- [ ] Integration tests for basic pub/sub

### Phase 3: Message Delivery with Delta (2-3 days)
- [ ] Implement deterministic subscriber assignment
- [ ] Add delta delivery based on `addedInVersion`
- [ ] Add coordinator-to-coordinator coordination protocol
- [ ] Implement message pushing to subscribers (leverage existing `sendMessage()`)
- [ ] Add bootstrap subscriber flow (historical messages)
- [ ] Handle delivery failures and retries
- [ ] Integration tests for message delivery

### Phase 4: Conflict Resolution & Recovery (3-4 days)
- [ ] Implement history-based merging (union of collection ID arrays)
- [ ] Implement message union during merge (prevent loss)
- [ ] Add version conflict detection
- [ ] Handle concurrent updates gracefully
- [ ] Implement history pruning (bounded arrays)
- [ ] Implement catastrophic recovery mechanism
- [ ] Add channel state management (ACTIVE/RECOVERING/FAILED)
- [ ] Unit tests for conflict scenarios

### Phase 5: Client-Side Recovery (2-3 days)
- [ ] Implement client-side version gap detection
- [ ] Add `requestFullUpdate(fromVersion)` method
- [ ] Implement periodic version checking
- [ ] Add client-side message deduplication
- [ ] Implement `lastSeenVersion` tracking in subscriptions
- [ ] Integration tests for gap recovery

### Phase 6: Garbage Collection (1-2 days)
- [ ] Implement lazy cleanup during operations
- [ ] Add coordinator deletion when topic inactive
- [ ] Implement subscription renewal mechanism (leverage existing signature infrastructure)
- [ ] Add expired message/subscriber filtering
- [ ] Implement snapshot TTL and cleanup
- [ ] Integration tests for cleanup

### Phase 7: Testing & Validation (2-3 days)
- [ ] Implement Test 1: Single publisher with late joiner
- [ ] Implement Test 2: 10 concurrent publishers
- [ ] Add per-publisher sequence validation
- [ ] Add gap detection in tests
- [ ] Performance testing and benchmarks
- [ ] Chaos testing (failures, partitions)

### Phase 8: Optimization & API (2-3 days)
- [ ] Implement lazy loading of messages (IDs only in collection)
- [ ] Add message batching for efficiency
- [ ] Implement collection pagination for large subscriber lists
- [ ] Create high-level API wrapper
- [ ] Add browser/Node.js examples
- [ ] Write API documentation
- [ ] Add debugging tools

**Total Estimated Time**: 17-25 days

## API Design

### High-Level API

```javascript
// Subscribe to a topic
const subscription = await pubsub.subscribe('chat-room-42', {
  onMessage: (message) => {
    console.log('Received:', message.data);
  },
  ttl: 30 * 60 * 1000,  // 30 minutes
  receiveHistory: true,  // Receive all non-expired messages
  lastSeenVersion: null  // null = full history, number = delta from version
});

// Publish a message
await pubsub.publish('chat-room-42', {
  text: 'Hello, world!',
  sender: 'Alice'
}, {
  ttl: 24 * 60 * 60 * 1000  // 24 hours
});

// Unsubscribe
await subscription.unsubscribe();

// Renew subscription (before expiry)
await subscription.renew(30 * 60 * 1000);

// Check subscription status
console.log('Last seen version:', subscription.lastSeenVersion);
console.log('Channel state:', subscription.channelState);
```

### Low-Level Protocol API

```javascript
// Direct protocol access
const coordinator = await stickyPubSub.loadCoordinator(topicID);
const subscribers = await stickyPubSub.loadSubscriberCollection(coordinator.currentSubscribers);
const messages = await stickyPubSub.loadMessageCollection(coordinator.currentMessages);

// Inspect histories
console.log('Subscriber collection lineage:', coordinator.subscriberHistory);
console.log('Message collection lineage:', coordinator.messageHistory);

// Load deep history
const fullHistory = await stickyPubSub.loadFullHistory(coordinator, maxDepth: 5);

// Manual conflict resolution
const unified = await stickyPubSub.mergeCoordinators(coordA, coordB);

// Catastrophic recovery
await stickyPubSub.catastrophicRecovery(topicID);

// Channel state management
const state = stickyPubSub.getChannelState(topicID); // 'ACTIVE' | 'RECOVERING' | 'FAILED'
```

## Security Considerations

### Preventing Abuse

**Topic Squatting:**
- Require initial authorization token to create topics
- Limit topics per node (rate limiting)
- Implement topic expiry (garbage collection)

**Message Spam:**
- Rate limit publications per node
- Size limits on messages (e.g., 10KB max)
- Require proof-of-work for large messages

**Subscriber Spam:**
- Rate limit subscriptions per node
- Limit subscribers per topic (e.g., 1000 max)
- Subscription expiry (30 minutes TTL)

**Coordinator Hijacking:**
- Sign coordinator updates with node keys
- Verify signatures during replication
- Reject coordinators with invalid signatures

### Privacy Considerations

**Topic Discovery:**
- Topic IDs are hashed, not plaintext
- Cannot enumerate all topics
- Subscription list not public

**Message Privacy:**
- Messages stored in DHT (public by default)
- **Application can encrypt message data** client-side before publishing
- Metadata (IDs, timestamps, TTL) remains unencrypted for DHT operations
- Coordinator metadata is public (subscriber count, message count)

**Encryption Support:**
```javascript
// Encrypt message data before publishing
const encrypted = await encryptData(messageData, sharedSecret);
await pubsub.publish(topicID, encrypted);

// Decrypt on receipt
subscription.onMessage = async (message) => {
  const decrypted = await decryptData(message.data, sharedSecret);
  console.log('Decrypted:', decrypted);
};
```

## Advantages of This Design

✅ **Fully Decentralized**: No central message broker or coordinator
✅ **Fault Tolerant**: Replicated coordinators, no single point of failure
✅ **Scalable**: O(log N) lookups, deterministic load balancing
✅ **Message Persistence**: New subscribers receive historical messages
✅ **Conflict Resistant**: History-based merge handles concurrent updates
✅ **No Message Loss**: Optimistic concurrency with automatic merge
✅ **Client-Side Recovery**: Version gap detection and full update requests
✅ **Catastrophic Recovery**: Infinite retry with recovery from majority
✅ **Automatic Cleanup**: Lazy garbage collection, content-based TTL
✅ **DHT-Native**: Built entirely on existing DHT primitives
✅ **Flexible TTL**: Per-message and per-subscriber expiry
✅ **No Duplicates**: Deterministic assignment prevents duplicate delivery
✅ **Simple Merge**: Collection ID histories merge via set union
✅ **Bounded Coordinator**: Linked snapshots prevent unbounded growth
✅ **Delta Delivery**: Efficient updates via `addedInVersion` tracking
✅ **Drop Detection**: Per-publisher sequences detect missing messages
✅ **Encryption Support**: Application-level encryption without affecting DHT operations
✅ **Leverages Existing Infrastructure**: Uses implemented DHT, crypto, and networking

## Limitations and Trade-offs

### 1. Message Ordering

**Issue**: No global message ordering across publishers

**Mitigation**:
- Use `publishedAt` timestamp for approximate ordering
- Per-publisher sequences provide ordering within publisher
- Application can implement ordering if needed

### 2. Delivery Guarantees

**Issue**: At-most-once semantics (fire-and-forget)

**Mitigation**:
- Client-side deduplication handles duplicate delivery
- Per-publisher sequences detect drops
- Application can implement acknowledgments if needed

### 3. Coordinator Conflicts

**Issue**: Concurrent updates create temporary inconsistency

**Mitigation**:
- Optimistic concurrency with automatic merge
- History-based merge prevents message loss
- All coordinators eventually converge
- Catastrophic recovery handles merge failures

### 4. Topic Discovery

**Issue**: Cannot enumerate all topics (by design)

**Mitigation**:
- Topic IDs must be shared out-of-band
- Application maintains topic directory if needed
- Protects privacy (feature, not bug)

### 5. Large Subscriber Lists

**Issue**: Collections become large with many subscribers

**Mitigation**:
- Pagination of collections (split into multiple)
- Lazy loading of subscriber metadata
- Topic subscriber limits (e.g., 1000 max)

### 6. Network Partitions

**Issue**: Partitioned networks create divergent state

**Mitigation**:
- Same as general DHT partition issues
- Merge on reconnection using history
- Coordinators detect conflicts via version numbers

## Status

**Current Status**: Proposal stage - design complete, implementation not started

**Already Implemented (Reusable):**
- ✅ DHT operations: `store()`, `get()`, `findNode()` (KademliaDHT.js)
- ✅ Cryptographic identity: Key generation, signing, verification (IdentityStore.js, InvitationToken.js)
- ✅ Bootstrap authentication: Challenge/response flow (EnhancedBootstrapServer.js)
- ✅ Message routing: `sendMessage()` via DHT connections (ConnectionManager.js)
- ✅ Node ID system: Public key hash → 160-bit Kademlia ID (DHTNodeId.js)
- ✅ IndexedDB storage: Private key persistence (IdentityStore.js)

**Decisions Finalized:**
- ✅ Linked coordinator snapshots with size/time-based pruning
- ✅ Content-based TTL for collections (max expiry + 1 hour grace)
- ✅ Per-publisher sequence numbers for drop detection
- ✅ Client-side version gap detection and recovery
- ✅ Optimistic concurrency with automatic merge
- ✅ Catastrophic recovery with infinite retry
- ✅ Two test specifications (single publisher + 10 concurrent publishers)
- ✅ Application-level encryption support
- ✅ Initiator node concept (ephemeral, any k-closest node)

**Next Steps**:
1. Begin Phase 1 implementation (core data structures)
2. Set up DHT integration (reuse existing primitives)
3. Build minimal subscribe/publish prototype
4. Implement Test 1 (single publisher)
5. Add conflict resolution
6. Implement Test 2 (concurrent publishers)
7. Iterate based on test results

**Last Updated**: 2025-01-25
