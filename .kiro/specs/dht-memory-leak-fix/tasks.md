# Implementation Plan

- [x] 1. Write bug condition exploration test
  - **Property 1: Bug Condition** - Timer Leak on Stop
  - **IMPORTANT**: Write this property-based test BEFORE implementing the fix
  - **GOAL**: Surface counterexamples that demonstrate the bug exists
  - **Scoped PBT Approach**: Scope the property to concrete failing cases - call stop() and verify timers continue running
  - Test that `KademliaDHT.stop()` leaves interval timers running (from Bug Condition in design)
  - Test that `OverlayNetwork.stop()` leaves interval timers running
  - Run test on UNFIXED code - expect FAILURE (this confirms the bug exists)
  - Document counterexamples found (e.g., "After stop(), republishData timer still fires")
  - _Requirements: 1.1, 1.2, 1.3_

- [x] 2. Write preservation property tests (BEFORE implementing fix)
  - **Property 2: Preservation** - Maintenance Tasks During Operation
  - **IMPORTANT**: Follow observation-first methodology
  - Observe: Maintenance tasks execute at configured intervals on unfixed code
  - Observe: Valid pending requests are processed correctly before timeout
  - Observe: DHT messages are routed correctly during normal operation
  - Write property-based test: for all normal operations (no stop/restart), maintenance behavior is preserved
  - Verify test passes on UNFIXED code
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8_

- [x] 3. Fix KademliaDHT timer management

  - [x] 3.1 Store all interval timer references in startMaintenanceTasks()
    - Store `this.republishDataTimer = setInterval(...)` for republishData
    - Store `this.cleanupTrackingMapsTimer = setInterval(...)` for cleanupTrackingMaps
    - Store `this.cleanupTimer = setInterval(...)` for cleanup
    - Store `this.routingMaintenanceTimer = setInterval(...)` for maintainRoutingTableConnections
    - Store `this.staleCleanupTimer = setInterval(...)` for cleanupStaleConnections
    - _Bug_Condition: isBugCondition(input) where operation='stop' AND hasUncleanedIntervalTimers_
    - _Expected_Behavior: All timer references stored for later cleanup_
    - _Requirements: 2.1_

  - [x] 3.2 Clear all timers in stop() method
    - Clear `republishDataTimer`, `cleanupTrackingMapsTimer`, `cleanupTimer`, `routingMaintenanceTimer`, `staleCleanupTimer`
    - Clear `pingMaintenanceTimer` if exists
    - Call `stopDHTOfferPolling()` to clear `dhtOfferPollingInterval`
    - Set all timer references to null after clearing
    - _Bug_Condition: isBugCondition(input) where operation='stop'_
    - _Expected_Behavior: allTimersCleared(result) returns true_
    - _Preservation: Existing stop() behavior for bootstrapRetryTimer and refreshTimer unchanged_
    - _Requirements: 2.1, 2.3_

- [x] 4. Fix OverlayNetwork timer management

  - [x] 4.1 Store all interval timer references in startMaintenanceTasks()
    - Store `this.keepAliveTimer = setInterval(...)` for sendKeepAlives
    - Store `this.routingCacheCleanupTimer = setInterval(...)` for cleanupRoutingCache
    - Store `this.connectionHealthTimer = setInterval(...)` for checkConnectionHealth
    - _Bug_Condition: isBugCondition(input) where operation='stop' AND hasUncleanedIntervalTimers_
    - _Expected_Behavior: All timer references stored for later cleanup_
    - _Requirements: 2.2_

  - [x] 4.2 Clear all timers in stop() method
    - Clear `keepAliveTimer`, `routingCacheCleanupTimer`, `connectionHealthTimer`
    - Set all timer references to null after clearing
    - _Bug_Condition: isBugCondition(input) where operation='stop'_
    - _Expected_Behavior: allTimersCleared(result) returns true_
    - _Requirements: 2.2, 2.3_

- [x] 5. Add pendingRequests cleanup in cleanupTrackingMaps()
  - Add explicit cleanup of timed-out `pendingRequests` entries
  - Use `requestTimeout * 2` as the cleanup threshold
  - Delete entries where `now - request.timestamp > requestTimeout * 2`
  - Log cleanup count for debugging
  - _Bug_Condition: isBugCondition(input) where operation='running' AND hasUnboundedMapGrowth_
  - _Expected_Behavior: pendingRequests.size < MAX_BOUNDED_SIZE_
  - _Preservation: Valid pending requests continue to be processed correctly_
  - _Requirements: 2.4, 3.4_

- [x] 6. Add failedPeerQueries cleanup in cleanupTrackingMaps()
  - Add cleanup of stale entries from `failedPeerQueries` Map
  - Remove entries older than 10 minutes
  - Log cleanup count for debugging
  - _Bug_Condition: isBugCondition(input) where operation='running' AND hasUnboundedMapGrowth_
  - _Expected_Behavior: failedPeerQueries.size stays bounded_
  - _Preservation: Recent failure tracking preserved for routing decisions_
  - _Requirements: 2.5_

- [x] 7. Add handler verification and reattachment logic
  - Add `ensureDHTMessageHandler()` method to ConnectionManager
  - Check `listenerCount('dhtMessage')` and emit 'handlerDetached' if zero
  - In KademliaDHT, add logic to detect stale `_dhtMessageHandlerAttached` flag
  - Reset flag and reattach handler when actual listeners is 0 but flag is true
  - _Bug_Condition: isBugCondition(input) where operation='restart' AND hasDetachedMessageHandlers_
  - _Expected_Behavior: listenerCount('dhtMessage') > 0 after restart_
  - _Preservation: Normal message routing unchanged_
  - _Requirements: 2.6, 2.7, 3.6_

- [x] 8. Improve stale peer cleanup in RoutingTable
  - Enhance `removeStaleNodes()` to accept optional connectionManager parameter
  - Add connection-based stale detection for browser peers
  - Remove nodes not in connected set and older than maxAge
  - _Bug_Condition: isBugCondition(input) where operation='peerDisconnect' AND hasStalePeerEntries_
  - _Expected_Behavior: NOT routingTable.hasNode(disconnectedPeerId)_
  - _Preservation: Active peer entries maintained_
  - _Requirements: 2.8, 3.7_

- [x] 9. Verify bug condition exploration test now passes
  - **Property 1: Expected Behavior** - Timer Cleanup on Stop
  - **IMPORTANT**: Re-run the SAME test from task 1 - do NOT write a new test
  - The test from task 1 encodes the expected behavior
  - When this test passes, it confirms the expected behavior is satisfied
  - Run bug condition exploration test from step 1
  - **EXPECTED OUTCOME**: Test PASSES (confirms bug is fixed)
  - _Requirements: 2.1, 2.2, 2.3_

- [x] 10. Verify preservation tests still pass
  - **Property 2: Preservation** - Maintenance Tasks During Operation
  - **IMPORTANT**: Re-run the SAME tests from task 2 - do NOT write new tests
  - Run preservation property tests from step 2
  - **EXPECTED OUTCOME**: Tests PASS (confirms no regressions)
  - Confirm all tests still pass after fix (no regressions)
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8_

- [x] 11. Write unit tests for timer cleanup
  - Test `KademliaDHT.stop()` clears all 5 maintenance timers
  - Test `KademliaDHT.stop()` clears `refreshTimer`, `bootstrapRetryTimer`, `pingMaintenanceTimer`, `dhtOfferPollingInterval`
  - Test `OverlayNetwork.stop()` clears all 3 maintenance timers
  - Test `pendingRequests` entries are removed on timeout
  - Test `cleanupTrackingMaps()` removes orphaned entries from all Maps
  - _Requirements: 2.1, 2.2, 2.4, 2.5_

- [x] 12. Write property-based tests for bounded Map growth
  - Generate random request/timeout patterns and verify `pendingRequests` size stays bounded
  - Generate random peer connect/disconnect patterns and verify routing table stays clean
  - Generate random sequences of start/stop operations and verify no timer leaks
  - _Requirements: 2.3, 2.4, 2.5_

- [x] 13. Write integration tests for the full fix
  - Test full DHT lifecycle: start → run maintenance → stop → verify cleanup
  - Test OOM restart scenario: start → simulate OOM → restart → verify message handling
  - Test browser peer churn: connect browsers → disconnect → verify routing table cleanup
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8_

- [x] 14. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.
