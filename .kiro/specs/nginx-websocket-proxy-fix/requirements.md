# Requirements Document

## Introduction

Fix the nginx WebSocket proxy path routing issue where requests to `/bridge1` and `/bridge2` are being proxied with the wrong path to bridge node containers. The nginx configuration is proxying to `http://yz-bridge-node-1:8083/bridge1` but bridge nodes are listening on the root path `/`, causing WebSocket connection failures.

## Glossary

- **Bootstrap_Server**: The enhanced bootstrap server that needs to connect to bridge nodes
- **Bridge_Node**: Bridge nodes that should accept WebSocket connections through nginx proxy
- **Nginx_Proxy**: The nginx reverse proxy that routes external connections to internal bridge nodes
- **WebSocket_Upgrade**: The HTTP upgrade process that establishes WebSocket connections
- **Connection_Pool**: The persistent connection manager that needs to connect through nginx

## Requirements

### Requirement 1: Correct Proxy Path Routing

**User Story:** As nginx, I want to proxy WebSocket requests to the correct path on bridge nodes, so that WebSocket connections succeed instead of returning 502 errors.

#### Acceptance Criteria

1. WHEN a request comes to `/bridge1`, THE Nginx_Proxy SHALL proxy to `http://yz-bridge-node-1:8083/` (root path)
2. WHEN a request comes to `/bridge2`, THE Nginx_Proxy SHALL proxy to `http://yz-bridge-node-2:8084/` (root path)  
3. WHEN using `proxy_pass` with trailing slash, THE Nginx_Proxy SHALL strip the location path from the upstream request
4. THE bridge node WebSocket servers SHALL receive requests on their root path `/` instead of `/bridge1` or `/bridge2`
5. WHEN WebSocket handshake occurs, THE bridge nodes SHALL respond successfully from their root WebSocket server

### Requirement 2: Bridge Node Accessibility

**User Story:** As nginx, I want to successfully connect to bridge node containers, so that WebSocket proxy requests don't fail with 502 errors.

#### Acceptance Criteria

1. WHEN nginx tries to connect to `yz-bridge-node-1:8083`, THE connection SHALL succeed within the Docker network
2. WHEN nginx tries to connect to `yz-bridge-node-2:8084`, THE connection SHALL succeed within the Docker network
3. WHEN bridge nodes are starting up, THE Nginx_Proxy SHALL handle temporary connection failures gracefully
4. THE Docker network configuration SHALL allow nginx container to reach bridge node containers
5. WHEN bridge nodes are healthy, THE Nginx_Proxy SHALL successfully proxy WebSocket connections

### Requirement 3: WebSocket Connection Persistence

**User Story:** As a connection pool, I want WebSocket connections through nginx to remain stable, so that persistent connections don't drop unexpectedly.

#### Acceptance Criteria

1. WHEN WebSocket connections are established through nginx, THE connections SHALL remain stable for extended periods
2. WHEN no data is transmitted, THE Nginx_Proxy SHALL not timeout WebSocket connections prematurely
3. WHEN WebSocket ping/pong frames are sent, THE Nginx_Proxy SHALL pass them through transparently
4. THE proxy timeout configuration SHALL be appropriate for persistent WebSocket connections (86400 seconds)
5. WHEN connections are idle, THE Nginx_Proxy SHALL maintain them without dropping

### Requirement 4: SSL/TLS WebSocket Support

**User Story:** As a bootstrap server, I want to connect to bridge nodes using secure WebSocket connections (wss://), so that connections are encrypted and secure.

#### Acceptance Criteria

1. WHEN connecting to `wss://imeyouwe.com/bridge1`, THE Nginx_Proxy SHALL terminate SSL and proxy to internal HTTP WebSocket
2. WHEN SSL handshake occurs, THE Nginx_Proxy SHALL use valid SSL certificates for imeyouwe.com
3. WHEN WebSocket upgrade happens over HTTPS, THE Nginx_Proxy SHALL properly handle the protocol transition
4. THE SSL configuration SHALL support WebSocket connections without certificate validation errors
5. WHEN internal connections are made, THE Nginx_Proxy SHALL use `ws://` (not `wss://`) to connect to bridge nodes

### Requirement 5: Docker Network Resolution

**User Story:** As nginx, I want to reliably resolve bridge node hostnames, so that proxy connections don't fail due to DNS issues.

#### Acceptance Criteria

1. WHEN nginx starts, THE Docker DNS resolver SHALL be properly configured to resolve container hostnames
2. WHEN resolving `yz-bridge-node-1` and `yz-bridge-node-2`, THE DNS resolution SHALL succeed consistently
3. WHEN bridge nodes restart, THE DNS resolution SHALL update to reflect new container IPs
4. THE nginx configuration SHALL use Docker's internal DNS resolver (127.0.0.11)
5. WHEN DNS resolution fails, THE Nginx_Proxy SHALL log clear error messages

### Requirement 6: Connection Pool Compatibility

**User Story:** As a connection pool, I want nginx WebSocket proxy to work with Node.js WebSocket clients, so that the bootstrap server can establish connections successfully.

#### Acceptance Criteria

1. WHEN Node.js WebSocket client connects through nginx, THE connection SHALL establish successfully
2. WHEN WebSocket authentication occurs, THE Nginx_Proxy SHALL pass authentication messages transparently
3. WHEN JSON messages are sent over WebSocket, THE Nginx_Proxy SHALL not modify or corrupt the message content
4. THE proxy configuration SHALL be compatible with the `ws` Node.js WebSocket library
5. WHEN connection pool retries connections, THE Nginx_Proxy SHALL handle multiple connection attempts properly

### Requirement 7: Error Handling and Logging

**User Story:** As a system administrator, I want clear error messages when WebSocket proxy connections fail, so that I can diagnose and fix connection issues.

#### Acceptance Criteria

1. WHEN WebSocket proxy connections fail, THE Nginx_Proxy SHALL log detailed error messages
2. WHEN 502 errors occur, THE logs SHALL indicate whether the issue is DNS resolution, connection timeout, or backend unavailability
3. WHEN bridge nodes are unreachable, THE Nginx_Proxy SHALL distinguish between temporary and permanent failures
4. THE error logs SHALL include the specific backend server that failed (yz-bridge-node-1 vs yz-bridge-node-2)
5. WHEN debugging is needed, THE log level SHALL be configurable to provide more detailed connection information