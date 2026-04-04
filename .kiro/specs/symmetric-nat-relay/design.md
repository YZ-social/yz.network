# Symmetric NAT Relay System - Design

## Key Insight from Tailscale

> "The algorithm is: try everything at once, and pick the best thing that works."

This is the ICE (Interactive Connectivity Establishment) philosophy. Rather than trying to detect NAT types and apply specific workarounds, we gather ALL possible connection paths and probe them simultaneously.

## Critical Decision: No Public TURN Servers

### Why We're Removing Public TURN

The current implementation uses public TURN servers (`openrelay.metered.ca`, `relay.metered.ca`). We're removing them because:

| Risk | Impact |
|------|--------|
| **Reliability** | Free services with no SLA, can go down or rate-limit without notice |
| **Usage Limits** | Bandwidth caps, connection limits, may block traffic patterns |
| **Privacy** | TURN servers see connection metadata (who connects to whom, duration, volume) |
| **Dependency** | Network connectivity depends on third parties we don't control |

### STUN vs TURN - Keep STUN, Remove TURN

| Service | Purpose | Keep? | Why |
|---------|---------|-------|-----|
| **STUN** | Discover public IP:port | ✓ Yes | Tiny bandwidth, no privacy concern, Google servers are reliable |
| **TURN** | Relay ALL WebRTC traffic | ✗ No | Replaced by our own WebSocket relay |

### New ICE Configuration

```javascript
// BEFORE (risky third-party dependency):
iceServers: [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'turn:openrelay.metered.ca:80', username: '...', credential: '...' },  // REMOVE
  { urls: 'turn:relay.metered.ca:443', username: '...', credential: '...' },     // REMOVE
]

// AFTER (self-reliant):
iceServers: [
  { urls: 'stun:stun.l.google.com:19302' },   // Keep: NAT discovery
  { urls: 'stun:stun1.l.google.com:19302' },  // Keep: Backup STUN
  { urls: 'stun:stun2.l.google.com:19302' },  // Keep: Backup STUN
  // NO TURN - use our WebSocket relay instead
]
```

## Current State Analysis

### What We Already Have (Good)
- WebRTC with ICE candidate gathering (host, srflx)
- Multiple STUN servers (Google's public servers)
- ICE transport policy: 'all' (tries all candidate types)
- Candidate pool size: 10
- **Existing WebSocket infrastructure** to all Node.js nodes

### What's Missing (To Implement)
1. **No relay fallback** - When WebRTC fails, we give up instead of falling back
2. **No path upgrade** - Once connected, we don't try to find better paths
3. **No connection profile detection** - We don't know our NAT type
4. **No distributed relay** - Not using our own infrastructure for relay
5. **No IPv6 preference** - Not prioritizing IPv6 which bypasses NAT entirely

## Architecture Overview

```
                    ┌─────────────────────────────────────────┐
                    │         Relay-Capable Nodes             │
                    │  (DHT nodes, bridge nodes, bootstrap)   │
                    │     All have public WebSocket addresses │
                    └─────────────────────────────────────────┘
                                      │
     ┌────────────────┬───────────────┼───────────────┬────────────────┐
     │                │               │               │                │
┌────▼─────┐   ┌──────▼──────┐  ┌─────▼──────┐  ┌─────▼─────┐  ┌───────▼───────┐
│ DHT Node │   │ Bridge Node │  │ Bootstrap  │  │ Desktop   │  │ Desktop       │
│ (Docker) │   │  (Docker)   │  │  Server    │  │ Node.js   │  │ Browser       │
│CanRelay  │   │ CanRelay    │  │ CanRelay   │  │ (open NAT)│  │ (open NAT)    │
└────┬─────┘   └──────┬──────┘  └─────┬──────┘  └─────┬─────┘  └───────┬───────┘
     │                │               │               │                │
     │ WebSocket      │ WebSocket     │ WebSocket     │                │
     │ relay          │ relay         │ relay         │                │
     │                │               │               │                │
┌────▼─────┐   ┌──────▼──────┐  ┌─────▼──────┐  ┌─────▼─────┐  ┌───────▼───────┐
│Browser A │   │ Browser B   │  │ Browser C  │  │ Browser D │  │ Browser E     │
│(sym NAT) │   │ (sym NAT)   │  │ (sym NAT)  │  │ (sym NAT) │  │ (sym NAT)     │
└──────────┘   └─────────────┘  └────────────┘  └───────────┘  └───────────────┘
```

**Key insight:** All browsers already connect to bridge nodes via WebSocket. We just need to add relay message forwarding to these existing connections.

## Component Design

### 1. Connection Profile Detector (Browser)

New module: `src/network/ConnectionProfileDetector.js`

Detects NAT type using the two-STUN-server method from Tailscale:
- Query two different STUN servers from the same socket
- If both return the same external port → Endpoint-Independent Mapping (Easy NAT)
- If different ports → Endpoint-Dependent Mapping (Hard NAT / Symmetric)

```javascript
async function getConnectionProfile() {
  return {
    hasIPv6: boolean,           // Global IPv6 address available?
    ipv6Addresses: string[],    // List of global IPv6 addresses
    ipv4External: string | null, // External IPv4 from STUN
    natType: 'open' | 'easy' | 'hard' | 'unknown',
    // 'open' = no NAT (public IP as host candidate)
    // 'easy' = Endpoint-Independent Mapping (cone NAT)
    // 'hard' = Endpoint-Dependent Mapping (symmetric NAT)
    needsRelay: boolean         // true if hard NAT detected
  };
}
```

### 2. Simplified Connection Strategy (No TURN)

```javascript
// Connection priority (highest to lowest):
const connectionStrategies = [
  { name: 'ipv6-direct', priority: 1 },      // Best: No NAT at all
  { name: 'webrtc-direct', priority: 2 },    // Good: ICE hole-punch via STUN
  { name: 'websocket-relay', priority: 3 }   // Fallback: Our relay nodes
];

// NO TURN in the list - we control our own relay infrastructure
```

### 3. Relay Capability Metadata

Extend node metadata in DHT:

```javascript
{
  nodeId: '...',
  nodeType: 'nodejs',
  canRelay: true,           // Can this node relay for others?
  relayLoad: 0.2,           // Current relay utilization (0-1)
  relayCapacity: 100,       // Max simultaneous relay connections
  publicAddress: 'wss://...' // Must have public address to relay
}
```

### 4. Relay Protocol Messages

```javascript
// Request relay setup (browser → relay node)
{ type: 'relay_request', targetPeerId: '...', sessionId: '...' }

// Forward encrypted payload through relay
{ type: 'relay_forward', from: '...', to: '...', sessionId: '...', payload: encrypted }

// Acknowledge relay setup
{ type: 'relay_ack', sessionId: '...', success: boolean }

// Relay teardown
{ type: 'relay_close', sessionId: '...' }
```

### 5. Relay Manager (New Component)

New module: `src/network/RelayManager.js`

Responsibilities:
- Track active relay sessions
- Select optimal relay node for new connections
- Handle relay protocol messages
- Monitor relay health and failover

### 6. Connection Flow (TURN-Free, Tailscale-Inspired)

```
Browser A wants to connect to Browser B
    │
    ▼
IMMEDIATELY start communication via WebSocket relay (bridge node)
    │ (connection works right away, guaranteed)
    │
    ▼
IN PARALLEL: Gather ICE candidates
    - IPv6 addresses (if available)
    - IPv4 LAN addresses (host candidates)
    - IPv4 WAN addresses (via STUN - srflx candidates)
    - NO TURN candidates (we don't use TURN)
    │
    ▼
Exchange candidate lists via signaling (bootstrap server)
    │
    ▼
Probe candidate pairs for direct WebRTC connection
    │
    ├─► IPv6 direct works? → Upgrade to IPv6 (best latency)
    │
    ├─► WebRTC direct works? → Upgrade to WebRTC
    │
    └─► No direct path found? → Stay on WebSocket relay (guaranteed to work)
    │
    ▼
Continue probing in background
    │
    ├─► Better path found later? → Transparently upgrade
    │
    └─► Current path fails? → Already on relay, or downgrade to relay
```

Key differences from current implementation:
1. **Immediate connectivity** via WebSocket relay while probing
2. **No TURN dependency** - our relay replaces TURN
3. **Parallel probing** of direct paths
4. **Dynamic path switching** based on measured latency
5. **Continuous background probing** to find better paths

### 7. Why WebSocket Relay is Better Than TURN for DHT

| Aspect | TURN | Our WebSocket Relay |
|--------|------|---------------------|
| Protocol | UDP relay (complex) | WebSocket (simple) |
| Traffic type | Designed for media streams | Perfect for small JSON messages |
| Control | Third party | We own it |
| Privacy | Metadata visible to TURN provider | Only our nodes see metadata |
| Cost | Pay per bandwidth or use unreliable free | Our existing infrastructure |
| Firewall traversal | May be blocked | HTTP/HTTPS always works |

### 8. Integration Points

#### ConnectionManagerFactory.js
- Add relay fallback logic when WebRTC fails
- Query RelayManager for available relays
- Create WebSocket connections to relay nodes

#### WebRTCConnectionManager.js
- Remove TURN servers from ICE config
- Detect connection failure after ICE timeout
- Emit event for relay fallback trigger
- Support hybrid mode (relay + background direct probing)

#### WebSocketConnectionManager.js
- Handle relay protocol messages
- Forward relay traffic between browsers

#### KademliaDHT.js
- Store/retrieve relay capability metadata
- Provide relay node discovery API

#### PassiveBridgeNode.js / EnhancedBootstrapServer.js
- Enable relay capability
- Handle relay_request, relay_forward messages

## Tailscale Techniques Applicable to Browser WebRTC

| Technique | Tailscale | Browser WebRTC | Notes |
|-----------|-----------|----------------|-------|
| IPv6 preference | ✓ | ✓ Can implement | Browsers support IPv6, just need to prioritize |
| STUN discovery | ✓ | ✓ Keep | Using Google STUN servers for NAT discovery |
| TURN relay | ✓ (DERP) | ✗ Replace | Use our WebSocket relay instead |
| Port mapping (UPnP/NAT-PMP) | ✓ | ✗ Not available | Browser sandbox prevents this |
| Birthday attack port scanning | ✓ | ✗ Not practical | Would need 256 sockets, browsers limit this |
| Relay fallback | ✓ (DERP) | ✓ Implement | Our WebSocket relay system |
| Path upgrade | ✓ | ✓ Implement | Switch from relay to direct when found |
| Continuous probing | ✓ | ✓ Implement | Keep trying better paths |
| Coordinated timing | ✓ | ✓ Can implement | Use bootstrap server as coordination channel |
| Port prediction | ✓ | ⚠️ Limited | Can detect pattern, limited control over WebRTC |

## Advanced NAT Traversal Techniques

### Coordinated Simultaneous Transmission

**Tailscale's approach:** Use a side channel to coordinate timing so both peers send packets at the same moment, opening both firewalls simultaneously.

**Our implementation:**
```
Bootstrap Server coordinates timing:

1. Browser A wants to connect to Browser B
2. A sends: { type: 'ice_coordinate', target: B, candidates: [...] }
3. Bootstrap holds A's request, waits for B to be ready
4. B sends: { type: 'ice_coordinate', target: A, candidates: [...] }
5. Bootstrap sends BOTH peers: { type: 'ice_start', timestamp: T }
6. Both peers start ICE probing at exactly time T
7. Packets cross in flight, opening both firewalls
```

This is especially useful for symmetric NAT ↔ cone NAT pairs where timing matters.

### Port Prediction for Sequential NATs

**Tailscale's approach:** Many symmetric NATs allocate ports sequentially (54481→54482→54483). Predict the next port and target it.

**Browser limitations:**
- We can't directly control which port WebRTC uses
- We can't open multiple sockets to probe different ports

**What we CAN do:**
1. Detect if NAT uses sequential allocation via multiple STUN queries
2. Report this in connection profile metadata
3. Use this info to decide if direct connection is worth attempting
4. Inform ICE candidate prioritization

```javascript
// In ConnectionProfileDetector
async function detectPortAllocationPattern() {
  // Query STUN server 3 times rapidly
  const ports = await Promise.all([
    queryStunPort('stun:stun.l.google.com:19302'),
    queryStunPort('stun:stun1.l.google.com:19302'),
    queryStunPort('stun:stun2.l.google.com:19302'),
  ]);
  
  // Check if sequential
  const diffs = [ports[1] - ports[0], ports[2] - ports[1]];
  const isSequential = diffs.every(d => d >= 1 && d <= 10);
  
  return {
    pattern: isSequential ? 'sequential' : 'random',
    increment: isSequential ? Math.round((diffs[0] + diffs[1]) / 2) : null,
    lastPort: ports[2]
  };
}
```

### ICE Restart for Hard NAT Pairs

When both peers are behind hard NATs and initial ICE fails:

1. **Detect the situation** via connection profile exchange
2. **Coordinate ICE restart** via bootstrap server
3. **Time the restart** so both peers gather new candidates simultaneously
4. **Retry with fresh NAT mappings** - sometimes NAT state changes help

```javascript
// Coordinated ICE restart
async function coordinatedIceRestart(peerId) {
  // Request coordination from bootstrap
  await this.bootstrapClient.send({
    type: 'ice_restart_coordinate',
    target: peerId,
    myProfile: this.connectionProfile
  });
  
  // Bootstrap will send 'ice_restart_go' to both peers at same time
  // Then both call pc.restartIce() simultaneously
}
```

### Aggressive ICE Candidate Gathering

WebRTC's ICE already does simultaneous probing, but we can optimize:

```javascript
// Enhanced ICE configuration
const pc = new RTCPeerConnection({
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
  ],
  iceCandidatePoolSize: 10,        // Pre-gather candidates
  iceTransportPolicy: 'all',       // Try all candidate types
  bundlePolicy: 'max-bundle',      // Reduce port usage
  rtcpMuxPolicy: 'require'         // Reduce port usage
});

// Trickle ICE - send candidates as they're discovered
pc.onicecandidate = (event) => {
  if (event.candidate) {
    // Send immediately, don't wait for gathering complete
    signaling.send({ type: 'candidate', candidate: event.candidate });
  }
};
```

### What We Can't Do in Browsers (Tailscale-only)

| Technique | Why Not in Browser |
|-----------|-------------------|
| **Birthday attack (256 ports)** | Browser can't open multiple UDP sockets |
| **UPnP/NAT-PMP port mapping** | Browser sandbox blocks local network access |
| **Raw UDP socket control** | WebRTC abstracts this away |
| **Custom STUN from same socket** | Can't share socket between STUN and WebRTC |
| **Kernel-level packet manipulation** | Obviously not in browser |

### Fallback Strategy When All Else Fails

```
Hard NAT ↔ Hard NAT connection attempt:

1. Try coordinated ICE (both start at same time)
   └─► Success? Use WebRTC direct
   
2. Try ICE restart with fresh NAT mappings
   └─► Success? Use WebRTC direct
   
3. Check if either peer has IPv6
   └─► Success? Use IPv6 direct (bypasses NAT)
   
4. Fall back to WebSocket relay
   └─► Always works, guaranteed connectivity
   
5. Continue background probing
   └─► NAT state may change, upgrade later
```

## File Changes Summary

| File | Change Type | Description |
|------|-------------|-------------|
| `src/network/ConnectionProfileDetector.js` | NEW | NAT type detection using dual-STUN |
| `src/network/RelayManager.js` | NEW | Relay session management |
| `src/network/RelayProtocol.js` | NEW | Message types and handlers |
| `src/network/ConnectionManagerFactory.js` | MODIFY | Add relay fallback logic |
| `src/network/WebRTCConnectionManager.js` | MODIFY | Remove TURN, emit failure events, support hybrid |
| `src/network/WebSocketConnectionManager.js` | MODIFY | Handle relay protocol messages |
| `src/dht/KademliaDHT.js` | MODIFY | Relay metadata in routing table |
| `src/bridge/PassiveBridgeNode.js` | MODIFY | Enable relay capability |
| `src/bootstrap/server.js` | MODIFY | Enable relay capability |

## Security Considerations

1. **End-to-End Encryption**: Relay payloads are encrypted before sending; relay node never sees plaintext
2. **Session Isolation**: Each relay session uses unique session ID
3. **No User Correlation**: Relay forwards by opaque peer ID, cannot build social graph
4. **Rate Limiting**: Relay nodes limit connections per source to prevent abuse
5. **No Third-Party Visibility**: Unlike public TURN, only our nodes see connection metadata

## Testing Strategy

1. **Unit Tests**: RelayManager, ConnectionProfileDetector
2. **Integration Tests**: Relay protocol message flow
3. **Browser Tests**: Full relay fallback scenario with Playwright
4. **Load Tests**: Relay capacity under concurrent connections
5. **Regression Tests**: Verify WebRTC direct still works after TURN removal
