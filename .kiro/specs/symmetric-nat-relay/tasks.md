# Symmetric NAT Relay System - Implementation Tasks

## Phase 0: Remove Public TURN Dependency (Quick Win) ✅ COMPLETED

### Task 0.1: Remove TURN servers from ICE configuration ✅
- [x] Update `WebRTCConnectionManager.js` to remove all TURN servers
- [x] Update `WebRTCManager.js` to remove all TURN servers
- [x] Update `src/index.js` to remove TURN server from test connectivity
- [x] Keep only STUN servers for NAT discovery:
  ```javascript
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' }
  ]
  ```
- [x] Add comment explaining why no TURN (we use our own relay)
- [x] Test that WebRTC direct connections still work (448 tests passed)

### Task 0.2: Document the change ✅
- [x] Update any documentation referencing TURN servers (design.md already documents rationale)
- [x] Add architecture note about self-reliant relay strategy (comments in code)

## Phase 1: Connection Profile Detection & Metrics

### Task 1.1: Create ConnectionProfileDetector module
- [x] Create `src/network/ConnectionProfileDetector.js`
- [x] Implement `getConnectionProfile()` using ICE candidate analysis
- [x] Detect IPv6 availability from host candidates (2xxx: prefix)
- [x] Detect NAT type using dual-STUN method (same socket, two servers)
- [x] Detect port allocation pattern (sequential vs random) via multiple STUN queries
- [x] Export profile: `{ hasIPv6, ipv6Addresses, ipv4External, natType, portPattern, needsRelay }`

### Task 1.1b: Port allocation pattern detection
- [x] Query 3 different STUN servers rapidly from same context
- [x] Compare returned ports to detect sequential allocation
- [x] Calculate average increment if sequential (typically +1 to +10)
- [x] Store pattern in connection profile for routing decisions
- [x] Use pattern to inform whether direct connection is worth attempting

### Task 1.2: Integrate profile detection into browser bootstrap
- [x] Call `getConnectionProfile()` during BootstrapClient initialization
- [x] Store connection profile in local node metadata
- [x] Report profile to bootstrap server for network-wide metrics
- [x] Add profile to DHT node metadata for routing decisions

### Task 1.3: Add connection metrics tracking
- [x] Track connection attempt outcomes (direct success, relay needed, failure)
- [x] Track ICE candidate types used for successful connections
- [x] Add metrics endpoint to report connection success rates
- [x] Log NAT type distribution across connected browsers

## Phase 2: WebSocket Relay Infrastructure

### Task 2.1: Add relay capability to Node.js nodes
- [x] Add `canRelay: true` to DHT node metadata
- [x] Add `canRelay: true` to bridge node metadata
- [x] Add `canRelay: true` to bootstrap server metadata
- [x] Include `relayLoad` and `relayCapacity` in metadata

### Task 2.2: Create RelayManager module
- [x] Create `src/network/RelayManager.js`
- [x] Implement relay session tracking (Map of sessionId → {from, to, relayNode})
- [x] Implement relay node selection algorithm:
  - Prefer nodes already connected to both peers
  - Consider latency (ping time)
  - Consider current load (relayLoad metadata)
- [x] Implement relay health monitoring and failover

### Task 2.3: Implement relay protocol messages
- [x] Create `src/network/RelayProtocol.js` with message type definitions
- [x] Add `relay_request` handler to WebSocketConnectionManager
- [x] Add `relay_forward` handler to WebSocketConnectionManager
- [x] Add `relay_ack` and `relay_close` handlers
- [x] Ensure relay payloads are opaque (encrypted by sender)

### Task 2.4: Add relay handlers to bridge nodes
- [x] Modify `PassiveBridgeNode.js` to handle relay messages
- [x] Modify `EnhancedBootstrapServer.js` to handle relay messages
- [x] Implement relay forwarding logic:
  ```javascript
  handleRelayForward(fromPeerId, toPeerId, sessionId, payload) {
    const targetConnection = this.getConnectionTo(toPeerId);
    if (targetConnection) {
      targetConnection.send({ type: 'relay_forward', from: fromPeerId, sessionId, payload });
    }
  }
  ```

## Phase 3: Immediate Relay Connectivity

### Task 3.1: Implement "relay first" connection strategy
- [x] When browser wants to connect to another browser:
  1. Immediately establish relay path via bridge node
  2. Start WebRTC ICE gathering in parallel
  3. Use relay for initial messages while WebRTC probes
- [x] Emit events for relay connection established/failed

### Task 3.2: Integrate relay into ConnectionManagerFactory
- [x] Modify `getManagerForPeer()` to support relay connections
- [x] Add `RelayConnectionManager` or extend `WebSocketConnectionManager`
  - Note: Implemented via `HybridConnectionManager` which wraps both relay and WebRTC
  - This approach is cleaner than extending `WebSocketConnectionManager` because it:
    1. Keeps relay logic separate from WebSocket transport
    2. Enables transparent transport switching (relay ↔ WebRTC)
    3. Follows the Tailscale "try everything at once" philosophy
- [x] Route browser↔browser traffic through relay when direct fails

### Task 3.3: Handle relay message routing in browsers
- [x] Browser receives `relay_forward` → deliver to local DHT
- [x] Browser sends to peer → check if relay path exists, use it
- [x] Maintain mapping of peerId → relay session

## Phase 4: Parallel Path Probing & Upgrade

### Task 4.1: Implement parallel connection strategy
- [x] Modify WebRTCConnectionManager to not block on ICE completion
- [x] Start relay connection immediately (guaranteed to work)
- [x] Run WebRTC ICE gathering in parallel
- [x] Track multiple candidate paths with measured latency

### Task 4.2: Implement coordinated ICE timing (Tailscale technique)
- [x] Add `ice_coordinate` message type to bootstrap server
- [x] When Browser A wants to connect to B, send coordination request
- [x] Bootstrap server holds request until B is also ready
- [x] Bootstrap sends `ice_start` to BOTH peers with synchronized timestamp
- [x] Both peers start ICE probing at exactly the same time
- [x] Packets cross in flight, opening both firewalls simultaneously

### Task 4.3: Implement coordinated ICE restart for hard NAT pairs
- [x] Detect when both peers have hard NAT (from connection profiles)
- [x] If initial ICE fails, request coordinated ICE restart via bootstrap
- [x] Bootstrap sends `ice_restart_go` to both peers simultaneously
- [x] Both peers call `pc.restartIce()` at the same time
- [x] Fresh NAT mappings may succeed where old ones failed

### Task 4.4: Implement path quality measurement
- [x] Add RTT measurement to relay path (ping/pong through relay)
- [x] Add RTT measurement to WebRTC path (existing keep-alive)
- [x] Compare path quality: latency, packet loss
- [x] Prefer IPv6 > WebRTC direct > WebSocket relay

### Task 4.5: Implement transparent path upgrade
- [x] When better path found, migrate traffic without dropping messages
- [x] Implement brief dual-send period during migration
- [x] Close old path after migration confirmed
- [x] Log path upgrades for debugging

### Task 4.6: Implement path downgrade on failure
- [x] Detect when current path fails (no pong response)
- [x] Immediately fall back to relay (always available)
- [x] Restart path probing to find new direct path
- [x] Emit events for path changes

## Phase 5: Continuous Background Probing

### Task 5.1: Implement background path discovery
- [x] After initial connection, continue probing for better paths
- [x] Probe interval: every 30 seconds while on relay, every 5 minutes while direct
- [x] Re-run ICE gathering periodically to detect NAT state changes
- [x] Handle NAT mapping timeout (typically 30 seconds for UDP)

### Task 5.2: Implement aggressive ICE configuration
- [x] Use multiple STUN servers for redundancy
- [x] Set `iceCandidatePoolSize: 10` for pre-gathering
- [x] Use trickle ICE - send candidates immediately as discovered
- [x] Configure `bundlePolicy: 'max-bundle'` to reduce port usage
- [x] Configure `rtcpMuxPolicy: 'require'` to reduce port usage

### Task 5.3: Implement keep-alive for all paths
- [x] Send periodic packets on active path to keep NAT mappings alive
- [x] Keep-alive interval: 25 seconds (under typical 30s NAT timeout)
- [x] Detect path failure if keep-alive times out
- [x] Maintain "warm" backup paths ready for instant failover

### Task 5.4: Add path statistics and logging
- [x] Track time spent on each path type per connection
- [x] Log path upgrade/downgrade events with timestamps
- [x] Report aggregate statistics: % direct, % relay
- [x] Target metric: 80%+ direct connections on desktop networks

## Phase 6: IPv6 Optimization

### Task 6.1: Prioritize IPv6 candidates
- [x] Detect global IPv6 addresses in ICE candidates (2xxx: prefix)
- [x] Prioritize IPv6 host candidates over IPv4
- [x] Skip NAT traversal entirely for IPv6-capable peers
- [x] Handle IPv6-only networks (NAT64 detection via ipv4only.arpa)

### Task 6.2: Add IPv6 metrics
- [x] Track % of connections using IPv6
- [x] Track IPv6 availability by user agent / platform
- [x] Log IPv6 vs IPv4 latency comparison
- [x] Report IPv6 adoption trends over time

## Phase 7: Testing & Validation

### Task 7.1: Unit tests
- [x] Test ConnectionProfileDetector NAT type detection
- [x] Test RelayManager session management (RelayNodeSelection.test.js)
- [x] Test RelayProtocol message handling (RelayProtocol.test.js)
- [x] Test path selection algorithm (PathTracker.test.js, RelayNodeSelection.test.js)

### Task 7.2: Integration tests
- [x] Test relay fallback when WebRTC fails (HybridConnectionManager.test.js)
- [x] Test path upgrade from relay to direct (PathTracker.test.js)
- [x] Test path downgrade on failure (PathTracker.test.js)
- [x] Test continuous probing finds better paths (BackgroundProbing.test.js)

### Task 7.3: Browser tests (Playwright)
- [x] Test two browsers can communicate via relay
- [x] Test relay connection establishment time
- [x] Test message delivery through relay
- [x] Test path upgrade when direct becomes available

**Note**: Browser tests require deployment to production (https://imeyouwe.com).
See `tests/browser/webrtc-two-browsers.spec.js` for existing patterns.
Run with: `npx playwright test tests/browser/relay-communication.spec.js`

### Task 7.4: Regression tests
- [x] Verify WebRTC direct still works after TURN removal
- [ ] Verify browser↔Node.js connections unaffected
- [ ] Verify Node.js↔Node.js connections unaffected

**Note**: These can be validated by running existing browser tests after deployment.
The `webrtc-two-browsers.spec.js` test validates WebRTC direct connections.

### Task 7.5: Production validation
- [ ] Deploy to production with feature flag
- [ ] Monitor connection success rates
- [ ] Monitor relay usage and load distribution
- [ ] Compare before/after metrics

**Note**: Requires deployment to oracle-yz server and monitoring via dashboard.

## Implementation Priority

1. **Phase 0** (Remove TURN) - Eliminate third-party dependency immediately
2. **Phase 1** (Connection Profile Detection) - Understand current state
3. **Phase 2** (Relay Infrastructure) - Build our relay capability
4. **Phase 3** (Immediate Relay) - Guarantee connectivity
5. **Phase 4** (Path Upgrade) - Optimize when possible
6. **Phase 5** (Background Probing) - Continuous improvement
7. **Phase 6** (IPv6) - Free wins for capable peers
8. **Phase 7** (Testing) - Validate everything works

## Success Criteria

- [ ] Zero dependency on public TURN servers
- [ ] 95%+ connection success rate (up from current ~70-80%)
- [ ] Relay used only when necessary (<20% of connections on desktop)
- [ ] Path upgrade happens within 30 seconds when direct path available
- [ ] No single relay node handles >10% of total relay traffic
- [ ] Connection establishment time <5 seconds (including relay fallback)
