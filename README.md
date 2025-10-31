# YZSocialC

A browser-based Distributed Hash Table (DHT) implementation using the Kademlia algorithm with WebRTC for peer-to-peer connections. Creates a fully decentralized network with minimal server dependency.

## Features

- **Kademlia DHT**: Literature-compliant implementation with adaptive refresh and k-buckets
- **Native WebRTC**: Direct peer-to-peer connections with Perfect Negotiation Pattern and keep-alive
- **Minimal Server Dependency**: Bootstrap server only for initial peer discovery
- **Cryptographic Identity**: ECDSA P-256 key pairs with challenge/response authentication
- **Chain of Trust Security**: Ed25519-signed invitation tokens prevent unauthorized access
- **Open Network Mode**: No invitations required - bridge coordinates automatic peer introductions
- **DHT-Based Signaling**: Complete WebRTC negotiation through DHT messaging with signal handling
- **Adaptive Performance**: 15s refresh for new nodes, 10min for established (following literature)
- **Connection Resilience**: Keep-alive for inactive tabs, emergency discovery bypass, connection health monitoring
- **Tab-Specific Testing**: Multiple clients in same browser for easy development testing
- **Browser-First**: No Node.js dependencies in client code

## Quick Start

```bash
# Install dependencies
npm install

# Start bridge nodes server
npm run bridge-nodes

# Start bootstrap server
npm run bridge-bootstrap:genesis

# In a different terminal, start bootstrap server
npm run bridge-bootstrap:genesis

# In a third terminal, start development server
npm run dev

```

Open your browser to the development server URL. The first client becomes the genesis peer automatically.
1. Press the `START DHT` button.
2. Open another browser to the same url.
3. In the new browser, press the `START DHT` button, and grab the Node ID at the top of the screen.
4. In the first browser, paste that Node ID into the box next to the `INIVITE` button, and then press the button.
5. Repeat 2-4 as desired.
6. Run the Debug Tests one at a time. (Not `RUN ALL TESTS`)
7. Enter a key and value next to the `STORE` button and press the button.
8. Enter the same key next to the `GET` button and press the button. Scroll down to the Activity Log and see that the value was retrieved.
9. Now you can repeat step 4 in the second browser, and it will display the right info in the Activity Log below.

## Network Setup

1. **Start Bootstrap Server** (genesis mode for first network):
   ```bash
   npm run bootstrap:genesis
   ```

2. **First Client** (becomes genesis peer):
   ```javascript
   YZSocialC.startDHT()
   ```

3. **Additional Clients** (require invitations):
   ```javascript
   // Genesis peer invites new client
   YZSocialC.inviteNewClient('target_node_id')
   
   // New client joins with invitation
   YZSocialC.startDHT()
   ```

## Development Commands

```bash
# Development
npm run dev              # Start dev server with hot reload
npm run build           # Build for production
npm run test            # Run tests
npm run lint            # Run ESLint

# Bridge System (Recommended)
npm run bridge-nodes                        # Start bridge nodes (internal)
npm run bridge-bootstrap                    # Start bootstrap (standard mode)
npm run bridge-bootstrap:genesis            # Start bootstrap (genesis mode)
npm run bridge-bootstrap:genesis:openNetwork # Genesis + open network
npm run bridge-bootstrap:openNetwork        # Open network (existing DHT)

# Bridge System (All-in-One)
npm run bridge:genesis                      # Complete system (genesis)
npm run bridge:genesis:openNetwork          # Complete system (genesis + open)
npm run bridge                              # Complete system (standard)

# Server Management
npm run shutdown        # Kill all servers
npm run restart         # Restart bootstrap server
npm run kill-ports      # Kill processes on default ports
```

## Browser Console Debug

```javascript
// Network statistics
YZSocialC.getStats()

// Connected peers
YZSocialC.getPeers()

// Test DHT storage
await YZSocialC.testStore('key', 'value')
await YZSocialC.testGet('key')

// Invitation system
YZSocialC.inviteNewClient('node_id')
YZSocialC.dht.createInvitationToken('node_id')

// Adaptive refresh system (Literature-Compliant)
YZSocialC.getAdaptiveRefreshStatus()
YZSocialC.forceAdaptiveRefresh()
YZSocialC.refreshStaleBuckets()

// WebRTC keep-alive and signaling (FIXED)
YZSocialC.getKeepAliveStatus()
YZSocialC.testKeepAlivePing()
YZSocialC.simulateTabVisibilityChange()
YZSocialC.checkConnectionHealth()
YZSocialC.debugWebRTCStates()

// Network discovery
YZSocialC.refreshBuckets()
YZSocialC.triggerPeerDiscovery()

// Debug tools
YZSocialC.debugConnectionState()
YZSocialC.debugRoutingTable()
YZSocialC.getTrafficStats()
YZSocialC.investigatePhantomPeer('node_id')
```

## Testing

### Browser Testing (Web UI)

#### Multi-Tab Testing (Default)
1. Start bootstrap server: `npm run bridge-bootstrap:genesis:openNetwork`
2. Start bridge nodes: `npm run bridge-nodes`
3. Start dev server: `npm run dev`
4. **Client A**: Open `http://localhost:3000` - becomes genesis peer
5. **Client B**: Open **new tab** `http://localhost:3000` - gets unique identity automatically
6. Each tab will have different Node ID thanks to tab-specific identity feature
7. Watch them connect via WebRTC through DHT network

#### Single Identity Testing
To test behavior with shared identity across tabs:
1. Open `http://localhost:3000?tabIdentity=false` in first tab
2. Open `http://localhost:3000?tabIdentity=false` in second tab
3. Both tabs share same identity (for testing persistent identity features)

#### Multi-Browser Testing
For production-like testing without tab identity:
1. Open client A in Chrome
2. Open client B in Firefox or Chrome Incognito
3. Each browser has naturally separate identity storage



## Architecture

- **DHT Layer**: `src/dht/` - Kademlia implementation and routing
- **Core Classes**: `src/core/` - Node IDs, DHT nodes, k-buckets, invitation tokens
- **Network Layer**: `src/network/` - WebRTC management and overlay networking
  - `WebRTCManager.js` - Browser WebRTC using native APIs
- **Bootstrap**: `src/bootstrap/` - Initial peer discovery server
- **UI**: `src/ui/` - Network visualization and controls
- **Testing**: `test/` - Browser test suites

## Network Flow

1. Genesis node connects to bootstrap server
2. Creates cryptographic invitation tokens for new peers
3. New peers join using invitation tokens
4. WebRTC connections established using Perfect Negotiation Pattern
5. DHT routing table built through peer discovery
6. Automatic transition to DHT-based signaling
7. Bootstrap server disconnected (minimal dependency achieved)

## Cryptographic Identity System

YZSocialC uses a robust cryptographic identity system for secure peer identification and authentication.

### Identity Components

- **Key Pair**: ECDSA P-256 (Web Crypto API standard)
  - Private key: Stored in IndexedDB, never leaves browser
  - Public key: Shared with bootstrap server for verification
- **Node ID**: 160-bit Kademlia ID derived from SHA-256 hash of public key
- **Storage**: IndexedDB for persistent identity across sessions

### Bootstrap Authentication Flow

1. **Client connects** to bootstrap server with Node ID and public key
2. **Server generates challenge** with nonce and timestamp
3. **Client signs challenge** using private key (ECDSA signature)
4. **Server verifies signature** using public key (Node.js crypto)
5. **Authentication success** grants network access

### Tab-Specific Identity (Testing Feature)

**Default Behavior**: Each browser tab gets unique identity for easy multi-client testing
- Enabled by default (URL: `http://localhost:3000`)
- Uses `sessionStorage` to generate per-tab IDs
- Allows testing multiple clients in same browser without conflicts

**Shared Identity Mode**: All tabs use same identity
- Add URL parameter: `http://localhost:3000?tabIdentity=false`
- Useful for testing persistent identity behavior
- Identity persists across browser restarts

### Identity Management Commands

```javascript
// Export identity for backup
const backup = await YZSocialC.exportIdentity()

// Import identity from backup
await YZSocialC.importIdentity(backup)

// Delete identity (requires page reload to regenerate)
await YZSocialC.deleteIdentity()

// Get identity info (without private key)
const info = YZSocialC.getIdentityInfo()
```

## Open Network Mode

**Purpose**: Simplifies testing and development by eliminating manual invitation workflow. New peers automatically join the network through bridge coordination.

### How It Works

**Standard Mode (Invitation Required)**:
1. Genesis peer creates invitation token for specific new peer
2. New peer uses token to join network
3. Manual coordination required for each new peer

**Open Network Mode (No Invitations)**:
1. **Genesis Peer**: First client connects, becomes genesis temporarily
2. **Automatic Bridge Connection**: Genesis connects to bridge node, gains DHT membership
3. **Subsequent Peers**: Bridge selects random active DHT member to invite them
4. **Distributed Load**: Each new peer gets introduced by different existing member
5. **No Bottleneck**: Bridge coordinates but doesn't connect to all peers directly

### Activation

**npm Scripts**:
```bash
# Start open network (genesis mode)
npm run bridge-bootstrap:genesis:openNetwork

# Connect to existing open network
npm run bridge-bootstrap:openNetwork

# Complete system (bridge nodes + bootstrap)
npm run bridge:genesis:openNetwork
npm run bridge:openNetwork
```

**Command Line Flags**:
```bash
# Genesis + open network
node src/bridge/start-enhanced-bootstrap.js -createNewDHT -openNetwork

# Existing network + open access
node src/bridge/start-enhanced-bootstrap.js -openNetwork
```

### Onboarding Flow (Open Network)

1. **New peer connects** to bootstrap server
2. **Bridge query**: Bootstrap asks bridge for random active peer
3. **Helper selection**: Bridge randomly selects existing DHT member
4. **Invitation via DHT**: Bridge sends invitation request to helper peer
5. **Helper invites**: Existing member creates invitation token for new peer
6. **WebRTC establishment**: New peer connects to helper via WebRTC
7. **DHT membership**: New peer joins routing table and can help others

### Architecture Benefits

- **Scalability**: Load distributed across existing DHT members
- **No Central Bottleneck**: Bridge doesn't maintain connections to all peers
- **Self-Organizing**: Network grows organically through peer introductions
- **Testing Friendly**: No manual coordination for development testing
- **Production Ready**: Can disable for controlled network access

### Security Considerations

- **Testing Only**: Open network mode recommended for development/testing
- **Production**: Use standard invitation mode for controlled access
- **Authentication Still Required**: All peers must pass cryptographic challenge
- **Bridge Validation**: Bridge verifies active peers before selection
- **Membership Tokens**: Issued normally after successful connection

## Security Model

- **Cryptographic Identity**: ECDSA P-256 keys with challenge/response authentication
- **Chain of Trust**: Genesis peer controls initial network access
- **Invitation Tokens**: Ed25519-signed, single-use, time-limited
- **Replay Protection**: Unique nonces prevent token reuse
- **Decentralized Validation**: DHT stores consumed tokens and public keys
- **Signature Verification**: Bootstrap server validates all peer identities
- **No Credential Storage**: Private keys never leave browser, stored only in IndexedDB

## Configuration

- **k = 20**: Kademlia bucket size
- **alpha = 3**: Lookup parallelism  
- **adaptive refresh**: 15s (new nodes) → 60s (medium) → 10min (established, literature-compliant)
- **timeout = 30s**: WebRTC connection timeout
- **max connections = 50**: Concurrent peer limit
- **keep-alive**: 30s (active tabs) / 10s (inactive tabs)
- **rate limiting**: 10s minimum between find_node requests (emergency bypass available)
- **emergency discovery**: Rate limit bypass for new/isolated nodes

## Requirements

### Browser Testing
- Modern browser with WebRTC DataChannel support
- WebAssembly support recommended for UI components
- HTTPS required for production WebRTC


## License

Mozilla Public License Version 2.0  
Copyright 2025 Ron Teitelbaum and YZ.Social  
See LICENSE file for full license text.
