# Design Document

## Overview

Fix the nginx WebSocket proxy configuration to properly handle connections from the bootstrap server to bridge nodes. The current issues are:

1. **DNS Resolution Failures**: nginx cannot resolve `yz-bridge-node-1` and `yz-bridge-node-2` hostnames
2. **Connection Refused**: When DNS does resolve, connections to bridge nodes are refused
3. **WebSocket Upgrade Issues**: Improper WebSocket proxy configuration

## Architecture

The fix involves three main components:

1. **Docker Network Configuration**: Ensure nginx can reach bridge node containers
2. **Nginx Proxy Configuration**: Fix WebSocket proxy settings and upstream definitions
3. **Bridge Node Accessibility**: Ensure bridge nodes accept connections on the correct interfaces

## Root Cause Analysis

From the nginx error logs:
- `yz-bridge-node-1 could not be resolved (2: Server failure)` - DNS resolution failing
- `connect() failed (111: Connection refused)` - Bridge nodes refusing connections
- `upstream: "http://172.20.0.5:8083/bridge1"` - nginx is appending the location path to upstream

## Components and Interfaces

### 1. Nginx Configuration Updates

**Current Issue**: Dynamic upstream resolution with path appending
```nginx
location /bridge1 {
    set $bridge1_upstream yz-bridge-node-1:8083;
    proxy_pass http://$bridge1_upstream;
}
```

**Problem**: nginx appends `/bridge1` to the upstream URL, creating `http://yz-bridge-node-1:8083/bridge1`

**Solution**: Use static upstream blocks and proper proxy_pass configuration
```nginx
upstream bridge-node-1 {
    server yz-bridge-node-1:8083;
}

location /bridge1 {
    proxy_pass http://bridge-node-1/;
}
```

### 2. Docker Network Connectivity

**Current Issue**: nginx container cannot resolve bridge node hostnames

**Solution**: Ensure all containers are on the same Docker network with proper service discovery

### 3. Bridge Node Interface Binding

**Current Issue**: Bridge nodes may be binding to localhost only

**Solution**: Verify bridge nodes bind to `0.0.0.0:8083/8084` to accept connections from nginx

## Data Models

### Nginx Upstream Configuration
```nginx
upstream bridge-node-1 {
    server yz-bridge-node-1:8083 max_fails=3 fail_timeout=30s;
}

upstream bridge-node-2 {
    server yz-bridge-node-2:8084 max_fails=3 fail_timeout=30s;
}
```

### WebSocket Proxy Location Blocks
```nginx
location /bridge1 {
    proxy_pass http://bridge-node-1/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 86400;
    proxy_connect_timeout 10s;
    proxy_send_timeout 10s;
}
```

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system-essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: DNS Resolution Success
*For any* nginx container restart, DNS resolution of bridge node hostnames should succeed consistently within the Docker network
**Validates: Requirements 5.1, 5.2, 5.3**

### Property 2: WebSocket Upgrade Success  
*For any* valid WebSocket connection request to `/bridge1` or `/bridge2`, nginx should return 101 Switching Protocols instead of 502 Bad Gateway
**Validates: Requirements 1.1, 1.2, 1.5**

### Property 3: Upstream Connection Success
*For any* healthy bridge node, nginx should successfully establish TCP connections to the bridge node container
**Validates: Requirements 2.1, 2.2, 2.4**

### Property 4: Proxy Path Handling
*For any* WebSocket request to `/bridge1`, nginx should proxy to the bridge node root path without appending `/bridge1`
**Validates: Requirements 6.1, 6.4**

### Property 5: Connection Pool Compatibility
*For any* Node.js WebSocket client connection through nginx, the connection should establish and authenticate successfully
**Validates: Requirements 6.1, 6.2, 6.3**

## Error Handling

### DNS Resolution Failures
- Use static upstream blocks instead of dynamic resolution
- Add health checks to upstream servers
- Configure appropriate fail_timeout and max_fails

### Connection Refused Errors
- Verify bridge nodes bind to 0.0.0.0 interface
- Add connection timeout configuration
- Implement upstream health monitoring

### WebSocket Upgrade Failures
- Ensure proper WebSocket headers are set
- Use HTTP/1.1 for proxy connections
- Configure appropriate timeouts for WebSocket connections

## Testing Strategy

### Manual Testing
1. Test nginx DNS resolution: `docker exec yz-webserver nslookup yz-bridge-node-1`
2. Test TCP connectivity: `docker exec yz-webserver nc -zv yz-bridge-node-1 8083`
3. Test WebSocket upgrade: Use WebSocket client to connect through nginx
4. Test connection pool: Verify bootstrap server can establish persistent connections

### Integration Testing
1. Restart nginx and verify bridge connections work immediately
2. Restart bridge nodes and verify nginx handles reconnection
3. Test multiple concurrent WebSocket connections through nginx
4. Verify connection pool maintains persistent connections through nginx

### Property Testing
Each correctness property should be validated through automated tests that verify the universal behavior across different connection scenarios.