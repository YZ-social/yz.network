# Sticky Pub/Sub - Phase 1: Core Data Structures ✅

**Status:** COMPLETE
**Test Results:** 82/82 tests passing (100%)

## Overview

Phase 1 implements the foundational data structures for the Sticky Pub/Sub protocol, providing message persistence, immutable collections, and DHT storage integration.

## Implemented Components

### 1. Message (`Message.js`)
Individual pub/sub messages with cryptographic signatures and per-publisher sequences.

**Features:**
- Per-publisher monotonic sequence numbers (drop detection)
- Ed25519 signature signing and verification
- `addedInVersion` field for delta delivery tracking
- Deterministic message ID generation
- Expiry timestamps with validation

**Usage:**
```javascript
import { Message } from './pubsub/Message.js';
import { InvitationToken } from './core/InvitationToken.js';

// Generate keys
const keyInfo = await InvitationToken.generateKeyPair();

// Create and sign message
const message = await Message.create({
  topicID: 'my-topic',
  publisherID: nodeID,
  publisherSequence: 1,
  addedInVersion: 0,
  data: { text: 'Hello World' },
  publishedAt: Date.now(),
  expiresAt: Date.now() + 3600000
}, keyInfo);

// Verify signature
const isValid = await message.verify(keyInfo.publicKey);
```

---

### 2. MessageCollection (`MessageCollection.js`)
Immutable collection of message metadata (not full message data).

**Features:**
- **Immutable:** All modifications create new collections (copy-on-write)
- **Content-based TTL:** Expires when max(message expiry) + 1 hour grace period
- **Delta delivery:** `getMessagesSince(version)` for subscriber updates
- **Sequence gap detection:** Identifies missing per-publisher sequences
- **Merge support:** Set union by messageID for conflict resolution

**Usage:**
```javascript
import { MessageCollection } from './pubsub/MessageCollection.js';

const collection = new MessageCollection();

// Add message (returns NEW collection)
const updated = collection.addMessage({
  messageID: 'msg-001',
  publisherID: 'pub-001',
  publisherSequence: 1,
  addedInVersion: 1,
  expiresAt: Date.now() + 3600000
});

// Get messages added after version 5
const deltaMessages = updated.getMessagesSince(5);

// Detect missing sequences
const gaps = updated.detectSequenceGaps();
```

---

### 3. SubscriberCollection (`SubscriberCollection.js`)
Immutable collection of subscriber metadata.

**Features:**
- **Deterministic coordinator assignment:** Hash-based distribution across k coordinators
- **Signature verification:** Subscribers sign subscriptions to prove intent
- **Content-based TTL:** Expires when max(subscription expiry) + 1 hour grace period
- **Immutable:** All modifications create new collections
- **Merge support:** Set union by subscriberID (takes latest on duplicate)

**Usage:**
```javascript
import { SubscriberCollection } from './pubsub/SubscriberCollection.js';

// Calculate which coordinator handles this subscriber
const coordinatorNode = SubscriberCollection.calculateCoordinatorNode(
  'my-topic',
  subscriberID,
  20 // k = 20 for Kademlia
);

const collection = new SubscriberCollection();

// Add subscriber (returns NEW collection)
const updated = collection.addSubscriber({
  subscriberID: 'sub-001',
  coordinatorNode: 5,
  subscribedAt: Date.now(),
  expiresAt: Date.now() + 3600000,
  signature: '...'
});

// Get all subscribers assigned to coordinator 5
const coordinator5Subs = updated.getSubscribersByCoordinator(5);
```

---

### 4. CoordinatorObject (`CoordinatorObject.js`)
Central mutable coordinator for a topic, tracking current state and history.

**Features:**
- **Dual histories:** Separate tracking for subscriber and message collections
- **Version-based concurrency:** Optimistic locking for conflict detection
- **Automatic pruning:** Creates snapshots when histories grow too large (>1KB or >50 entries)
- **Channel state tracking:** ACTIVE, RECOVERING, or FAILED states
- **History-based merging:** Resolves conflicts via set union of collection IDs

**Usage:**
```javascript
import { CoordinatorObject } from './pubsub/CoordinatorObject.js';

// Create initial coordinator for new topic
const coordinator = CoordinatorObject.createInitial('my-topic');

// Update subscribers (returns NEW coordinator with version++)
const updated = coordinator.updateSubscribers('sub-coll-001');

// Update messages (returns NEW coordinator with version++)
const updated2 = updated.updateMessages('msg-coll-001');

// Check if pruning needed
if (updated2.needsPruning()) {
  const { coordinator: pruned, snapshot } = updated2.prune();
  // Store both pruned coordinator and snapshot in DHT
}

// Merge coordinators (conflict resolution)
const merged = coordinatorA.merge(coordinatorB);
```

---

### 5. CoordinatorSnapshot (`CoordinatorSnapshot.js`)
Historical snapshot of coordinator history for bounded size.

**Features:**
- **Linked list:** `previousCoordinator` points to older snapshots
- **Fixed TTL:** Expires after 1 hour (independent of content)
- **Immutable:** Never modified after creation
- **Lazy loading:** Only loaded when deep history merge is needed

**Usage:**
```javascript
import { CoordinatorSnapshot } from './pubsub/CoordinatorSnapshot.js';

// Created automatically during coordinator pruning
const snapshot = CoordinatorSnapshot.createFromPruning({
  version: 100,
  topicID: 'my-topic',
  prunedSubscriberHistory: ['sub-1', 'sub-2', ...],
  prunedMessageHistory: ['msg-1', 'msg-2', ...],
  previousCoordinator: 'older-snapshot-id'
});

// Traverse snapshot chain
const chain = await storage.loadSnapshotChain(snapshotID, maxDepth);
```

---

### 6. PubSubStorage (`PubSubStorage.js`)
DHT storage integration with type-safe serialization/deserialization.

**Features:**
- **Type-safe storage:** Validates all objects before storing
- **Optimistic locking:** Version-checked coordinator updates
- **Parallel loading:** Batch load messages with `loadMessages()`
- **Snapshot chain traversal:** Load linked snapshot history
- **Replication:** Uses DHT's k=20 replication factor automatically

**Storage Keys:**
- `coordinator:{topicID}` → CoordinatorObject
- `msgcoll:{collectionID}` → MessageCollection
- `subcoll:{collectionID}` → SubscriberCollection
- `msg:{messageID}` → Message
- `snapshot:{snapshotID}` → CoordinatorSnapshot

**Usage:**
```javascript
import { PubSubStorage } from './pubsub/PubSubStorage.js';

const storage = new PubSubStorage(dht);

// Store coordinator
await storage.storeCoordinator(coordinator);

// Load coordinator
const loaded = await storage.loadCoordinator('my-topic');

// Optimistic locking (version check)
const result = await storage.storeCoordinatorWithVersionCheck(
  newCoordinator,
  expectedVersion
);

if (result.conflict) {
  // Handle version conflict
  const merged = newCoordinator.merge(result.currentCoordinator);
  await storage.storeCoordinator(merged);
}

// Load messages in parallel
const messages = await storage.loadMessages([
  'msg-001', 'msg-002', 'msg-003'
]);
```

---

## Architecture Decisions

### 1. Immutable Collections
**Why:** Eliminates race conditions, simplifies concurrent updates, enables efficient merging.

**How:** All `add()`, `remove()`, `merge()` methods return NEW collections instead of modifying in place.

**Trade-off:** More memory allocations, but JavaScript GC handles short-lived objects efficiently.

---

### 2. Content-Based TTL
**Why:** Old collections auto-expire when contents expire, no manual cleanup needed.

**How:** `TTL = max(item.expiresAt) + GRACE_PERIOD (1 hour)`

**Trade-off:** Collections outlive contents slightly (1 hour), but ensures merge conflicts can still access recent history.

---

### 3. Linked Coordinator Snapshots
**Why:** Prevents unbounded coordinator growth while preserving deep history for conflict resolution.

**How:** When coordinator > 1KB or > 50 history entries, create snapshot and prune to last 10 entries.

**Trade-off:** Requires lazy-loading snapshots during deep merges (rare), but keeps active coordinator small.

---

### 4. Per-Publisher Sequences
**Why:** Enables drop detection without complex ordering guarantees.

**How:** Each publisher maintains monotonic counter, subscribers detect gaps per-publisher.

**Trade-off:** Publishers must track sequence state, but enables reliable message completeness checking.

---

### 5. addedInVersion Field
**Why:** Enables efficient delta delivery to subscribers without scanning all messages.

**How:** Each message metadata records which coordinator version added it, filter by `addedInVersion > lastSeenVersion`.

**Trade-off:** 4-8 extra bytes per message, but eliminates need to scan entire collection for deltas.

---

## Testing

**Test Suite:** `test-data-structures.js`
**Coverage:** 82 tests covering all classes
**Run Tests:** `node src/pubsub/test-data-structures.js`

**Test Areas:**
- ✅ Message signing/verification
- ✅ Serialization/deserialization for all classes
- ✅ Immutability guarantees (original unchanged after updates)
- ✅ Content-based TTL calculation
- ✅ Coordinator pruning and snapshot creation
- ✅ Merge conflict resolution
- ✅ Sequence gap detection
- ✅ Validation (all required fields present)

---

## Integration with Existing Codebase

**Leverages:**
- ✅ `DHTNodeId.fromString()` for deterministic ID generation (src/core/DHTNodeId.js)
- ✅ `InvitationToken.signData()` and `verifySignature()` for Ed25519 crypto (src/core/InvitationToken.js)
- ✅ `KademliaDHT.store()` and `get()` for DHT storage with k=20 replication (src/dht/KademliaDHT.js)

**No Breaking Changes:** All code isolated in `src/pubsub/` directory, does not modify existing DHT or network layers.

---

## Next Steps (Phase 2 & 3)

### Phase 2: Protocol Operations (Not Yet Implemented)
- [ ] `PublishOperation` - Handles message publishing with optimistic concurrency
- [ ] `SubscribeOperation` - Manages subscriptions with delta delivery
- [ ] `CoordinatorRole` - Handles delivery and replication
- [ ] Catastrophic recovery mechanism
- [ ] Renewal protocol (signature-based subscription extension)

### Phase 3: Integration & Testing (Not Yet Implemented)
- [ ] DHTClient API integration (`dht.publish()`, `dht.subscribe()`)
- [ ] Sequential integer test (1000 messages, no gaps)
- [ ] Concurrent publishing test (10 publishers, 100 messages each)
- [ ] Late joiner test (receive all historical messages)
- [ ] Merge conflict stress test

---

## File Structure

```
src/pubsub/
├── Message.js                    # Individual signed messages
├── MessageCollection.js          # Immutable message metadata collection
├── SubscriberCollection.js       # Immutable subscriber metadata collection
├── CoordinatorObject.js          # Mutable coordinator with dual histories
├── CoordinatorSnapshot.js        # Historical coordinator snapshots
├── PubSubStorage.js              # DHT storage integration
├── index.js                      # Module exports
├── test-data-structures.js       # Unit tests (82 tests passing)
└── README.md                     # This file
```

---

## Key Metrics

- **Lines of Code:** ~2,500 (all classes + tests)
- **Test Coverage:** 82 tests, 100% passing
- **Dependencies:** Minimal (reuses existing DHT + crypto infrastructure)
- **Memory Overhead:** ~1KB per coordinator, ~100 bytes per message metadata
- **Storage Keys:** 5 types (coordinator, msgcoll, subcoll, msg, snapshot)

---

## Summary

Phase 1 provides a solid foundation with:
- ✅ Type-safe, immutable data structures
- ✅ Cryptographic message signing
- ✅ Content-based automatic expiry
- ✅ Bounded coordinator size via snapshots
- ✅ Optimistic concurrency support
- ✅ DHT storage integration
- ✅ Comprehensive test coverage

Ready to proceed with Phase 2: Protocol Operations implementation.
