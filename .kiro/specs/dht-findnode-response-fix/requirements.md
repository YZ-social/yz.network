# Requirements Document

## Introduction

Browser clients are unable to create PubSub channels because find_node requests to server DHT nodes are timing out, even though ping/pong communication works correctly. This indicates a one-way message handling issue where server nodes receive find_node requests but fail to send responses back to browser clients.

## Glossary

- **DHT_Node**: A Kademlia distributed hash table node that stores data and routes messages
- **Browser_Client**: A browser-based client that connects via WebSocket to DHT nodes
- **Server_Node**: A Node.js DHT node that accepts WebSocket connections from browsers
- **find_node_Request**: A DHT protocol message requesting the K closest nodes to a target ID
- **find_node_Response**: A DHT protocol message containing the K closest nodes found
- **Connection_Manager**: Abstraction layer handling WebSocket connections with per-peer dedicated managers
- **DHT_Message_Handler**: Event listener that processes incoming DHT protocol messages
- **Dedicated_Manager**: A connection manager instance created for each incoming peer connection

## Requirements

### Requirement 1: find_node Response Delivery

**User Story:** As a browser client, I want my find_node requests to receive responses from server nodes, so that I can perform DHT lookups and create PubSub channels.

#### Acceptance Criteria

1. WHEN a browser sends a find_node request to a connected server node, THE Server_Node SHALL send a find_node_response within 3 seconds
2. WHEN a server node receives a find_node request, THE Server_Node SHALL log receipt of the request with the requestId
3. WHEN a server node sends a find_node_response, THE Server_Node SHALL log the response with matching requestId
4. WHEN find_node requests timeout, THE Browser_Client SHALL log detailed diagnostic information including connection state
5. WHEN ping/pong works but find_node fails, THE System SHALL identify the specific failure point in message handling

### Requirement 2: DHT Message Handler Attachment

**User Story:** As a server node, I want DHT message handlers to be properly attached to dedicated connection managers, so that incoming find_node requests are processed correctly.

#### Acceptance Criteria

1. WHEN a browser connects to a server node, THE Server_Node SHALL create a dedicated connection manager for that peer
2. WHEN a dedicated connection manager is created, THE Server_Node SHALL attach DHT message handlers before any messages are processed
3. WHEN DHT message handlers are attached, THE System SHALL log the attachment with manager type and peer ID
4. WHEN a dhtMessage event is emitted, THE System SHALL log the number of listeners attached
5. IF no DHT message handlers are attached, THEN THE System SHALL log a warning and attempt to attach handlers

### Requirement 3: Message Routing Verification

**User Story:** As a system administrator, I want to verify that messages are being routed correctly between browser and server, so that I can diagnose communication issues.

#### Acceptance Criteria

1. WHEN a find_node request is sent, THE System SHALL log the message path from browser to server
2. WHEN a find_node_response is sent, THE System SHALL log the message path from server to browser
3. WHEN messages are processed, THE System SHALL log the connection manager type handling the message
4. WHEN responses fail to reach the browser, THE System SHALL identify where the response was lost
5. WHEN debugging is enabled, THE System SHALL provide end-to-end message tracing

### Requirement 4: Connection Manager Consistency

**User Story:** As a developer, I want connection managers to be consistent between incoming and outgoing message handling, so that bidirectional communication works reliably.

#### Acceptance Criteria

1. WHEN a dedicated manager is created for incoming connections, THE System SHALL use the same manager for outgoing responses
2. WHEN sending a response, THE System SHALL verify the connection manager is the one that received the request
3. WHEN multiple managers exist for a peer, THE System SHALL use the correct manager based on connection direction
4. WHEN manager mismatch is detected, THE System SHALL log a warning and attempt to use the correct manager
5. WHEN connection state changes, THE System SHALL update all relevant manager references

### Requirement 5: Diagnostic Logging Enhancement

**User Story:** As a system administrator, I want comprehensive logging for DHT message handling, so that I can quickly identify and resolve communication issues.

#### Acceptance Criteria

1. WHEN find_node requests are received, THE System SHALL log: requestId, source peer, target ID, timestamp
2. WHEN find_node responses are sent, THE System SHALL log: requestId, destination peer, node count, timestamp
3. WHEN message handlers process messages, THE System SHALL log: message type, handler type, processing time
4. WHEN timeouts occur, THE System SHALL log: request type, peer ID, timeout duration, connection state
5. WHEN errors occur in message handling, THE System SHALL log: error type, stack trace, message context
