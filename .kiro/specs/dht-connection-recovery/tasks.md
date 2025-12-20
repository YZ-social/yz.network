# DHT Connection Recovery Implementation Plan

## Overview

This implementation plan focuses on debugging and enhancing the existing DHT Connection Recovery system. Many components are already implemented but may need debugging, optimization, or enhancement based on the requirements analysis.

## Implementation Status Legend
- **[IMPLEMENTED]** - Feature exists and appears functional, may need minor debugging
- **[REVIEW]** - Feature partially implemented, needs review and potential fixes
- **[ENHANCE]** - Feature exists but needs enhancement to meet requirements
- **[NEW]** - Feature needs to be implemented from scratch

## Task List

- [ ] 1. **[REVIEW]** Enhanced error handling and fast failure mechanisms
  - Review existing timeout handling in ConnectionManager (currently 45s, needs differentiation)
  - Implement comprehensive DHT_ErrorCode enum with specific error types (currently basic)
  - Enhance fast failure response system (some exists, needs specific error codes)
  - Add differentiated timeout strategy (10s connected, 3s disconnected, 30s bootstrap)
  - _Requirements: 2.3, 12.1, 12.2, 12.3, 12.4, 12.5_
  - _Current: Basic timeout handling exists, needs enhancement_

- [ ]* 1.1 Write property test for fast failure mechanisms
  - **Property 6: Fast Failure with Error Codes**
  - **Validates: Requirements 12.1**

- [ ]* 1.2 Write property test for differentiated timeouts
  - **Property 7: Differentiated Timeouts**
  - **Validates: Requirements 12.5**

- [ ] 2. **[IMPLEMENTED]** Connection Manager architecture with browser/Node.js asymmetry
  - ✅ Abstract ConnectionManager superclass exists with transport-agnostic interface
  - ✅ WebSocketConnectionManager implemented for browser-Node.js and Node.js-Node.js connections
  - ✅ WebRTCConnectionManager implemented for browser-browser connections
  - ✅ ConnectionManagerFactory exists with node type detection and manager selection
  - 🔍 **DEBUG NEEDED**: Review Perfect Negotiation implementation for WebRTC conflicts
  - 🔍 **DEBUG NEEDED**: Verify STUN server configuration for NAT traversal
  - _Requirements: 1.1, 1.4, 6.3, 9.1, 9.2, 9.3_
  - _Current: Full implementation exists, needs debugging for connection issues_

- [ ]* 2.1 Write property test for browser-Node.js connection direction
  - **Property 21: Browser-NodeJS Connection Direction**
  - **Validates: Requirements 9.2**

- [ ]* 2.2 Write property test for Perfect Negotiation conflict resolution
  - **Property 20: Perfect Negotiation Conflict Resolution**
  - **Validates: Requirements 9.1**

- [ ]* 2.3 Write property test for Perfect Negotiation polite peer behavior
  - **Property 22: Perfect Negotiation Polite Peer**
  - **Validates: Requirements 9.3**

- [ ] 3. **[IMPLEMENTED]** Bootstrap Server with stateless bridge interactions
  - ✅ EnhancedBootstrapServer exists with comprehensive functionality
  - ✅ Stateless bridge node querying implemented (connect, query, disconnect pattern)
  - ✅ Multiple bootstrap endpoints support exists
  - ✅ Bridge node load balancing implemented
  - ✅ Invitation model and open network security models implemented
  - 🔍 **DEBUG NEEDED**: Review bridge node availability testing (testSingleBridge method)
  - 🔍 **DEBUG NEEDED**: Verify stateless interaction patterns are working correctly
  - _Requirements: 1.5, 2.3, 5.2, 5.3, 5.5, 7.2, 11.1, 11.2, 11.3, 11.4, 11.5_
  - _Current: Full implementation exists, needs debugging for connection coordination issues_

- [ ]* 3.1 Write property test for stateless bootstrap interactions
  - **Property 13: Stateless Bootstrap Interactions**
  - **Validates: Requirements 11.2**

- [ ]* 3.2 Write property test for NAT traversal coordination
  - **Property 4: NAT Traversal Coordination**
  - **Validates: Requirements 1.5**

- [ ] 4. **[REVIEW]** Bridge Node functionality
  - 🔍 **REVIEW NEEDED**: Verify bridge node implementation exists and works correctly
  - 🔍 **REVIEW NEEDED**: Check if bridge nodes properly reject data storage operations
  - 🔍 **REVIEW NEEDED**: Verify random peer selection service for bootstrap server queries
  - 🔍 **REVIEW NEEDED**: Ensure bridge nodes participate in routing but not data operations
  - _Requirements: 5.1, 5.2, 5.4_
  - _Current: Bridge node functionality may exist, needs verification and testing_

- [ ]* 4.1 Write property test for bridge node data rejection
  - **Property 12: Bridge Node Data Rejection**
  - **Validates: Requirements 5.4**

- [ ] 5. **[ENHANCE]** Strategic routing table maintenance
  - 🔍 **ENHANCE**: Add neighborhood connection prioritization (k-closest to own address)
  - ✅ Connection limit management exists (platformLimits.maxConnections)
  - 🔍 **ENHANCE**: Implement strategic connection dropping based on routing value
  - 🔍 **ENHANCE**: Add disconnected node retention for fallback discovery with connected node preference
  - ✅ Ping-based cleanup exists (cleanupStaleConnections method)
  - 🔍 **ENHANCE**: Add routing table diversity optimization
  - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5_
  - _Current: Basic routing table exists, needs strategic enhancements_

- [ ]* 5.1 Write property test for neighborhood connection priority
  - **Property 23: Neighborhood Connection Priority**
  - **Validates: Requirements 10.1**

- [ ]* 5.2 Write property test for disconnected node retention with connected preference
  - **Property 24: Disconnected Node Retention with Connected Preference**
  - **Validates: Requirements 10.4**

- [ ] 6. **[IMPLEMENTED]** Connection state management and recovery
  - ✅ Immediate routing table updates exist (handlePeerConnected/Disconnected)
  - ✅ Connection cleanup exists (cleanupStaleConnections method)
  - ✅ Connection health checks exist (ping method in ConnectionManager)
  - ✅ Automatic reconnection exists (bootstrap retry mechanisms)
  - ✅ Peer metadata synchronization exists (ConnectionManagerFactory.setPeerMetadata)
  - 🔍 **DEBUG NEEDED**: Verify 5-second disconnection cleanup timing
  - 🔍 **DEBUG NEEDED**: Review stale connection detection accuracy
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_
  - _Current: Full implementation exists, needs debugging for timing and accuracy_

- [ ]* 6.1 Write property test for immediate routing table updates
  - **Property 10: Immediate Routing Table Updates**
  - **Validates: Requirements 4.1**

- [ ]* 6.2 Write property test for timely disconnection cleanup
  - **Property 11: Timely Disconnection Cleanup**
  - **Validates: Requirements 4.2**

- [ ] 7. **[REVIEW]** Docker networking with nginx proxy support
  - 🔍 **REVIEW NEEDED**: Check if external address advertisement uses nginx proxy addresses
  - 🔍 **REVIEW NEEDED**: Verify proxy connection handling with WebSocket upgrade headers
  - 🔍 **REVIEW NEEDED**: Test internal/external connection source handling
  - 🔍 **REVIEW NEEDED**: Verify resilience to container hostname changes
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_
  - _Current: Docker deployment exists, needs verification of proxy configuration_

- [ ]* 7.1 Write property test for external address advertisement
  - **Property 14: External Address Advertisement**
  - **Validates: Requirements 6.1**

- [ ]* 7.2 Write property test for proxy connection handling
  - **Property 15: Proxy Connection Handling**
  - **Validates: Requirements 6.3**

- [ ] 8. **[IMPLEMENTED]** Rate limiting with intelligent bypass mechanisms
  - ✅ Rate limiting exists (findNodeRateLimit Map with 500ms minimum interval)
  - ✅ Emergency bypass mechanisms exist (emergencyBypass parameter)
  - ✅ Per-peer rate limiting implemented to prevent spam
  - 🔍 **ENHANCE**: Add request queuing with exponential backoff during rate limits
  - 🔍 **ENHANCE**: Add network size-based rate limit scaling
  - 🔍 **ENHANCE**: Implement alternative discovery methods during rate limit periods
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_
  - _Current: Basic rate limiting exists, needs enhancement for queuing and scaling_

- [ ]* 8.1 Write property test for legitimate discovery allowance
  - **Property 8: Legitimate Discovery Allowance**
  - **Validates: Requirements 3.1**

- [ ]* 8.2 Write property test for rate limit queuing
  - **Property 9: Rate Limit Queuing**
  - **Validates: Requirements 3.5**

- [ ] 9. **[IMPLEMENTED]** Automatic recovery mechanisms
  - ✅ Bootstrap fallback exists (setupBootstrapRetry method)
  - ✅ Connection loss detection exists (getConnectedPeers checks)
  - ✅ Exponential backoff retry exists (peerFailureBackoff Map)
  - ✅ Connection storm prevention exists (discoveryGracePeriod, jitter in timing)
  - 🔍 **DEBUG NEEDED**: Verify 60-second recovery window timing
  - 🔍 **DEBUG NEEDED**: Verify 5-attempt retry limit enforcement
  - 🔍 **ENHANCE**: Add network partition healing with automatic merge
  - _Requirements: 1.3, 1.4, 7.1, 7.3, 7.4, 7.5_
  - _Current: Most recovery mechanisms exist, needs debugging and partition healing_

- [ ]* 9.1 Write property test for connection loss recovery
  - **Property 2: Connection Loss Recovery**
  - **Validates: Requirements 1.3**

- [ ]* 9.2 Write property test for exponential backoff retry
  - **Property 3: Exponential Backoff Retry**
  - **Validates: Requirements 1.4**

- [ ]* 9.3 Write property test for bootstrap fallback
  - **Property 16: Bootstrap Fallback**
  - **Validates: Requirements 7.1**

- [ ]* 9.4 Write property test for partition healing
  - **Property 17: Partition Healing**
  - **Validates: Requirements 7.5**

- [ ] 10. **[IMPLEMENTED]** Mesh topology formation
  - ✅ Peer announcement system exists (inviteNewClient method)
  - ✅ Peer announcement processing exists (handleInvitationReceived)
  - ✅ Routing table updates exist (handlePeerConnected)
  - ✅ Connection establishment timing exists (discoveryGracePeriod)
  - ✅ Minimum connectivity checks exist (connectedPeers < 3 triggers discovery)
  - 🔍 **DEBUG NEEDED**: Verify 30-second connection establishment window
  - 🔍 **DEBUG NEEDED**: Ensure mesh topology (not hub-and-spoke) formation
  - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_
  - _Current: Full implementation exists, needs debugging for topology formation_

- [ ]* 10.1 Write property test for peer announcement propagation
  - **Property 18: Peer Announcement Propagation**
  - **Validates: Requirements 8.1**

- [ ]* 10.2 Write property test for minimum connectivity
  - **Property 19: Minimum Connectivity**
  - **Validates: Requirements 8.5**

- [ ] 11. **[IMPLEMENTED]** Startup connection establishment
  - ✅ Startup connection timing exists (30s timeout in ConnectionManager)
  - ✅ Direct Docker network connections exist (WebSocket connections)
  - ✅ Minimum connectivity checks exist (connectedPeers < 3 logic)
  - ✅ Startup validation exists (isBootstrapped flag)
  - 🔍 **DEBUG NEEDED**: Verify 30-second startup window enforcement
  - 🔍 **DEBUG NEEDED**: Test direct Docker network connections without bootstrap
  - _Requirements: 1.1, 1.2_
  - _Current: Full implementation exists, needs debugging for Docker networking_

- [ ]* 11.1 Write property test for startup connection success
  - **Property 1: Startup Connection Success**
  - **Validates: Requirements 1.1**

- [ ] 12. **[NEW]** Optimized data republishing system
  - 🆕 **IMPLEMENT**: Add storage metadata with randomized refresh timing and spread window
  - 🆕 **IMPLEMENT**: Implement delegated replication to minimize network probes
  - 🆕 **IMPLEMENT**: Add lightweight verification with hash comparison before data transfer
  - 🆕 **IMPLEMENT**: Implement timestamp coordination for republishing attempts
  - ✅ Basic TTL-based data expiration exists (republishQueue, expireInterval)
  - 🔍 **ENHANCE**: Add grace period to existing TTL system
  - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5_
  - _Current: Basic republishing exists, needs optimization features from design_

- [ ]* 12.1 Write property test for randomized republishing timing
  - **Property 25: Randomized Republishing Timing**
  - **Validates: Requirements 13.1**

- [ ]* 12.2 Write property test for delegated replication optimization
  - **Property 26: Delegated Replication Optimization**
  - **Validates: Requirements 13.2**

- [ ]* 12.3 Write property test for lightweight verification
  - **Property 27: Lightweight Verification**
  - **Validates: Requirements 13.3**

- [x] 13. **[IMPLEMENTED]** Sticky Pub/Sub system with message persistence


  - ✅ Complete three-tier architecture exists (Coordinator, Collections, Messages)
  - ✅ Optimistic concurrency control with automatic merge implemented
  - ✅ Message persistence with configurable TTL implemented
  - ✅ Historical message delivery for new subscribers implemented
  - ✅ Push delivery with polling fallback implemented (MessageDelivery.js)
  - ✅ Cryptographic message signing with Ed25519 implemented
  - ✅ Signature-based subscription renewal implemented
  - ✅ Comprehensive test suite: 122+ tests passing (100%)
  - 🔍 **DEBUG NEEDED**: Review garbage collection for expired messages and subscriptions
  - 🔍 **DEBUG NEEDED**: Verify push delivery excludes inactive browser tabs (apply same filter as onboarding)
  - 🔍 **DEBUG NEEDED**: Test integration with connection recovery after network failures
  - 🔍 **DEBUG NEEDED**: Verify coordinator pruning and snapshot creation works correctly
  - _Requirements: 16.1, 16.2, 16.3, 16.4, 16.5, 17.1, 17.2, 17.3, 17.4, 17.5, 18.1, 18.2, 18.3, 18.4, 18.5, 19.1, 19.2, 19.3, 19.4, 19.5_
  - _Current: Full implementation exists (~4,700 lines), needs debugging for connection recovery integration_

- [ ]* 13.1 Write property test for message persistence
  - **Property 32: Message Persistence**
  - **Validates: Requirements 16.1**

- [ ]* 13.2 Write property test for historical message delivery
  - **Property 33: Historical Message Delivery**
  - **Validates: Requirements 16.2**

- [ ]* 13.3 Write property test for optimistic concurrency handling
  - **Property 34: Optimistic Concurrency Handling**
  - **Validates: Requirements 16.3**

- [ ]* 13.4 Write property test for push delivery performance
  - **Property 35: Push Delivery Performance**
  - **Validates: Requirements 17.5**

- [ ]* 13.5 Write property test for inactive tab exclusion
  - **Property 36: Inactive Tab Exclusion**
  - **Validates: Requirements 17.4**

- [ ]* 13.6 Write property test for message expiration cleanup
  - **Property 37: Message Expiration Cleanup**
  - **Validates: Requirements 18.1**

- [ ]* 13.7 Write property test for subscription expiration cleanup
  - **Property 38: Subscription Expiration Cleanup**
  - **Validates: Requirements 18.2**

- [ ]* 13.8 Write property test for cryptographic message signing
  - **Property 39: Cryptographic Message Signing**
  - **Validates: Requirements 19.1**

- [ ]* 13.9 Write property test for signature-based subscription renewal
  - **Property 40: Signature-Based Subscription Renewal**
  - **Validates: Requirements 19.3**

- [ ] 14. **[REVIEW]** End-to-end encryption
  - 🔍 **REVIEW NEEDED**: Check if encryption system exists (InvitationToken suggests crypto exists)
  - 🔍 **REVIEW NEEDED**: Verify automatic AES-256-GCM encryption before DHT data transmission
  - 🔍 **REVIEW NEEDED**: Check automatic decryption and signature verification on retrieval
  - ✅ ECDSA identity keys exist (keyPair generation in DHT start method)
  - 🔍 **REVIEW NEEDED**: Verify tampering detection through signature verification
  - 🔍 **REVIEW NEEDED**: Check backward compatibility support for encrypted and plaintext data
  - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5_
  - _Current: Crypto infrastructure exists, needs verification of data encryption features_

- [ ]* 14.1 Write property test for automatic data encryption
  - **Property 30: Automatic Data Encryption**
  - **Validates: Requirements 15.1**

- [ ]* 14.2 Write property test for tampering detection
  - **Property 31: Tampering Detection**
  - **Validates: Requirements 15.4**

- [ ] 15. **[IMPLEMENTED]** Comprehensive logging and diagnostics
  - ✅ Detailed connection failure logging exists (extensive console.log throughout)
  - ✅ Rate limiting logging exists (rate limit threshold and wait time logging)
  - ✅ Bridge node testing exists (testSingleBridge, checkBridgeAvailability methods)
  - ✅ Docker network validation exists (detectPlatformLimits, environment detection)
  - ✅ Comprehensive error logging exists (try/catch blocks with detailed logging)
  - 🔍 **ENHANCE**: Standardize logging format and add structured logging
  - 🔍 **ENHANCE**: Add centralized diagnostics dashboard
  - _Requirements: 2.1, 2.2, 2.4, 2.5_
  - _Current: Extensive logging exists, needs standardization and enhancement_

- [ ]* 15.1 Write property test for connection failure logging
  - **Property 5: Connection Failure Logging**
  - **Validates: Requirements 2.1**

- [ ] 16. **[IMMEDIATE]** Diagnose current connection failure root cause
  - 🚨 **IMMEDIATE**: Check if DHT nodes are actually starting WebSocket servers on their advertised ports
  - 🚨 **IMMEDIATE**: Test manual WebSocket connection to wss://imeyouwe.com/node8 from another container
  - 🚨 **IMMEDIATE**: Verify nginx configuration routes /nodeX paths to correct internal containers
  - 🚨 **IMMEDIATE**: Check if containers can reach each other using internal Docker network names
  - 🚨 **IMMEDIATE**: Validate that nodes are using correct external addresses in metadata
  - 🚨 **IMMEDIATE**: Debug connection manager factory - ensure correct manager type selection
  - 🚨 **IMMEDIATE**: Check if WebSocket connection attempts are reaching target containers
  - 🚨 **IMMEDIATE**: Verify that connection establishment isn't failing due to handshake issues
  - _Requirements: 1.1, 1.2, 6.1, 6.3_
  - _Current: Bridge node works, peer discovery works, but peer-to-peer connections fail_

- [ ] 17. **[CRITICAL]** Debug and fix current DHT peer-to-peer connection failures
  - 🚨 **CRITICAL**: Bridge node can discover peers (22 connected) but DHT nodes cannot connect to each other
  - 🚨 **CRITICAL**: All find_node queries failing with "No connection to peer" despite peers being in routing table
  - 🚨 **CRITICAL**: Emergency bypasses being triggered due to connection failures
  - 🚨 **CRITICAL**: Peers being removed from routing tables after 29 failures
  - 🚨 **CRITICAL**: Investigate nginx proxy routing - nodes advertise wss://imeyouwe.com/nodeX but connections fail
  - 🚨 **CRITICAL**: Verify WebSocket servers are actually listening on advertised addresses
  - 🚨 **CRITICAL**: Test direct container-to-container connectivity within Docker network
  - 🚨 **CRITICAL**: Check if nodes can reach their own advertised addresses
  - 🚨 **CRITICAL**: Validate that nginx is correctly routing WebSocket upgrade requests
  - 🚨 **CRITICAL**: Debug why "not connected to bridge" when bridge shows 22 connections


- [ ] 18. **[PRIORITY]** Debug and fix Pub/Sub integration issues







  - 🚨 **HIGH PRIORITY**: Fix Pub/Sub system integration with connection recovery
  - 🚨 **HIGH PRIORITY**: Apply inactive tab filtering to Pub/Sub coordinator selection (same as onboarding)
  - 🚨 **HIGH PRIORITY**: Test Pub/Sub message delivery after network partitions and reconnections
  - 🚨 **HIGH PRIORITY**: Verify Pub/Sub works correctly with Docker networking and nginx proxy
  - 🚨 **HIGH PRIORITY**: Debug any issues with DHT storage integration for Pub/Sub data
  - 🚨 **HIGH PRIORITY**: Test Pub/Sub garbage collection during connection failures
  - 🚨 **HIGH PRIORITY**: Verify push delivery coordination works with connection manager
  - 🚨 **HIGH PRIORITY**: Ensure Pub/Sub coordinator replication works with DHT connection recovery

- [ ] 19. Final integration and testing checkpoint
  - Ensure all tests pass and system integration is complete
  - Validate end-to-end connection recovery scenarios work correctly
  - Test Docker networking with nginx proxy configuration
  - Verify bootstrap server coordination with bridge nodes functions properly
  - Ensure all error handling and recovery mechanisms work correctly
  - Validate Pub/Sub system works correctly with connection recovery
  - Test Pub/Sub message delivery during network failures and recovery
  - Verify push delivery coordination excludes inactive tabs
  - Ensure Pub/Sub garbage collection works during connection issues
  - Ask the user if questions arise during integration testing

## Implementation Notes

### Property-Based Testing Configuration
- Use **fast-check** JavaScript library for property-based testing
- Configure minimum 100 iterations per property test
- Tag each property test with: **Feature: dht-connection-recovery, Property {number}: {property_text}**
- Generate custom test data for network topologies, node configurations, and connection scenarios

### Connection Type Matrix
- **Browser ↔ Node.js**: WebSocket (Browser client → Node.js server)
- **Node.js ↔ Browser**: WebSocket (Browser client → Node.js server, via invitation)
- **Browser ↔ Browser**: WebRTC with Perfect Negotiation and STUN servers
- **Node.js ↔ Node.js**: WebSocket with Perfect Negotiation for server selection

### Key Architecture Principles
- Connection managers are per-connection, not per-node
- Bootstrap server uses stateless interactions with bridge nodes
- Strategic routing maintains neighborhood connectivity while allowing disconnected nodes for fallback
- Fast failure with specific error codes instead of timeouts
- Delegated replication minimizes network probes for data republishing