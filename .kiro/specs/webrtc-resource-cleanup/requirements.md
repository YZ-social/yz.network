# Requirements Document

## Introduction

This feature implements robust WebRTC resource cleanup for the YZ Network to prevent memory leaks and ensure proper connection teardown. The current implementation performs basic cleanup (calling `pc.close()` and deleting map entries) without considering connection state, cleanup order, or proper resource release. This leads to resource leaks including UDP sockets and file descriptors that accumulate over time, causing server instability after extended operation (observed: 500+ UDP sockets, 2000+ file descriptors after 9 hours).

The enhanced cleanup system will:
- Wait for stable connection states before cleanup (avoiding cleanup during transitional states)
- Execute cleanup in the correct order (tracks → listeners → channel → connection → references)
- Track event listeners for proper removal
- Provide metrics for monitoring cleanup success/failure
- Handle concurrent cleanup attempts safely
- Properly clean up connections that timeout during establishment
- Handle unexpected peer disconnections gracefully

## Glossary

- **WebRTCConnectionManager**: The connection manager class responsible for WebRTC peer-to-peer connections between browser nodes
- **RTCPeerConnection**: The native WebRTC API object representing a connection to a remote peer
- **RTCDataChannel**: The WebRTC data channel used for sending/receiving DHT messages
- **Transitional_State**: Connection states where cleanup is unsafe: 'new', 'connecting', 'disconnected'
- **Stable_State**: Connection states where cleanup is safe: 'connected', 'failed', 'closed'
- **ConnectionTracker**: A new class for monitoring cleanup metrics and active connection counts
- **Media_Track**: Audio or video tracks associated with a peer connection (RTCRtpSender/RTCRtpReceiver tracks)
- **Event_Listener**: A registered callback function on RTCPeerConnection or RTCDataChannel
- **Resource_Cleanup**: The process of releasing UDP sockets, file descriptors, and memory associated with a connection
- **Connection_Timeout**: When a connection attempt exceeds the maximum allowed time during establishment

## Requirements

### Requirement 1: State-Aware Cleanup

**User Story:** As a developer, I want WebRTC connections to only be cleaned up when in stable states, so that cleanup operations don't interfere with ongoing connection negotiations.

#### Acceptance Criteria

1. WHEN cleanup is requested AND the RTCPeerConnection is in a Transitional_State, THE WebRTCConnectionManager SHALL wait for a Stable_State before proceeding with cleanup
2. WHEN cleanup is requested AND the RTCPeerConnection is in a Stable_State, THE WebRTCConnectionManager SHALL proceed with cleanup immediately
3. WHEN waiting for a Stable_State, THE WebRTCConnectionManager SHALL timeout after a configurable duration and force cleanup
4. THE WebRTCConnectionManager SHALL classify 'new', 'connecting', and 'disconnected' as Transitional_States
5. THE WebRTCConnectionManager SHALL classify 'connected', 'failed', and 'closed' as Stable_States

### Requirement 2: Ordered Cleanup Execution

**User Story:** As a developer, I want WebRTC resources to be cleaned up in the correct order, so that dependent resources are released before their dependencies.

#### Acceptance Criteria

1. WHEN performing cleanup, THE WebRTCConnectionManager SHALL stop all Media_Tracks before closing the RTCDataChannel
2. WHEN performing cleanup, THE WebRTCConnectionManager SHALL remove all Event_Listeners before closing the RTCPeerConnection
3. WHEN performing cleanup, THE WebRTCConnectionManager SHALL close the RTCDataChannel before closing the RTCPeerConnection
4. WHEN performing cleanup, THE WebRTCConnectionManager SHALL close the RTCPeerConnection before nullifying references
5. WHEN performing cleanup, THE WebRTCConnectionManager SHALL nullify all connection references after closing the RTCPeerConnection

### Requirement 3: Event Listener Tracking

**User Story:** As a developer, I want all event listeners to be tracked and removed during cleanup, so that no orphaned listeners cause memory leaks.

#### Acceptance Criteria

1. WHEN registering an event listener on RTCPeerConnection or RTCDataChannel, THE WebRTCConnectionManager SHALL store the listener reference for later removal
2. WHEN cleanup is performed, THE WebRTCConnectionManager SHALL remove all tracked Event_Listeners from their targets
3. THE WebRTCConnectionManager SHALL provide a method to register listeners that automatically tracks them for cleanup
4. FOR ALL registered Event_Listeners, cleanup then checking listener count SHALL result in zero remaining listeners (round-trip property)

### Requirement 4: Connection Metrics Tracking

**User Story:** As a developer, I want to monitor cleanup success and failure rates, so that I can identify resource leak issues in production.

#### Acceptance Criteria

1. THE ConnectionTracker SHALL maintain a count of active connections
2. WHEN a connection is established, THE ConnectionTracker SHALL increment the active connection count
3. WHEN cleanup succeeds, THE ConnectionTracker SHALL increment the cleanup success count and decrement active connections
4. WHEN cleanup fails, THE ConnectionTracker SHALL increment the cleanup failure count
5. THE ConnectionTracker SHALL provide a method to retrieve current resource statistics
6. WHEN cleanup fails, THE ConnectionTracker SHALL log detailed error information including connection state and error message
7. FOR ALL connection lifecycle operations, the active connection count SHALL equal established minus successfully cleaned up connections (invariant property)

### Requirement 5: Concurrent Cleanup Prevention

**User Story:** As a developer, I want concurrent cleanup attempts on the same connection to be prevented, so that cleanup operations don't interfere with each other.

#### Acceptance Criteria

1. WHEN cleanup is already in progress for a connection, THE WebRTCConnectionManager SHALL ignore subsequent cleanup requests for that connection
2. WHEN cleanup completes, THE WebRTCConnectionManager SHALL clear the cleanup-in-progress flag
3. IF cleanup fails with an error, THEN THE WebRTCConnectionManager SHALL still clear the cleanup-in-progress flag

### Requirement 6: Routing Table Integration

**User Story:** As a developer, I want disconnected peers to be removed from the routing table, so that the DHT doesn't attempt to route messages through dead connections.

#### Acceptance Criteria

1. WHEN an unexpected disconnect occurs, THE WebRTCConnectionManager SHALL emit a disconnect event with the peer ID
2. WHEN a disconnect event is received, THE routing table SHALL remove the peer from its contact list
3. WHEN cleanup is performed due to timeout, THE WebRTCConnectionManager SHALL emit a disconnect event

### Requirement 7: Complete Shutdown Cleanup

**User Story:** As a developer, I want all connections to be properly cleaned up when the manager is destroyed, so that no resources leak on application shutdown.

#### Acceptance Criteria

1. WHEN destroy is called on WebRTCConnectionManager, THE WebRTCConnectionManager SHALL perform cleanup on all active connections
2. WHEN destroy is called, THE WebRTCConnectionManager SHALL wait for all cleanup operations to complete before resolving
3. WHEN destroy is called, THE ConnectionTracker SHALL report zero active connections after completion
4. WHEN destroy is called, THE WebRTCConnectionManager SHALL handle cleanup failures gracefully without throwing exceptions
5. FOR ALL active connections at destroy time, cleanup SHALL be attempted for each connection (completeness property)

### Requirement 8: Timeout Connection Cleanup

**User Story:** As a developer, I want connections that timeout during establishment to be properly cleaned up, so that failed connection attempts don't leak resources.

#### Acceptance Criteria

1. WHEN a connection attempt times out, THE WebRTCConnectionManager SHALL perform complete resource cleanup
2. WHEN a connection attempt times out, THE WebRTCConnectionManager SHALL log the timeout event to ConnectionTracker
3. WHEN a connection attempt times out, THE WebRTCConnectionManager SHALL not leave any dangling event listeners
4. WHEN a connection attempt times out, THE WebRTCConnectionManager SHALL ensure the RTCPeerConnection is fully closed
5. WHEN a connection attempt times out, THE WebRTCConnectionManager SHALL emit a disconnect event with the peer ID

### Requirement 9: Unexpected Disconnect Cleanup

**User Story:** As a developer, I want unexpected peer disconnections to trigger proper cleanup, so that abandoned connections don't leak resources.

#### Acceptance Criteria

1. WHEN a remote peer disconnects unexpectedly, THE WebRTCConnectionManager SHALL detect the disconnection via connection state change
2. WHEN a remote peer disconnects unexpectedly, THE WebRTCConnectionManager SHALL perform complete resource cleanup
3. WHEN a remote peer disconnects unexpectedly, THE WebRTCConnectionManager SHALL log the event to ConnectionTracker with relevant details including peer ID and connection state
4. WHEN a remote peer disconnects unexpectedly, THE WebRTCConnectionManager SHALL remove the contact from the host's routing table
