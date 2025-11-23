# Multi-Tier Encryption Architecture - Addendum

**Date:** 2025-01-22
**Status:** Draft - Extension to security-and-connectivity.md
**Purpose:** Address multiple data access patterns in YZ Network DHT

---

## Overview

The original proposal covered only **user-owned private data**. However, YZ Network requires three distinct encryption patterns:

1. **User-Owned Private Data** - Only owner can decrypt (original proposal)
2. **Public DHT Data with Transport Encryption** - Accessible to all DHT members, encrypted hop-by-hop during transport
3. **Group-Shared Data** - Multiple users need access (channels, topics, shared resources)

This addendum extends the encryption proposal to support all three patterns.

---

## Table of Contents

1. [Data Classification](#data-classification)
2. [Pattern 1: User-Owned Private Data](#pattern-1-user-owned-private-data)
3. [Pattern 2: Transport-Encrypted Public Data](#pattern-2-transport-encrypted-public-data)
4. [Pattern 3: Group-Shared Data](#pattern-3-group-shared-data)
5. [Implementation Architecture](#implementation-architecture)
6. [API Design](#api-design)
7. [Integration with distributed-security](#integration-with-distributed-security)

---

## Data Classification

### Three Data Types in YZ Network

| Data Type | Accessibility | Transport Security | Storage Security | Example Use Cases |
|-----------|--------------|-------------------|------------------|-------------------|
| **User-Private** | Owner only | End-to-end encrypted | Encrypted at rest | Personal settings, private notes |
| **Public DHT** | All DHT members | Hop-by-hop encrypted | Plaintext or signed | Routing data, public posts, network metadata |
| **Group-Shared** | Group members | End-to-end encrypted | Encrypted for group | Channels, topics, team documents |

### Security Goals by Type

**User-Private:**
- ✅ Only owner can decrypt content
- ✅ Even DHT storage nodes can't read
- ✅ Zero-knowledge storage
- ✅ Multi-device sync (same user)

**Public DHT:**
- ✅ All DHT members can access
- ✅ Network observers can't sniff (WS transport protection)
- ✅ Prevents MITM tampering
- ✅ Authenticity verification (signatures)
- ❌ NOT confidential (members can read)

**Group-Shared:**
- ✅ Group members can decrypt
- ✅ Non-members cannot access
- ✅ Membership changes don't require re-encryption
- ✅ Hierarchical groups (teams within teams)
- ✅ Multi-device per member

---

## Pattern 1: User-Owned Private Data

### Architecture (From Original Proposal)

**Already covered in main proposal** - End-to-end encryption with user's key:

```javascript
// Encrypt for storage
const encrypted = await encrypt(data, userPrivateKey);
await dht.store(key, encrypted);

// Decrypt after retrieval
const encrypted = await dht.get(key);
const plaintext = await decrypt(encrypted, userPrivateKey);
```

**Key Properties:**
- AES-256-GCM encryption
- Key derived from user's ECDSA identity
- ECDSA signatures for authenticity
- Multi-device via key sync (IndexedDB)

**No changes needed** - Original proposal covers this pattern.

---

## Pattern 2: Transport-Encrypted Public Data

### Problem Statement

**Scenario:** DHT routing data, public posts, network metadata
- Should be **accessible to all DHT members** (public information)
- Should be **protected during transport** (prevent ISP/network snooping)
- Should be **tamper-proof** (prevent MITM attacks)

**Current Issue with WS-only transport:**
- Data transmitted in plaintext over WebSocket
- ISPs, network operators can read content
- Man-in-the-middle can modify data

**Why not just use WSS?**
- Community nodes can't get TLS certificates
- Not all hops use WSS (Node.js ↔ Node.js uses WS)

### Proposed Solution: Hop-by-Hop Re-Encryption

**Concept:** Encrypt data for each hop in the routing path

```
Node A (source) → Node B → Node C → Node D (destination)

1. A encrypts with B's public key → sends to B
2. B decrypts with B's private key → sees plaintext
3. B encrypts with C's public key → sends to C
4. C decrypts with C's private key → sees plaintext
5. C encrypts with D's public key → sends to D
6. D decrypts with D's private key → final plaintext
```

**Benefits:**
- ✅ Network observers can't read (encrypted in transit)
- ✅ Each hop verifies sender authenticity
- ✅ Works over WS (no TLS required)
- ✅ Prevents passive ISP monitoring

**Trade-offs:**
- ⚠️ Intermediate nodes see plaintext (not end-to-end)
- ⚠️ Adds latency (decrypt/encrypt at each hop)
- ⚠️ Malicious DHT nodes can read/modify
- ⚠️ More CPU overhead

### Implementation

#### Message Envelope Structure

```javascript
class TransportEncryptedMessage {
  constructor(payload, nextHop, senderPrivateKey, recipientPublicKey) {
    this.version = 1;
    this.type = 'transport_encrypted';
    this.sender = senderNodeId;
    this.recipient = recipientNodeId;
    this.encrypted = this.encrypt(payload, recipientPublicKey);
    this.signature = this.sign(this.encrypted, senderPrivateKey);
  }

  async encrypt(payload, recipientPublicKey) {
    // ECIES (Elliptic Curve Integrated Encryption Scheme)
    // 1. Generate ephemeral ECDH key pair
    const ephemeralKey = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveKey"]
    );

    // 2. Derive shared secret with recipient's public key
    const sharedSecret = await crypto.subtle.deriveKey(
      { name: "ECDH", public: recipientPublicKey },
      ephemeralKey.privateKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt"]
    );

    // 3. Encrypt payload with shared secret
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      sharedSecret,
      payload
    );

    return {
      ephemeralPublicKey: await crypto.subtle.exportKey("jwk", ephemeralKey.publicKey),
      iv: base64(iv),
      ciphertext: base64(ciphertext)
    };
  }

  async decrypt(encrypted, recipientPrivateKey) {
    // 1. Import ephemeral public key
    const ephemeralPubKey = await crypto.subtle.importKey(
      "jwk",
      encrypted.ephemeralPublicKey,
      { name: "ECDH", namedCurve: "P-256" },
      false,
      []
    );

    // 2. Derive same shared secret
    const sharedSecret = await crypto.subtle.deriveKey(
      { name: "ECDH", public: ephemeralPubKey },
      recipientPrivateKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"]
    );

    // 3. Decrypt payload
    return await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unbase64(encrypted.iv) },
      sharedSecret,
      unbase64(encrypted.ciphertext)
    );
  }
}
```

#### DHT Message Routing with Re-Encryption

```javascript
class RoutingTable {
  async forwardMessage(message, targetNodeId) {
    // 1. Determine next hop
    const nextHop = this.getClosestNode(targetNodeId);

    if (!nextHop) {
      throw new Error('No route to target');
    }

    // 2. If message is transport-encrypted, re-encrypt for next hop
    if (message.type === 'transport_encrypted') {
      // Decrypt with our private key
      const payload = await this.decryptTransportMessage(
        message,
        this.localPrivateKey
      );

      // Verify sender signature
      if (!await this.verifySignature(message)) {
        throw new Error('Invalid message signature');
      }

      // Re-encrypt for next hop
      const reencrypted = new TransportEncryptedMessage(
        payload,
        nextHop.id,
        this.localPrivateKey,
        nextHop.publicKey
      );

      // Forward to next hop
      await nextHop.sendMessage(reencrypted);
    } else {
      // Regular message, just forward
      await nextHop.sendMessage(message);
    }
  }
}
```

#### API Usage

```javascript
// Send public data with transport encryption
await dht.storePublic(key, value, {
  transportEncryption: true,  // Enable hop-by-hop encryption
  ttl: 3600
});

// Retrieve public data (automatic decryption)
const value = await dht.getPublic(key);
// Value is accessible to all DHT members
```

### Security Analysis

**Protected Against:**
- ✅ ISP/network eavesdropping (passive monitoring)
- ✅ WiFi snooping attacks
- ✅ Traffic analysis (content level)
- ✅ Unauthorized modification (signatures verify authenticity)

**NOT Protected Against:**
- ❌ Malicious DHT nodes (they see plaintext at their hop)
- ❌ Compromised routing nodes
- ❌ Colluding nodes in routing path

**When to Use:**
- Public DHT metadata (accessible to members anyway)
- Routing information
- Network announcements
- Data that's public but shouldn't be sniffed by non-members

**When NOT to Use:**
- Sensitive user data → Use Pattern 1 (User-Private)
- Group-private data → Use Pattern 3 (Group-Shared)

### Performance Considerations

**Overhead per Hop:**
- ECDH key derivation: ~5ms
- AES-GCM encrypt/decrypt: ~1ms
- Signature verify: ~3ms
- **Total: ~9ms per hop**

**Example Routing Path (5 hops):**
- Source → Hop1 → Hop2 → Hop3 → Hop4 → Destination
- Total overhead: 5 hops × 9ms = **~45ms**
- Acceptable for DHT operations (store/get)

**Optimization:**
- Cache derived keys (same source-destination pair)
- Use session keys (valid for N messages)
- Batch messages when possible

---

## Pattern 3: Group-Shared Data

### Problem Statement

**Use Cases:**
- **Channels/Topics:** Multiple users subscribe to a topic, all can read/write
- **Team Documents:** Shared files, collaborative editing
- **Group Messaging:** Private group chats
- **Organizational Data:** Department-wide shared resources

**Requirements:**
- ✅ Only group members can decrypt
- ✅ Add/remove members without re-encrypting all data
- ✅ Hierarchical groups (teams within teams)
- ✅ Multi-device support per member
- ✅ No centralized key management

### Proposed Solution: distributed-security Integration

**Library:** [kilroy-code/distributed-security](https://github.com/kilroy-code/distributed-security)

**Key Features:**
- **Team-based encryption:** Groups share keys cryptographically
- **No centralized custody:** Keys distributed across member devices
- **Membership changes:** Re-encrypt team keys automatically
- **Multi-device:** Each device has own keys, can access team keys
- **Recovery mechanisms:** Security questions for key recovery
- **Standard protocols:** JOSE (JWE, JWS)

### Architecture Overview

```
┌─────────────────────────────────────────────────┐
│ Application Layer                               │
│  - Create channel/topic                         │
│  - Add/remove members                           │
│  - Publish/subscribe to group data              │
└────────────────┬────────────────────────────────┘
                 │
┌────────────────▼────────────────────────────────┐
│ distributed-security Layer                      │
│  - Team key management                          │
│  - Member encryption/decryption                 │
│  - Automatic re-keying on membership change     │
└────────────────┬────────────────────────────────┘
                 │
┌────────────────▼────────────────────────────────┐
│ DHT Storage Layer                               │
│  - Store encrypted team data                    │
│  - Store encrypted team keys                    │
│  - Store member lists (encrypted)               │
└────────────────┬────────────────────────────────┘
                 │
┌────────────────▼────────────────────────────────┐
│ Transport Layer (with Pattern 2 encryption)     │
└─────────────────────────────────────────────────┘
```

### Implementation

#### Team Creation and Management

```javascript
import { Team } from '@kilroy-code/distributed-security';

class GroupEncryption {
  async createGroup(groupName, members) {
    // 1. Create team with distributed-security
    const team = await Team.create({
      tag: `group:${groupName}`,
      name: groupName,
      memberTags: members.map(m => `user:${m.nodeId}`)
    });

    // 2. Store team metadata in DHT
    await this.dht.store(`team:${groupName}:metadata`, {
      name: groupName,
      created: Date.now(),
      teamTag: team.tag
    });

    // 3. Return team reference
    return team;
  }

  async addMember(groupName, newMemberNodeId) {
    // 1. Load team
    const team = await Team.load(`group:${groupName}`);

    // 2. Add member (auto re-encrypts team keys)
    await team.changeMembership({
      add: [`user:${newMemberNodeId}`]
    });

    // 3. Update metadata in DHT
    await this.updateGroupMetadata(groupName);
  }

  async removeMember(groupName, memberNodeId) {
    const team = await Team.load(`group:${groupName}`);

    await team.changeMembership({
      remove: [`user:${memberNodeId}`]
    });

    await this.updateGroupMetadata(groupName);
  }
}
```

#### Encrypting/Decrypting Group Data

```javascript
class GroupDataStorage {
  async storeGroupData(groupName, key, data) {
    // 1. Load team
    const team = await Team.load(`group:${groupName}`);

    // 2. Encrypt data with team key (JWE format)
    const encrypted = await team.encrypt(data, {
      team: `group:${groupName}`
    });

    // 3. Store encrypted data in DHT
    const storageKey = `group:${groupName}:data:${key}`;
    await this.dht.store(storageKey, encrypted);

    return storageKey;
  }

  async getGroupData(groupName, key) {
    // 1. Retrieve encrypted data from DHT
    const storageKey = `group:${groupName}:data:${key}`;
    const encrypted = await this.dht.get(storageKey);

    // 2. Load team
    const team = await Team.load(`group:${groupName}`);

    // 3. Decrypt with team key
    const decrypted = await team.decrypt(encrypted);

    return decrypted;
  }
}
```

#### PubSub with Group Encryption

```javascript
class GroupPubSub {
  async publish(topicName, message) {
    // 1. Get topic's team
    const team = await Team.load(`topic:${topicName}`);

    // 2. Encrypt message for team members
    const encrypted = await team.encrypt(message, {
      team: `topic:${topicName}`
    });

    // 3. Publish encrypted message to DHT
    await this.pubsub.publish(topicName, encrypted);
  }

  async subscribe(topicName, handler) {
    // 1. Get topic's team (verifies membership)
    const team = await Team.load(`topic:${topicName}`);

    // 2. Subscribe with decryption wrapper
    await this.pubsub.subscribe(topicName, async (encryptedMsg) => {
      // Decrypt message
      const plaintext = await team.decrypt(encryptedMsg);

      // Call user's handler with plaintext
      handler(plaintext);
    });
  }
}
```

### Hierarchical Teams

**Example: Organization with Departments**

```javascript
// Create organization team
const org = await Team.create({
  tag: 'team:acme-corp',
  name: 'ACME Corporation'
});

// Create department teams (children of org)
const engineering = await Team.create({
  tag: 'team:acme-corp:engineering',
  name: 'Engineering Department',
  memberTags: [
    'user:alice',
    'user:bob'
  ],
  parentTeam: 'team:acme-corp'  // Hierarchical relationship
});

const sales = await Team.create({
  tag: 'team:acme-corp:sales',
  name: 'Sales Department',
  memberTags: [
    'user:charlie',
    'user:diana'
  ],
  parentTeam: 'team:acme-corp'
});

// Org-wide data (accessible to all departments)
await org.encrypt(orgWideData);

// Department-specific data
await engineering.encrypt(engineeringData);  // Only eng can decrypt
await sales.encrypt(salesData);              // Only sales can decrypt
```

### Multi-Device Support

**Scenario:** User has laptop + phone, both should access group data

```javascript
// On laptop (primary device)
const userTag = 'user:alice';
const laptopTag = 'device:alice:laptop';
const phoneTag = 'device:alice:phone';

// Create user team with multiple devices
const alice = await Team.create({
  tag: userTag,
  name: 'Alice',
  memberTags: [laptopTag, phoneTag]
});

// Now both devices can decrypt user-specific data
// When alice joins a group, all her devices get access
await engineeringTeam.changeMembership({
  add: [userTag]  // Adds alice (and implicitly all her devices)
});
```

### Security Properties

**Cryptographic Guarantees:**
- ✅ **Confidentiality:** Only group members can decrypt
- ✅ **Authenticity:** JWS signatures verify message source
- ✅ **Membership Control:** Cryptographically enforced
- ✅ **Forward Secrecy:** Removing member prevents future access
- ⚠️ **Backward Secrecy:** Removed members keep previously accessed data (re-encrypt needed for true backward secrecy)

**Threat Model Protection:**

| Attack | Protected? | Notes |
|--------|-----------|-------|
| Non-member eavesdropping | ✅ Yes | Cannot decrypt team-encrypted data |
| Compromised DHT node | ✅ Yes | Sees encrypted blobs only |
| Removed member access | ⚠️ Partial | Can't decrypt NEW data, but keeps old data they accessed |
| Malicious member leaking data | ❌ No | Authorized members can always leak (inherent to group sharing) |
| Key recovery by attacker | ✅ Yes | Requires security question answers + salt |

### Integration with distributed-security

**Installation:**

```bash
npm install @kilroy-code/distributed-security
```

**Dependencies:**
- Standard JOSE protocols (JWE, JWS)
- panva library for cryptographic operations
- Browser indexedDB for key storage
- Cloud storage for encrypted key backup (optional)

**Configuration:**

```javascript
import { Team, Device } from '@kilroy-code/distributed-security';

// Initialize user's device
const myDevice = await Device.create({
  tag: `device:${nodeId}:${deviceId}`,
  recovery: {
    questions: ['What is your favorite color?', 'Pet name?'],
    answers: await hashAnswers(['blue', 'fluffy'])
  }
});

// Store device keys in IndexedDB
await myDevice.persist();
```

**API Reference:**
- `Team.create()` - Create new team/group
- `Team.load()` - Load existing team
- `team.encrypt(data)` - Encrypt for team members
- `team.decrypt(encrypted)` - Decrypt team data
- `team.changeMembership()` - Add/remove members
- `team.sign(data)` - Sign data as team
- `team.verify(signature)` - Verify team signature

---

## Implementation Architecture

### Unified Encryption Layer

```javascript
class UnifiedEncryption {
  constructor(dht, identityStore) {
    this.dht = dht;
    this.identityStore = identityStore;

    // Pattern 1: User-private encryption
    this.userEncryption = new UserPrivateEncryption(identityStore);

    // Pattern 2: Transport encryption
    this.transportEncryption = new TransportEncryption(identityStore);

    // Pattern 3: Group encryption
    this.groupEncryption = new GroupEncryption(identityStore);
  }

  async store(key, value, options = {}) {
    const {
      type = 'private',        // 'private' | 'public' | 'group'
      transportSecurity = true, // Enable hop-by-hop encryption
      group = null,            // Group name (if type='group')
      ttl = 3600
    } = options;

    let encryptedValue;

    // Encrypt based on type
    switch (type) {
      case 'private':
        // Pattern 1: User-owned private data
        encryptedValue = await this.userEncryption.encrypt(value);
        break;

      case 'public':
        // Pattern 2: Public data (may use transport encryption)
        if (transportSecurity) {
          // Store with transport encryption enabled
          // (encryption happens during routing, not here)
          encryptedValue = value;
        } else {
          // Store plaintext (signed for authenticity)
          encryptedValue = await this.signOnly(value);
        }
        break;

      case 'group':
        // Pattern 3: Group-shared data
        if (!group) throw new Error('Group name required for group data');
        encryptedValue = await this.groupEncryption.encrypt(group, value);
        break;

      default:
        throw new Error(`Unknown encryption type: ${type}`);
    }

    // Store in DHT with transport encryption if enabled
    return await this.dht.store(key, encryptedValue, {
      transportEncryption: transportSecurity,
      ttl
    });
  }

  async get(key, options = {}) {
    const {
      type = 'private',
      group = null
    } = options;

    // Retrieve from DHT (auto-decrypts transport encryption)
    const encryptedValue = await this.dht.get(key);

    // Decrypt based on type
    switch (type) {
      case 'private':
        return await this.userEncryption.decrypt(encryptedValue);

      case 'public':
        // Verify signature, return plaintext
        return await this.verifyAndExtract(encryptedValue);

      case 'group':
        if (!group) throw new Error('Group name required for group data');
        return await this.groupEncryption.decrypt(group, encryptedValue);

      default:
        throw new Error(`Unknown encryption type: ${type}`);
    }
  }
}
```

### Usage Examples

```javascript
// Pattern 1: Store private user data
await dht.store('user:alice:settings', mySettings, {
  type: 'private'
});

// Pattern 2: Store public data with transport encryption
await dht.store('dht:routing:info', routingData, {
  type: 'public',
  transportSecurity: true  // Encrypted hop-by-hop
});

// Pattern 2: Store public data without transport encryption (signed only)
await dht.store('dht:public:announcement', announcement, {
  type: 'public',
  transportSecurity: false  // Just signed, no encryption
});

// Pattern 3: Store group-shared data
await dht.store('channel:general:message:123', message, {
  type: 'group',
  group: 'channel:general'
});
```

---

## API Design

### High-Level API

```javascript
class EnhancedDHTClient extends BrowserDHTClient {
  // === Pattern 1: User-Private Data ===

  async storePrivate(key, value, ttl) {
    return await this.encryption.store(key, value, {
      type: 'private',
      ttl
    });
  }

  async getPrivate(key) {
    return await this.encryption.get(key, { type: 'private' });
  }

  // === Pattern 2: Public Data ===

  async storePublic(key, value, options = {}) {
    return await this.encryption.store(key, value, {
      type: 'public',
      transportSecurity: options.transportSecurity ?? true,
      ttl: options.ttl
    });
  }

  async getPublic(key) {
    return await this.encryption.get(key, { type: 'public' });
  }

  // === Pattern 3: Group-Shared Data ===

  async createGroup(groupName, members) {
    return await this.encryption.groupEncryption.createGroup(
      groupName,
      members
    );
  }

  async storeGroupData(group, key, value, ttl) {
    return await this.encryption.store(key, value, {
      type: 'group',
      group,
      ttl
    });
  }

  async getGroupData(group, key) {
    return await this.encryption.get(key, {
      type: 'group',
      group
    });
  }

  async addGroupMember(group, memberNodeId) {
    return await this.encryption.groupEncryption.addMember(
      group,
      memberNodeId
    );
  }

  async removeGroupMember(group, memberNodeId) {
    return await this.encryption.groupEncryption.removeMember(
      group,
      memberNodeId
    );
  }
}
```

### PubSub Extensions

```javascript
class EnhancedPubSubClient extends PubSubClient {
  // Public topic (accessible to all, transport-encrypted)
  async publishPublic(topic, message) {
    const signed = await this.sign(message);
    return await super.publish(topic, signed, {
      transportEncryption: true
    });
  }

  async subscribePublic(topic, handler) {
    return await super.subscribe(topic, async (signed) => {
      const verified = await this.verify(signed);
      handler(verified);
    });
  }

  // Group topic (encrypted for group members)
  async publishGroup(groupName, topic, message) {
    const encrypted = await this.groupEncryption.encrypt(groupName, message);
    return await super.publish(`group:${groupName}:${topic}`, encrypted);
  }

  async subscribeGroup(groupName, topic, handler) {
    return await super.subscribe(`group:${groupName}:${topic}`, async (encrypted) => {
      const plaintext = await this.groupEncryption.decrypt(groupName, encrypted);
      handler(plaintext);
    });
  }
}
```

---

## Performance and Trade-offs

### Overhead Comparison

| Pattern | Operation | Encryption Cost | Storage Overhead | Transport Overhead |
|---------|-----------|----------------|------------------|-------------------|
| User-Private | Store | ~7ms (AES-GCM) | +30% (IV + tag) | +0ms (end-to-end) |
| User-Private | Get | ~6ms (AES-GCM) | - | +0ms |
| Public (transport) | Store | ~0ms (no encryption) | +5% (signature) | +9ms per hop |
| Public (transport) | Get | ~3ms (verify sig) | - | +9ms per hop |
| Group-Shared | Store | ~10ms (JOSE JWE) | +40% (JWE overhead) | +0ms (end-to-end) |
| Group-Shared | Get | ~12ms (JOSE JWE) | - | +0ms |

### Storage Impact

**Example: 1KB message**

- **Plaintext:** 1024 bytes
- **User-Private:** 1330 bytes (+30%)
- **Public (signed):** 1075 bytes (+5%)
- **Group-Shared:** 1435 bytes (+40%)

**Mitigation:** Compression before encryption can offset overhead

### Network Impact

**Transport Encryption (5-hop path):**
- Latency: +45ms (9ms × 5 hops)
- CPU: Decrypt + re-encrypt at each hop
- Bandwidth: Same (encrypted size ≈ plaintext size)

**Recommendation:**
- Enable transport encryption for sensitive routing info
- Disable for high-frequency, low-sensitivity data
- Use end-to-end encryption (Pattern 1 or 3) for truly sensitive data

---

## Migration and Deployment

### Phase 1: Core Infrastructure (Week 1-2)

- [ ] Implement UserPrivateEncryption (Pattern 1)
- [ ] Implement TransportEncryption (Pattern 2)
- [ ] Install and configure distributed-security
- [ ] Implement GroupEncryption (Pattern 3)
- [ ] Unit tests for all three patterns

### Phase 2: DHT Integration (Week 3-4)

- [ ] Extend DHT store/get methods with encryption options
- [ ] Implement routing with transport re-encryption
- [ ] Add signature verification to message handling
- [ ] Integration tests (all patterns)

### Phase 3: PubSub Integration (Week 5-6)

- [ ] Public topics with transport encryption
- [ ] Group topics with distributed-security
- [ ] Topic subscription management
- [ ] End-to-end tests

### Phase 4: API Finalization (Week 7-8)

- [ ] High-level API design
- [ ] Documentation and examples
- [ ] Migration guides for existing data
- [ ] Performance optimization

---

## Security Considerations

### Threat Model

**Protected Against:**
1. ✅ **Passive Network Monitoring** - Transport encryption prevents ISP snooping
2. ✅ **Unauthorized Data Access** - User-private and group encryption enforce access control
3. ✅ **MITM Tampering** - Signatures verify authenticity
4. ✅ **Compromised Storage Nodes** - Encrypted data at rest

**Limitations:**
1. ⚠️ **Malicious DHT Nodes** - Can read transport-encrypted data at their hop (use end-to-end for sensitive data)
2. ⚠️ **Authorized Member Leaking** - Group members can always leak data they can decrypt
3. ⚠️ **Backward Secrecy** - Removed group members keep previously accessed data
4. ❌ **Traffic Analysis** - Connection patterns still visible

### Best Practices

**For Application Developers:**
- Use **Pattern 1** (user-private) for sensitive personal data
- Use **Pattern 2** (public with transport) for routing/metadata
- Use **Pattern 3** (group-shared) for collaborative data
- Always verify signatures on public data
- Implement rate limiting to prevent DoS via encryption overhead

**For Node Operators:**
- Keep private keys secure (encrypted at rest)
- Monitor CPU usage (encryption overhead)
- Implement caching for derived keys
- Regular security audits

---

## Conclusion

This addendum extends the encryption proposal to support all three data access patterns in YZ Network:

1. **User-Private:** End-to-end encryption for personal data
2. **Public with Transport Security:** Hop-by-hop encryption for public DHT data
3. **Group-Shared:** Team-based encryption using distributed-security

The architecture provides:
- ✅ Flexible encryption policies per data type
- ✅ Protection against network monitoring (WS transport)
- ✅ Access control (user and group level)
- ✅ Manageable performance overhead
- ✅ Integration with existing distributed-security library

**Recommended Next Steps:**
1. Review this proposal with team
2. Prototype transport encryption (Pattern 2)
3. Evaluate distributed-security integration (Pattern 3)
4. Design final API based on application requirements

---

**End of Addendum**
