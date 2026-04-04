# Symmetric NAT Relay System - Requirements

## Problem Statement

Browser-to-browser WebRTC connections fail when both peers are behind symmetric NAT (common on mobile carriers and some ISPs). Currently, the system relies on public TURN servers which:
- Are centralized and expensive at scale
- Create a single point of failure
- Don't leverage the existing DHT infrastructure
- Pose privacy risks (third parties see connection metadata)
- Have unreliable availability and usage limits

## Goal

Implement a distributed WebSocket relay system where any publicly-accessible node (DHT nodes, bridge nodes, bootstrap server) can relay traffic for browsers that cannot establish direct WebRTC connections. This replaces dependency on public TURN servers with our own infrastructure.

## Functional Requirements

### FR-1: Remove Public TURN Dependency
- Remove all public TURN servers from WebRTC ICE configuration
- Keep STUN servers (Google) for NAT discovery only
- All relay traffic flows through our own infrastructure

### FR-2: Relay Capability Detection
- Nodes with public addresses MUST advertise `canRelay: true` in their DHT metadata
- All server-hosted Node.js nodes (DHT nodes, bridge nodes, bootstrap) are relay-capable
- Desktop Node.js clients with public IPs can opt-in to relay

### FR-3: Connection Profile Detection
- Browsers MUST detect their NAT type on connection (symmetric vs cone)
- Browsers MUST detect IPv6 availability
- Connection profile MUST be reported to the network for routing decisions

### FR-4: WebSocket Relay Fallback
- When WebRTC direct fails between two browsers, fall back to WebSocket relay
- Relay selection based on: latency, proximity, current load
- Prefer relay nodes already connected to both peers
- Relay connection established immediately, WebRTC probed in parallel

### FR-5: Relay Protocol
- Relay nodes forward encrypted payloads by opaque peer ID
- Relay MUST NOT see plaintext (end-to-end encryption)
- Support for `relay_request`, `relay_forward`, `relay_ack`, `relay_close` message types

### FR-6: Direct Path Upgrade
- Continue probing for direct WebRTC path after relay fallback
- Automatically migrate traffic to direct path when available
- Target: 80%+ direct connections on desktop networks

## Non-Functional Requirements

### NFR-1: Performance
- Relay selection latency < 500ms
- Relay message overhead < 10% of payload size
- Support 100+ simultaneous relay connections per node

### NFR-2: Privacy
- No third-party visibility into connection metadata
- Relay nodes cannot correlate which users are communicating
- Each relay session uses unique identifiers
- No logging of relay traffic content

### NFR-3: Reliability
- Automatic failover to alternate relay if primary fails
- Graceful degradation when no relay nodes available
- Connection recovery after relay node restart
- No dependency on external services for relay

### NFR-4: Self-Reliance
- Network functions without any third-party relay infrastructure
- Only external dependency: STUN for NAT discovery (lightweight, reliable)

## Out of Scope (Phase 1)

- Mobile native app for overnight operation
- IPv6-only network support (NAT64)
- Geographic relay distribution optimization
- Relay bandwidth compensation/incentives
- Running our own STUN servers

## Success Metrics

- Eliminate dependency on public TURN servers
- Achieve 95%+ connection success rate for browser pairs
- Relay traffic distributed across multiple nodes (no single bottleneck)
- Direct WebRTC connections for 80%+ of desktop browser pairs
