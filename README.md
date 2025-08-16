# YZSocialC

A browser-based Distributed Hash Table (DHT) implementation using the Kademlia algorithm with WebRTC for peer-to-peer connections. Creates a fully decentralized network with minimal server dependency.

## Features

- **Kademlia DHT**: Literature-compliant implementation with adaptive refresh and k-buckets
- **Native WebRTC**: Direct peer-to-peer connections with Perfect Negotiation Pattern and keep-alive
- **Minimal Server Dependency**: Bootstrap server only for initial peer discovery
- **Chain of Trust Security**: Cryptographic invitation tokens prevent unauthorized access
- **DHT-Based Signaling**: Complete WebRTC negotiation through DHT messaging with signal handling
- **Adaptive Performance**: 15s refresh for new nodes, 10min for established (following literature)
- **Connection Resilience**: Keep-alive for inactive tabs, emergency discovery bypass, connection health monitoring
- **Browser-First**: No Node.js dependencies in client code

## Quick Start

```bash
# Install dependencies
npm install

# Start bootstrap server
npm run bootstrap:genesis

# Start development server
npm run dev
```

Open your browser to the development server URL. The first client becomes the genesis peer automatically.

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

# Server Management
npm run bootstrap       # Start bootstrap server
npm run bootstrap:genesis  # Start in genesis mode
npm run shutdown        # Kill all servers
npm run restart         # Restart bootstrap server


# Debugging
npm run kill-ports      # Kill processes on default ports
npm run start-all       # Start all services
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

1. Start bootstrap server: `npm run bootstrap:genesis`
2. Start dev server: `npm run dev`
3. Open browser to dev server URL
4. First client becomes genesis peer automatically
5. Use invite button to add more peers



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

## Security Model

- **Chain of Trust**: Genesis peer controls initial network access
- **Invitation Tokens**: Ed25519-signed, single-use, time-limited
- **Replay Protection**: Unique nonces prevent token reuse
- **Decentralized Validation**: DHT stores consumed tokens and public keys

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