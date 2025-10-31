# Sticky Pub/Sub Protocol Proposal

## Problem Statement

### The Need for Persistent Messaging on DHT

Traditional pub/sub systems rely on centralized message brokers (e.g., Redis, RabbitMQ, Kafka) to maintain subscriber lists and message queues. In a fully decentralized DHT network, we need a pub/sub mechanism that:

1. **Works without central servers** - All coordination via DHT storage
2. **Provides message persistence** - New subscribers receive historical messages (hence "sticky")
3. **Scales to many topics** - Support for 1000s of independent channels
4. **Handles dynamic membership** - Nodes can join/leave/disconnect at any time
5. **Tolerates network failures** - No single point of failure

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

## Design Principles

Before diving into the solution, establish core principles:

1. **Immutability Where Possible**: Copy-on-write collections prevent race conditions
2. **Ephemeral Coordinators**: No persistent root node, any node can coordinate
3. **DHT-Native Storage**: Everything stored using existing DHT primitives
4. **Lazy Operations**: Cleanup/maintenance happens during normal operations
5. **Time-Based Expiry**: All data has TTL, automatic cleanup
6. **Consensus via History**: Merge conflicts using collection ID history

## Proposed Solution: Three-Tier Architecture

### Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│  COORDINATOR OBJECT (mutable, small)                    │
│  Topic ID: "chat-room-42"                               │
│  Stored at: k closest nodes to hash(topic ID)           │
│─────────────────────────────────────────────────────────│
│  - Version: 142                                         │
│  - Subscriber Collection ID: "abc123..."                │
│  - Message Collection ID: "def456..."                   │
│  - Subscriber History: ["xyz789", "abc123"]             │
│  - Message History: ["uvw456", "def456"]                │
└─────────────────────────────────────────────────────────┘
       │                              │
       │                              │
       ▼                              ▼
┌──────────────────────┐    ┌──────────────────────┐
│ SUBSCRIBER           │    │ MESSAGE              │
│ COLLECTION           │    │ COLLECTION           │
│ (immutable)          │    │ (immutable)          │
│──────────────────────│    │──────────────────────│
│ Collection ID:       │    │ Collection ID:       │
│   "abc123..."        │    │   "def456..."        │
│ Topic ID:            │    │ Topic ID:            │
│   "chat-room-42"     │    │   "chat-room-42"     │
│ Subscribers:         │    │ Messages:            │
│   - node-001         │    │   - msg-001 ─────────┼──┐
│     expiresAt: T+30m │    │   - msg-002 ─────────┼──┼──┐
│   - node-002         │    │   - msg-003          │  │  │
│     expiresAt: T+30m │    │   ...                │  │  │
│   ...                │    │                      │  │  │
│                      │    │                      │  │  │
│ Stored at random     │    │ Stored at random     │  │  │
│ DHT location         │    │ DHT location         │  │  │
└──────────────────────┘    └──────────────────────┘  │  │
                                       │              │  │
                                       ▼              ▼  ▼
                            ┌──────────────────────────────┐
                            │ INDIVIDUAL MESSAGES          │
                            │ (immutable, stored separate) │
                            │──────────────────────────────│
                            │ Message ID: "msg-001"        │
                            │ Topic ID: "chat-room-42"     │
                            │ Data: {text: "Hello!"}       │
                            │ Published At: T1             │
                            │ Expires At: T1 + 24h         │
                            │                              │
                            │ Stored at: hash(messageID)   │
                            └──────────────────────────────┘
```

### Three-Tier Structure Explained

**Tier 1: Coordinator Object (Mutable)**
- Small object (~1KB) stored at k-closest nodes to `hash(topicID)`
- Contains pointers to current subscriber/message collections
- Maintains **two separate histories**: subscriber collection IDs and message collection IDs
- Only this object is mutable; everything else is copy-on-write

**Tier 2: Collections (Immutable)**
- Subscriber Collection: List of active subscribers with expiry times
- Message Collection: List of message IDs with metadata
- Stored at random DHT locations (not predictable)
- Never modified; always copied with changes
- History tracked in coordinator object, not in collections themselves

**Tier 3: Individual Messages (Immutable)**
- Actual message payload stored separately
- Enables lazy loading (fetch only needed messages)
- Each message stored at `hash(messageID)`
- Independent expiry per message

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

## Protocol Flows

### Subscribe Flow

```
1. Client Application
   ↓ subscribe(topicID)

2. findNode(topicID)
   ↓ returns k-closest nodes

3. Contact first reachable node (becomes initiator)
   ↓ SUBSCRIBE message

4. Initiator Node
   ├─ Check: Do I have coordinator?
   │  ├─ YES → Load coordinator (I'm one of k-closest)
   │  └─ NO  → Create new coordinator
   │
   ├─ Load current subscriber collection
   │
   ├─ Create new collection (copy-on-write)
   │  ├─ Add new subscriber
   │  └─ Set expiresAt = now + 30 minutes
   │
   ├─ Store new collection at random DHT location
   │  └─ Get new collectionID
   │
   ├─ Update coordinator
   │  ├─ Increment version
   │  ├─ Set currentSubscribers = new collectionID
   │  ├─ Append to subscriberHistory: push(new collectionID)
   │  └─ Store locally
   │
   └─ Replicate coordinator to n closest nodes

5. Bootstrap Subscriber (send historical messages)
   ├─ Load message collection from coordinator
   ├─ Filter non-expired messages
   ├─ Coordinate with other coordinators
   │  └─ Deterministic assignment: hash(subscriberID) % n
   └─ Deliver assigned messages to new subscriber

6. Return to client
   └─ {success: true, expiresAt}
```

### Publish Flow

```
1. Client Application
   ↓ publish(topicID, messageData)

2. findNode(topicID)
   ↓ returns k-closest nodes

3. Contact first reachable node (becomes initiator)
   ↓ PUBLISH message

4. Initiator Node
   ├─ Check: Do I have coordinator?
   │  ├─ YES → Load coordinator
   │  └─ NO  → Create new coordinator (empty subscribers OK)
   │
   ├─ Generate messageID = randomUUID()
   │
   ├─ Store message at hash(messageID)
   │  └─ {messageID, topicID, data, publishedAt, expiresAt}
   │
   ├─ Load current message collection
   │
   ├─ Create new collection (copy-on-write)
   │  └─ Add {messageID, publishedAt, expiresAt, size}
   │
   ├─ Store new collection at random DHT location
   │  └─ Get new collectionID
   │
   ├─ Update coordinator
   │  ├─ Increment version
   │  ├─ Set currentMessages = new collectionID
   │  ├─ Append to messageHistory: push(new collectionID)
   │  └─ Store locally
   │
   └─ Replicate coordinator to n closest nodes

5. Message Delivery (if subscribers exist)
   ├─ Load subscriber collection
   ├─ Coordinate with other coordinators
   │  └─ Deterministic assignment per subscriber
   └─ Each coordinator delivers to assigned subscribers

6. Return to client
   └─ {success: true, messageID, deliveredTo: count}
```

### Subscription Renewal Flow

Subscriptions expire after TTL (default 30 minutes). Clients can renew before expiry using signature-based authentication:

```
1. Client Application
   ↓ renew(topicID, newTTL) - triggered before subscription expires

2. Client signs renewal request
   ├─ Create renewal payload: {topicID, clientID, timestamp, newTTL}
   └─ Sign with node's private key: signature = sign(payload, privateKey)

3. findNode(topicID)
   ↓ returns k-closest nodes

4. Contact first reachable node (becomes initiator)
   ↓ RENEW_SUBSCRIPTION message {topicID, clientID, timestamp, newTTL, signature}

5. Initiator Node
   ├─ Verify signature
   │  ├─ Extract public key from clientID (DHT node ID)
   │  ├─ Verify signature matches payload
   │  └─ Reject if signature invalid
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
  if (!crypto.verify(payload, signature, publicKey)) {
    throw new Error('Invalid signature - renewal request rejected');
  }

  return true;
}
```

**Advantages of Signature-Based Renewal:**
- ✅ No token generation/storage needed
- ✅ Leverages existing DHT node signature infrastructure
- ✅ More secure (tied to node's private key, can't be forged)
- ✅ Timestamp-based replay protection
- ✅ Cleaner API (no token management)
- ✅ Works even if coordinator nodes change (no stored token state)

### Coordinator Replication

```
Initiator Node → Replicate to n closest nodes

1. findNode(topicID)
   ↓ Get n closest nodes

2. For each of n closest nodes:
   ├─ Send REPLICATE_COORDINATOR message
   │  └─ {topicID, coordinator, version, signature}
   │
   └─ Recipient checks version:
      ├─ recipient.version < incoming.version
      │  └─ Accept: Store new coordinator
      │
      ├─ recipient.version == incoming.version
      │  └─ Ignore: Already have this version
      │
      └─ recipient.version > incoming.version
         └─ Reply: Send newer version back to initiator
```

### Conflict Resolution via History

```
Scenario: Two nodes update coordinator simultaneously

Node A:                          Node B:
version 100                      version 100
subscriberHistory: [ID1, ID2]    subscriberHistory: [ID1, ID2]
messageHistory: [ID3, ID4]       messageHistory: [ID3, ID4]
     ↓                                ↓
Update: add subscriber          Update: publish message
version 101                      version 101
subscriberHistory: [..., ID5]    subscriberHistory: [ID1, ID2]
messageHistory: [ID3, ID4]       messageHistory: [..., ID6]
     ↓                                ↓
Replicate to n nodes            Replicate to n nodes

Result: Some nodes have A's v101, some have B's v101

Resolution:
1. Node C receives both versions (both version 101)
2. Node C detects conflict (same version, different content)
3. Node C merges using histories:
   ├─ A's subscriberHistory: [ID1, ID2, ID5]
   ├─ B's subscriberHistory: [ID1, ID2]
   ├─ A's messageHistory: [ID3, ID4]
   └─ B's messageHistory: [ID3, ID4, ID6]

4. Merge algorithm:
   ├─ Merge subscriberHistory: union of both = [ID1, ID2, ID5]
   ├─ Merge messageHistory: union of both = [ID3, ID4, ID6]
   └─ Take most recent collection ID from each history

5. Create unified coordinator:
   ├─ version = 102 (max + 1)
   ├─ currentSubscribers = ID5 (from A's update)
   ├─ currentMessages = ID6 (from B's update)
   ├─ subscriberHistory = [ID1, ID2, ID5]
   └─ messageHistory = [ID3, ID4, ID6]

6. Replicate unified version to all n nodes
```

## Data Structures

### Coordinator Object

```javascript
{
  topicID: string,                    // Topic identifier
  version: number,                    // Monotonic version counter
  currentSubscribers: string | null,  // DHT ID of current subscriber collection
  currentMessages: string | null,     // DHT ID of current message collection

  // Two separate histories tracking collection IDs
  subscriberHistory: string[],        // Array of subscriber collection IDs (oldest to newest)
  messageHistory: string[],           // Array of message collection IDs (oldest to newest)

  createdAt: timestamp,               // When topic was created
  lastModified: timestamp             // Last update time
}
```

**History Arrays Explained:**
- Each array tracks the lineage of collection IDs
- Newest collection ID is at the end of array
- Used for merging conflicts: union of both histories
- Limited size (e.g., keep last 100 IDs) to prevent unbounded growth
- Older entries can be pruned as needed (history maintained in coordinator only)

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
      metadata: {                    // Optional subscriber metadata
        tags?: string[],
        filters?: object
      }
    }
  ],
  version: number,                   // Matches coordinator version
  createdAt: timestamp,
  expiresAt: timestamp               // Collection expiry (max of all subscriber expiries)
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
      publishedAt: timestamp,        // Publication time
      expiresAt: timestamp,          // Message expiry
      size: number,                  // Message size in bytes (for lazy loading)
      metadata: {                    // Optional message metadata
        priority?: number,
        tags?: string[]
      }
    }
  ],
  version: number,                   // Matches coordinator version
  createdAt: timestamp,
  expiresAt: timestamp               // Collection expiry (max of all message expiries)
}
```

### Individual Message

```javascript
{
  messageID: string,                 // Unique message identifier
  topicID: string,                   // Parent topic
  data: any,                         // Actual message payload (JSON)
  publishedAt: timestamp,            // Publication time
  expiresAt: timestamp,              // When message expires
  publisher: string,                 // Publishing node ID (optional)
  signature: string                  // Cryptographic signature (optional)
}
```

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

## Garbage Collection

### When to Clean Up

**Coordinator Cleanup Triggers:**
- All subscribers expired (all `expiresAt < now`)
- All messages expired (all `expiresAt < now`)
- No activity for extended period (e.g., 7 days)

**Cleanup Process:**
```javascript
function shouldGarbageCollect(coordinator) {
  // Load current collections
  const subscriberCollection = await dht.get(coordinator.currentSubscribers);
  const messageCollection = await dht.get(coordinator.currentMessages);

  // Check if all subscribers expired
  const hasActiveSubscribers = subscriberCollection?.subscribers.some(
    sub => sub.expiresAt > Date.now()
  );

  // Check if all messages expired
  const hasActiveMessages = messageCollection?.messages.some(
    msg => msg.expiresAt > Date.now()
  );

  // Garbage collect if both are inactive
  return !hasActiveSubscribers && !hasActiveMessages;
}

async function garbageCollect(topicID) {
  // Delete coordinator from all n closest nodes
  const closestNodes = await dht.findNode(topicID);

  for (const nodeID of closestNodes) {
    await dht.sendMessage(nodeID, {
      type: 'delete_coordinator',
      topicID: topicID
    });
  }

  // Note: Collections and messages will be cleaned up by DHT TTL expiry
}
```

### Lazy Cleanup Strategy

Instead of periodic cleanup scans, piggyback on normal operations:

```javascript
async function subscribe(topicID, clientID) {
  const coordinator = await loadOrCreateCoordinator(topicID);

  // Lazy cleanup: Remove expired subscribers during normal operation
  const subscriberCollection = await dht.get(coordinator.currentSubscribers);
  const activeSubscribers = subscriberCollection.subscribers.filter(
    sub => sub.expiresAt > Date.now()
  );

  // If expired subscribers were removed, create new collection
  if (activeSubscribers.length < subscriberCollection.subscribers.length) {
    subscriberCollection.subscribers = activeSubscribers;
    // Update collections and coordinator...
  }

  // Continue with subscribe operation...
}
```

### History Pruning

Keep history arrays bounded to prevent unbounded growth:

```javascript
function pruneHistory(coordinator) {
  const MAX_HISTORY_LENGTH = 100;

  // Keep last 100 subscriber collection IDs
  if (coordinator.subscriberHistory.length > MAX_HISTORY_LENGTH) {
    coordinator.subscriberHistory = coordinator.subscriberHistory.slice(-MAX_HISTORY_LENGTH);
  }

  // Keep last 100 message collection IDs
  if (coordinator.messageHistory.length > MAX_HISTORY_LENGTH) {
    coordinator.messageHistory = coordinator.messageHistory.slice(-MAX_HISTORY_LENGTH);
  }
}
```

## Implementation Phases

### Phase 1: Core Data Structures (1-2 days)
- [ ] Create `CoordinatorObject` class with dual histories
- [ ] Create `SubscriberCollection` class (immutable)
- [ ] Create `MessageCollection` class (immutable)
- [ ] Create `Message` class
- [ ] Add DHT storage/retrieval methods
- [ ] Unit tests for serialization/deserialization

### Phase 2: Basic Subscribe/Publish (2-3 days)
- [ ] Implement `subscribe(topicID, clientID)` method
- [ ] Implement `publish(topicID, messageData)` method
- [ ] Implement coordinator creation and updates
- [ ] Implement copy-on-write collection updates
- [ ] Add coordinator replication to n nodes
- [ ] Integration tests for basic pub/sub

### Phase 3: Message Delivery (2-3 days)
- [ ] Implement deterministic subscriber assignment
- [ ] Add coordinator-to-coordinator coordination protocol
- [ ] Implement message pushing to subscribers
- [ ] Add bootstrap subscriber flow (historical messages)
- [ ] Handle delivery failures and retries
- [ ] Integration tests for message delivery

### Phase 4: Conflict Resolution (1-2 days)
- [ ] Implement history-based merging (union of collection ID arrays)
- [ ] Add version conflict detection
- [ ] Handle concurrent updates gracefully
- [ ] Implement history pruning (bounded arrays)
- [ ] Unit tests for conflict scenarios

### Phase 5: Garbage Collection (1-2 days)
- [ ] Implement lazy cleanup during operations
- [ ] Add coordinator deletion when topic inactive
- [ ] Implement subscription renewal mechanism
- [ ] Add expired message/subscriber filtering
- [ ] Integration tests for cleanup

### Phase 6: Optimization & Advanced Features (2-3 days)
- [ ] Implement lazy loading of messages (IDs only in collection)
- [ ] Add message batching for efficiency
- [ ] Implement collection pagination for large subscriber lists
- [ ] Add subscription filters/tags
- [ ] Add message priority queues
- [ ] Performance testing and optimization

### Phase 7: API & Documentation (1-2 days)
- [ ] Create high-level API wrapper
- [ ] Add browser/Node.js examples
- [ ] Write API documentation
- [ ] Create usage guide
- [ ] Add debugging tools

**Total Estimated Time**: 10-15 days

## API Design

### High-Level API

```javascript
// Subscribe to a topic
const subscription = await pubsub.subscribe('chat-room-42', {
  onMessage: (message) => {
    console.log('Received:', message.data);
  },
  ttl: 30 * 60 * 1000,  // 30 minutes
  receiveHistory: true   // Receive all non-expired messages
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

// Renew subscription (before expiry) - uses signature-based authentication
await subscription.renew(30 * 60 * 1000);  // Automatically signs with node's private key
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

// Manual message delivery
await stickyPubSub.deliverMessage(messageID, subscriberID);

// Manual conflict resolution
const unified = await stickyPubSub.mergeCoordinators(coordA, coordB);

// Manual renewal with signature
const renewalPayload = {
  topicID: 'chat-room-42',
  clientID: myNodeID,
  timestamp: Date.now(),
  newTTL: 30 * 60 * 1000
};
const signature = await crypto.sign(
  `${renewalPayload.topicID}:${renewalPayload.clientID}:${renewalPayload.timestamp}:${renewalPayload.newTTL}`,
  myPrivateKey
);
await stickyPubSub.renewSubscription({...renewalPayload, signature});
```

## Cryptographic Identity Requirement

### Node ID as Public Key Hash

**Requirement:** All nodes participating in Sticky Pub/Sub MUST have cryptographic identities.

```javascript
// Node identity generation
const keyPair = await crypto.subtle.generateKey(
  {name: "ECDSA", namedCurve: "P-256"},
  true,
  ["sign", "verify"]
);

const publicKeyJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
const publicKeyBytes = encodePublicKey(publicKeyJwk);
const nodeId = sha256(publicKeyBytes).substring(0, 40); // 160-bit Kademlia ID
```

**Why This Is Required:**
- Subscription renewal uses signature-based authentication
- Node ID must be verifiable against public key
- Prevents identity spoofing and unauthorized renewals
- Standard pattern used by IPFS, Ethereum, etc.

---

### Bootstrap Authentication Flow

When connecting to the DHT network, nodes must prove ownership of their private key:

```
1. Client → Bootstrap: CONNECT {nodeId, publicKey}

2. Bootstrap validates:
   ├─ Verify: hash(publicKey) == nodeId
   └─ If invalid → reject connection

3. Bootstrap → Client: CHALLENGE {nonce, timestamp}

4. Client signs challenge:
   ├─ payload = nonce + ":" + timestamp + ":" + nodeId
   ├─ signature = sign(payload, privateKey)
   └─ Client → Bootstrap: CHALLENGE_RESPONSE {signature}

5. Bootstrap verifies:
   ├─ Verify signature against publicKey
   ├─ Check timestamp freshness (< 30 seconds old)
   ├─ If valid → add to DHT with verified status
   └─ If invalid → reject connection

6. Client receives: CONNECTION_ACCEPTED {nodeId, verified: true}
```

**Security Properties:**
- ✅ Proves client has access to private key
- ✅ Prevents replay attacks (timestamp check)
- ✅ Prevents man-in-the-middle (signature verification)
- ✅ No long-lived tokens to steal

---

### Private Key Storage

**Browser Applications:**

Store cryptographic keys in IndexedDB for persistence:

```javascript
// Storage structure
{
  privateKey: JWK,      // Ed25519 or ECDSA P-256 private key
  publicKey: JWK,       // Corresponding public key
  nodeId: string,       // Derived from publicKey hash
  createdAt: timestamp,
  lastUsed: timestamp
}
```

**Recommendations:**
- Use Web Crypto API (`crypto.subtle`) for key generation
- Store in IndexedDB (persistent across sessions)
- Consider encryption with user password for high-security applications
- Provide export/backup functionality for users
- Never transmit private key over network

**Node.js Applications:**

Store keys in encrypted file with restricted permissions:

```javascript
// ~/.yz-network/identity.json (chmod 600)
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

**First Run:**
```javascript
// Generate new identity
if (!await identityStore.exists()) {
  const identity = await generateIdentity();
  await identityStore.save(identity);
  console.log('New identity created:', identity.nodeId);
}
```

**Subsequent Runs:**
```javascript
// Load existing identity
const identity = await identityStore.load();
await dht.connect(identity);
```

**Backup/Export:**
```javascript
// Export identity for backup
const backup = await identityStore.export();
// backup = {privateKey, publicKey, nodeId}
// User should store securely (password manager, encrypted file)
```

**Import/Restore:**
```javascript
// Restore identity from backup
await identityStore.import(backup);
```

---

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
- Application can encrypt messages client-side
- Coordinator metadata is public

## Advantages of This Design

✅ **Fully Decentralized**: No central message broker or coordinator
✅ **Fault Tolerant**: Replicated coordinators, no single point of failure
✅ **Scalable**: O(log N) lookups, deterministic load balancing
✅ **Message Persistence**: New subscribers receive historical messages
✅ **Conflict Resistant**: History-based merge handles concurrent updates
✅ **Automatic Cleanup**: Lazy garbage collection, time-based expiry
✅ **DHT-Native**: Built entirely on existing DHT primitives
✅ **Flexible TTL**: Per-message and per-subscriber expiry
✅ **No Duplicates**: Deterministic assignment prevents duplicate delivery
✅ **Simple Merge**: Collection ID histories merge via set union

## Limitations and Trade-offs

### 1. Message Ordering

**Issue**: No global message ordering across publishers

**Mitigation**:
- Use `publishedAt` timestamp for approximate ordering
- Application can add sequence numbers if strict ordering needed
- Single-publisher topics have natural ordering

### 2. Delivery Guarantees

**Issue**: Fire-and-forget delivery (at-most-once semantics)

**Mitigation**:
- No built-in acknowledgments (future enhancement)
- Application can implement retries if needed
- Coordinator tracks delivery attempts

### 3. Coordinator Conflicts

**Issue**: Concurrent updates can create temporary inconsistency

**Mitigation**:
- History-based merge resolves conflicts
- Version numbers detect conflicts
- All coordinators eventually converge

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

## Future Enhancements

### 1. Acknowledgment-Based Delivery

Upgrade from fire-and-forget to at-least-once delivery:

```javascript
{
  messageID: string,
  deliveryStatus: {
    'subscriber-001': {status: 'delivered', timestamp: T1},
    'subscriber-002': {status: 'pending', attempts: 2},
    'subscriber-003': {status: 'failed', lastAttempt: T2}
  }
}
```

### 2. Message Ordering Guarantees

Add per-publisher sequence numbers:

```javascript
{
  messageID: string,
  publisherID: string,
  sequenceNumber: 142,  // Monotonic per publisher
  previousMessageID: string  // Chain messages
}
```

### 3. Topic Hierarchies

Support topic namespaces:

```
/app/chat/room-42/messages
/app/chat/room-42/presence
/app/notifications/urgent
/app/notifications/normal
```

### 4. Subscription Filters

Filter messages at coordinator level:

```javascript
subscribe('sensor-data', {
  filter: {
    sensorType: 'temperature',
    value: {$gt: 25}
  }
});
```

### 5. Priority Queues

Deliver high-priority messages first:

```javascript
publish(topicID, data, {priority: 10});
```

### 6. Dead Letter Queue

Store undeliverable messages:

```javascript
{
  messageID: string,
  failureReason: 'subscriber_unreachable',
  attempts: 5,
  lastAttempt: timestamp
}
```

## Testing Strategy

### Unit Tests
- Coordinator serialization/deserialization
- Collection copy-on-write operations
- History array merging (union of IDs)
- Deterministic assignment algorithm
- Expiry filtering

### Integration Tests
- Basic subscribe/publish flow
- Historical message delivery to new subscribers
- Concurrent updates and conflict resolution
- Subscription renewal
- Garbage collection

### Performance Tests
- 1000 subscribers per topic
- 10,000 messages per topic
- 1000 concurrent topics
- Message delivery latency
- Coordinator replication overhead

### Chaos Tests
- Node failures during operations
- Network partitions
- Concurrent conflicting updates
- Clock skew between nodes

## Related Documentation

- **Kademlia DHT**: Base protocol for storage and routing
- **CRDTs**: Conflict-free replicated data types (similar merge strategy)
- **Pub/Sub Patterns**: Traditional messaging patterns
- **Vector Clocks**: Alternative conflict resolution mechanism

## Open Questions

1. **What's the optimal n for coordinator replication?** Current proposal: k nodes (same as DHT replication factor)
2. **Should we support topic wildcards?** e.g., subscribe to "chat/*"
3. **How to handle very large messages?** Chunking? Separate storage?
4. **Should subscription be cryptographically signed?** Prevent impersonation
5. **What's the message size limit?** Balance usability vs DHT efficiency
6. **Should coordinators cache hot topics?** Reduce DHT lookups for popular topics
7. **How long to keep history arrays?** Balance merge accuracy vs coordinator size

## Status

**Current Status**: Proposal stage - design complete, implementation not started

**Next Steps**:
1. Review and refine data structures
2. Implement Phase 1 (core data structures with dual histories)
3. Add basic DHT integration
4. Build minimal subscribe/publish prototype
5. Test with multi-node local network
6. Iterate based on performance/issues

**Last Updated**: 2025-01-24
