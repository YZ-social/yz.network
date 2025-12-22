# Implementation Plan: Docker Networking Fix

## Overview

Remove hardcoded IP addresses from Docker configuration and implement proper service discovery to make the system portable and reliable.

## Tasks

- [x] 1. Update Docker Compose Network Configuration
  - Remove all hardcoded IP addresses from `extra_hosts` entries
  - Configure custom bridge network with proper subnet
  - Add network aliases for nginx container
  - _Requirements: 1.1, 1.3, 5.1, 5.2_

- [x] 2. Configure Nginx Container with Service Discovery
  - Add `imeyouwe.com` and `www.imeyouwe.com` as network aliases
  - Ensure nginx accepts connections from Docker network subnet
  - Verify SSL certificate works for internal connections
  - _Requirements: 2.1, 2.2, 6.1, 6.2_

- [x] 3. Update Bootstrap Server Network Configuration
  - Remove hardcoded `extra_hosts` entries
  - Ensure connection pool uses external addresses that resolve via Docker DNS
  - Test connection to `wss://imeyouwe.com/bridge1` and `wss://imeyouwe.com/bridge2`
  - _Requirements: 3.1, 3.2, 7.1, 7.2_

- [x] 4. Update Bridge Node Network Configuration
  - Remove hardcoded `extra_hosts` entries from bridge node containers
  - Ensure bridge nodes can resolve nginx container via Docker DNS
  - Test internal connectivity to nginx proxy
  - _Requirements: 2.1, 2.3, 6.3_

- [x] 5. Update Genesis Node Network Configuration
  - Remove hardcoded `extra_hosts` entries from genesis node container
  - Ensure genesis node uses Docker DNS for service discovery
  - Test connectivity to bootstrap server and bridge nodes
  - _Requirements: 2.1, 5.3_

- [ ] 6. Test Connection Pool Functionality
  - Verify connection pool can connect to bridge nodes via nginx proxy
  - Test SSL handshake and WebSocket upgrade through proxy
  - Verify authentication works over proxied connections
  - Test request multiplexing over persistent connections
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 7.3, 7.4_

- [ ] 7. Implement Network Health Checks
  - Add health checks that verify DNS resolution works
  - Test nginx container accessibility from other containers
  - Verify SSL certificate validity for internal connections
  - _Requirements: 6.2, 8.2_

- [ ] 8. Test Container Restart Scenarios
  - Test system recovery when nginx container restarts
  - Verify connection pool reconnects after network issues
  - Test DNS resolution after Docker network recreation
  - _Requirements: 8.1, 8.2, 8.3_

- [ ] 9. Validate System Portability
  - Test deployment in different Docker environments
  - Verify no hardcoded IPs remain in configuration
  - Test system works without manual network configuration
  - _Requirements: 1.4, 5.4_

- [ ] 10. Deploy and Monitor
  - Deploy updated Docker configuration
  - Monitor connection pool health and bridge connectivity
  - Verify external browser clients still work correctly
  - Monitor for any DNS resolution issues
  - _Requirements: 3.3, 4.4, 8.4_

## Notes

- All hardcoded IP addresses must be removed from Docker configuration
- Docker's built-in DNS resolution should handle all internal service discovery
- External addressing scheme remains the same for compatibility
- Connection pool functionality must be preserved and improved
- System must be portable across different Docker environments