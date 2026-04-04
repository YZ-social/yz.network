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
- [ ] Create `src/network/ConnectionProfileDetector.js`
- [ ] Implement `getConnectionProfile()` using ICE candidate analysis
- [ ] Detect IPv6 availability from host candidates (2xxx: prefix)
- [ ] Detect NAT type using dual-STUN method (same socket, two servers)
- [ ] Detect port allocation pattern (sequential vs random) via multiple STUN queries
- [ ] Export profile: `{ hasIPv6, ipv6Addresses, ipv4External, natType, portPattern, needsRelay }`

### Task 1.1b: Port allocation pattern detection
- [ ] Query 3 different STUN servers rapidly from same context
- [ ] Compare returned ports to detect sequential allocation
- [ ] Calculate average increment if sequential (typically +1 to +10)
- [ ] Store pattern in connection profile for routing decisions
- [ ] Use pattern to inform whether direct connection is worth attempting

### Task 1.2: Integrate profile detection into browser bootstrap
- [ ] Call `getConnectionProfile()` during BootstrapClient initialization
- [ ] Store connection profile in local node metadata
- [ ] Report profile to bootstrap server for network-wide metrics
- [ ] Add profile to DHT node metadata for routing decisions

### Task 1.3: Add connection metrics tracking
- [ ] Track connection attempt outcomes (direct success, relay needed, failure)
- [ ] Track ICE candidate types used for successful connections
- [ ] Add metrics endpoint to report connection success rates
- [ ] Log NAT type distribution across connected browsers

## Phase 2: WebSocket Relay Infrastructure

### Task 2.1: Add relay capability to Node.js nodes
- [ ] Add `canRelay: true` to DHT node metadata
- [ ] Add `canRelay: true` to bridge node metadata  
- [ ] Add `canRelay: true` to bootstrap server metadata
- [ ] Include `relayLoad` and `relayCapacity` in metadata

### Task 2.2: Create RelayManager module
- [ ] Create `src/network/RelayManager.js`
- [ ] Implement relay session tracking (Map of sessionId → {from, to, relayNode})
- [ ] Implement relay node selection algorithm:
  - Prefer nodes already connected to both peers
  - Consider latency (ping time)
  - Consider current load (relayLoad metadata)
- [ ] Implement relay health monitoring and failover

### Task 2.3: Implement relay protocol messages
- [ ] Create `src/network/RelayProtocol.js` with message type definitions
- [ ] Add `relay_request` handler to WebSocketConnectionManager
- [ ] Add `relay_forward` handler to WebSocketConnectionManager
- [ ] Add `relay_ack` and `relay_close` handlers
- [ ] Ensure relay payloads are opaque (encrypted by sender)

### Task 2.4: Add relay handlers to bridge nodes
- [ ] Modify `PassiveBridgeNode.js` to handle relay messages
- [ ] Modify `EnhancedBootstrapServer.js` to handle relay messages
- [ ] Implement relay forwarding logic:
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
- [ ] When browser wants to connect to another browser:
  1. Immediately establish relay path via bridge node
  2. Start WebRTC ICE gathering in parallel
  3. Use relay for initial messages while WebRTC probes
- [ ] Emit events for relay connection established/failed

### Task 3.2: Integrate relay into ConnectionManagerFactory
- [ ] Modify `getManagerForPeer()` to support relay connections
- [ ] Add `RelayConnectionManager` or extend `WebSocketConnectionManager`
- [ ] Route browser↔browser traffic through relay when direct fails

### Task 3.3: Handle relay message routing in browsers
- [ ] Browser receives `relay_forward` → deliver to local DHT
- [ ] Browser sends to peer → check if relay path exists, use it
- [ ] Maintain mapping of peerId → relay session

## Phase 4: Parallel Path Probing & Upgrade

### Task 4.1: Implement parallel connection strategy
- [ ] Modify WebRTCConnectionManager to not block on ICE completion
- [ ] Start relay connection immediately (guaranteed to work)
- [ ] Run WebRTC ICE gathering in parallel
- [ ] Track multiple candidate paths with measured latency

### Task 4.2: Implement coordinated ICE timing (Tailscale technique)
- [ ] Add `ice_coordinate` message type to bootstrap server
- [ ] When Browser A wants to connect to B, send coordination request
- [ ] Bootstrap server holds request until B is also ready
- [ ] Bootstrap sends `ice_start` to BOTH peers with synchronized timestamp
- [ ] Both peers start ICE probing at exactly the same time
- [ ] Packets cross in flight, opening both firewalls simultaneously

### Task 4.3: Implement coordinated ICE restart for hard NAT pairs
- [ ] Detect when both peers have hard NAT (from connection profiles)
- [ ] If initial ICE fails, request coordinated ICE restart via bootstrap
- [ ] Bootstrap sends `ice_restart_go` to both peers simultaneously
- [ ] Both peers call `pc.restartIce()` at the same time
- [ ] Fresh NAT mappings may succeed where old ones failed

### Task 4.4: Implement path quality measurement
- [ ] Add RTT measurement to relay path (ping/pong through relay)
- [ ] Add RTT measurement to WebRTC path (existing keep-alive)
- [ ] Compare path quality: latency, packet loss
- [ ] Prefer IPv6 > WebRTC direct > WebSocket relay

### Task 4.5: Implement transparent path upgrade
- [ ] When better path found, migrate traffic without dropping messages
- [ ] Implement brief dual-send period during migration
- [ ] Close old path after migration confirmed
- [ ] Log path upgrades for debugging

### Task 4.6: Implement path downgrade on failure
- [ ] Detect when current path fails (no pong response)
- [ ] Immediately fall back to relay (always available)
- [ ] Restart path probing to find new direct path
- [ ] Emit events for path changes

## Phase 5: Continuous Background Probing

### Task 5.1: Implement background path discovery
- [ ] After initial connection, continue probing for better paths
- [ ] Probe interval: every 30 seconds while on relay, every 5 minutes while direct
- [ ] Re-run ICE gathering periodically to detect NAT state changes
- [ ] Handle NAT mapping timeout (typically 30 seconds for UDP)

### Task 5.2: Implement aggressive ICE configuration
- [ ] Use multiple STUN servers for redundancy
- [ ] Set `iceCandidatePoolSize: 10` for pre-gathering
- [ ] Use trickle ICE - send candidates immediately as discovered
- [ ] Configure `bundlePolicy: 'max-bundle'` to reduce port usage
- [ ] Configure `rtcpMuxPolicy: 'require'` to reduce port usage

### Task 5.3: Implement keep-alive for all paths
- [ ] Send periodic packets on active path to keep NAT mappings alive
- [ ] Keep-alive interval: 25 seconds (under typical 30s NAT timeout)
- [ ] Detect path failure if keep-alive times out
- [ ] Maintain "warm" backup paths ready for instant failover

### Task 5.4: Add path statistics and logging
- [ ] Track time spent on each path type per connection
- [ ] Log path upgrade/downgrade events with timestamps
- [ ] Report aggregate statistics: % direct, % relay
- [ ] Target metric: 80%+ direct connections on desktop networks

## Phase 6: IPv6 Optimization

### Task 6.1: Prioritize IPv6 candidates
- [ ] Detect global IPv6 addresses in ICE candidates (2xxx: prefix)
- [ ] Prioritize IPv6 host candidates over IPv4
- [ ] Skip NAT traversal entirely for IPv6-capable peers
- [ ] Handle IPv6-only networks (NAT64 detection via ipv4only.arpa)

### Task 6.2: Add IPv6 metrics
- [ ] Track % of connections using IPv6
- [ ] Track IPv6 availability by user agent / platform
- [ ] Log IPv6 vs IPv4 latency comparison
- [ ] Report IPv6 adoption trends over time

## Phase 7: Testing & Validation

### Task 7.1: Unit tests
- [ ] Test ConnectionProfileDetector NAT type detection
- [ ] Test RelayManager session management
- [ ] Test RelayProtocol message handling
- [ ] Test path selection algorithm

### Task 7.2: Integration tests
- [ ] Test relay fallback when WebRTC fails
- [ ] Test path upgrade from relay to direct
- [ ] Test path downgrade on failure
- [ ] Test continuous probing finds better paths

### Task 7.3: Browser tests (Playwright)
- [ ] Test two browsers can communicate via relay
- [ ] Test relay connection establishment time
- [ ] Test message delivery through relay
- [ ] Test path upgrade when direct becomes available

### Task 7.4: Regression tests
- [ ] Verify WebRTC direct still works after TURN removal
- [ ] Verify browser↔Node.js connections unaffected
- [ ] Verify Node.js↔Node.js connections unaffected

### Task 7.5: Production validation
- [ ] Deploy to production with feature flag
- [ ] Monitor connection success rates
- [ ] Monitor relay usage and load distribution
- [ ] Compare before/after metrics

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
