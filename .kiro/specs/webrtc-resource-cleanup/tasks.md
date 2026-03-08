# Implementation Plan: WebRTC Resource Cleanup

## Overview

This implementation adds robust WebRTC resource cleanup to prevent memory leaks and ensure proper connection teardown. The work involves creating a new ConnectionTracker class, adding ConnectionStates utility, and extending WebRTCConnectionManager with state-aware cleanup methods, event listener tracking, and proper resource release ordering.

## Tasks

- [x] 1. Create ConnectionStates utility and ConnectionTracker class
  - [x] 1.1 Create ConnectionStates utility with state classification
    - Add `ConnectionStates` object with TRANSITIONAL and STABLE arrays
    - Implement `isTransitional(state)` and `isStable(state)` methods
    - Export from new file `src/network/ConnectionTracker.js`
    - _Requirements: 1.4, 1.5_

  - [x] 1.2 Implement ConnectionTracker singleton class
    - Add static properties: `activeConnections`, `cleanupSuccesses`, `cleanupFailures`, `failureLogs`
    - Implement `trackConnectionCreated()` method
    - Implement `trackConnectionClosed(success, reason, details)` method
    - Implement `getResourceStats()` method returning stats object
    - Implement `reset()` method for testing
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6_

  - [x] 1.3 Write unit tests for ConnectionTracker
    - Test `trackConnectionCreated` increments active count
    - Test `trackConnectionClosed` with success updates counters correctly
    - Test `trackConnectionClosed` with failure logs error details
    - Test `getResourceStats` returns correct structure
    - Test `reset` clears all counters
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

  - [x] 1.4 Write property test for state classification
    - **Property 1: State Classification Correctness**
    - **Validates: Requirements 1.4, 1.5**

  - [x] 1.5 Write property test for connection count invariant
    - **Property 5: Connection Count Invariant**
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.7**

- [x] 2. Checkpoint - Ensure ConnectionTracker tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 3. Add event listener tracking to WebRTCConnectionManager
  - [x] 3.1 Add listener tracking infrastructure
    - Add `trackedListeners` array property to WebRTCConnectionManager
    - Implement `registerListener(target, event, handler)` method
    - Method should add listener to target and store reference in `trackedListeners`
    - _Requirements: 3.1, 3.3_

  - [x] 3.2 Implement removeAllListeners method
    - Implement `removeAllListeners()` method
    - Iterate through `trackedListeners` and call `removeEventListener` on each
    - Clear `trackedListeners` array after removal
    - Handle errors gracefully (log and continue)
    - _Requirements: 3.2_

  - [x] 3.3 Update existing event listener registrations
    - Modify `setupPeerConnectionEvents` to use `registerListener`
    - Modify `setupDataChannelEvents` to use `registerListener`
    - Ensure all RTCPeerConnection and RTCDataChannel listeners are tracked
    - _Requirements: 3.1, 3.3_

  - [x] 3.4 Write property test for listener round-trip
    - **Property 4: Listener Registration Round-Trip**
    - **Validates: Requirements 3.1, 3.2, 3.4**

- [x] 4. Implement state-aware cleanup methods
  - [x] 4.1 Add cleanup properties and stopAllTracks method
    - Add `cleanupInProgress` boolean property (default: false)
    - Add `cleanupTimeout` property (default: 5000ms)
    - Implement `stopAllTracks()` method using `getSenders()` and `getReceivers()`
    - _Requirements: 2.1_

  - [x] 4.2 Implement waitForStableState method
    - Implement `async waitForStableState(timeout)` method
    - Check current state using `ConnectionStates.isStable()`
    - If stable, return immediately
    - If transitional, wait for `connectionstatechange` event or timeout
    - Log warning on timeout and return current state
    - _Requirements: 1.1, 1.2, 1.3_

  - [x] 4.3 Implement performCleanup method
    - Implement `performCleanup(reason)` method
    - Execute cleanup in order: tracks → listeners → channel → connection → refs
    - Wrap each step in try/catch to continue on errors
    - Log to ConnectionTracker on completion
    - Emit `peerDisconnected` event with peerId and reason
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 6.1_

  - [x] 4.4 Implement safeCleanup entry point
    - Implement `async safeCleanup(reason)` method
    - Check `cleanupInProgress` flag, return early if true
    - Set `cleanupInProgress = true` at start
    - Call `waitForStableState()` then `performCleanup()`
    - Clear `cleanupInProgress` in finally block
    - _Requirements: 5.1, 5.2, 5.3_

  - [x] 4.5 Write property test for state-aware cleanup behavior
    - **Property 2: State-Aware Cleanup Behavior**
    - **Validates: Requirements 1.1, 1.2**

  - [x] 4.6 Write property test for cleanup execution order
    - **Property 3: Cleanup Execution Order**
    - **Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5**

  - [x] 4.7 Write property test for concurrent cleanup prevention
    - **Property 7: Concurrent Cleanup Prevention**
    - **Validates: Requirements 5.1**

  - [x] 4.8 Write property test for cleanup flag consistency
    - **Property 8: Cleanup Flag Consistency**
    - **Validates: Requirements 5.2, 5.3**

- [x] 5. Checkpoint - Ensure cleanup method tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Integrate cleanup with existing connection lifecycle
  - [x] 6.1 Update destroyConnection to use safeCleanup
    - Modify `destroyConnection(peerId, reason)` to call `safeCleanup(reason)`
    - Ensure backward compatibility with existing callers
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

  - [x] 6.2 Update cleanupConnection to use safeCleanup
    - Modify `cleanupConnection()` to call `safeCleanup('cleanup')`
    - Ensure proper resource release
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

  - [x] 6.3 Add connection state change handler for unexpected disconnects
    - In `setupPeerConnectionEvents`, detect state changes to 'failed' or 'disconnected'
    - Trigger `safeCleanup('unexpected_disconnect')` on unexpected state changes
    - Log event to ConnectionTracker with peer ID and state
    - _Requirements: 9.1, 9.2, 9.3_

  - [x] 6.4 Add timeout cleanup handling
    - Ensure connection timeout triggers `safeCleanup('timeout')`
    - Log timeout event to ConnectionTracker
    - Emit disconnect event with peer ID
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

  - [x] 6.5 Write property test for disconnect event emission
    - **Property 9: Disconnect Event Emission**
    - **Validates: Requirements 6.1, 6.3, 8.5**

  - [x] 6.6 Write property test for timeout cleanup completeness
    - **Property 13: Timeout Cleanup Completeness**
    - **Validates: Requirements 8.1, 8.2, 8.3, 8.4**

  - [x] 6.7 Write property test for unexpected disconnect detection
    - **Property 14: Unexpected Disconnect Detection and Cleanup**
    - **Validates: Requirements 9.1, 9.2, 9.3**

- [x] 7. Implement routing table integration
  - [x] 7.1 Add peerDisconnected event listener in KademliaDHT
    - Listen for `peerDisconnected` events from WebRTCConnectionManager
    - Remove peer from routing table when event received
    - _Requirements: 6.2, 9.4_

  - [x] 7.2 Write property test for routing table integration
    - **Property 10: Routing Table Integration**
    - **Validates: Requirements 6.2, 9.4**

- [x] 8. Implement complete shutdown cleanup
  - [x] 8.1 Update destroy method for complete cleanup
    - Modify `destroy()` to iterate all active connections
    - Call `safeCleanup('shutdown')` for each connection
    - Use `Promise.allSettled` to wait for all cleanups
    - Handle individual failures gracefully without throwing
    - Verify `ConnectionTracker.activeConnections === 0` after completion
    - _Requirements: 7.1, 7.2, 7.3, 7.4_

  - [x] 8.2 Write property test for destroy completeness
    - **Property 11: Destroy Completeness**
    - **Validates: Requirements 7.1, 7.3, 7.5**

  - [x] 8.3 Write property test for destroy error resilience
    - **Property 12: Destroy Error Resilience**
    - **Validates: Requirements 7.2, 7.4**

- [x] 9. Add ConnectionTracker integration to createConnection
  - [x] 9.1 Track connection creation
    - Call `ConnectionTracker.trackConnectionCreated()` when connection is established
    - Ensure tracking happens after successful RTCPeerConnection creation
    - _Requirements: 4.2_

  - [x] 9.2 Write property test for cleanup failure logging
    - **Property 6: Cleanup Failure Logging**
    - **Validates: Requirements 4.4, 4.6**

- [x] 10. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The ConnectionTracker is a singleton shared across all WebRTCConnectionManager instances
- All cleanup methods use try/catch to ensure cleanup continues even if individual steps fail
