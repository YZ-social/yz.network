# Security and Connectivity Proposal for YZ Network

**Date:** 2025-01-22
**Status:** Draft
**Authors:** Claude Code Analysis

---

## Executive Summary

This proposal addresses two critical architectural challenges in YZ Network's browser-based DHT implementation:

1. **TLS/Security Challenge:** Browser clients on HTTPS cannot connect to community-run Node.js nodes without TLS certificates
2. **Data Security:** All data stored in the DHT is currently transmitted in plaintext over WebSocket connections

**Proposed Solutions:**
- **Short-term:** Two-tier network architecture (infrastructure nodes with WSS, community nodes with WS)
- **Long-term:** Application-level end-to-end encryption for all DHT data + WebRTC support for Node.js

---

## Table of Contents

1. [Background & Problem Statement](#background--problem-statement)
2. [Security Analysis: WS vs WSS](#security-analysis-ws-vs-wss)
3. [Proposal 1: Application-Level Encryption](#proposal-1-application-level-encryption)
4. [Proposal 2: WebRTC for Node.js (Re-evaluation)](#proposal-2-webrtc-for-nodejs-re-evaluation)
5. [Proposal 3: Two-Tier Network Architecture](#proposal-3-two-tier-network-architecture)
6. [Implementation Roadmap](#implementation-roadmap)
7. [Appendix: Technical Details](#appendix-technical-details)

---

## Background & Problem Statement

### Current Architecture

YZ Network is a browser-based DHT implementation using Kademlia with the following connection matrix:

- **Browser ↔ Browser:** WebRTC (P2P connections)
- **Browser → Node.js:** WebSocket (Node.js is WebSocket server)
- **Node.js ↔ Node.js:** WebSocket (server/client connections)

### The TLS Problem

**Deployment Scenarios:**
1. **Oracle Infrastructure:** 60+ Node.js DHT nodes running on Oracle Cloud
2. **Community Nodes:** Unknown number of nodes running on users' personal computers/servers
3. **Browser Clients:** Users accessing via HTTPS web interface

**Browser Security Restriction:**
- HTTPS pages can only make **WSS (WebSocket Secure)** connections
- Cannot connect to **WS (WebSocket)** endpoints without TLS
- Triggers "Mixed Content" errors and blocks connection

**Infrastructure vs Community Challenge:**

| Node Type | We Control? | Can Issue Certs? | TLS Solution |
|-----------|-------------|------------------|--------------|
| Oracle nodes (60+) | ✅ Yes | ✅ Yes | Nginx proxy + Let's Encrypt |
| Community nodes | ❌ No | ❌ No | **NO VIABLE SOLUTION** |

**Impact:**
- Browser clients cannot connect to community Node.js nodes
- Severely limits network growth and decentralization
- Community participation restricted to non-browser deployments only

### Previous Attempts

**WebRTC for Node.js (2 weeks effort):**
- Explored `node-webrtc` and `wrtc` packages
- Found poor maintenance, bad dependencies, compatibility issues
- **Result:** Abandoned due to technical barriers

---

## Security Analysis: WS vs WSS

### What Gets Transmitted

YZ Network DHT traffic includes:

**Public Data (by design):**
- Node IDs (SHA-256 hashes of public keys)
- Routing table queries (`find_node`)
- K-bucket information
- Network topology discovery

**Sensitive Data (requires protection):**
- ⚠️ **User data stored in DHT** - application-specific content
- ⚠️ **PubSub messages** - private communications
- ⚠️ **WebRTC signaling** - IP addresses, ICE candidates
- ⚠️ **Invitation tokens** - currently signed but transmitted in clear

### Security Implications Table

| Security Aspect | WS (Unencrypted) | WSS (TLS) |
|----------------|------------------|-----------|
| **Confidentiality** | ❌ Plaintext visible to ISPs, routers, attackers | ✅ Encrypted in transit |
| **Integrity** | ❌ Can be tampered with (MITM attacks) | ✅ HMAC verification prevents tampering |
| **Authentication** | ❌ Can't verify server identity | ✅ Certificate-based authentication |
| **Privacy** | ❌ Traffic analysis possible | ✅ Content encrypted (metadata still visible) |

### Attack Vectors with WS-only

**Passive Attacks:**
1. **ISP/Network Monitoring:** ISPs can read all DHT traffic including stored data
2. **WiFi Eavesdropping:** Attackers on same network can sniff all messages
3. **Traffic Analysis:** Pattern analysis reveals user behavior

**Active Attacks:**
1. **Man-in-the-Middle:** Attacker intercepts and modifies DHT messages
2. **Fake Node Injection:** Inject malicious nodes with fake data
3. **Data Tampering:** Alter stored values in transit
4. **Routing Attacks:** Manipulate routing table responses

### Current Mitigations (Already Implemented)

✅ **Cryptographic Signatures:**
- Ed25519 signatures on invitation tokens
- ECDSA signatures for browser identity
- Prevents forgery (but not eavesdropping)

✅ **Node ID Verification:**
- Node IDs derived from public key hashes
- Difficult to fake without key compromise

❌ **Missing:** End-to-end encryption for stored data

---

## Proposal 1: Application-Level Encryption

### Overview

Implement **automatic end-to-end encryption** for all data stored in the DHT, independent of transport security (WS/WSS).

### Architecture

**Encryption Layer:** Between DHT API and storage layer

```
┌─────────────────────────────────────────────┐
│ Application Layer                           │
│  - User calls: dht.store(key, data)         │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│ ENCRYPTION LAYER (NEW)                      │
│  - Encrypt data with user key               │
│  - Sign encrypted blob                      │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│ DHT Storage Layer                           │
│  - Store encrypted blob in DHT              │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│ Transport Layer (WS or WSS)                 │
│  - Encrypted blob transmitted               │
└─────────────────────────────────────────────┘
```

**Key Benefits:**
- ✅ Works over WS and WSS (transport-agnostic)
- ✅ Protects against compromised infrastructure nodes
- ✅ Users control their own encryption keys
- ✅ Zero-knowledge storage (servers can't read data)

### Implementation Plan

#### Phase 1: Encryption Infrastructure

**Key Management:**

```javascript
// Use existing ECDSA identity keys for encryption
class DataEncryption {
  constructor(identityStore) {
    this.identityStore = identityStore;
    // Derive encryption key from identity
    this.encryptionKey = await this.deriveEncryptionKey();
  }

  async deriveEncryptionKey() {
    // Use HKDF to derive AES-256-GCM key from ECDSA private key
    const privateKey = this.identityStore.getPrivateKey();
    return await crypto.subtle.deriveKey(
      { name: "HKDF", /* ... */ },
      privateKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }
}
```

**Encryption/Decryption:**

```javascript
class EncryptedDHTStorage {
  async store(key, plaintext, ttl) {
    // 1. Generate random IV
    const iv = crypto.getRandomValues(new Uint8Array(12));

    // 2. Encrypt data with AES-256-GCM
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      this.encryptionKey,
      plaintext
    );

    // 3. Create encrypted blob
    const encryptedBlob = {
      version: 1,
      iv: base64(iv),
      ciphertext: base64(ciphertext),
      signature: await this.sign(ciphertext)  // Authenticity
    };

    // 4. Store in DHT
    return await this.dht.store(key, JSON.stringify(encryptedBlob), ttl);
  }

  async get(key) {
    // 1. Retrieve from DHT
    const blob = JSON.parse(await this.dht.get(key));

    // 2. Verify signature
    if (!await this.verify(blob.ciphertext, blob.signature)) {
      throw new Error('Signature verification failed');
    }

    // 3. Decrypt
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unbase64(blob.iv) },
      this.encryptionKey,
      unbase64(blob.ciphertext)
    );

    return plaintext;
  }
}
```

#### Phase 2: Transparent API Integration

**Wrap existing DHT methods:**

```javascript
class BrowserDHTClient extends DHTClient {
  constructor(options) {
    super(options);
    // Initialize encryption layer
    this.encryption = new EncryptedDHTStorage(this, this.identityStore);
  }

  // Override store method
  async store(key, value, ttl) {
    // Automatically encrypt before storage
    return await this.encryption.store(key, value, ttl);
  }

  // Override get method
  async get(key) {
    // Automatically decrypt after retrieval
    return await this.encryption.get(key);
  }
}
```

**Backward Compatibility:**

```javascript
// Support both encrypted and plaintext data
async get(key) {
  const value = await this.dht.get(key);

  try {
    // Try to parse as encrypted blob
    const blob = JSON.parse(value);
    if (blob.version && blob.ciphertext) {
      return await this.decrypt(blob);
    }
  } catch (e) {
    // Not encrypted, return as-is
  }

  return value;
}
```

#### Phase 3: PubSub Encryption

**Encrypt PubSub messages:**

```javascript
class EncryptedPubSubClient extends PubSubClient {
  async publish(topic, data, options) {
    // 1. Encrypt message
    const encryptedData = await this.encryption.encrypt(data);

    // 2. Publish encrypted blob
    return await super.publish(topic, encryptedData, options);
  }

  async subscribe(topic, handler, options) {
    // Wrap handler to decrypt messages
    const wrappedHandler = async (encryptedData) => {
      const plaintext = await this.encryption.decrypt(encryptedData);
      return handler(plaintext);
    };

    return await super.subscribe(topic, wrappedHandler, options);
  }
}
```

### Security Properties

**Threat Model Protection:**

| Attack | Without Encryption | With Encryption |
|--------|-------------------|-----------------|
| ISP monitoring WS traffic | ❌ Reads all data | ✅ Sees encrypted blobs only |
| Compromised infrastructure node | ❌ Full data access | ✅ No access to plaintext |
| MITM tampering | ❌ Can modify data | ✅ Signature verification detects tampering |
| Malicious DHT peer | ❌ Can read stored values | ✅ Cannot decrypt without user key |

**Cryptographic Properties:**
- **Confidentiality:** AES-256-GCM (authenticated encryption)
- **Authenticity:** ECDSA signatures verify data source
- **Integrity:** GCM authentication tag + signature
- **Forward Secrecy:** Optional key rotation support

### Limitations

⚠️ **What This Doesn't Protect:**
- DHT routing metadata (node IDs, routing queries) - intentionally public
- Connection metadata (who connects to whom) - network layer visibility
- Traffic patterns and timing - statistical analysis still possible

✅ **What This Does Protect:**
- User data content - completely private
- Message content in PubSub - end-to-end encrypted
- Stored values - zero-knowledge storage

### Migration Strategy

**Phase 1: Opt-in (Week 1-2)**
- Deploy encryption layer
- Default: disabled
- Users can enable via `encryptData: true` option

**Phase 2: Opt-out (Week 3-4)**
- Default: enabled
- Users can disable via `encryptData: false`
- Monitor for compatibility issues

**Phase 3: Mandatory (Month 2+)**
- Encryption required for all new data
- Plaintext data still readable (backward compat)
- Gradual transition period

### Performance Impact

**Benchmarks (estimated):**

| Operation | Without Encryption | With Encryption | Overhead |
|-----------|-------------------|-----------------|----------|
| Store (1KB) | 5ms | 7ms | +40% |
| Get (1KB) | 4ms | 6ms | +50% |
| Store (100KB) | 45ms | 52ms | +15% |
| Get (100KB) | 40ms | 48ms | +20% |

**Mitigations:**
- Web Crypto API uses hardware acceleration
- AES-GCM is very fast
- Signature verification cached
- Negligible impact on real-world usage

---

## Proposal 2: WebRTC for Node.js (Re-evaluation)

### Background: Previous Attempt

**Two weeks of effort (prior attempt):**
- Explored `node-webrtc` and `wrtc` packages
- Issues encountered:
  - Poor maintenance (last updates 2+ years ago)
  - Native compilation failures
  - Dependency conflicts
  - Incompatibility with modern Node.js versions

**Result:** Abandoned as non-viable

### New Research: 2025 WebRTC Landscape

Comprehensive search conducted January 2025 revealed **three actively maintained libraries:**

---

#### Option 1: @roamhq/wrtc ⭐ (Recommended)

**Overview:**
- Actively maintained fork of original `node-webrtc`
- Native bindings to **WebRTC M98** (modern)
- Supports **Node.js 20+**

**Key Information:**
- **NPM:** [@roamhq/wrtc](https://www.npmjs.com/package/@roamhq/wrtc)
- **GitHub:** [node-webrtc/node-webrtc](https://github.com/node-webrtc/node-webrtc) (recommends @roamhq/wrtc fork)
- **Downloads:** 20,938 per week
- **Last Release:** Less than 1 year ago
- **Platform Support:** Linux, Windows, macOS
- **Prebuilt Binaries:** Yes (automatic download for common platforms)

**Pros:**
- ✅ Native WebRTC (same as browsers)
- ✅ Active maintenance and updates
- ✅ Production-ready (used by various projects)
- ✅ Familiar browser-like API
- ✅ Hardware acceleration

**Cons:**
- ❌ Native compilation required for uncommon platforms
- ❌ Larger installation size (native binaries)
- ❌ Platform-specific bugs possible

**Installation:**
```bash
npm install @roamhq/wrtc
```

**Example Usage:**
```javascript
import { RTCPeerConnection } from '@roamhq/wrtc';

// Similar to browser API
const pc = new RTCPeerConnection({
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
});

const dc = pc.createDataChannel('dht');
dc.onmessage = (event) => {
  console.log('Message:', event.data);
};
```

**Recommendation:** **High priority to evaluate** - Most mature option

---

#### Option 2: werift

**Overview:**
- **Pure TypeScript implementation** (no native modules!)
- Includes complete WebRTC stack: ICE/DTLS/SCTP/RTP/SRTP
- API similar to browser WebRTC

**Key Information:**
- **NPM:** [werift](https://www.npmjs.com/package/werift)
- **GitHub:** [shinyoshiaki/werift-webrtc](https://github.com/shinyoshiaki/werift-webrtc)
- **Last Release:** 5 months ago (June 2024)
- **Node.js Version:** 16+ required
- **Dependencies:** Only Node.js standard libraries + pure JavaScript

**Pros:**
- ✅ **No native compilation** - pure TypeScript
- ✅ Works on all platforms (ARM, x86, etc.)
- ✅ Easy debugging (all code is JavaScript/TypeScript)
- ✅ Small codebase (single repository)
- ✅ Active development (2024-2025 commits)

**Cons:**
- ❌ Slower than native (no hardware acceleration)
- ❌ Less mature than native implementations
- ❌ Smaller community/ecosystem

**Installation:**
```bash
npm install werift
```

**Example Usage:**
```javascript
import { RTCPeerConnection } from 'werift';

const pc = new RTCPeerConnection({
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
});

const dc = pc.createDataChannel('dht');
dc.onmessage = (event) => {
  console.log('Message:', event.data);
};
```

**Recommendation:** **Medium priority** - Good for pure JavaScript environments, easier deployment

---

#### Option 3: node-datachannel

**Overview:**
- Node.js bindings for **libdatachannel** (C++ library)
- Focus on data channels (not media streaming)
- Integrated WebSocket client/server for signaling

**Key Information:**
- **NPM:** [node-datachannel](https://www.npmjs.com/package/node-datachannel)
- **GitHub:** [murat-dogan/node-datachannel](https://github.com/murat-dogan/node-datachannel)
- **Latest Release:** June 2024 (v0.28.0), January 2025 assets (v0.29.0)
- **Node.js Version:** 18.20+ required
- **Platform Support:** Linux, Windows, macOS

**Pros:**
- ✅ Fast (native C++ implementation)
- ✅ Focus on data channels (perfect for DHT!)
- ✅ Built-in signaling (WebSocket client/server)
- ✅ Active maintenance
- ✅ Can polyfill simple-peer

**Cons:**
- ❌ Native compilation required
- ❌ Less documentation than alternatives
- ❌ Smaller community

**Installation:**
```bash
npm install node-datachannel
```

**Example Usage:**
```javascript
import nodeDataChannel from 'node-datachannel';

const peer = new nodeDataChannel.PeerConnection({
  iceServers: ['stun:stun.l.google.com:19302']
});

const dc = peer.createDataChannel('dht');
dc.onMessage((msg) => {
  console.log('Message:', msg);
});
```

**Recommendation:** **Medium priority** - Good for data-only use case

---

### Comparison Matrix

| Feature | @roamhq/wrtc | werift | node-datachannel |
|---------|--------------|--------|------------------|
| **Maturity** | ⭐⭐⭐⭐⭐ High | ⭐⭐⭐ Medium | ⭐⭐⭐⭐ High |
| **Performance** | ⭐⭐⭐⭐⭐ Native | ⭐⭐⭐ JS | ⭐⭐⭐⭐⭐ Native |
| **Ease of Install** | ⭐⭐⭐⭐ Prebuilt | ⭐⭐⭐⭐⭐ Pure JS | ⭐⭐⭐ Compile |
| **Maintenance** | ✅ Active (2024-25) | ✅ Active (2024-25) | ✅ Active (2024-25) |
| **Node.js Support** | 20+ | 16+ | 18.20+ |
| **Documentation** | ⭐⭐⭐⭐ Good | ⭐⭐⭐ Moderate | ⭐⭐⭐ Moderate |
| **Community** | ⭐⭐⭐⭐ Large | ⭐⭐⭐ Medium | ⭐⭐⭐ Medium |
| **Best For** | Production use | Easy deployment | Data channels only |

### Recommendation: Phased Evaluation

**Week 1-2: Proof of Concept**

Test all three libraries with minimal DHT integration:

```javascript
// Create simple WebRTC data channel test
// 1. Establish connection between two Node.js processes
// 2. Send DHT ping/pong messages
// 3. Measure latency and reliability
// 4. Test NAT traversal with STUN
```

**Evaluation Criteria:**
- ✅ Installation success on target platforms
- ✅ Basic WebRTC connection established
- ✅ Data channel messaging works
- ✅ ICE/STUN NAT traversal functional
- ✅ Reasonable performance (< 100ms latency)
- ✅ No dependency conflicts

**Week 3-4: Full Integration**

Best-performing library from POC:

```javascript
// Implement WebRTCConnectionManager
class WebRTCConnectionManagerNodeJS extends ConnectionManager {
  async createConnection(peerId, initiator) {
    this.pc = new RTCPeerConnection(this.config);
    this.dc = this.pc.createDataChannel('dht');

    // Standard WebRTC signaling via DHT
    // ...existing DHT signaling code...
  }
}
```

**Week 5-6: Testing & Deployment**
- Test with 60+ Oracle nodes
- Community node beta testing
- Performance benchmarking
- Production rollout

### Expected Outcome

**If successful:**
- ✅ Browsers can connect to ANY Node.js node (via WebRTC)
- ✅ No TLS certificates required
- ✅ NAT traversal built-in
- ✅ True peer-to-peer architecture
- ✅ Fully decentralized network

**If unsuccessful:**
- Fall back to Proposal 3 (Two-Tier Architecture)
- Document specific failures for future reference

---

## Proposal 3: Two-Tier Network Architecture

### Overview

If WebRTC for Node.js remains non-viable, implement a **two-tier architecture** where browsers connect only to infrastructure nodes, while all Node.js nodes participate in full DHT.

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────┐
│ Tier 1: Infrastructure Nodes (Oracle Cloud)             │
│                                                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐             │
│  │  Node 1  │  │  Node 2  │  │  Node 60 │             │
│  │ (WSS)    │  │ (WSS)    │  │ (WSS)    │             │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘             │
│       │             │             │                     │
│       └─────────────┴─────────────┘                     │
│              WS connections                             │
└──────────────────┬──────────────────────────────────────┘
                   │ WSS (via nginx)
                   │
          ┌────────┴─────────┐
          │                  │
    ┌─────▼──────┐    ┌─────▼──────┐
    │  Browser 1 │    │  Browser 2 │
    │  (HTTPS)   │    │  (HTTPS)   │
    └────────────┘    └────────────┘

┌─────────────────────────────────────────────────────────┐
│ Tier 2: Community Nodes (User Computers)                │
│                                                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐             │
│  │ User N 1 │  │ User N 2 │  │ User N N │             │
│  │  (WS)    │  │  (WS)    │  │  (WS)    │             │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘             │
│       │             │             │                     │
│       └─────────────┴─────────────┘                     │
│       WS connections (DHT routing)                      │
│                                                          │
│  ❌ Browsers DO NOT connect directly                    │
│  ✅ Messages route via Tier 1 nodes                     │
└─────────────────────────────────────────────────────────┘
```

### Connection Matrix

| From | To | Protocol | Direct Connection |
|------|-----|----------|-------------------|
| Browser | Tier 1 Node | WSS | ✅ Yes |
| Browser | Tier 2 Node | - | ❌ No (routes via DHT) |
| Browser | Browser | WebRTC | ✅ Yes (P2P) |
| Tier 1 | Tier 1 | WS | ✅ Yes |
| Tier 1 | Tier 2 | WS | ✅ Yes |
| Tier 2 | Tier 2 | WS | ✅ Yes |

### DHT Routing Mechanism

**How browsers reach Tier 2 nodes:**

```
1. Browser wants to store data:
   Browser → Tier 1 Node → findNode(key) → Tier 2 Node

2. Tier 1 Node routes request:
   Forwards store(key, value) through DHT to closest nodes

3. Tier 2 Node receives and stores:
   Message arrives via DHT routing, responds via reverse path

4. Browser receives confirmation:
   Response routed back through DHT to Tier 1 → Browser
```

**Key Insight:** Browsers don't need direct connections to ALL nodes - DHT routing provides reachability.

### Implementation Details

#### Tier 1: Infrastructure Nodes (Oracle)

**Docker Compose Configuration:**

```yaml
services:
  infra-node-1:
    image: itsmeront/yz-dht-node:latest
    environment:
      - NODE_TYPE=infrastructure
      - PUBLIC_ADDRESS_WSS=wss://node1.yz.imeyouwe.com
      - PUBLIC_ADDRESS_WS=ws://node1.yz.imeyouwe.com:8083
      - WEBSOCKET_HOST=0.0.0.0
      - WEBSOCKET_PORT=8083
    # ...60 nodes total...
```

**Nginx Configuration (Wildcard Certificate):**

```nginx
# Wildcard cert: *.yz.imeyouwe.com
server {
    listen 443 ssl http2;
    server_name ~^node(?<node_num>\d+)\.yz\.imeyouwe\.com$;

    ssl_certificate /etc/letsencrypt/live/yz.imeyouwe.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yz.imeyouwe.com/privkey.pem;

    location / {
        # Route to corresponding container
        proxy_pass http://infra-node-$node_num:8083;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

**Node Metadata (Multi-address):**

```javascript
{
  nodeId: "a1b2c3d4...",
  nodeType: "infrastructure",
  addresses: [
    {
      protocol: "wss",
      url: "wss://node1.yz.imeyouwe.com",
      clientTypes: ["browser"]  // For browser clients
    },
    {
      protocol: "ws",
      url: "ws://node1.yz.imeyouwe.com:8083",
      clientTypes: ["nodejs"]   // For Node.js clients
    }
  ],
  capabilities: ["storage", "routing", "bridge"]
}
```

#### Tier 2: Community Nodes

**Standard Node.js Installation:**

```bash
# No special configuration needed!
npm install -g yz-network
yz-node --port 8083
```

**Node Metadata (WS only):**

```javascript
{
  nodeId: "e5f6g7h8...",
  nodeType: "community",
  addresses: [
    {
      protocol: "ws",
      url: "ws://192.168.1.100:8083",
      clientTypes: ["nodejs"]   // Only Node.js can connect
    }
  ],
  capabilities: ["storage", "routing"]
}
```

#### Connection Manager Logic

**Browser Connection Manager:**

```javascript
class BrowserConnectionManager {
  canConnectTo(peerNode) {
    // Check if node has WSS address
    const wssAddress = peerNode.addresses.find(
      addr => addr.protocol === 'wss' &&
              addr.clientTypes.includes('browser')
    );

    if (!wssAddress) {
      console.log(`Cannot connect to ${peerNode.nodeId} - no WSS available`);
      return false;  // Don't attempt connection
    }

    return true;
  }

  async connectToPeer(peerNode) {
    if (!this.canConnectTo(peerNode)) {
      // Peer is reachable via DHT routing only
      return null;
    }

    // Connect via WSS
    const wssAddr = peerNode.addresses.find(a => a.protocol === 'wss');
    return await this.connectWebSocket(wssAddr.url);
  }
}
```

**Node.js Connection Manager:**

```javascript
class NodeJSConnectionManager {
  canConnectTo(peerNode) {
    // Can connect to any WS or WSS address
    return peerNode.addresses.some(
      addr => ['ws', 'wss'].includes(addr.protocol)
    );
  }

  async connectToPeer(peerNode) {
    // Prefer WS (no overhead), fallback to WSS
    const wsAddr = peerNode.addresses.find(a => a.protocol === 'ws') ||
                   peerNode.addresses.find(a => a.protocol === 'wss');

    return await this.connectWebSocket(wsAddr.url);
  }
}
```

### Benefits

**For Browsers:**
- ✅ Full DHT participation (via routing)
- ✅ Data storage/retrieval works
- ✅ PubSub messaging works
- ✅ Connect to infrastructure with WSS
- ✅ P2P WebRTC to other browsers
- ✅ No certificate issues

**For Community Node Operators:**
- ✅ Simple installation (no TLS required)
- ✅ Full DHT participation
- ✅ Connect to all Node.js nodes (WS)
- ✅ No domain name needed
- ✅ NAT traversal not required (WS works through NAT)

**For Infrastructure:**
- ✅ Only 60 certificates needed (not thousands)
- ✅ Centrally managed
- ✅ Reliable entry points for browsers
- ✅ Can implement rate limiting, abuse prevention

### Limitations

**What This Doesn't Provide:**
- ❌ Direct browser ↔ community node connections
- ❌ True full-mesh P2P for browsers (limited to Tier 1)
- ❌ Lowest possible latency (routing adds hops)

**What This DOES Provide:**
- ✅ Functional DHT network for all participants
- ✅ Community node participation without barriers
- ✅ Browser participation from HTTPS
- ✅ Scalable architecture
- ✅ Manageable infrastructure

### Scaling Considerations

**Infrastructure Node Count:**
- Start: 60 nodes on Oracle
- Target: 100-200 nodes for redundancy
- Each node handles ~1000 browser connections
- Total capacity: 60,000-200,000 browsers

**Community Node Growth:**
- No limit on community nodes
- Each adds routing capacity
- Improves DHT resilience
- Data replication improves

**Browser Scaling:**
- Limited by Tier 1 capacity
- Can add more infrastructure nodes as needed
- Geographic distribution for latency

---

## Implementation Roadmap

### Phase 1: Application-Level Encryption (Month 1)

**Week 1-2: Encryption Infrastructure**
- [ ] Implement `DataEncryption` class
- [ ] Key derivation from existing ECDSA keys
- [ ] AES-256-GCM encryption/decryption
- [ ] Signature generation and verification
- [ ] Unit tests (100% coverage)

**Week 3-4: DHT Integration**
- [ ] Wrap `store()` and `get()` methods
- [ ] Transparent encryption/decryption
- [ ] Backward compatibility for plaintext
- [ ] Migration utilities
- [ ] Integration tests

**Week 5-6: PubSub Encryption**
- [ ] Encrypt PubSub messages
- [ ] Group key management (for shared topics)
- [ ] Key rotation support
- [ ] Performance testing

**Deliverables:**
- ✅ End-to-end encrypted DHT storage
- ✅ Encrypted PubSub messaging
- ✅ Zero-knowledge data architecture
- ✅ Documentation and examples

---

### Phase 2: WebRTC Evaluation (Month 2)

**Week 1: Library Testing**
- [ ] Test @roamhq/wrtc installation
- [ ] Test werift installation
- [ ] Test node-datachannel installation
- [ ] Basic connection tests (2 processes)
- [ ] Document issues and compatibility

**Week 2: Proof of Concept**
- [ ] Implement `WebRTCConnectionManagerNodeJS`
- [ ] DHT signaling integration
- [ ] Ping/pong messaging tests
- [ ] NAT traversal testing (STUN)
- [ ] Latency benchmarks

**Week 3: Integration (if POC successful)**
- [ ] Full DHT protocol support
- [ ] Connection manager factory updates
- [ ] Metadata handling (WebRTC addresses)
- [ ] Fallback to WebSocket (graceful degradation)
- [ ] Integration tests with browser clients

**Week 4: Testing & Decision**
- [ ] Test with 10+ Node.js nodes
- [ ] Stress testing (concurrent connections)
- [ ] Reliability testing (connection failures)
- [ ] Performance comparison (WebRTC vs WebSocket)
- [ ] **GO/NO-GO decision**

**Deliverables (if successful):**
- ✅ WebRTC support for Node.js DHT clients
- ✅ Browser ↔ Node.js WebRTC connections
- ✅ Fully decentralized network
- ✅ No TLS requirements for community nodes

**Deliverables (if unsuccessful):**
- ✅ Documented evaluation results
- ✅ Specific failure reasons
- ✅ Proceed to Phase 3 (Two-Tier Architecture)

---

### Phase 3: Two-Tier Architecture (Month 3) - IF WebRTC FAILS

**Week 1-2: Infrastructure Setup**
- [ ] Wildcard SSL certificate (`*.yz.imeyouwe.com`)
- [ ] DNS configuration (60+ subdomains)
- [ ] Nginx SNI routing configuration
- [ ] Docker Compose generation (60 nodes)
- [ ] Deployment automation

**Week 3-4: Connection Logic**
- [ ] Multi-address metadata support
- [ ] Connection manager address filtering
- [ ] Browser WSS-only connection logic
- [ ] Node.js WS/WSS connection logic
- [ ] DHT routing verification

**Week 5-6: Testing & Rollout**
- [ ] Test browser connections to Tier 1
- [ ] Test Node.js connections to all tiers
- [ ] Test DHT routing (browser → Tier 2 via routing)
- [ ] Community node installation guide
- [ ] Production deployment

**Deliverables:**
- ✅ 60+ Oracle nodes with WSS support
- ✅ Nginx reverse proxy with SSL
- ✅ Browser clients functional on HTTPS
- ✅ Community nodes easy to deploy (WS only)
- ✅ Documentation and guides

---

### Phase 4: Monitoring & Optimization (Month 4+)

**Ongoing:**
- [ ] Performance monitoring (encryption overhead)
- [ ] Security audits (encryption implementation)
- [ ] Community feedback collection
- [ ] Bug fixes and improvements
- [ ] Scalability testing

---

## Success Metrics

**Security Metrics:**
- ✅ 100% of stored data encrypted
- ✅ Zero plaintext data observable in WS traffic
- ✅ Signature verification success rate > 99.9%
- ✅ No key compromise incidents

**Connectivity Metrics:**
- ✅ Browser clients connect successfully from HTTPS
- ✅ Community node deployment rate increases
- ✅ Network size grows (target: 100+ community nodes)
- ✅ Connection success rate > 95%

**Performance Metrics:**
- ✅ Encryption overhead < 20% (store/get operations)
- ✅ DHT routing latency < 500ms (browser → Tier 2)
- ✅ WebRTC connection establishment < 5s (if implemented)

---

## Appendix: Technical Details

### Cryptographic Specifications

**Encryption Algorithm:** AES-256-GCM
- **Key Size:** 256 bits
- **IV Size:** 96 bits (12 bytes)
- **Tag Size:** 128 bits (16 bytes)
- **Random IV:** Generated per encryption operation

**Signature Algorithm:** ECDSA P-256
- **Curve:** P-256 (secp256r1)
- **Hash:** SHA-256
- **Signature Format:** IEEE P1363 (r || s)

**Key Derivation:** HKDF
- **Hash Function:** SHA-256
- **Info:** "yz-network-encryption-v1"
- **Salt:** Node ID (SHA-256 of public key)

### WebRTC Library Sources

1. **@roamhq/wrtc**
   - NPM: [https://www.npmjs.com/package/@roamhq/wrtc](https://www.npmjs.com/package/@roamhq/wrtc)
   - GitHub: [https://github.com/node-webrtc/node-webrtc](https://github.com/node-webrtc/node-webrtc)
   - Security Analysis: [https://socket.dev/npm/package/@roamhq/wrtc](https://socket.dev/npm/package/@roamhq/wrtc)

2. **werift**
   - NPM: [https://www.npmjs.com/package/werift](https://www.npmjs.com/package/werift)
   - GitHub: [https://github.com/shinyoshiaki/werift-webrtc](https://github.com/shinyoshiaki/werift-webrtc)
   - Documentation: [https://shinyoshiaki.github.io/werift-webrtc/website/build/](https://shinyoshiaki.github.io/werift-webrtc/website/build/)

3. **node-datachannel**
   - NPM: [https://www.npmjs.com/package/node-datachannel](https://www.npmjs.com/package/node-datachannel)
   - GitHub: [https://github.com/murat-dogan/node-datachannel](https://github.com/murat-dogan/node-datachannel)

### Performance Benchmarks (Target)

**Encryption Performance:**
- AES-256-GCM: ~1 GB/s (hardware accelerated)
- ECDSA sign: ~1000 ops/sec
- ECDSA verify: ~300 ops/sec

**Network Performance:**
- WebSocket (WS): ~1ms overhead
- WebSocket (WSS): ~2-3ms overhead (TLS handshake)
- WebRTC: ~5-10ms setup, ~1-2ms data channel overhead

### References

- [node-webrtc GitHub](https://github.com/node-webrtc/node-webrtc)
- [werift-webrtc GitHub](https://github.com/shinyoshiaki/werift-webrtc)
- [node-datachannel GitHub](https://github.com/murat-dogan/node-datachannel)
- [Web Crypto API Specification](https://www.w3.org/TR/WebCryptoAPI/)
- [WebRTC 1.0 Specification](https://www.w3.org/TR/webrtc/)
- [Kademlia DHT Paper](https://pdos.csail.mit.edu/~petar/papers/maymounkov-kademlia-lncs.pdf)

---

**End of Proposal**
