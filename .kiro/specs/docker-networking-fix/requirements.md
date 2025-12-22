# Requirements Document

## Introduction

Fix hardcoded IP addresses in Docker configuration that prevent proper container networking and make the system fragile and non-portable.

## Glossary

- **Docker_Network**: The internal Docker bridge network used by containers
- **Service_Discovery**: Docker's built-in DNS resolution for container names
- **Nginx_Container**: The webserver container that handles SSL termination and routing
- **Bootstrap_Server**: The main bootstrap server container
- **Bridge_Nodes**: The bridge node containers that need to connect to external addresses

## Requirements

### Requirement 1: Remove Hardcoded IP Addresses

**User Story:** As a system administrator, I want to deploy the system without hardcoded IP addresses, so that it works reliably across different environments and Docker network configurations.

#### Acceptance Criteria

1. THE Docker_Network SHALL NOT contain any hardcoded IP addresses in container configurations
2. WHEN containers need to resolve external domains internally, THE system SHALL use Docker's built-in service discovery
3. WHEN the Docker network is recreated, THE system SHALL continue to function without manual IP updates
4. THE system SHALL be portable across different Docker environments without configuration changes

### Requirement 2: Fix Internal Domain Resolution

**User Story:** As a container, I want to resolve `imeyouwe.com` to the correct nginx container, so that internal connections work properly without hardcoded IPs.

#### Acceptance Criteria

1. WHEN a container needs to connect to `imeyouwe.com`, THE Docker_Network SHALL resolve it to the Nginx_Container
2. THE resolution SHALL work automatically without manual IP configuration
3. WHEN the nginx container restarts, THE resolution SHALL continue to work
4. THE system SHALL use Docker's built-in DNS resolution instead of hardcoded host entries

### Requirement 3: Maintain External Connectivity

**User Story:** As a bridge connection pool, I want to connect to external nginx-proxied addresses, so that I can communicate with bridge nodes through the proper SSL-terminated endpoints.

#### Acceptance Criteria

1. THE Bootstrap_Server SHALL connect to bridge nodes using external addresses (`wss://imeyouwe.com/bridge1`, `wss://imeyouwe.com/bridge2`)
2. WHEN connecting from inside Docker, THE external addresses SHALL resolve to the Nginx_Container
3. THE SSL termination and routing SHALL work correctly for internal connections
4. THE system SHALL maintain the same addressing scheme for both internal and external clients

### Requirement 4: Preserve Connection Pool Functionality

**User Story:** As a connection pool, I want to establish persistent connections to bridge nodes, so that I can multiplex requests efficiently without connection storms.

#### Acceptance Criteria

1. THE connection pool SHALL successfully connect to bridge nodes via nginx proxy
2. WHEN authentication is required, THE connection pool SHALL authenticate successfully
3. THE persistent connections SHALL remain stable and healthy
4. THE request multiplexing SHALL work correctly over the persistent connections

### Requirement 5: Docker Network Configuration

**User Story:** As a Docker network, I want to provide reliable service discovery, so that containers can find each other without hardcoded addresses.

#### Acceptance Criteria

1. THE Docker_Network SHALL use a custom network with predictable naming
2. THE containers SHALL be able to resolve each other by service name
3. THE nginx container SHALL be accessible via a consistent service name
4. THE network configuration SHALL be declarative and reproducible

### Requirement 6: Nginx Proxy Configuration

**User Story:** As an nginx proxy, I want to handle both external and internal connections, so that the same endpoints work for browsers and Docker containers.

#### Acceptance Criteria

1. THE Nginx_Container SHALL accept connections from both external clients and internal Docker containers
2. THE SSL certificates SHALL work for connections from inside Docker
3. THE routing rules SHALL work correctly for internal connections
4. THE proxy SHALL handle WebSocket upgrades for internal connections

### Requirement 7: Connection Pool Docker Networking

**User Story:** As a connection pool running inside Docker, I want to connect to external addresses that resolve internally, so that I can use the same addressing scheme as external clients.

#### Acceptance Criteria

1. WHEN the connection pool connects to `wss://imeyouwe.com/bridge1`, THE connection SHALL reach the correct bridge node
2. THE WebSocket connection SHALL establish successfully through the nginx proxy
3. THE SSL handshake SHALL complete successfully for internal connections
4. THE connection SHALL remain stable and support request multiplexing

### Requirement 8: System Reliability

**User Story:** As a system operator, I want the networking to be robust and self-healing, so that temporary network issues don't break the entire system.

#### Acceptance Criteria

1. WHEN Docker containers restart, THE networking SHALL recover automatically
2. WHEN the nginx container restarts, THE other containers SHALL reconnect successfully
3. THE system SHALL not depend on specific IP addresses that can change
4. THE connection pool SHALL implement proper retry logic for network failures