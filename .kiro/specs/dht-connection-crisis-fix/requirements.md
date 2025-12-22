# DHT Connection Crisis Fix - Requirements

## Introduction

The DHT network is in a critical state with only 1 out of 15 nodes healthy and complete bootstrap connection failures. This spec addresses the immediate crisis by systematically diagnosing and fixing the dual connection architecture without breaking existing paths.

## Glossary

- **DHT_Node**: A Node.js server that can accept WebSocket connections and initiate connections
- **Browser_Client**: A browser-based client that connects via WebSocket to DHT nodes and WebRTC to other browsers
- **Bootstrap_Server**: Central coordination server for initial peer discovery and onboarding
- **Connection_Manager**: Abstraction layer handling WebSocket and WebRTC connections
- **WebSocket_Path**: Browser → Node.js DHT connection via WebSocket client
- **WebRTC_Path**: Browser ↔ Browser connection via WebRTC DataChannels

## Requirements

### Requirement 1: Emergency Connection Diagnosis

**User Story:** As a system administrator, I want to immediately diagnose all connection paths, so that I can identify what broke the network.

#### Acceptance Criteria

1. WHEN running connection diagnosis, THE System SHALL test bootstrap server connectivity from external clients
2. WHEN testing WebSocket paths, THE System SHALL verify browser → Node.js DHT connections work
3. WHEN testing WebRTC paths, THE System SHALL verify browser ↔ browser connections work  
4. WHEN checking data transfer metrics, THE System SHALL identify if recent changes broke message flow
5. THE System SHALL report which specific connection managers are failing

### Requirement 2: Bootstrap Server Connection Recovery

**User Story:** As a DHT node, I want to connect to the bootstrap server reliably, so that I can participate in network coordination.

#### Acceptance Criteria

1. WHEN connecting to bootstrap server, THE DHT_Node SHALL establish WebSocket connection successfully
2. WHEN bootstrap connection fails, THE DHT_Node SHALL provide detailed error information
3. WHEN "Unexpected server response: 200" occurs, THE System SHALL identify the root cause
4. THE Bootstrap_Server SHALL accept connections from both internal Docker nodes and external clients
5. WHEN bootstrap coordination occurs, THE System SHALL successfully facilitate peer introductions

### Requirement 3: WebSocket Connection Path Integrity

**User Story:** As a browser client, I want to connect to Node.js DHT nodes via WebSocket, so that I can participate in the DHT network.

#### Acceptance Criteria

1. WHEN browser connects to DHT node, THE WebSocket_Connection_Manager SHALL establish connection successfully
2. WHEN sending DHT messages via WebSocket, THE System SHALL preserve message integrity and routing
3. WHEN data transfer metrics are recorded, THE WebSocket_Path SHALL continue functioning normally
4. THE DHT_Node SHALL accept WebSocket connections on configured ports with proper CORS headers
5. WHEN WebSocket connection fails, THE System SHALL provide specific error details for debugging

### Requirement 4: WebRTC Connection Path Integrity  

**User Story:** As a browser client, I want to connect to other browsers via WebRTC, so that I can form direct peer connections.

#### Acceptance Criteria

1. WHEN browsers establish WebRTC connections, THE WebRTC_Connection_Manager SHALL handle signaling correctly
2. WHEN WebRTC DataChannels are created, THE System SHALL maintain message routing capabilities
3. WHEN data transfer metrics are recorded, THE WebRTC_Path SHALL continue functioning normally
4. THE System SHALL coordinate WebRTC signaling through bootstrap server or DHT routing
5. WHEN WebRTC connection fails, THE System SHALL fall back to WebSocket routing if available

### Requirement 5: Data Transfer Metrics Safety

**User Story:** As a system administrator, I want data transfer metrics without breaking existing connections, so that I can monitor network performance safely.

#### Acceptance Criteria

1. WHEN recording data transfer metrics, THE System SHALL not interfere with message processing
2. WHEN calculating message sizes, THE System SHALL handle JSON serialization errors gracefully
3. WHEN metrics tracking fails, THE System SHALL continue normal DHT operations
4. THE Metrics_Tracker SHALL be optional and fail-safe for all connection managers
5. WHEN metrics are disabled, THE System SHALL operate identically to pre-metrics behavior

### Requirement 6: Connection Manager Hierarchy Preservation

**User Story:** As a developer, I want the connection manager hierarchy to remain intact, so that both WebSocket and WebRTC paths continue working.

#### Acceptance Criteria

1. WHEN modifying connection code, THE System SHALL preserve WebSocketConnectionManager functionality
2. WHEN modifying connection code, THE System SHALL preserve WebRTCConnectionManager functionality  
3. WHEN adding new features, THE Connection_Manager_Factory SHALL route to correct managers
4. THE System SHALL maintain backward compatibility with existing connection establishment flows
5. WHEN connection managers fail, THE System SHALL provide manager-specific error information

### Requirement 7: Network Recovery and Stabilization

**User Story:** As a DHT network, I want to recover from the current crisis and achieve stable operation, so that pubsub and DHT operations work reliably.

#### Acceptance Criteria

1. WHEN network recovery is initiated, THE System SHALL restore at least 80% node health within 5 minutes
2. WHEN nodes reconnect, THE System SHALL establish multiple peer connections per node (target: 3-8 connections)
3. WHEN DHT operations resume, THE System SHALL achieve <2 second average latency for find_node operations
4. THE System SHALL maintain data transfer rates appropriate for message sizes (target: >1KB/sec total)
5. WHEN network is stable, THE System SHALL support successful pubsub channel creation in <5 seconds

### Requirement 8: Rollback and Recovery Strategy

**User Story:** As a system administrator, I want a clear rollback strategy, so that I can quickly restore service if fixes fail.

#### Acceptance Criteria

1. WHEN fixes fail, THE System SHALL provide commands to disable data transfer metrics completely
2. WHEN rolling back, THE System SHALL restore previous DHT maintenance intervals if needed
3. WHEN emergency recovery is needed, THE System SHALL provide minimal working configuration
4. THE System SHALL maintain git commits for each fix attempt for easy rollback
5. WHEN rollback is complete, THE System SHALL verify network health returns to previous levels