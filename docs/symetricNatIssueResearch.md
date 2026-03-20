# yz.network Connectivity Architecture Analysis

## Executive Summary

This document analyzes connectivity options for yz.network's browser-based DHT, comparing VPN solutions against distributed relay approaches for handling symmetric NAT traversal.

---

## Open Source VPN Solutions Analysis

### Headscale (Self-Hosted Tailscale)

[Headscale](https://github.com/juanfont/headscale) is an open-source implementation of Tailscale's coordination server.

**What you get:**
- Full Tailscale client compatibility
- Embedded DERP relay server
- STUN server for NAT traversal
- Self-hosted control plane

**What you don't get:**
- Browser-native client — still requires native Tailscale app installation
- The browser extension (`ts-browser-ext`) requires Native Messaging with a native binary

**Verdict:** Headscale solves the "Tailscale dependency" concern but doesn't solve the "requires install" problem.

### NetBird (Most Advanced Open Source Option)

[NetBird](https://netbird.io) is a fully open-source WireGuard-based mesh VPN with a browser client.

**Browser Client Architecture:**
- Runs NetBird peer as WebAssembly (WASM) in browser
- Uses `wireguard-go` compiled to WASM
- **Critical finding:** "All traffic routes through NetBird relay servers using WebSocket"

**What this reveals:** Even the most advanced open-source browser VPN implementation still requires relay servers for browser traffic. They cannot achieve direct browser-to-browser connections either.

**Implications for yz.network:**
- NetBird's browser client proves the relay approach is correct
- Their architecture validates our distributed relay recommendation
- Adding NetBird would give WireGuard encryption but still require relay infrastructure

### Tailscale WASM (SSH Console)

Tailscale ported their client to WebAssembly for browser-based SSH access.

**How it works:**
- Full Tailscale client compiled to WASM
- WireGuard and gVisor network stack in browser
- Uses WebSocket transport for DERP (browsers can't do raw UDP)

**Limitation:** This is for accessing resources *through* Tailscale, not for browser-to-browser P2P DHT participation.

### Summary: VPN Solutions Don't Solve the Core Problem

| Solution | Open Source | Browser Native | No Install | Direct Browser↔Browser |
|----------|-------------|----------------|------------|------------------------|
| Headscale | ✓ | ✗ | ✗ | ✗ |
| NetBird | ✓ | ✓ (WASM) | ✓ | ✗ (still needs relay) |
| Tailscale WASM | Partial | ✓ | ✓ | ✗ (still needs DERP) |
| Our Relay Approach | ✓ | ✓ | ✓ | ✗ (by design) |

**Key insight:** All browser-based VPN solutions still require relay servers. The symmetric NAT problem is fundamental — no amount of VPN magic makes two browsers behind CGNAT connect directly.

---

## Current Architecture Issues

### WebRTC Configuration

The current `WebRTCConnectionManager.js` uses:
- Google STUN servers (`stun.l.google.com`)
- Public TURN servers from `openrelay.metered.ca` and `relay.metered.ca`

**Problem:** TURN servers are centralized and expensive at scale. The current setup has no distributed relay capability for browser↔browser connections when both peers are behind symmetric NAT.

### Connection Routing

`ConnectionManagerFactory.js` correctly routes:

| Source | Target | Transport |
|--------|--------|-----------|
| Browser | Browser | WebRTC |
| Browser | Node.js | WebSocket |
| Node.js | Node.js | WebSocket |

**Gap:** No fallback relay path when WebRTC fails between browsers.

---

## Option Comparison

### Option 1: Tailscale VPN Approach

#### How It Would Work
1. Users install Tailscale (native app or browser extension)
2. All traffic routes through Tailscale's mesh network
3. DERP servers handle relay when direct connections fail
4. App connects via Tailscale IPs instead of public internet

#### Pros
- Tailscale handles all NAT traversal (~90% direct, ~10% DERP relay)
- Battle-tested infrastructure
- Works on mobile with native app
- Encrypted end-to-end via WireGuard
- Browser extension exists (Tailchrome) but requires native helper binary

#### Cons
- **Requires install** — kills the "JavaScript-only, no install" vision
- Users must create Tailscale accounts
- Dependency on Tailscale's infrastructure
- Browser extension requires native helper binary (not pure JS)
- Mobile requires native Tailscale app
- Adds friction to onboarding
- Loss of control over the network layer
- Tailscale is designed for private networks, not public DHT participation

#### Verdict
Tailscale solves connectivity but fundamentally changes the product from "open browser-based DHT" to "private VPN-based network."

---

### Option 2: Distributed Relay Nodes (Recommended)

#### How It Would Work
1. **Any publicly accessible node** can act as a relay — not just bridge nodes
2. Browsers that can't connect directly route through nearest available relay
3. Relay is blind (forwards encrypted packets by peer ID)
4. Similar to Tailscale's DERP but fully distributed across the network

#### Who Can Relay

| Node Type | Can Relay? | Notes |
|-----------|------------|-------|
| DHT nodes (Docker containers) | ✓ Always | Server-hosted, public IP via nginx |
| Bridge nodes (Docker/VPS) | ✓ Always | Server-hosted, public IP via nginx |
| Bootstrap server | ✓ Always | Server-hosted, public IP |
| Desktop Node.js clients with public IP | ✓ Yes | Home users on AT&T Fiber, Verizon FiOS, etc. |
| Desktop browsers with open NAT | ✓ Yes | Can accept WebSocket connections |
| Mobile browsers | ✗ No | Behind CGNAT, cannot accept inbound |
| Starlink / T-Mobile Home Internet | ✗ No | CGNAT, no public IP |

**Current infrastructure:** All Node.js nodes running on oracle-yz (DHT nodes, bridge nodes, bootstrap) are server-hosted with public addresses via nginx reverse proxy. This means you already have multiple relay-capable nodes available today.

#### Architecture

```
                    ┌─────────────────────────────────────────┐
                    │         Relay-Capable Nodes             │
                    │  (All server-hosted Node.js + volunteers)│
                    └─────────────────────────────────────────┘
                                      │
     ┌────────────────┬───────────────┼───────────────┬────────────────┐
     │                │               │               │                │
┌────▼─────┐   ┌──────▼──────┐  ┌─────▼──────┐  ┌─────▼─────┐  ┌───────▼───────┐
│ DHT Node │   │ Bridge Node │  │ Bootstrap  │  │ Desktop   │  │ Desktop       │
│ (Docker) │   │  (Docker)   │  │  Server    │  │ Node.js   │  │ Browser       │
│          │   │             │  │            │  │ (open NAT)│  │ (open NAT)    │
└────┬─────┘   └──────┬──────┘  └─────┬──────┘  └─────┬─────┘  └───────┬───────┘
     │                │               │               │                │
     │ relay          │ relay         │ relay         │ relay          │ relay
     │                │               │               │                │
┌────▼─────┐   ┌──────▼──────┐  ┌─────▼──────┐  ┌─────▼─────┐  ┌───────▼───────┐
│Browser A │   │ Browser B   │  │ Browser C  │  │ Browser D │  │ Browser E     │
│(sym NAT) │   │ (sym NAT)   │  │ (sym NAT)  │  │ (sym NAT) │  │ (sym NAT)     │
└──────────┘   └─────────────┘  └────────────┘  └───────────┘  └───────────────┘
```

**Key insight:** Your current Docker infrastructure already provides multiple relay nodes. The DHT nodes, bridge nodes, and bootstrap server are all server-hosted with public addresses — they can all relay traffic for browsers behind symmetric NAT.

#### Relay Selection Strategy

When a browser needs relay:
1. Query DHT for nodes with `canRelay: true` in metadata
2. Select based on: latency, geographic proximity, current load
3. Prefer nodes already connected to target peer (reduces hops)
4. Fall back to bridge nodes if no volunteer relays available

#### Pros
- Preserves the "no install" browser-only vision
- Full control over infrastructure
- **Distributed load** — relay traffic spread across many nodes, not concentrated on bridges
- Bridge nodes provide guaranteed baseline availability
- Volunteer nodes with public IPs expand relay capacity organically
- Matches Tailscale's DERP architecture conceptually
- Works with existing WebSocket infrastructure
- No user accounts needed
- **Incentive-compatible** — users with public IPs can earn more by relaying

#### Cons
- Requires implementing relay protocol
- Need to track which nodes can relay (metadata flag)
- Relay bandwidth costs (minimal for DHT messages)
- More development work

---

### Option 3: libp2p Circuit Relay

Use libp2p's circuit relay v2 protocol.

#### Pros
- Well-documented protocol
- Interoperable with IPFS ecosystem
- Resource reservation and rate limiting built-in

#### Cons
- Circuit relay server doesn't work in browsers (only Node.js)
- Adds libp2p dependency
- May be overkill for this use case

---

## Updated Recommendation

### Why VPN Solutions Don't Change the Analysis

The research into Headscale, NetBird, and Tailscale WASM confirms:

1. **Browser-to-browser direct connections are impossible** regardless of VPN layer
2. **All browser VPN solutions still require relay** — NetBird explicitly states "all traffic routes through relay servers"
3. **VPN adds complexity without solving the core problem** — you'd still need relay infrastructure

### What VPN Solutions Would Add

| Benefit | Value for yz.network |
|---------|---------------------|
| WireGuard encryption | Could add independently if needed |
| Coordination server | Already have bootstrap server |
| User authentication | Already have membership tokens |
| Relay infrastructure | Still need to build/host |

### Final Recommendation: Distributed Relay via Any Public Node

The original recommendation stands, now with stronger validation and clarification:

1. **Any publicly accessible node can relay** — not just bridge nodes
2. **Bridge nodes are the guaranteed baseline** — always available, controlled infrastructure
3. **Volunteer nodes with public IPs expand capacity** — desktop users on open NAT can opt-in to relay
4. **Load distributes naturally** — relay traffic spread across network, not concentrated
5. **Incentive-compatible** — users who can relay earn more compensation

#### Relay Node Tiers

| Tier | Node Type | Availability | Notes |
|------|-----------|--------------|-------|
| 1 | DHT nodes (Docker) | Always on | Already running, just need relay protocol |
| 1 | Bridge nodes (Docker) | Always on | Already running, just need relay protocol |
| 1 | Bootstrap server | Always on | Already running, just need relay protocol |
| 2 | Desktop Node.js volunteers | When running | Users with public IPs opt-in |
| 3 | Desktop browsers (open NAT) | When tab open | Opportunistic relay |

**Immediate win:** Implementing relay on your existing Docker nodes gives you distributed relay capacity with zero additional infrastructure cost.

#### Implementation Priority

1. **Phase 1**: All server-hosted Node.js nodes relay (DHT nodes, bridge nodes, bootstrap)
2. **Phase 2**: External Node.js clients with public IP can opt-in to relay
3. **Phase 3**: Desktop browsers with open NAT can relay (if WebSocket server possible)

The key insight from Tailscale's NAT traversal article remains valid:

> Always have a relay fallback, then aggressively try to upgrade to direct.

---

## Implementation Roadmap

### Phase 1: WebSocket Relay Fallback

Modify the connection flow:

```
Browser A wants to connect to Browser B
    │
    ▼
Try WebRTC direct (ICE with STUN/TURN)
    │
    ├─► Success? Use WebRTC
    │
    └─► Timeout after 15s? Fall back to WebSocket relay
            │
            ▼
        Query DHT for nodes with canRelay=true
            │
            ▼
        Select best relay: latency, proximity, load
        (Prefer nodes already connected to target)
            │
            ▼
        Both browsers connect to relay via WebSocket
            │
            ▼
        Relay forwards messages between them
            │
            ▼
        Continue probing for direct path in background
```

### Phase 2: Relay Protocol

Any node that can accept inbound connections implements the relay handler:

```javascript
// In ConnectionManager or a RelayMixin
handleRelayRequest(fromPeerId, toPeerId, encryptedPayload) {
  // Forward encrypted payload to target peer
  // Relay never sees plaintext (SimpleX model)
  const targetManager = this.getManagerForPeer(toPeerId);
  if (targetManager && targetManager.isConnected()) {
    targetManager.sendMessage(toPeerId, {
      type: 'relay_forward',
      from: fromPeerId,
      payload: encryptedPayload
    });
    return { success: true };
  }
  return { success: false, reason: 'target_not_connected' };
}
```

**Metadata flag for relay capability:**
```javascript
// In node metadata (shared via DHT)
{
  nodeId: '...',
  nodeType: 'nodejs',
  canRelay: true,           // Can this node relay for others?
  relayLoad: 0.2,           // Current relay utilization (0-1)
  relayCapacity: 100,       // Max simultaneous relay connections
  publicAddress: 'wss://...' // Must have public address to relay
}
```

### Phase 3: Metrics & Optimization

- Track % direct vs relayed connections
- Geographic distribution of relay nodes
- Automatic relay node selection based on latency
- **Relay load balancing** — distribute traffic across available relays
- **Relay health monitoring** — remove unresponsive relays from selection pool

### Phase 4: Volunteer Relay Incentives

- Desktop Node.js clients can opt-in to relay with `--enable-relay` flag
- Track relay bandwidth contribution per node
- Higher compensation for nodes that provide relay services
- Relay contribution visible in node metrics/dashboard

---

## Mobile Reality Check

Browser-only overnight mobile operation is impossible due to OS background suspension. The revised model:

| User Type | Contribution | Connection Method |
|-----------|--------------|-------------------|
| Mobile browser (active) | DHT participation while screen on | WebSocket to bridge → relay to other mobiles |
| Desktop browser | DHT + potential relay if open NAT | WebRTC direct or WebSocket relay |
| Desktop volunteer (native app) | Full relay capability | WebSocket server, can relay for others |
| VPS/Docker nodes | Always-on relay | Existing bridge infrastructure |

---

## Cost Comparison

| Approach | Infrastructure Cost | Development Effort | User Friction |
|----------|--------------------|--------------------|---------------|
| Tailscale | $0 (they pay) | Low | High (install required) |
| Distributed Relay | ~$150-500/mo for relay VPS | Medium | None |
| libp2p Circuit Relay | Same as above | Medium-High | None |

---

## Key Insight

From Tailscale's NAT traversal article:

> Always have a relay fallback, then aggressively try to upgrade to direct.

The current code tries WebRTC and gives up. It should:
1. Try WebRTC
2. Fall back to relay
3. Keep probing for direct path in the background
4. Upgrade to direct when possible

This approach achieves Tailscale's benchmark of ~90% direct connections.
