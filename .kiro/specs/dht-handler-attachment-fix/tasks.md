# Implementation Plan

- [x] 1. Write bug condition exploration test
  - **Property 1: Bug Condition** - DHT Handler Attachment for Incoming Connections
  - **CRITICAL**: This test MUST FAIL on unfixed code - failure confirms the bug exists
  - **DO NOT attempt to fix the test or the code when it fails**
  - **NOTE**: This test encodes the expected behavior - it will validate the fix when it passes after implementation
  - **GOAL**: Surface counterexamples that demonstrate the bug exists
  - **Scoped PBT Approach**: Scope the property to incoming WebSocket connections where a dedicated `peerManager` is created
  - Test that for any incoming connection, `peerManager.listenerCount('dhtMessage') > 0` after `handlePeerConnected()` completes
  - Test that `peerManager._dhtMessageHandlerAttached === true` for the dedicated manager
  - Test that handlers are attached BEFORE `setupConnection()` returns (timing check)
  - Test replacement cache path: fill bucket, add new peer, verify handlers attached despite `addNode()` returning false
  - Run test on UNFIXED code
  - **EXPECTED OUTCOME**: Test FAILS (this is correct - it proves the bug exists)
  - Document counterexamples found: `peerManager.listenerCount('dhtMessage')` returns 0, messages logged as "NO DHT MESSAGE LISTENERS ATTACHED!"
  - Mark task complete when test is written, run, and failure is documented
  - _Requirements: 1.1, 1.2, 1.3, 2.1, 2.2_

- [x] 2. Write preservation property tests (BEFORE implementing fix)
  - **Property 2: Preservation** - Outgoing Connection and Existing Node Behavior
  - **IMPORTANT**: Follow observation-first methodology
  - Observe: Outgoing WebSocket connections (initiator=true) create managers via `ConnectionManagerFactory.getManagerForPeer()` on unfixed code
  - Observe: Nodes successfully added to main bucket trigger `onNodeAdded` callback on unfixed code
  - Observe: `routingTable.getNode(peerId)` returning existing node uses that node's manager on unfixed code
  - Observe: Bootstrap connections (peerId starting with "bootstrap_") are ignored in routing table on unfixed code
  - Write property-based test: for all outgoing connections, manager is created via factory and handlers attached
  - Write property-based test: for all existing nodes with managers, no new manager is created
  - Write property-based test: for all bootstrap connections, routing table ignores them
  - Verify tests pass on UNFIXED code
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

- [x] 3. Fix for DHT handler attachment race condition

  - [x] 3.1 Add `onAttachDHTHandler` callback to RoutingTable
    - Add new callback property `onAttachDHTHandler` in `RoutingTable` class
    - Callback signature: `(manager, peerId) => void`
    - This allows `KademliaDHT` to provide handler attachment logic without tight coupling
    - _Bug_Condition: isBugCondition(input) where dedicatedManager ≠ handlerManager_
    - _Expected_Behavior: dedicatedManager.listenerCount('dhtMessage') > 0_
    - _Preservation: Outgoing connections continue to use ConnectionManagerFactory_
    - _Requirements: 2.1, 2.2_

  - [x] 3.2 Call `onAttachDHTHandler` in `handlePeerConnected()` BEFORE `setupConnection()`
    - In `RoutingTable.handlePeerConnected()`, call `this.onAttachDHTHandler(manager, peerId)` BEFORE calling `node.setupConnection(manager, connection)`
    - This ensures handlers are ready before any messages can arrive
    - Handle both new nodes AND existing nodes getting their connection updated
    - Guard against null callback (for backwards compatibility)
    - _Bug_Condition: Handler attachment happens after setupConnection, creating race window_
    - _Expected_Behavior: Handler attachment happens BEFORE setupConnection completes_
    - _Preservation: Existing callback flow via onNodeAdded still works_
    - _Requirements: 2.1, 2.2, 2.3_

  - [x] 3.3 Have KademliaDHT provide the `onAttachDHTHandler` callback during initialization
    - In `KademliaDHT.setupRoutingTable()` or initialization, set `routingTable.onAttachDHTHandler`
    - Callback should attach DHT message handler using same logic as `getOrCreatePeerNode()`
    - Include guard: check `manager._dhtMessageHandlerAttached` to prevent duplicate handlers
    - Include stale flag detection: if flag is true but `listenerCount('dhtMessage') === 0`, reset and reattach
    - _Bug_Condition: KademliaDHT never learns about incoming connections in replacement cache_
    - _Expected_Behavior: KademliaDHT attaches handlers to ALL incoming connection managers_
    - _Preservation: getOrCreatePeerNode() continues to work for outgoing connections_
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

  - [x] 3.4 Verify bug condition exploration test now passes
    - **Property 1: Expected Behavior** - DHT Handler Attachment for Incoming Connections
    - **IMPORTANT**: Re-run the SAME test from task 1 - do NOT write a new test
    - The test from task 1 encodes the expected behavior
    - When this test passes, it confirms the expected behavior is satisfied
    - Run bug condition exploration test from step 1
    - **EXPECTED OUTCOME**: Test PASSES (confirms bug is fixed)
    - _Requirements: 2.1, 2.2, 2.3_

  - [x] 3.5 Verify preservation tests still pass
    - **Property 2: Preservation** - Outgoing Connection and Existing Node Behavior
    - **IMPORTANT**: Re-run the SAME tests from task 2 - do NOT write new tests
    - Run preservation property tests from step 2
    - **EXPECTED OUTCOME**: Tests PASS (confirms no regressions)
    - Confirm all tests still pass after fix (no regressions)
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

- [x] 4. Checkpoint - Ensure all tests pass
  - Run full test suite: `npm test`
  - Ensure Property 1 (Bug Condition → Expected Behavior) passes
  - Ensure Property 2 (Preservation) passes
  - Ensure no regressions in existing DHT tests
  - **RESULT**: All 448 tests pass (1 skipped), no regressions
  - Ask the user if questions arise
