# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

YZSocialC is a browser-based Distributed Hash Table (DHT) implementation using the Kademlia algorithm with WebRTC for peer-to-peer connections. The project aims to create a fully decentralized network with minimal server dependency, using only bootstrap servers for initial peer discovery.

## Development Setup

**Prerequisites:**
- Node.js 16+ with npm
- Modern browser with WebRTC support
- Optional: WebAssembly toolchain for UI components

**Installation:**
```bash
npm install
```

## Common Commands

**Development:**
- `npm run dev` - Start development server with hot reload
- `npm run build` - Build for production
- `npm run bootstrap` - Start bootstrap server for peer discovery
- `npm test` - Run tests
- `npm run lint` - Run ESLint
- `npm run clean` - Clean build artifacts

**Server Management:**
- `npm run shutdown` - Kill all YZSocialC servers (ports 3000, 8080, 8081)
- `npm run cleanup` - Alias for shutdown
- `npm run kill-ports` - Kill processes on default ports
- `npm run restart` - Shutdown and restart bootstrap server

**Bootstrap Server:**
- `node src/bootstrap/server.js` - Start signaling server on port 8080
- The bootstrap server is only used for initial peer discovery and ICE candidate exchange

## Project Architecture

### Core Components

**DHT Implementation (`src/dht/`):**
- `KademliaDHT.js` - Main DHT coordinator with WebRTC integration
- `RoutingTable.js` - Kademlia routing table with k-buckets and phantom peer validation
- DHT automatically switches from bootstrap signaling to DHT-based signaling once connected
- **Separation of Concerns**: `findNode()` is pure data lookup, `discoverPeers()` handles peer discovery

**Core Classes (`src/core/`):**
- `DHTNodeId.js` - 160-bit node identifiers with XOR distance calculations
- `DHTNode.js` - Represents peers in the DHT network
- `KBucket.js` - K-bucket implementation for routing table
- `InvitationToken.js` - Cryptographic chain-of-trust token system for secure peer invitations

**Network Layer (`src/network/`):**
- `WebRTCManager.js` - WebRTC connection management using native WebRTC API with Perfect Negotiation Pattern
- `OverlayNetwork.js` - Advanced overlay for direct peer connections and routing

**Bootstrap (`src/bootstrap/`):**
- `BootstrapClient.js` - Client for connecting to bootstrap servers
- `server.js` - WebSocket-based bootstrap/signaling server

**UI Layer (`src/ui/`):**
- `DHTVisualizer.js` - Web-based DHT network visualization and controls
- WebAssembly components for advanced UI (placeholder implementation)

### Key Features

1. **Kademlia DHT**: Full implementation with proper k-buckets, XOR distance routing
2. **WebRTC Transport**: Native WebRTC API with Perfect Negotiation Pattern for reliable P2P connections
3. **Minimal Server Dependency**: Aggressive transition to DHT-based signaling after first connection
4. **Chain of Trust Security**: Cryptographic invitation tokens prevent unauthorized network access
5. **DHT-Based ICE Candidate Exchange**: Complete WebRTC signaling (offers/answers/ICE) via DHT storage
6. **Temporary Bootstrap Usage**: Reconnect to bootstrap only when sending invitations
7. **Automatic Peer Discovery**: Enhanced k-bucket maintenance for small networks (3-10 nodes)
8. **Progressive Enhancement Cryptography**: Ed25519 with native browser crypto + library fallback

### Network Flow

1. **Genesis Bootstrap**: First node connects to bootstrap server (started with `-createNewDHT` flag) and receives genesis privileges
2. **Token-Based Invitations**: Genesis node creates cryptographic invitation tokens for new peers
3. **DHT Formation**: Establish WebRTC connections using invitation tokens, build routing table
4. **Chain of Trust**: Newly joined peers receive membership tokens and can invite others
5. **Immediate DHT Signaling**: Switch to DHT-based signaling after **first DHT connection** (not waiting for multiple peers)
6. **Bootstrap Disconnection**: Disconnect from bootstrap server, reconnect only for sending invitations
7. **DHT-Based Peer Discovery**: Automatic k-bucket maintenance discovers and connects peers via DHT (30-second intervals)
8. **Full Independence**: All WebRTC signaling (offers/answers/ICE candidates) stored in DHT with minimal server usage

### DHT Security Model

**Chain of Trust Architecture:**
- Bootstrap server designates first connecting node as genesis peer (server admin controlled)
- Genesis peer can invite initial peers using cryptographically signed invitation tokens
- Invited peers receive membership tokens and can invite others, creating a web of trust
- All invitation tokens are single-use, time-limited, and non-transferable
- Consumed tokens are stored in the DHT itself for decentralized validation

**Token-Based Access Control:**
- **Invitation Tokens**: Created by DHT members to invite specific new peers
- **Membership Tokens**: Prove a node is legitimately part of the DHT network
- **Cryptographic Signatures**: Ed25519 signatures prevent token forgery
- **Replay Protection**: Unique nonces prevent token reuse
- **Decentralized Validation**: DHT network stores consumed tokens and public keys

## Configuration

**DHT Parameters:**
- `k = 20` - Kademlia k parameter (bucket size)
- `alpha = 3` - Lookup parallelism
- `replicateK = 3` - Replication factor for stored data
- `refreshInterval = 30 seconds` - K-bucket maintenance frequency (dev-friendly)
- `pingInterval = 1 minute` - Node liveness check frequency

**DHT Signaling Transition:**
- **Immediate Switch**: Transition to DHT-based signaling after **≥1 DHT connection**
- **Bootstrap Usage**: Temporary reconnection only for sending invitations
- **Discovery Aggressiveness**: 30% search probability for networks <10 peers, 10% for larger
- **DHT Offer Polling**: Check for incoming WebRTC offers every 5 seconds

**WebRTC:**
- Uses Google STUN servers by default
- Supports up to 50 concurrent connections
- 30-second connection timeout
- **Perfect Negotiation Pattern**: Handles simultaneous connection attempts using node ID comparison (lower ID = polite peer)
- **DHT Storage Keys**: `webrtc_offer:from:to`, `webrtc_answer:from:to`, `ice_candidate:from:to:timestamp`

**Bootstrap Servers:**
- Default: `ws://localhost:8080`
- Fallback: `ws://localhost:8081`
- **Usage Pattern**: Connect → Send invitation → Disconnect (minimal server dependency)
- Start with `-createNewDHT` flag to enable genesis peer assignment

## Development Notes

**Architecture Decisions:**
- Uses native WebRTC API with Perfect Negotiation Pattern for maximum control and reliability
- Moved away from SimplePeer and PeerJS to eliminate external dependencies and improve collision handling
- **Hybrid Signaling Architecture**: Bootstrap signaling for new clients, direct DHT messaging for existing members
- **Message Queue System**: Ordered processing prevents race conditions and ensures reliable message delivery
- **DHT-Based Message Routing**: Multi-hop message delivery through existing DHT connections
- Replaced flawed storage polling with direct peer-to-peer messaging for WebRTC signaling
- Overlay network enables application-specific connection types

**Class Naming:**
- All DHT-related classes prefixed with "DHT" (e.g., `DHTNodeId`) to avoid confusion with Node.js

**Browser Compatibility:**
- Requires modern browser with WebRTC DataChannel support
- WebAssembly support recommended for UI components
- No Node.js dependencies in browser code

**Testing:**
- Bootstrap server must be running for DHT functionality
- Use browser dev tools to access `window.YZSocialC` debug interface
- Virtual node testing available for large-scale simulation

## Debugging

**Browser Console:**
```javascript
// Access DHT instance
YZSocialC.dht

// Get network statistics
YZSocialC.getStats()

// Test store/retrieve
await YZSocialC.testStore('key', 'value')
await YZSocialC.testGet('key')

// Get connected peers
YZSocialC.getPeers()

// Invitation token system
YZSocialC.inviteNewClient('target_node_id') // Invite peer to join DHT
YZSocialC.dht.createInvitationToken('target_node_id') // Create token manually

// DHT Signaling Control
YZSocialC.getSignalingMode() // Check current signaling mode
YZSocialC.switchToDHTSignaling() // Force switch to DHT-based ICE sharing

// Network Discovery & Maintenance (Updated for DHT Messaging)
YZSocialC.refreshBuckets() // Force k-bucket refresh and DHT peer discovery
YZSocialC.triggerPeerDiscovery() // Aggressive peer discovery using direct DHT messaging
YZSocialC.dht.discoverPeersViaDHT() // Manual DHT peer discovery via direct messaging

// Debug Tools
YZSocialC.debugConnectionState() // Analyze peer connections
YZSocialC.debugRoutingTable() // Check routing table consistency
YZSocialC.investigatePhantomPeer('suspect_id') // Debug phantom peer issues

// Export logs
YZSocialC.exportLogs()
```

**DHT Network Setup:**
```bash
# OPTION 1: Using npm scripts (recommended)
npm run bootstrap:genesis    # Start bootstrap server in genesis mode
npm run bootstrap           # Start bootstrap server in standard mode

# OPTION 2: Direct node command
node src/bootstrap/server.js -createNewDHT    # Genesis mode (server admin only)
node src/bootstrap/server.js                 # Standard mode

# Client workflow:
# 1. First client: YZSocialC.startDHT() -> becomes genesis peer automatically
# 2. Second client: YZSocialC.startDHT() -> waits for invitation
# 3. Genesis peer: YZSocialC.inviteNewClient('second_client_id')
# 4. Subsequent clients follow same pattern
```

**Network Behavior:**
- **Hybrid Signaling Mode**: Bootstrap server for new client invitations, direct DHT messaging for existing members
- **Message Queue Processing**: Ordered message handling per peer prevents race conditions
- **Direct DHT Messaging**: WebRTC signaling via `webrtc_offer`, `webrtc_answer`, `webrtc_ice` message types
- **Multi-Hop Routing**: Messages route through DHT network to reach target peers
- **Peer Discovery Messaging**: `peer_discovery_request`/`peer_discovery_response` for finding willing peers
- **Automatic Discovery**: K-bucket maintenance runs every 30 seconds, using direct DHT messaging for peer discovery
- **Bootstrap Usage**: Only used for invitations and initial DHT joining, not for member-to-member signaling

**Common Issues:**
- Ensure bootstrap server is running before starting DHT
- Bootstrap server must be started with `-createNewDHT` for first network setup
- New peers require valid invitation tokens from existing DHT members
- DHT signaling requires at least 1 existing connection to store/retrieve WebRTC signals
- WebRTC connections require STUN/TURN servers for NAT traversal
- Browser security requires HTTPS for WebRTC in production
- Invitation tokens expire after 30 minutes by default
- K-bucket refresh may take 30+ seconds - use `YZSocialC.refreshBuckets()` for immediate testing

**DHT Direct Messaging System (IMPLEMENTED):**
- **Problem Solved**: Replaced flawed DHT storage polling with direct peer-to-peer messaging through existing DHT connections
- **Architecture**: 
  - **Bootstrap Signaling**: Still used for new client invitations and initial DHT joining
  - **DHT Messaging**: Used for WebRTC signaling between existing DHT members
  - **Message Queue**: Ordered processing of multiple incoming messages per peer
  - **Message Routing**: DHT-based routing of messages to target peers through intermediate nodes
- **Implementation**: 
  - Added `webrtc_offer`, `webrtc_answer`, `webrtc_ice` message types to DHT protocol
  - Implemented `sendWebRTCOffer()`, `sendWebRTCAnswer()`, `sendWebRTCIceCandidate()` methods
  - Added `routeWebRTCMessage()` for multi-hop message delivery through DHT
  - Integrated `peer_discovery_request`/`peer_discovery_response` for peer discovery
- **Message Queue System**: 
  - Prevents concurrent message processing per peer
  - Handles message ordering and timeout cleanup
  - Memory leak protection with queue size limits
- **Signaling Flow**:
  - New clients: Bootstrap server → WebRTC connection → DHT membership
  - Existing members: Direct DHT messaging → WebRTC negotiation
- **Debug Tools**: Monitor with `YZSocialC.debugConnectionState()` and message queue logs

**Phantom Peer Issues:**
- **Symptom**: Random node IDs appearing in logs causing endless connection attempts
- **Root Cause**: Storage key hashes, random IDs, or DHT maintenance IDs being mistaken for real peer nodes
- **Key Insight**: Only peers with invitation tokens are legitimate node IDs - random IDs are not real clients
- **Fix Applied**: Separated `findNode()` data lookup from peer discovery to prevent phantom peers
- **Validation**: Added routing table validation to reject likely phantom peer IDs
- **Debug Tools**: Use `YZSocialC.investigatePhantomPeer('id')` to analyze suspicious peers