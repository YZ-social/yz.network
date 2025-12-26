# Design Document: Bridge Connection Configuration Fix

## Overview

The current bridge connection pool failure is caused by a configuration mismatch where the bootstrap server attempts to connect to bridge nodes using external nginx-proxied addresses (`wss://imeyouwe.com/bridge1|2`) from inside Docker containers. This creates unnecessary network complexity and connection failures.

The solution is to use Docker internal addresses for container-to-container communication while maintaining external addresses for client connections.

## Architecture

### Current Problem Architecture
```
Bootstrap Server (Docker) 
    ↓ (attempts wss://imeyouwe.com/bridge1)
    ↓ (goes through nginx proxy)
Nginx Proxy 
    ↓ (proxies to bridge-node-1:8083)
Bridge Node 1 (Docker)
```

### Proposed Solution Architecture
```
Bootstrap Server (Docker) 
    ↓ (direct ws://bridge-node-1:8083)
Bridge Node 1 (Docker)

External Clients
    ↓ (wss://imeyouwe.com/bridge1)
Nginx Proxy 
    ↓ (proxies to bridge-node-1:8083)
Bridge Node 1 (Docker)
```

## Components and Interfaces

### 1. Bootstrap Server Configuration
- **Internal Bridge Addresses**: Use Docker service names for connection pool
- **Configuration Source**: Docker Compose environment variables
- **Connection Method**: Direct WebSocket connections within Docker network

### 2. Bridge Node Configuration  
- **Internal Listening**: Accept connections on all interfaces (0.0.0.0)
- **External Advertisement**: Advertise nginx-proxied addresses to external clients
- **Dual Address Support**: Handle both internal and external connection types

### 3. Connection Pool Updates
- **Address Resolution**: Use internal Docker addresses for bootstrap-to-bridge connections
- **Fallback Logic**: Maintain external address fallback for debugging
- **Connection Validation**: Verify internal connectivity before external attempts

## Data Models

### Bridge Configuration
```javascript
{
  internalAddress: 'ws://bridge-node-1:8083',    // For bootstrap server connections
  externalAddress: 'wss://imeyouwe.com/bridge1', // For client connections  
  healthEndpoint: 'http://bridge-node-1:9090/health',
  nodeId: 'bridge-node-1',
  authToken: 'shared-bridge-auth-key'
}
```

### Connection Pool Configuration
```javascript
{
  bridgeNodes: [
    'bridge-node-1:8083',  // Internal Docker addresses
    'bridge-node-2:8084'
  ],
  useInternalAddresses: true,
  fallbackToExternal: false,
  connectionTimeout: 10000,
  healthCheckInterval: 30000
}
```

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system-essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Internal Connection Success
*For any* bootstrap server and bridge node in the same Docker network, connecting using internal Docker addresses should succeed within the connection timeout period.
**Validates: Requirements 1.1, 1.3**

### Property 2: External Client Access
*For any* external client connecting to bridge nodes, the connection should succeed using nginx-proxied external addresses.
**Validates: Requirements 1.5**

### Property 3: Health Check Reliability  
*For any* bridge node with a functioning health endpoint, Docker health checks should consistently pass without false failures.
**Validates: Requirements 2.1, 2.2**

### Property 4: Connection Pool Recovery
*For any* bridge node that restarts, the connection pool should detect disconnection and successfully reconnect using internal addresses.
**Validates: Requirements 1.4, 3.5**

### Property 5: Configuration Consistency
*For any* deployment environment, the addresses used for connections should match the configuration specified in Docker Compose files.
**Validates: Requirements 4.1, 4.3**

## Error Handling

### Connection Failures
- **Internal Address Failure**: Log specific error and connection details
- **Timeout Handling**: Use appropriate timeouts for internal vs external connections
- **Retry Logic**: Implement exponential backoff for reconnection attempts

### Configuration Validation
- **Address Reachability**: Validate internal addresses are reachable before starting
- **Environment Mismatch**: Warn when runtime environment differs from compose configuration
- **Health Check Failures**: Distinguish between actual failures and configuration issues

## Testing Strategy

### Unit Tests
- Test internal address resolution and connection logic
- Test configuration parsing and validation
- Test error handling for various failure scenarios
- Test health check endpoint responses

### Property-Based Tests
- Test connection success across various network configurations (Property 1)
- Test external client access patterns (Property 2)  
- Test health check reliability under load (Property 3)
- Test connection pool recovery scenarios (Property 4)
- Test configuration consistency validation (Property 5)

### Integration Tests
- Test full bootstrap-to-bridge connection flow using internal addresses
- Test external client connections through nginx proxy
- Test bridge node restart and reconnection scenarios
- Test Docker Compose deployment with correct environment variables

## Implementation Plan

### Phase 1: Configuration Fix
1. Update Docker Compose to use internal addresses for bootstrap server
2. Ensure bridge nodes listen on all interfaces for internal connections
3. Maintain external address advertisement for client connections

### Phase 2: Connection Pool Updates
1. Modify connection pool to prefer internal addresses
2. Add configuration validation and logging
3. Implement proper error handling and retry logic

### Phase 3: Testing and Validation
1. Test internal connectivity between containers
2. Verify external client access still works
3. Validate health checks pass consistently
4. Test bridge node restart scenarios