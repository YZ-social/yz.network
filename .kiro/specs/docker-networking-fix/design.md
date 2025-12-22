# Design Document

## Overview

This design addresses the critical issue of hardcoded IP addresses in Docker configuration that make the system fragile and non-portable. The current system uses hardcoded IP `172.18.0.3` to route `imeyouwe.com` to the nginx container, which breaks when Docker networks change.

## Architecture

### Current Problem

```yaml
extra_hosts:
  - "imeyouwe.com:172.18.0.3"  # HARDCODED IP - BAD!
```

This approach has several critical flaws:
1. **IP addresses are not stable** - Docker can assign different IPs on restart
2. **Not portable** - Won't work in different environments
3. **Maintenance nightmare** - Requires manual updates
4. **Race conditions** - IP might not be assigned when containers start

### Proposed Solution

Use Docker's built-in service discovery and network aliases to eliminate hardcoded IPs:

```yaml
networks:
  yz-network:
    driver: bridge
    
services:
  webserver:
    networks:
      yz-network:
        aliases:
          - imeyouwe.com  # Docker will resolve this automatically
```

## Components and Interfaces

### Docker Network Configuration

**Custom Bridge Network:**
```yaml
networks:
  yz-network:
    driver: bridge
    driver_opts:
      com.docker.network.bridge.name: yz-bridge
```

**Service Aliases:**
- Nginx container gets alias `imeyouwe.com`
- All containers join the same network
- Docker DNS resolves aliases automatically

### Container Network Configuration

**Nginx Container (webserver):**
```yaml
webserver:
  networks:
    yz-network:
      aliases:
        - imeyouwe.com
        - www.imeyouwe.com
```

**Bootstrap Server:**
```yaml
bootstrap:
  networks:
    - yz-network
  # No extra_hosts needed - Docker DNS handles resolution
```

**Bridge Nodes:**
```yaml
bridge-node-1:
  networks:
    - yz-network
  # Connects to wss://imeyouwe.com/bridge1 via Docker DNS
```

### Connection Flow

1. **External Browser → Nginx:**
   - DNS resolves `imeyouwe.com` to public IP
   - Connects directly to nginx on port 443

2. **Internal Container → Nginx:**
   - Docker DNS resolves `imeyouwe.com` to nginx container
   - Connects to nginx within Docker network
   - Same SSL certificates and routing rules apply

3. **Connection Pool → Bridge Nodes:**
   - Uses external addresses: `wss://imeyouwe.com/bridge1`
   - Docker DNS resolves to nginx container
   - Nginx proxies to appropriate bridge node
   - SSL termination and WebSocket upgrade work correctly

## Data Models

### Docker Compose Network Structure

```yaml
networks:
  yz-network:
    driver: bridge
    ipam:
      driver: default
      config:
        - subnet: 172.20.0.0/16  # Use different subnet to avoid conflicts
```

### Service Discovery Model

```
Container Name    → Docker DNS → IP Address
imeyouwe.com     → Docker DNS → nginx container IP (dynamic)
bootstrap        → Docker DNS → bootstrap container IP (dynamic)
bridge-node-1    → Docker DNS → bridge-node-1 container IP (dynamic)
```

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system-essentially, a formal statement about what the system should do.*

### Property 1: DNS Resolution Consistency
*For any* container in the Docker network, resolving `imeyouwe.com` should always return the IP address of the nginx container, regardless of container restart order or network recreation.
**Validates: Requirements 1.1, 2.1**

### Property 2: Connection Pool External Address Resolution
*For any* connection attempt from the bootstrap server to `wss://imeyouwe.com/bridge1` or `wss://imeyouwe.com/bridge2`, the connection should successfully reach the appropriate bridge node through the nginx proxy.
**Validates: Requirements 3.1, 7.1**

### Property 3: Network Portability
*For any* Docker environment where the compose file is deployed, the system should function correctly without requiring IP address modifications or manual network configuration.
**Validates: Requirements 1.4, 5.3**

### Property 4: Service Discovery Reliability
*For any* container restart or network recreation, service name resolution should continue to work without manual intervention or configuration updates.
**Validates: Requirements 2.3, 8.1**

### Property 5: SSL Certificate Validity
*For any* connection from inside Docker to `https://imeyouwe.com` or `wss://imeyouwe.com`, the SSL certificate should be valid and the connection should establish successfully.
**Validates: Requirements 6.2, 7.3**

## Error Handling

### Network Resolution Failures

**Scenario:** Docker DNS fails to resolve `imeyouwe.com`
**Handling:** 
- Connection pool implements retry with exponential backoff
- Log clear error messages indicating DNS resolution failure
- Fallback to direct container name resolution if available

### SSL Certificate Issues

**Scenario:** SSL handshake fails for internal connections
**Handling:**
- Verify nginx is configured to accept connections from Docker network
- Check certificate includes `imeyouwe.com` in SAN
- Implement proper error logging for SSL failures

### Container Startup Order

**Scenario:** Bootstrap tries to connect before nginx is ready
**Handling:**
- Use Docker `depends_on` with health checks
- Connection pool implements connection retry logic
- Health checks verify nginx is accepting connections

## Testing Strategy

### Unit Tests
- Test Docker DNS resolution within containers
- Verify nginx proxy configuration
- Test connection pool retry logic

### Integration Tests
- Test full connection flow: Bootstrap → Nginx → Bridge Node
- Verify SSL termination works for internal connections
- Test container restart scenarios

### Property Tests
- **Property 1 Test:** Generate random container restart sequences, verify DNS resolution always works
- **Property 2 Test:** Generate random connection attempts, verify they reach correct bridge nodes
- **Property 3 Test:** Deploy in different Docker environments, verify portability
- **Property 4 Test:** Generate random network recreation scenarios, verify service discovery recovery
- **Property 5 Test:** Generate random SSL connection attempts, verify certificate validity

Each property test should run minimum 100 iterations and be tagged with:
**Feature: docker-networking-fix, Property {number}: {property_text}**

## Implementation Notes

### Migration Strategy

1. **Phase 1:** Update Docker Compose configuration
   - Remove hardcoded `extra_hosts` entries
   - Add network aliases for nginx container
   - Update network configuration

2. **Phase 2:** Test connection pool functionality
   - Verify external address resolution works
   - Test SSL connections from inside Docker
   - Validate WebSocket upgrades

3. **Phase 3:** Deploy and monitor
   - Deploy updated configuration
   - Monitor connection pool health
   - Verify bridge node connectivity

### Nginx Configuration Requirements

Nginx must be configured to:
- Accept connections from Docker network subnet
- Handle SSL termination for internal connections
- Proxy WebSocket connections correctly
- Include proper CORS headers if needed

### Connection Pool Considerations

The connection pool should:
- Use the same external addresses as before
- Implement proper retry logic for connection failures
- Handle SSL certificate validation correctly
- Support WebSocket connection upgrades through proxy