# Implementation Plan: Bridge Connection Management

## Overview

This implementation plan transforms the bootstrap-to-bridge communication from a connection-per-request model to a persistent connection pool with request multiplexing. This will eliminate the connection storm that's overwhelming bridge nodes and preventing DHT peer discovery.

## Tasks

- [x] 1. Create connection pool infrastructure
  - Create BridgeConnectionPool class with connection lifecycle management
  - Implement WebSocket connection creation and authentication
  - Add connection state tracking (CONNECTING, READY, IDLE, FAILED)
  - _Requirements: 1.1, 1.3_

- [ ]* 1.1 Write property test for connection pool consistency
  - **Property 1: Connection Pool Consistency**
  - **Validates: Requirements 1.1**

- [x] 2. Implement request multiplexing system
  - Add unique request ID generation and correlation
  - Create request queue with timeout handling
  - Implement response matching using request IDs
  - Add concurrent request management
  - _Requirements: 2.1, 2.2, 2.3, 2.4_

- [ ]* 2.1 Write property test for request-response correlation
  - **Property 2: Request-Response Correlation**
  - **Validates: Requirements 2.3**

- [ ] 3. Add intelligent connection lifecycle management
  - Implement idle timeout with automatic cleanup (5 minutes)
  - Add instant reconnection on demand
  - Create connection health monitoring with ping/pong
  - Add exponential backoff for failed connections
  - _Requirements: 1.2, 1.4, 4.1, 4.2, 4.3_

- [ ]* 3.1 Write property test for connection recovery
  - **Property 3: Connection Recovery**
  - **Validates: Requirements 1.2**

- [x] 4. Update bootstrap server to use connection pool
  - Replace queryBridgeForOnboardingPeer with pooled requests
  - Modify requestOnboardingPeerFromBridge to use persistent connections
  - Update bridge health checking to use connection pool status
  - Remove stateless WebSocket creation code
  - _Requirements: 1.1, 2.1, 4.1_

- [ ]* 4.1 Write property test for request timeout handling
  - **Property 4: Request Timeout Handling**
  - **Validates: Requirements 2.4**

- [x] 5. Checkpoint - Test basic connection pooling
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 6. Implement bridge node message queue
  - Add asynchronous request processing on bridge nodes
  - Create request queue with capacity limits
  - Implement backpressure handling (busy responses)
  - Add request timeout cleanup
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 6.1, 6.2, 6.3_

- [ ]* 6.1 Write property test for resource cleanup
  - **Property 6: Resource Cleanup**
  - **Validates: Requirements 6.4**

- [ ] 7. Add load balancing and resilience
  - Implement round-robin bridge selection
  - Add circuit breaker for failed bridges
  - Create graceful degradation when bridges are unavailable
  - Add automatic bridge recovery detection
  - _Requirements: 5.1, 5.2, 5.3, 5.4_

- [ ]* 7.1 Write property test for load distribution
  - **Property 5: Load Distribution**
  - **Validates: Requirements 5.3**

- [ ] 8. Add monitoring and metrics
  - Create connection pool status endpoint
  - Add request processing time metrics
  - Implement connection health reporting
  - Add resource usage monitoring
  - _Requirements: 4.1, 4.5, 8.5_

- [ ]* 8.1 Write property test for idle connection management
  - **Property 7: Idle Connection Management**
  - **Validates: Requirements 1.1, 6.1**

- [ ] 9. Update bridge node request handling
  - Modify PassiveBridgeNode to handle persistent connections
  - Update message handling to support request queuing
  - Add proper request ID correlation in responses
  - Implement connection cleanup on bridge side
  - _Requirements: 3.1, 3.2, 3.3, 6.4_

- [ ]* 9.1 Write integration tests for end-to-end flow
  - Test complete onboarding flow with connection pooling
  - Test bridge failure and recovery scenarios
  - _Requirements: 1.2, 5.1, 5.4_

- [ ] 10. Performance optimization and testing
  - Add connection pool size configuration
  - Implement request batching for high load
  - Add performance monitoring and alerting
  - Test with 100+ concurrent onboarding requests
  - _Requirements: 8.1, 8.2, 8.3, 8.4_

- [ ]* 10.1 Write performance tests
  - Test latency improvement vs stateless connections
  - Test memory usage reduction
  - Test concurrent request handling capacity
  - _Requirements: 8.1, 8.2, 8.3, 8.4_

- [ ] 11. Backward compatibility and migration
  - Add feature flag for connection pool vs stateless mode
  - Ensure existing DHT nodes continue to work
  - Create migration guide for deployment
  - Add rollback capability
  - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

- [ ]* 11.1 Write backward compatibility tests
  - Test mixed environments with old and new bridge nodes
  - Test legacy client support
  - _Requirements: 7.2, 7.3_

- [ ] 12. Final checkpoint - Complete system validation
  - Ensure all tests pass, ask the user if questions arise.
  - Verify connection count reduction (558+ → 2)
  - Confirm bridge nodes can discover DHT peers
  - Validate onboarding performance improvement

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties
- Integration tests validate end-to-end functionality
- The implementation directly addresses the connection storm issue causing bridge nodes to show 0 DHT peers