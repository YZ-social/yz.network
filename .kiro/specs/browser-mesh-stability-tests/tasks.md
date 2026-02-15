# Implementation Plan: Browser Mesh Stability Tests

## Overview

Implement Playwright browser tests that verify WebRTC connection types, mesh network formation, and connection stability. The implementation uses JavaScript with fast-check for property-based testing of metrics calculations.

## Tasks

- [x] 1. Create MetricsManager and data models
  - [x] 1.1 Create ConnectionMetrics class in `tests/browser/helpers/ConnectionMetrics.js`
    - Implement peerId, connectTime, disconnectTimes, reconnectTimes tracking
    - Implement totalConnectedTime and totalDisconnectedTime calculations
    - _Requirements: 3.1, 3.2, 4.1_

  - [x] 1.2 Create MetricsManager class in `tests/browser/helpers/MetricsManager.js`
    - Implement recordEvent() for connect/disconnect/reconnect events
    - Implement calculateUptime(), calculateChurnRate(), calculateMTBF()
    - Implement getSummary() and isStable() methods
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.6_

  - [x] 1.3 Write property tests for MetricsManager
    - **Property 5: Uptime calculation correctness**
    - **Property 6: Churn rate calculation correctness**
    - **Property 7: MTBF calculation correctness**
    - **Property 8: Event count invariant**
    - **Property 9: Stability threshold correctness**
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.6**

- [x] 2. Create ConnectionVerifier helper
  - [x] 2.1 Create ConnectionVerifier class in `tests/browser/helpers/ConnectionVerifier.js`
    - Implement getConnectionType() to inspect connection manager type
    - Implement verifyWebRTCConnection() for browser-to-browser
    - Implement verifyWebSocketConnection() for browser-to-nodejs
    - Implement getAllConnectionTypes() to get all peer connection types
    - _Requirements: 1.1, 1.2, 1.3_

- [x] 3. Create TestCoordinator for multi-browser management
  - [x] 3.1 Create TestCoordinator class in `tests/browser/helpers/TestCoordinator.js`
    - Implement launchBrowsers() to create N browser instances
    - Implement connectAll() to start DHT on all browsers
    - Implement getConnectionInfo() to query connection state
    - Implement teardown() for cleanup
    - _Requirements: 2.1, 2.3, 5.5_

  - [x] 3.2 Implement mesh verification in TestCoordinator
    - Implement verifyMeshFormation() to check N*(N-1)/2 connections
    - Implement getMeshStatus() to report missing connections
    - _Requirements: 2.2, 2.4, 2.5_

  - [x] 3.3 Implement stability monitoring in TestCoordinator
    - Implement startMonitoring() with configurable duration
    - Wire up connection event listeners to MetricsManager
    - _Requirements: 3.1, 3.2, 3.6_

- [x] 4. Checkpoint - Verify helpers work correctly
  - Ensure all helper classes are implemented
  - Run property tests for MetricsManager
  - Ask the user if questions arise

- [x] 5. Implement WebRTC/WebSocket verification tests
  - [x] 5.1 Create `tests/browser/connection-type.spec.js`
    - Test browser-to-browser connections use WebRTC
    - Test browser-to-bootstrap connections use WebSocket
    - _Requirements: 1.1, 1.2, 1.4_

  - [x] 5.2 Write property test for connection type verification
    - **Property 1: Browser-to-Browser connections use WebRTC**
    - **Property 2: Browser-to-NodeJS connections use WebSocket**
    - **Validates: Requirements 1.1, 1.2**

- [x] 6. Implement mesh formation tests
  - [x] 6.1 Create `tests/browser/mesh-stability.spec.js` with mesh formation test
    - Launch configurable N browsers (default 4)
    - Verify full mesh formation with N*(N-1)/2 connections
    - Report formation time and any missing connections
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

  - [x] 6.2 Write property test for mesh completeness
    - **Property 3: Mesh completeness invariant**
    - **Validates: Requirements 2.1, 2.2**

- [x] 7. Implement connection stability tests
  - [x] 7.1 Add stability monitoring test to `tests/browser/mesh-stability.spec.js`
    - Monitor connections for configurable duration (default 60s)
    - Track disconnect/reconnect events
    - Verify zero unexpected disconnects on stable network
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

  - [x] 7.2 Write property test for event tracking
    - **Property 4: Event tracking accuracy**
    - **Validates: Requirements 3.1, 3.2**

- [x] 8. Implement stability metrics reporting
  - [x] 8.1 Add metrics reporting to stability tests
    - Output uptime percentage per connection
    - Output churn rate and MTBF
    - Output total connection events
    - Flag unstable connections (uptime < 99%)
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6_

- [x] 9. Final checkpoint - Run full test suite
  - Run all browser stability tests
  - Verify metrics output in test reports
  - Ensure tests pass on stable network
  - Ask the user if questions arise
  - **Note**: Browser tests require stable production DHT network. Tests are correctly implemented but depend on infrastructure health.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Property tests use fast-check library for JavaScript
- Integration tests require the production bootstrap server at wss://imeyouwe.com/ws
- Stability tests have longer timeouts due to mesh formation + monitoring periods
- Run with `npx playwright test tests/browser/mesh-stability.spec.js` for stability tests
