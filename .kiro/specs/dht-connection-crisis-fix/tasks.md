# DHT Connection Crisis Fix - Implementation Plan

## Overview

This implementation plan focuses on immediate diagnosis and recovery of the DHT network crisis. The network was previously working but has broken down to only 1 healthy node out of 15. We need to systematically debug and fix the connection issues to restore stable DHT operation.

## Tasks

- [x] 1. Emergency connection diagnosis and root cause identification
  - Run comprehensive connection path testing to identify what broke
  - Test bootstrap server connectivity from external clients and internal Docker nodes
  - Verify WebSocket connection paths (browser → Node.js DHT)
  - Test WebRTC connection paths (browser ↔ browser)
  - Check if data transfer metrics changes broke message flow
  - Identify which specific connection managers are failing
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

- [x] 2. Debug bootstrap server connection failures
  - Investigate "Unexpected server response: 200" errors
  - Test bootstrap WebSocket connections from both internal Docker nodes and external clients
  - Verify bootstrap server accepts connections on correct ports with proper headers
  - Check if bootstrap coordination is working for peer introductions
  - Debug why nodes can't establish initial bootstrap connections
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

- [x] 3. Verify WebSocket connection path integrity
  - Test browser → Node.js DHT WebSocket connections
  - Verify DHT message routing over WebSocket connections
  - Check if data transfer metrics interfere with WebSocket message processing
  - Ensure DHT nodes accept WebSocket connections with proper CORS headers
  - Debug specific WebSocket connection failures and provide detailed error reporting
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

- [x] 4. Verify WebRTC connection path integrity
  - Test browser ↔ browser WebRTC DataChannel establishment
  - Verify WebRTC signaling coordination through bootstrap server
  - Check if data transfer metrics interfere with WebRTC message routing
  - Test WebRTC fallback to WebSocket routing when direct connections fail
  - Debug WebRTC connection manager failures
  - **VERIFICATION RESULTS**:
    - ✅ WebRTCConnectionManager instantiation and configuration working
    - ✅ ICE servers configured (10 STUN/TURN servers)
    - ✅ Keep-alive intervals correct (30s visible, 10s hidden, 60s timeout)
    - ✅ Signal emission working correctly
    - ✅ ConnectionManagerFactory routes browser↔browser to WebRTCConnectionManager
    - ✅ ConnectionManagerFactory routes nodejs↔nodejs to WebSocketConnectionManager
    - ✅ Fallback mechanism: nodejs→browser uses WebSocket correctly
    - ✅ sendSignal method emits signal events for DHT routing
    - ⚠️ Bootstrap server connection returns HTTP 200 (nginx config issue, not WebRTC path issue)
  - **38/39 unit tests pass** (1 skipped - browser environment test)
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

- [x] 5. Fix data transfer metrics safety issues
  - Ensure metrics recording doesn't interfere with message processing
  - Add graceful handling of JSON serialization errors in metrics
  - Make metrics tracking completely optional and fail-safe
  - Verify system operates identically when metrics are disabled
  - Add fallback mechanisms when metrics tracking fails
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

- [x] 6. Verify connection manager hierarchy preservation
  - Test WebSocketConnectionManager functionality is intact
  - Test WebRTCConnectionManager functionality is intact
  - Verify ConnectionManagerFactory routes to correct managers
  - Ensure backward compatibility with existing connection flows
  - Add manager-specific error reporting for connection failures
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

- [ ] 7. Implement emergency bootstrap mode for network recovery
  - Add detection for empty/sparse DHT network conditions
  - Implement direct connection mode when bridge nodes find no DHT peers
  - Provide genesis node and bridge node addresses as direct connection targets
  - Skip DHT-based onboarding when network is too sparse
  - Add emergency peer discovery using known node addresses
  - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

- [x] 8. Debug Oracle YZ node mesh formation specifically
  - Investigate why 14 out of 15 Oracle YZ nodes are unhealthy
  - Test direct container-to-container connectivity within Docker network
  - Verify nginx proxy routing for /nodeX paths to internal containers
  - Check if nodes can reach their own advertised addresses (wss://imeyouwe.com/nodeX)
  - Debug why bridge node shows 22 connections but DHT nodes can't connect to each other
  - Test manual WebSocket connections to specific node endpoints
  - **ROOT CAUSE #1 FIXED**: BUILD_ID mismatch - added volume mount for bundle-hash.json to all DHT nodes
  - **ROOT CAUSE #2 FIXED**: Metadata propagation bug - `_setMembershipToken()` was overwriting all metadata with just the token, causing bridge nodes to see `nodeType=undefined`, `isBridgeNode=undefined` for genesis peer
  - **ROOT CAUSE #3 FIXED**: Duplicate connection manager creation - `getOrCreatePeerNode()` was creating new managers for incoming connections that already had dedicated managers
  - **ROOT CAUSE #4 FIXED**: DHT message handler race condition - handlers were attached in `setTimeout()` callback, causing messages to arrive before handlers were ready
  - **RESULT**: All 15 DHT nodes are now healthy ✅
  - _Requirements: 7.1, 7.2, 7.3_

- [ ] 9. Fix peer-to-peer connection establishment
  - Debug why find_node queries fail with "No connection to peer" despite peers in routing table
  - Investigate why emergency bypasses are being triggered due to connection failures
  - Fix why peers are being removed from routing tables after 29 failures
  - Verify WebSocket servers are actually listening on advertised addresses
  - Debug nginx WebSocket upgrade request routing
  - Test if nodes can connect to each other using internal Docker network names
  - **BROWSER RELAY FIX IMPLEMENTED**:
    - Modified `sendFindNode()` to use OverlayNetwork routing when no direct connection exists
    - Added `sendRoutedFindNode()` method for routing find_node queries through connected peers
    - Added `handleRoutedDHTRequest()` and `handleRoutedDHTResponse()` handlers in KademliaDHT
    - Updated OverlayNetwork `handleRoutedMessage()` to forward DHT-specific routed messages
    - This allows browsers to query peers they're not directly connected to by routing through existing connections
  - _Requirements: 7.2, 7.3, 7.4_

- [ ] 10. Checkpoint - Verify basic connectivity is restored
  - Ensure at least 80% of nodes report as healthy
  - Verify nodes can establish multiple peer connections (target: 3-8 per node)
  - Test that find_node operations complete in <2 seconds
  - Confirm data transfer rates are appropriate for message sizes
  - Ask the user if questions arise during connectivity testing

- [ ] 11. Test network recovery and stabilization
  - Verify network can recover from empty state using emergency bootstrap mode
  - Test mixed connection scenarios (some via DHT, some direct)
  - Ensure network maintains stability after initial recovery
  - Test that pubsub channel creation works in <5 seconds once DHT is stable
  - Verify all connection paths work correctly after recovery
  - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

- [ ] 12. Implement rollback and recovery strategy
  - Create commands to disable data transfer metrics completely if needed
  - Document rollback procedures for DHT maintenance intervals
  - Provide minimal working configuration for emergency recovery
  - Ensure git commits are available for each fix attempt
  - Verify rollback procedures restore network health to previous levels
  - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

- [ ] 13. Final checkpoint - Complete system validation
  - Ensure all tests pass and DHT network is stable
  - Verify all 15 Oracle YZ nodes report as healthy
  - Test end-to-end DHT operations (store, get, find_node)
  - Confirm pubsub system works correctly with stable DHT
  - Validate network can handle normal load without connection failures
  - Ask the user if questions arise during final validation

## Implementation Notes

### Debugging Priority
1. **IMMEDIATE**: Test basic connectivity - can nodes reach each other at all?
2. **CRITICAL**: Fix bootstrap server connection issues preventing initial coordination
3. **HIGH**: Debug peer-to-peer connection establishment failures
4. **MEDIUM**: Implement emergency bootstrap mode for sparse networks
5. **LOW**: Add comprehensive monitoring and rollback procedures

### Key Debugging Areas
- **Docker Networking**: Verify internal container connectivity and nginx proxy routing
- **WebSocket Servers**: Ensure nodes are actually listening on advertised ports
- **Connection Managers**: Verify factory routing and manager-specific functionality
- **Bootstrap Coordination**: Fix "Unexpected server response: 200" and peer introduction failures
- **Data Transfer Metrics**: Ensure metrics don't interfere with core DHT operations

### Success Criteria
- All 15 Oracle YZ nodes report as healthy
- Nodes can establish 3-8 peer connections each
- find_node operations complete in <2 seconds
- Pubsub channel creation works in <5 seconds
- Network maintains stability under normal load