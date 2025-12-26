# Implementation Plan: Nginx WebSocket Proxy Fix

## Overview

Fix nginx WebSocket proxy configuration to resolve DNS issues, connection refused errors, and improper path handling that prevent the bootstrap server from connecting to bridge nodes.

## Tasks

- [x] 1. Fix nginx upstream configuration and WebSocket proxy settings
  - Replace dynamic upstream resolution with static upstream blocks
  - Fix proxy_pass path handling to avoid appending location paths
  - Add proper WebSocket headers and timeout configuration
  - _Requirements: 1.1, 1.2, 1.5, 6.1, 6.4_

- [x] 2. Test Docker network connectivity
  - Verify nginx can resolve bridge node hostnames
  - Test TCP connectivity from nginx to bridge nodes
  - Ensure all containers are on the same Docker network
  - _Requirements: 2.1, 2.2, 2.4, 5.1, 5.2_

- [ ] 3. Verify bridge node interface binding
  - Confirm bridge nodes bind to 0.0.0.0 interface (not localhost)
  - Check bridge node port accessibility from nginx container
  - Test bridge node health endpoints from nginx
  - _Requirements: 2.1, 2.2, 2.4_

- [x] 4. Deploy and test nginx configuration
  - Apply updated nginx configuration
  - Restart nginx container to pick up changes
  - Test WebSocket connections through nginx proxy
  - _Requirements: 1.5, 6.1, 6.2_

- [x] 5. Validate connection pool functionality
  - Test bootstrap server connection pool initialization
  - Verify persistent WebSocket connections through nginx
  - Confirm connection pool can send/receive messages
  - _Requirements: 3.1, 3.2, 6.1, 6.2, 6.3_

- [x] 6. Final integration testing
  - Restart all services and verify end-to-end connectivity
  - Test connection pool resilience through nginx restarts
  - Verify bridge health endpoint reports connections as available
  - _Requirements: 2.5, 3.1, 3.4, 7.1, 7.2_

## Notes

- Focus on fixing the specific nginx configuration issues identified in error logs
- Test each change incrementally to isolate any remaining issues
- Verify both DNS resolution and TCP connectivity before testing WebSocket upgrades
- Connection pool should work immediately after nginx configuration is fixed