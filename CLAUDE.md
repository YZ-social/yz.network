# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

YZSocialC is a browser-based Distributed Hash Table (DHT) implementation using the Kademlia algorithm with WebRTC for peer-to-peer connections. The project aims to create a fully decentralized network with minimal server dependency, using only bootstrap servers for initial peer discovery.

## Development Setup

**Prerequisites:**
- Node.js 16+ with npm
- Modern browser with WebRTC support
- Optional: WebAssembly toolchain for UI components
- Optional: WSL2 (for Windows development)

**Installation:**
```bash
npm install
```

## Common Commands

**Development:**
- `npm run dev` - Start development server with hot reload
- `npm run build` - Build for production
- `npm test` - Run tests
- `npm run lint` - Run ESLint
- `npm run clean` - Clean build artifacts

**Bridge System (Recommended - Multi-Terminal Setup):**
- **Terminal 1:** `npm run bridge-nodes` - Start internal bridge nodes FIRST (ports 8083, 8084)
- **Terminal 2:** `npm run bridge-bootstrap` - Start public bootstrap server (port 8080)
- **Terminal 2 (Genesis):** `npm run bridge-bootstrap:genesis` - Create new DHT network

**Bridge System (Single Command - Development):**
- `npm run bridge` - Start complete bridge system (all components together)
- `npm run bridge:genesis` - Start bridge system in genesis mode (creates new DHT)

**Server Management:**
- `npm run shutdown` - Kill all YZSocialC servers (ports 3000, 8080-8084, 9083-9084)
- `npm run cleanup` - Alias for shutdown
- `npm run kill-ports` - Kill processes on default ports
- `npm run restart` - Shutdown and restart complete bridge system
- `npm run restart:genesis` - Shutdown and restart bridge system in genesis mode

## Project Architecture

### Core Components

**DHT Implementation (`src/dht/`):**
- `KademliaDHT.js` - Main DHT coordinator with WebRTC integration, adaptive refresh, and passive mode support
- `RoutingTable.js` - Kademlia routing table with k-buckets and phantom peer validation
- DHT automatically switches from bootstrap signaling to DHT-based signaling once connected
- **Integrated Discovery**: `findNode()` performs lookup AND adds discovered peers to routing table for proper Kademlia operation
- **Passive Mode**: Observer-only mode for bridge nodes that monitor without participating in DHT operations

**Core Classes (`src/core/`):**
- `DHTNodeId.js` - 160-bit node identifiers with XOR distance calculations
- `DHTNode.js` - **ENHANCED** - Represents peers with per-node connection management, event handlers, and transport abstraction
- `DHTDataID.js` - Data identifiers for DHT storage
- `KBucket.js` - K-bucket implementation for routing table with staleness-based cleanup
- `InvitationToken.js` - Cryptographic chain-of-trust token system for secure peer invitations

**Network Layer (`src/network/`) - CLEAN OBJECT-ORIENTED ARCHITECTURE:**
- `ConnectionManager.js` - **ABSTRACT BASE CLASS** - Implements ALL protocol logic (ping/pong, find_node, store/get, message routing)
- `WebRTCConnectionManager.js` - **WebRTC Transport Subclass** - Extends ConnectionManager for Browser↔Browser P2P connections
- `WebSocketConnectionManager.js` - **WebSocket Transport Subclass** - Extends ConnectionManager for Browser↔Node.js and Node.js↔Node.js connections
- `ConnectionManagerFactory.js` - **Clean Factory Pattern** - Creates appropriate transport managers based on connection matrix
- `OverlayNetwork.js` - Advanced overlay for direct peer connections and routing

**⚠️ CRITICAL ARCHITECTURE PRINCIPLES - ROUTING-TABLE-BASED CONNECTION MANAGEMENT:**
- **RoutingTable manages all connection events** - Central event hub where DHTNodes live
- **Uniform transport handling** - No distinction between WebRTC, WebSocket, or future transport types
- **Single event handler pattern** - One `peerConnectedHandler` works for all connection managers
- **DHT delegation** - DHT focuses on protocol logic, delegates connection management to RoutingTable
- **Per-node connection lifecycle** - Each DHTNode owns its connectionManager and connection object
- **Event handler isolation** - Each connection has isolated handlers, preventing cross-connection interference
- **Transport agnostic design** - Adding new transports requires no architectural changes

**Bridge System (`src/bridge/`) - NEW:**
- `PassiveBridgeNode.js` - Internal DHT observer for reconnection services (ports 8083, 8084)
- `EnhancedBootstrapServer.js` - Public bootstrap server with bridge integration (port 8080)
- `start-bridge-system.js` - Complete bridge system deployment and management
- **Two-Tier Security**: Public bootstrap edge + internal bridge network for minimal attack surface

**Bootstrap (`src/bootstrap/`):**
- `BootstrapClient.js` - Client for connecting to bootstrap servers
- `server.js` - Legacy WebSocket-based bootstrap/signaling server (basic mode)

**UI Layer (`src/ui/`):**
- `DHTVisualizer.js` - Web-based DHT network visualization and controls
- WebAssembly components for advanced UI (placeholder implementation)

### Key Features

1. **Kademlia DHT**: Full implementation with proper k-buckets, XOR distance routing
2. **WebRTC Transport**: Native WebRTC API with Perfect Negotiation Pattern for reliable P2P connections
3. **Minimal Server Dependency**: Aggressive transition to DHT-based signaling after first connection
4. **Chain of Trust Security**: Cryptographic invitation tokens prevent unauthorized network access
5. **DHT-Based ICE Candidate Exchange**: Complete WebRTC signaling (offers/answers/ICE) via DHT storage
6. **Serverless Reconnection System**: Bridge nodes enable disconnected peers to rejoin without new invitations
7. **Passive Bridge Monitoring**: Bridge nodes observe DHT network without participating in operations
8. **Network Health Verification**: Cryptographic fingerprints ensure reconnection to correct DHT network
9. **Two-Tier Security Architecture**: Public bootstrap edge with internal bridge network for minimal attack surface
10. **Adaptive Refresh System**: Literature-compliant Kademlia refresh with adaptive timing (15s for new nodes, 10min for established nodes)
11. **Progressive Enhancement Cryptography**: Ed25519 with native browser crypto + library fallback
12. **Peer Announcement System**: Active nodes broadcast status to bridge observers for network health assessment
13. **Background Maintenance System**: Automatic periodic maintenance following Kademlia specifications - bucket refresh (60s) and connection management (30s) ensuring routing table entries represent reachable peers
14. **Per-Node Connection Management**: Each DHTNode owns its connectionManager and connection object, eliminating centralized event handling
15. **Self-Managing Event Handlers**: Nodes set up and tear down their own event handlers, preventing cross-connection interference

### Per-Node Connection Architecture with RoutingTable Event Management

**Routing-Table-Based Connection Management:**
- **RoutingTable as Event Hub**: RoutingTable manages all connection events from transport managers
- **Uniform Event Handling**: Single event handler works for all transport types (WebRTC, WebSocket, etc.)
- **Automatic Node Creation**: RoutingTable creates and configures DHTNodes when connections arrive
- **DHT Delegation**: DHT delegates all connection management to RoutingTable
- **Transport Agnostic**: No distinction between connection manager types - all treated uniformly

**Connection Setup Flow (UPDATED):**
1. **Transport Manager Initialization**: All transport managers registered with RoutingTable
2. **Connection Established**: Any transport manager creates connection and emits `{ peerId, connection, manager, initiator }`
3. **RoutingTable Event Reception**: RoutingTable receives event via unified `peerConnectedHandler`
4. **Automatic Node Creation**: RoutingTable creates DHTNode and calls `node.setupConnection(manager, connection)`
5. **Per-Node Event Setup**: DHTNode sets up its own connection-specific event handlers
6. **DHT Notification**: RoutingTable notifies DHT via `handleRoutingTableEvent('nodeAdded')`
7. **Protocol Processing**: DHT handles high-level protocol events (peer discovery, DHT operations)

**Architecture Benefits:**
- **Single Event Handler**: One handler works for all connection manager types
- **No Transport Discrimination**: WebRTC and WebSocket treated identically
- **RoutingTable Ownership**: Connection management centralized where nodes live
- **Clean DHT Separation**: DHT focuses on protocol, RoutingTable handles connections
- **Scalable Design**: Adding new transports requires no DHT or RoutingTable changes

### Network Flow

#### New Peer Invitation Flow:
1. **Genesis Bootstrap**: First client connects to bridge system (started with `-createNewDHT` flag) and becomes genesis peer temporarily
2. **Automatic Bridge Connection**: Bootstrap server immediately connects genesis client to bridge node as first DHT peer
3. **Genesis Status Removal**: Bridge connection removes genesis status and provides valid DHT membership token
4. **Token-Based Invitations**: Former genesis client can now create cryptographic invitation tokens for new peers
5. **DHT Formation**: New peers establish WebRTC connections using invitation tokens, build routing table
6. **Chain of Trust**: Newly joined peers receive membership tokens and can invite others
7. **Bridge Network Growth**: Bridge node discovers additional peers through normal K-bucket maintenance
8. **Peer Announcements**: Active nodes periodically broadcast status to bridge observers
9. **Adaptive Bucket Maintenance**: Kademlia-compliant staleness-based refresh with adaptive timing (15s for isolated nodes, 10min for well-connected nodes)

#### Serverless Reconnection Flow (NEW):
1. **Bridge System Startup**: Enhanced bootstrap server + internal passive bridge nodes start monitoring DHT
2. **Network Observation**: Bridge nodes passively monitor DHT traffic and peer announcements
3. **Disconnected Peer Return**: Peer with valid membership token connects to public bootstrap server
4. **Token-Based Routing**: Bootstrap server detects membership token and routes to internal bridge node
5. **Network Health Validation**: Bridge node validates token and verifies DHT network integrity through observations
6. **Reconnection Authorization**: Bridge approves reconnection to authenticated DHT network (not isolated fragment)
7. **DHT Rejoin**: Peer successfully rejoins main DHT network without requiring new invitation
8. **Full Independence**: All signaling via DHT with minimal server dependency after reconnection

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

### Bridge System Architecture (CORRECTED)

**Two-Tier Security Model:**
- **Public Layer**: Enhanced bootstrap server (port 8080) - only component exposed to internet
- **Private Layer**: Bridge nodes (ports 8083, 8084) - internal network only, Node.js DHT clients in limited mode
- **Authenticated Communication**: Shared secrets between bootstrap and bridge nodes
- **Minimal Attack Surface**: Bridge nodes cannot be directly attacked from internet

**Bridge Node Features (Node.js DHT Clients):**
- **Limited DHT Participants**: Act as DHT nodes but with restricted operations (no storage, limited routing)
- **WebSocket Server Mode**: Accept both bootstrap server connections AND DHT peer connections
- **Connection Matrix Support**: 
  - Browser → Bridge Node: WebSocket connection (Bridge acts as WebSocket server)
  - Bootstrap → Bridge Node: WebSocket connection for coordination
- **Automatic Genesis Connection**: Genesis peer (browser) connects to bridge node via WebSocket
- **Network Health Monitoring**: Passively observes peer announcements and connection status through DHT participation
- **Reconnection Validation**: Verifies membership tokens and assesses DHT network integrity
- **K-Bucket Maintenance**: Participates in k-bucket maintenance and peer discovery like regular DHT nodes
- **Network Fingerprinting**: Creates cryptographic signatures of network state for integrity verification
- **DHT Message Processing**: Can send/receive DHT messages but with limited operational scope

**Enhanced Bootstrap Server Features:**
- **Dual-Mode Operation**: Handles both new peer invitations and reconnection requests
- **Token-Based Routing**: Automatically detects membership tokens vs new peer registrations
- **Bridge Integration**: Routes reconnection requests to internal bridge nodes for validation
- **Public Edge Security**: Only WebRTC signaling exposed, no DHT operations or sensitive data

**Reconnection Security Model:**
- **Membership Token Validation**: Bridge nodes verify cryptographic membership tokens
- **Network Integrity Checks**: Ensure reconnection to main DHT network, not isolated fragments
- **Consensus-Based Validation**: Multiple bridge nodes can verify network health independently
- **Minimal Privilege Access**: Bridge nodes have read-only access to DHT for validation only

**Deployment Architecture:**
```
Internet → Enhanced Bootstrap (8080) ← Internal Bridge Nodes (8083, 8084)
                   ↓                            ↕
               DHT Clients ←→ DHT Clients ←→ Bridge Nodes (DHT Participants)
                   ↕              ↕                      ↕
               P2P Network    P2P Network           DHT Network
```

**Connection Matrix (CLEAN ARCHITECTURE):**
- **Browser ↔ Browser**: WebRTCConnectionManager (P2P with Perfect Negotiation Pattern)
- **Browser → Node.js**: WebSocketConnectionManager (Node.js is WebSocket server)
- **Node.js → Browser**: WebSocketConnectionManager (Node.js is WebSocket server)  
- **Node.js ↔ Node.js**: WebSocketConnectionManager (Server/client WebSocket connections)

**Transport Selection Implementation:**
```javascript
// Clean factory method - NO HYBRID MANAGERS
ConnectionManagerFactory.createForConnection(localNodeType, targetNodeType, options)

// DHT uses static methods on abstract class
ConnectionManager.initializeTransports(nodeType, options)
ConnectionManager.getManagerForPeer(peerId, metadata) 
```

**Why This Architecture Prevents "Case Hell":**
- **Single Responsibility**: Each manager handles exactly ONE transport type
- **Clear Boundaries**: Protocol logic separate from transport implementation
- **Easy Testing**: Test each transport manager independently  
- **Simple Debugging**: Know exactly which class handles each connection type
- **Maintainable**: Add new transports without touching existing code

## INVARIANT: Connection-Agnostic Design Principle

**CRITICAL ARCHITECTURAL RULE**: The DHT layer MUST remain completely connection-agnostic.

**Forbidden in DHT Code:**
- ❌ `webrtc`, `websocket`, `WebRTC`, `WebSocket` references
- ❌ `this.connectionManager` (DHT-level connection manager)
- ❌ Connection-specific logic (browser/nodejs matrix, transport selection)
- ❌ Transport-specific event handling
- ❌ Hardcoded connection types or capabilities

**Required in DHT Code:**
- ✅ Use `this.getOrCreatePeerNode(peerId, metadata)` helper method
- ✅ Use `peerNode.connectionManager` (per-node managers)
- ✅ Generic terms: "connection", "signal", "peer", "transport" 
- ✅ Delegate ALL connection logic to ConnectionManager subclasses
- ✅ Store metadata on DHTNode instances, not in DHT directly

**Per-Node Connection Architecture:**
```javascript
// CORRECT: Use getOrCreatePeerNode helper (RECOMMENDED)
const peerNode = this.getOrCreatePeerNode(peerId, metadata);
await peerNode.connectionManager.createConnection(peerId, true);

// CORRECT: Manual approach (when getOrCreatePeerNode isn't suitable)
const peerNode = this.routingTable.getNode(peerId);
if (!peerNode.connectionManager) {
  peerNode.connectionManager = ConnectionManagerFactory.getManagerForPeer(peerId, metadata);
}
await peerNode.connectionManager.createConnection(peerId, true);

// INCORRECT: DHT-level connection manager (REMOVED IN REFACTORING)
await this.connectionManager.createConnection(peerId, true); // ❌ FORBIDDEN
```

**Factory Responsibility:**
- Auto-detect node type from environment (`detectNodeType()`)
- Create appropriate managers based on peer metadata
- Handle transport selection logic (Browser↔Browser = WebRTC, others = WebSocket)
- Extensible for future transports (LoRa, Bluetooth, etc.)

**Implementation Status:**
- ✅ **COMPLETED**: All 40+ `this.connectionManager` references removed from KademliaDHT.js
- ✅ **COMPLETED**: Connection-specific methods (`handleWebSocketCoordination`, `connectToWebSocketPeer`, `storePeerMetadataOnNode`) removed
- ✅ **COMPLETED**: DHT signaling made transport-agnostic (routes only, doesn't process WebRTC/WebSocket specifics)
- ✅ **COMPLETED**: Bridge node connection issue fixed (now establishes WebSocket connections after invitation)

**This Invariant Enables:**
- Clean separation of concerns
- Easy addition of new transport types  
- Transport-agnostic DHT protocol implementation
- Simplified testing and debugging
- Prevention of connection-specific bugs in DHT logic

## Configuration

**DHT Parameters:**
- `k = 20` - Kademlia k parameter (bucket size)
- `alpha = 3` - Lookup parallelism
- `replicateK = 3` - Replication factor for stored data
- `aggressiveRefreshInterval = 15 seconds` - For new/isolated nodes (< 2 peers)
- `standardRefreshInterval = 10 minutes` - For well-connected nodes (following IPFS/literature standards)
- `pingInterval = 1 minute` - Node liveness check frequency
- `refreshInterval = 60 seconds` - Background bucket refresh interval (automatic maintenance)
- `connectionMaintenanceInterval = 30 seconds` - Background connection attempts to routing table entries

**DHT Signaling Transition:**
- **Immediate Switch**: Transition to DHT-based signaling after **≥1 DHT connection**
- **Bootstrap Usage**: Temporary reconnection only for sending invitations
- **Adaptive Discovery**: Emergency mode for isolated nodes, staleness-based refresh for established networks
- **DHT Offer Polling**: Check for incoming WebRTC offers every 5 seconds

**WebRTC:**
- Uses Google STUN servers by default
- Supports up to 50 concurrent connections
- 30-second connection timeout
- **Perfect Negotiation Pattern**: Handles simultaneous connection attempts using node ID comparison (lower ID = polite peer)
- **DHT Storage Keys**: `webrtc_offer:from:to`, `webrtc_answer:from:to`, `ice_candidate:from:to:timestamp`

**Bridge System Configuration:**
- **Enhanced Bootstrap**: `ws://localhost:8080` (public-facing)
- **Bridge Nodes**: `localhost:8083`, `localhost:8084` (internal only)
- **Bridge Authentication**: Shared secret between bootstrap and bridge nodes
- **Max Peers**: 1000 concurrent connections (configurable)
- **Bridge Timeout**: 30 seconds for reconnection validation

**Legacy Bootstrap Servers:**
- Default: `ws://localhost:8080`
- Fallback: `ws://localhost:8081`
- **Usage Pattern**: Connect → Send invitation → Disconnect (minimal server dependency)
- Start with `-createNewDHT` flag to enable genesis peer assignment
- **Note**: Legacy mode does not support reconnection services

**Environment Variables:**
```bash
BRIDGE_AUTH=your-secure-bridge-auth-key
BOOTSTRAP_PORT=8080
BRIDGE_PORT_1=8083  
BRIDGE_PORT_2=8084
MAX_PEERS=1000
```

## Development Notes

### 🏗️ Connection Manager Architecture (MANDATORY DESIGN PATTERN)

**CRITICAL IMPLEMENTATION RULE:** This codebase uses a clean class hierarchy for connection management. **NEVER revert to hybrid/composite managers.**

**Class Hierarchy (MUST MAINTAIN):**
```javascript
ConnectionManager (abstract base class)
├── Protocol methods: ping(), sendMessage(), handleMessage()
├── Static transport delegation: getManagerForPeer(), initializeTransports()
├── Event emission: 'peerConnected', 'peerDisconnected', 'data'
└── Abstract methods: createConnection(), sendRawMessage(), isConnected()

WebRTCConnectionManager extends ConnectionManager
├── WebRTC transport implementation only
├── Perfect Negotiation Pattern for Browser↔Browser P2P
└── DataChannel message handling

WebSocketConnectionManager extends ConnectionManager  
├── WebSocket transport implementation only
├── Server mode for Node.js environments
└── Client mode for Browser→Node.js connections

ConnectionManagerFactory (static methods only)
└── createForConnection(localType, targetType) -> returns correct manager
```

**Transport Selection Matrix (ENFORCED BY FACTORY):**
- Browser → Browser: `WebRTCConnectionManager` (P2P)
- Browser → Node.js: `WebSocketConnectionManager` (Node.js server)
- Node.js → Browser: `WebSocketConnectionManager` (Node.js server)
- Node.js → Node.js: `WebSocketConnectionManager` (traditional client/server)

**Why This Design Is Mandatory:**
1. **Eliminates Case Hell**: No if/else chains checking transport types
2. **Single Responsibility**: Each class handles exactly ONE transport 
3. **Easy Debugging**: Know exactly which file to check for transport issues
4. **Testable**: Test each transport independently without interference
5. **Maintainable**: Add new transports without modifying existing code
6. **Protocol Consistency**: All managers implement same protocol interface

**Implementation in DHT:**
```javascript
// Initialize transport managers (called once)
ConnectionManagerFactory.initializeTransports(nodeType, options);

// Each DHTNode holds its own connection manager (assigned during routing table addition)
const node = new DHTNode(peerId);
node.connectionManager = ConnectionManagerFactory.getManagerForPeer(peerId, metadata);
this.routingTable.addNode(node);

// Send messages through the node's connection manager
await node.sendMessage(message);        // Clean object-oriented approach
const isConnected = node.isConnected(); // Node knows its own connection state
```

**Object-Oriented Connection Management (PREFERRED ARCHITECTURE):**
- Each `DHTNode` instance holds its own `connectionManager` reference
- `node.isConnected()` - checks connection through its assigned manager
- `node.sendMessage(message)` - sends via its assigned manager  
- `dht.getAllConnectedPeers()` - filters routing table nodes by `node.isConnected()`
- No centralized peer-to-manager mapping needed

**Why Node-Based Connection Management Is Superior:**
1. **Scalability**: Adding new transport types just requires setting `node.connectionManager`
2. **Performance**: No factory lookups on every message send
3. **Encapsulation**: Each node knows how to communicate with itself
4. **Simplicity**: DHT doesn't need to track peer-to-manager mappings
5. **Object-Oriented**: Follows proper OOP principles - objects manage their own state
6. **Debuggability**: Easy to inspect which transport each node uses
7. **Flexibility**: Different nodes can use different transport managers simultaneously

**⛔ FORBIDDEN PATTERNS:**
- Hybrid managers with transport switching logic
- Composite managers that delegate internally  
- Instance-level transport selection
- Protocol logic mixed with transport code
- Case statements checking transport types in business logic
- Centralized peer-to-manager mapping (brittle, doesn't scale)
- Factory lookups for every message send (performance bottleneck)
- **Transport-specific event handling** - Use uniform handlers for all transport types
- **DHT-level connection management** - Delegate to RoutingTable where nodes live
- **Cross-connection event interference** - Each connection must have isolated handlers

**Architecture Decisions:**
- Uses native WebRTC API with Perfect Negotiation Pattern for maximum control and reliability
- Migrated away from SimplePeer and PeerJS to eliminate external dependencies and improve collision handling
- **CLEAN CLASS HIERARCHY**: Abstract ConnectionManager base class + transport-specific subclasses
- **NO HYBRID MANAGERS**: Eliminated hybrid/composite patterns that create unmaintainable "case hell"
- **Factory Pattern Transport Selection**: Clean separation of transport selection from protocol implementation
- **RoutingTable-Based Connection Management**: RoutingTable manages all connection events uniformly
- **Transport-Agnostic Event Handling**: Single event handler pattern works for all transport types
- **DHT Protocol Focus**: DHT delegates connection management, focuses on protocol operations
- **Per-Node Connection Ownership**: Each DHTNode owns its connectionManager and connection object
- **Single Responsibility Principle**: Each manager handles exactly one transport type
- **Protocol/Transport Separation**: All protocol logic in base class, transport details in subclasses
- **Message Queue System**: Ordered processing prevents race conditions and ensures reliable message delivery
- **DHT-Based Message Routing**: Multi-hop message delivery through existing DHT connections
- Replaced flawed storage polling with direct peer-to-peer messaging for WebRTC signaling
- Overlay network enables application-specific connection types

**⚠️ CRITICAL: Why Hybrid Managers Were Eliminated:**
- **Case Hell**: Too many if/else statements checking transport types
- **Debugging Nightmare**: Hard to trace which code path handles each connection
- **Maintenance Horror**: Adding features requires touching multiple code paths
- **Testing Complexity**: Impossible to test transport logic in isolation
- **Code Duplication**: Similar logic scattered across multiple conditional branches
- **Clean Hierarchy Solution**: Each class has ONE job, easy to understand and maintain

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

// Adaptive Refresh System (Literature-Compliant)
YZSocialC.getAdaptiveRefreshStatus() // Check adaptive refresh status and bucket staleness
YZSocialC.forceAdaptiveRefresh() // Force recalculation of refresh timing
YZSocialC.refreshStaleBuckets() // Manually refresh only stale buckets

// WebRTC Keep-Alive System (NEW)
YZSocialC.getKeepAliveStatus() // Check WebRTC keep-alive status for inactive tabs
YZSocialC.testKeepAlivePing(peerId) // Manually send keep-alive ping to test connection
YZSocialC.simulateTabVisibilityChange() // Test inactive tab behavior
YZSocialC.checkConnectionHealth() // Check connection health for all peers
YZSocialC.debugWebRTCStates() // Debug WebRTC connection states and issues

// Network Discovery & Maintenance
YZSocialC.refreshBuckets() // Legacy: Force k-bucket refresh and DHT peer discovery
YZSocialC.triggerPeerDiscovery() // Aggressive peer discovery using direct DHT messaging

// Background Maintenance System (NEW)
YZSocialC.dht.maintainRoutingTableConnections() // Manually trigger connection maintenance
YZSocialC.dht.startBackgroundMaintenance() // Start background maintenance processes
YZSocialC.dht.stopBackgroundMaintenance() // Stop background maintenance processes
// Check routing table vs connections compliance
console.log('Routing entries:', YZSocialC.dht.routingTable.getAllNodes().length);
console.log('Active connections:', YZSocialC.dht.connectionManager.getConnectedPeers().length);

// Debug Tools
YZSocialC.debugConnectionState() // Analyze peer connections
YZSocialC.debugRoutingTable() // Check routing table consistency
YZSocialC.investigatePhantomPeer('suspect_id') // Debug phantom peer issues
YZSocialC.getTrafficStats() // Monitor find_node rate limiting and DHT traffic

// RoutingTable-Based Connection Management Debugging (NEW)
YZSocialC.debugNodeConnections() // Inspect each node's connection manager and event handlers
YZSocialC.dht.routingTable.getAllNodes().forEach(node => {
  console.log(`${node.id.toString().substring(0,8)}...`, {
    hasConnectionManager: !!node.connectionManager,
    managerType: node.connectionManager?.constructor.name,
    hasConnection: !!node.connection,
    eventHandlersSetup: node.eventHandlersSetup,
    connectionState: node.getConnectionState(),
    isConnected: node.isConnected()
  });
});

// Test RoutingTable event handling
console.log('RoutingTable event handlers setup:', YZSocialC.dht.routingTable.eventHandlersSetup);
console.log('RoutingTable total nodes:', YZSocialC.dht.routingTable.totalNodes);

// Test individual node communication
const nodes = YZSocialC.dht.routingTable.getAllNodes();
if (nodes.length > 0) {
  const testNode = nodes[0];
  testNode.sendMessage({type: 'ping', timestamp: Date.now()})
    .then(() => console.log('✅ Direct node communication working'))
    .catch(err => console.error('❌ Direct node communication failed:', err));
}

// Debug transport manager uniformity
ConnectionManagerFactory.managers.forEach((manager, type) => {
  console.log(`${type} manager:`, {
    hasEventHandlers: !!manager.listeners?.peerConnected?.length,
    localNodeId: manager.localNodeId?.substring(0, 8)
  });
});

// Export logs
YZSocialC.exportLogs()

// Bridge System Reconnection Testing (NEW)
YZSocialC.testReconnection() // Test reconnection with existing membership token
YZSocialC.getMembershipToken() // Get current membership token for manual reconnection
YZSocialC.simulateDisconnection() // Disconnect and test reconnection flow
```

**Bridge System Debugging (NEW):**

*Server-Side Bridge Monitoring:*
```javascript
// Bridge node status (run in Node.js bridge environment)
bridgeNode.getStatus() // Get bridge node health and statistics
bridgeNode.connectedPeers.size // Number of observed peer connections
bridgeNode.peerAnnouncements.size // Number of valid peer announcements
bridgeNode.networkFingerprint // Current network fingerprint hash

// Enhanced bootstrap server status
bootstrapServer.getStats() // Get bootstrap server statistics
bootstrapServer.peers.size // Current connected peers
bootstrapServer.bridgeConnections.size // Connected bridge nodes
```

*Network Health Verification:*
```javascript
// Browser console - check routing table persistence fix
console.log('Connected peers:', YZSocialC.dht.connectionManager.getConnectedPeers().length);
console.log('Routing table size:', YZSocialC.dht.routingTable.getAllNodes().length);
console.log('Last-seen updates:', YZSocialC.dht.routingTable.getAllNodes().map(n => ({ 
  id: n.id.toString().substring(0,8), 
  lastSeen: new Date(n.lastSeen).toISOString() 
})));

// Peer announcement monitoring
YZSocialC.dht.sendPeerAnnouncement() // Manually send peer announcement
YZSocialC.dht.startPeerAnnouncements() // Start periodic announcements
YZSocialC.dht.stopPeerAnnouncements() // Stop announcements

// Network fingerprint calculation
await YZSocialC.dht.calculateNetworkFingerprint() // Get current network fingerprint
```

**DHT Network Setup:**

*Multi-Terminal Setup (Recommended for Production):*
```bash
# Terminal 1: Start bridge nodes FIRST (internal services)
npm run bridge-nodes

# Terminal 2: Start enhanced bootstrap server (public-facing)
# For creating NEW DHT network:
npm run bridge-bootstrap:genesis    # First client becomes genesis

# For connecting to EXISTING DHT network:
npm run bridge-bootstrap           # All clients need invitations

# Environment configuration
BRIDGE_AUTH=your-secure-key BOOTSTRAP_PORT=8080 npm run bridge-bootstrap:genesis

# Client workflow (CORRECTED):
# 1. First client: YZSocialC.startDHT() -> becomes genesis peer
# 2. Genesis peer automatically connects to bridge node via WebSocket -> appears as connected peer
# 3. Genesis peer can invite others: YZSocialC.inviteNewClient('second_client_id')
# 4. Bridge node participates in DHT as limited Node.js client
# 5. Disconnected clients: Can reconnect automatically using membership tokens
```

*Single Command Setup (Development):*
```bash
# All-in-one startup (starts bridge nodes + bootstrap server together)
npm run bridge:genesis    # Start complete system in genesis mode (creates new DHT)
npm run bridge           # Start complete system in standard mode (existing DHT)
```

*Individual Server Control (Advanced):*
```bash
# Start bridge nodes only
node src/bridge/start-bridge-nodes.js

# Start enhanced bootstrap only (requires bridge nodes running)
node src/bridge/start-enhanced-bootstrap.js -createNewDHT    # Genesis mode
node src/bridge/start-enhanced-bootstrap.js                 # Standard mode
```


**Network Behavior:**
- **Hybrid Signaling Mode**: Bootstrap server for new client invitations, direct DHT messaging for existing members
- **Message Queue Processing**: Ordered message handling per peer prevents race conditions
- **Direct DHT Messaging**: WebRTC signaling via `webrtc_offer`, `webrtc_answer`, `webrtc_ice` message types
- **Multi-Hop Routing**: Messages route through DHT network to reach target peers
- **Peer Discovery Messaging**: `peer_discovery_request`/`peer_discovery_response` for finding willing peers
- **Adaptive Discovery**: K-bucket maintenance with adaptive timing - 15s for new nodes, 10min for established nodes, using staleness-based refresh
- **Bootstrap Usage**: Only used for invitations and initial DHT joining, not for member-to-member signaling

**Common Issues:**
- Ensure bridge system or bootstrap server is running before starting DHT
- Bridge system must be started with `-createNewDHT` for first network setup
- **Genesis Connection Process**: First client automatically connects to bridge node, removing genesis status
- New peers require valid invitation tokens from existing DHT members (issued by former genesis client)
- Disconnected peers can reconnect automatically with bridge system (not legacy bootstrap)
- DHT signaling requires at least 1 existing connection to store/retrieve WebRTC signals
- WebRTC connections require STUN/TURN servers for NAT traversal
- Browser security requires HTTPS for WebRTC in production
- Invitation tokens expire after 30 minutes by default
- K-bucket refresh is adaptive - new nodes refresh every 15s, established nodes every 10min
- **Routing Table Persistence**: Fixed issue where connected peers had empty routing tables (3 connected, 0 routing) - now uses staleness-based cleanup instead of connection-based removal


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
- **Fix Applied**: Disabled flawed phantom peer detection that was incorrectly rejecting legitimate connected peers
- **Validation**: `findNode()` now properly adds discovered peers to routing table (core Kademlia behavior)
- **Debug Tools**: Use `YZSocialC.investigatePhantomPeer('id')` to analyze suspicious peers

**Background Maintenance System (IMPLEMENTED):**
- **Problem Solved**: Missing automatic maintenance caused routing table entries without connections, violating Kademlia specifications
- **Literature Compliance**: Follows original Kademlia paper - routing table entries should represent reachable peers
- **Architecture**:
  - **Periodic Bucket Refresh**: Every 60 seconds, calls existing `refreshBuckets()` method automatically
  - **Connection Maintenance**: Every 30 seconds, attempts connections to unconnected routing table entries
  - **Failure Tracking**: Removes peers from routing table after 3 failed connection attempts
- **Implementation**:
  - Added `startBackgroundMaintenance()` method called in constructor
  - Added `maintainRoutingTableConnections()` for Kademlia compliance
  - Background timers using `setInterval()` with proper error handling
- **Expected Result**: `routing_table_size == active_connections` for proper Kademlia behavior
- **Debug Tools**: Monitor with `YZSocialC.dht.maintainRoutingTableConnections()` and connection/routing table size comparison

**Node ID Transformation Fix (IMPLEMENTED):**
- **Problem Solved**: Critical bug where `DHTNodeId.fromString()` was hashing existing peer IDs instead of using `DHTNodeId.fromHex()`
- **Root Cause**: RoutingTable methods were incorrectly converting 40-char hex peer IDs through SHA1 hash
- **Fix Applied**: 
  - Changed all routing table lookups to use `fromHex()` for existing node IDs
  - Enhanced `findNode()` to distinguish between node IDs (40-char hex) and data keys (arbitrary strings)
  - Fixed multiple peer ID lookups in KademliaDHT that were incorrectly hashing
- **Result**: Eliminated "FILTERING_DETECTED" errors, proper transport selection (WebRTC vs WebSocket), successful peer connections

**Adaptive Refresh System (NEW):**
- **Literature Compliance**: Follows original Kademlia paper timing with modern adaptations
- **Three-Tier System**: 
  - **Aggressive (15s)**: New/isolated nodes (<2 peers) for rapid bootstrap
  - **Medium (60s)**: Moderately connected nodes (2-5 peers)
  - **Standard (10min)**: Well-connected nodes (5+ peers) following IPFS/literature standards
- **Staleness-Based**: Only refreshes buckets that haven't been active (proper Kademlia behavior)
- **Traffic Reduction**: Dramatically reduces find_node message spam from ~50/30s to ~3/10min for established nodes
- **Debug Tools**: `YZSocialC.getAdaptiveRefreshStatus()`, `YZSocialC.forceAdaptiveRefresh()`

**WebRTC Keep-Alive for Inactive Tabs (NEW):**
- **Page Visibility API**: Detects when browser tabs become inactive/active
- **Adaptive Frequency**: 30s for active tabs, 10s for inactive tabs (combat browser throttling)
- **Ping/Pong Protocol**: `keep_alive_ping`/`keep_alive_pong` messages with timeout detection
- **Connection Health**: Automatic detection of failed connections and cleanup
- **Debug Tools**: `YZSocialC.getKeepAliveStatus()`, `YZSocialC.testKeepAlivePing()`, `YZSocialC.simulateTabVisibilityChange()`

**CRITICAL LESSONS LEARNED - INVITATION SYSTEM REGRESSION (RESOLVED):**

⚠️ **NEVER modify working invitation system without extreme caution**

**What Happened (2025-09-16 Debugging Session):**
- **Working State**: Git commit 8120d8b had functioning invitation system
- **Regression Introduced**: Added automatic bootstrap disconnection logic in `considerDHTSignaling()` method
- **Critical Bug**: `setTimeout(() => this.bootstrap.disconnect(), 2000)` conflicted with 45-second invitation timer
- **Result**: Invitations failed with "Cannot coordinate WebRTC - one or both peers are offline"

**Root Cause Analysis:**
- **Design Conflict**: DHT signaling optimization vs invitation coordination requirements
- **Timing Issue**: Bootstrap disconnection (2s) vs WebRTC coordination window (45s)
- **Architecture Violation**: DHT layer making connection management decisions

**Fix Applied:**
```javascript
// REMOVED: Automatic bootstrap disconnection
setTimeout(() => {
  if (this.bootstrap && this.bootstrap.isBootstrapConnected()) {
    console.log('🔌 Disconnecting from bootstrap server - now using DHT signaling');
    this.bootstrap.disconnect();
  }
}, 2000);

// REPLACED WITH: Keep connection for invitation coordination
// Keep bootstrap connection for invitation coordination
// Bootstrap will disconnect naturally when no longer needed
```

**Key Prevention Rules:**
1. **Git Checkpoint Before Changes**: Always commit working state before debugging
2. **Minimal Change Principle**: Fix specific issues without touching working systems
3. **Invitation System Isolation**: Never modify bootstrap connection logic during invitation flows
4. **Test Invitation First**: Always verify invitation system works before other optimizations
5. **Bootstrap Connection Timing**: Respect 45-second WebRTC coordination window
6. **Layer Separation**: DHT should not make connection management decisions

**Debug Pattern for Future Issues:**
```bash
# 1. Check git status - is current code committed?
git status
git diff  # Check what changed since last working commit

# 2. Test invitation system first
YZSocialC.inviteNewClient('test_client_id')

# 3. If broken, revert to last known good commit
git checkout HEAD~1 -- src/dht/KademliaDHT.js
# Then identify specific problematic changes
```

**Diagnostic Tools Added:**
- Enhanced logging shows when bootstrap connection is maintained vs disconnected
- Clear distinction between DHT signaling activation and bootstrap disconnection
- Better error messages for invitation coordination failures

**ROUTING TABLE PERFORMANCE ISSUE (OBSERVED):**

**Symptom**: Excessive "ROUTING TABLE DEBUG" logs showing repeated fallback searches:
```
🔧 ROUTING TABLE DEBUG - getNode for 404865da:
🔍 Starting fallback search for node 404865da - not found in bucket 0
🚨 Fallback search FAILED for node 404865da - not found in any bucket
```

**Root Cause**: Frequent routing table lookups for nodes during WebRTC connection establishment
- Multiple calls to `getOrCreatePeerNode()` during connection setup
- Each call triggers routing table search even when node doesn't exist yet
- Fallback search logs are too verbose for normal operation

**Performance Impact**: 
- Excessive logging creates noise in console output
- Multiple searches for same non-existent node during connection setup
- No functional impact but degrades debugging experience

**Potential Fixes** (for future consideration):
1. **Cache negative lookups** temporarily during connection establishment
2. **Reduce logging verbosity** for routing table searches (only log failures)
3. **Batch node creation** during connection setup to minimize searches
4. **Add exists-check** before expensive fallback searches

**Current Workaround**: 
- Logs are informational only and don't affect functionality
- Successfully connecting peers are added to routing table after WebRTC establishment
- Issue primarily affects debugging experience, not network performance

**WebRTC Signaling Fixes (FIXED):**
- **Missing handleSignal**: Added complete WebRTC signaling handling to connection managers
- **Perfect Negotiation Pattern**: Proper collision handling using node ID comparison for polite/impolite roles
- **Signal Processing**: Complete implementation of offer/answer/ICE candidate handling
- **Emergency Rate Limiting**: Added bypass for emergency discovery to prevent rate limit blocking
- **Connection State Monitoring**: Enhanced debugging for WebRTC connection state transitions
- **Debug Tools**: `YZSocialC.checkConnectionHealth()`, `YZSocialC.debugWebRTCStates()`

## Current Issue: Peer Discovery Bug in DHT Mesh Formation

**Problem**: 4-client network forms hub-and-spoke instead of full mesh. Only Client A (genesis/inviter) connects to all peers. Clients B, C, D only connect to A, not to each other.

**Root Cause**: When Client A invites multiple peers (B, C, D), the newly invited peers don't automatically discover each other through DHT peer discovery mechanisms.

**Current Status (CRITICAL)**: 
- **Working Git Commit**: Last commit had functioning 4-client mesh
- **Session Changes**: Attempted fixes introduced regressions
- **Reverted**: All changes reverted to last working git commit
- **Next**: Target minimal fix for peer discovery without breaking WebRTC

**Debugging Session Summary**:
1. **Original Issue**: C and D couldn't connect (hub-and-spoke topology)
2. **Manual Fix**: Adding peers manually to routing tables enabled connections
3. **Root Cause**: Lack of peer announcement when new peers join via invitation
4. **Attempted Fix**: Added routing loop prevention → broke DHT signaling  
5. **Partial Fix**: Removed routing loop prevention → some connections restored
6. **Major Regression**: Even basic A↔B connections started failing
7. **Emergency Revert**: Restored to last working git commit

**Technical Analysis**:
- **DHT Signaling Works**: Message routing through intermediate nodes functions correctly
- **WebRTC Establishment Fails**: ICE connections fail to establish for DHT-discovered peers
- **K-bucket Maintenance Works**: Routing tables populate correctly via find_node responses
- **Invitation Process Missing**: No peer announcement mechanism when new peers join

**Target Fix Needed**:
- **Minimal peer announcement** during invitation process
- **Ensure new peers are added** to existing members' routing tables
- **Trigger discovery attempts** between newly announced peers
- **Avoid touching WebRTC connection establishment code** (working correctly)

**Bridge System Implementation (ADDRESSES SOME ISSUES)**:
- **Peer Announcement System**: Active nodes now broadcast status to bridge observers
- **Routing Table Persistence**: Fixed "3 connected, 0 routing" issue with staleness-based cleanup
- **Last-Seen Tracking**: All peer messages now update lastSeen timestamps for accurate network state
- **Network Health Monitoring**: Bridge nodes provide network integrity verification for reconnections
- **Note**: Bridge system primarily addresses reconnection flow; mesh formation issue may persist

**Debug Commands for Testing**:
```javascript
// Check network topology
YZSocialC.getPeers()        // Connected peers
YZSocialC.getStats()        // Node info and routing table size

// Force peer discovery
YZSocialC.refreshBuckets()  // Trigger k-bucket maintenance
YZSocialC.triggerPeerDiscovery() // Force DHT peer discovery

// Manual routing table addition (workaround)
const existingNodes = YZSocialC.dht.routingTable.getAllNodes();
const nodeId = existingNodes[0].id.constructor.fromString('PEER_ID');
const node = new existingNodes[0].constructor(nodeId);
YZSocialC.dht.routingTable.addNode(node);
```