# Requirements Document

## Introduction

The bridge connection pool is failing because of a configuration mismatch between Docker Compose environment variables and the actual server environment. The bootstrap server is configured to connect to bridge nodes using external nginx-proxied addresses (`wss://imeyouwe.com/bridge1|2`) from inside Docker containers, which creates unnecessary complexity and potential connection failures.

## Glossary

- **Bootstrap_Server**: The main coordination server that manages peer discovery and bridge connections
- **Bridge_Node**: Specialized DHT nodes that help coordinate peer connections and provide reconnection services
- **Connection_Pool**: The persistent WebSocket connection manager between bootstrap server and bridge nodes
- **Docker_Internal_Address**: Container-to-container communication addresses (e.g., `ws://bridge-node-1:8083`)
- **External_Nginx_Address**: Public-facing addresses proxied through nginx (e.g., `wss://imeyouwe.com/bridge1`)

## Requirements

### Requirement 1: Fix Bridge Connection Configuration

**User Story:** As a system administrator, I want the bridge connection pool to use the most efficient connection method, so that bridge nodes remain connected and available for peer coordination.

#### Acceptance Criteria

1. WHEN the bootstrap server connects to bridge nodes, THE Bootstrap_Server SHALL use Docker internal addresses for container-to-container communication
2. WHEN bridge nodes advertise their external addresses, THE Bridge_Node SHALL use nginx-proxied addresses for external client connections
3. WHEN the connection pool initializes, THE Connection_Pool SHALL successfully establish persistent connections to all configured bridge nodes
4. WHEN a bridge node restarts, THE Connection_Pool SHALL automatically reconnect using the internal Docker address
5. WHEN external clients connect to bridge nodes, THE Bridge_Node SHALL accept connections via nginx proxy addresses

### Requirement 2: Prevent Unnecessary Health Check Failures

**User Story:** As a system operator, I want bridge nodes to remain stable and not restart due to false health check failures, so that the DHT network maintains consistent bridge connectivity.

#### Acceptance Criteria

1. WHEN Docker health checks run, THE Bridge_Node SHALL respond successfully to health endpoint requests
2. WHEN health checks pass consistently, THE Docker_Container SHALL remain running without restarts
3. WHEN a bridge node is healthy but connection pool fails, THE System SHALL not restart the bridge node container
4. WHEN connection pool issues occur, THE Bootstrap_Server SHALL log specific connection errors for debugging
5. WHEN bridge nodes restart, THE System SHALL provide a mechanism for them to rejoin the DHT network

### Requirement 3: Optimize Connection Pool Architecture

**User Story:** As a developer, I want the bridge connection pool to use the most efficient connection method, so that bridge coordination is reliable and performant.

#### Acceptance Criteria

1. WHEN bootstrap server and bridge nodes are in the same Docker network, THE Connection_Pool SHALL use internal Docker addresses
2. WHEN external clients need to connect to bridge nodes, THE Bridge_Node SHALL advertise nginx-proxied external addresses
3. WHEN the connection pool encounters connection failures, THE Connection_Pool SHALL retry with exponential backoff
4. WHEN bridge availability is checked, THE System SHALL report accurate connection status
5. WHEN bridge nodes are restarted, THE Connection_Pool SHALL detect disconnection and attempt reconnection

### Requirement 4: Environment Variable Consistency

**User Story:** As a deployment engineer, I want environment variables to be consistent between Docker Compose configuration and runtime environment, so that the system behaves predictably.

#### Acceptance Criteria

1. WHEN Docker Compose is deployed, THE Bootstrap_Server SHALL use bridge node addresses specified in the compose file
2. WHEN environment variables are overridden, THE System SHALL log the configuration being used
3. WHEN internal and external addresses differ, THE System SHALL use appropriate addresses for each connection type
4. WHEN configuration changes are made, THE System SHALL validate address reachability before starting services
5. WHEN debugging connection issues, THE System SHALL provide clear logging of which addresses are being used for connections