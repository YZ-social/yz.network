# Community Nodes Proposal

**Status:** ON HOLD
**Reason:** WSS domain requirement blocking
**Date:** 2025-12-04

---

## Vision

Enable community members to run YZ Network DHT nodes on their local machines to help strengthen and decentralize the network. This would distribute the network load across many community-operated nodes instead of relying solely on centralized infrastructure.

## Original Implementation

An installer script was developed (`src/installer/install-node.js`) with the following features:

### Automated Port Forwarding
- UPnP/NAT-PMP support via `nat-upnp` package
- Automatic router configuration for home networks
- External IP detection via multiple services
- Helper class: `src/installer/upnp-helper.js`

### User-Friendly Installation
- Interactive CLI installer
- Guided setup process
- Automatic configuration
- Service management

## Blocking Issue: WSS Requirement

**Problem Discovered:** Community nodes require a valid domain name with SSL/TLS certificate for WebSocket Secure (WSS) connections.

**Why This Blocks Community Nodes:**
1. **Browser Security:** Modern browsers require WSS (not WS) for connections
2. **Certificate Requirement:** WSS requires valid SSL/TLS certificate
3. **Domain Requirement:** SSL certificates require a registered domain name
4. **Dynamic IP Challenge:** Most home users have dynamic IP addresses
5. **DNS Complexity:** Setting up DNS for dynamic IPs is non-trivial

**What Community Users Would Need:**
- Own a domain name (cost + technical knowledge)
- Configure DNS A record pointing to their home IP
- Obtain SSL certificate (Let's Encrypt, etc.)
- Keep DNS updated if IP changes (dynamic DNS service)
- Configure router port forwarding (even with UPnP)
- Maintain certificate renewal

## Why This Is Unacceptable for Community Adoption

The domain + SSL requirement creates too high a barrier to entry:

1. **Cost:** Domain registration ($10-15/year minimum)
2. **Technical Knowledge:** DNS, SSL, port forwarding, certificate management
3. **Time Investment:** Setup and ongoing maintenance
4. **Dynamic IP Issues:** Most home users have changing IP addresses
5. **Security Concerns:** Opening ports on home networks

**Result:** Very few community members would actually run nodes, defeating the purpose of decentralization.

## Alternative Solutions Under Consideration

### 1. WebRTC-Only Community Nodes
- Eliminate need for public IP/domain
- P2P connections through NAT traversal
- Still contributes to network without WSS requirement
- **Limitation:** Cannot accept incoming WebSocket connections from browsers

### 2. Subdomain Service
- Central service provides subdomains (e.g., `node123.yznetwork.org`)
- Automated SSL certificate provisioning
- Dynamic DNS updates managed by service
- **Trade-off:** Requires central infrastructure, less decentralized

### 3. Tor Hidden Services
- No domain or SSL required
- NAT traversal not needed
- True decentralization
- **Limitation:** Requires Tor, slower connections, browser compatibility

### 4. Local Development Nodes Only
- Community members run nodes for testing
- Connect only via localhost
- No public accessibility requirement
- **Limitation:** Doesn't help production network

## Current Status

**Implementation:** Complete but unused
**Dependencies:** `nat-upnp` (has critical security vulnerabilities)
**Decision:** Remove `nat-upnp` dependency until WSS requirement is solved

### Security Note

The `nat-upnp` package (v2.1.0) has multiple critical vulnerabilities:
- CRITICAL: form-data unsafe random function (GHSA-fjxv-7rqg-78g4)
- HIGH: ip SSRF improper categorization (GHSA-2p57-rm9w-gvfp)
- MODERATE: tough-cookie prototype pollution (GHSA-72xf-g2v4-qvf3)
- MODERATE: xml2js prototype pollution (GHSA-776f-qx25-q3cc)

Since the installer is not currently usable due to the WSS requirement, it's safer to remove this vulnerable dependency entirely.

## Files Affected

When community nodes are removed:
- `src/installer/install-node.js` - Main installer script
- `src/installer/upnp-helper.js` - UPnP port forwarding helper
- `nat-upnp` npm dependency - Vulnerable package

These files will remain in the repository but the `nat-upnp` dependency will be removed. Users who want UPnP functionality can manually install it: `npm install nat-upnp` (at their own security risk).

## Future Work

This proposal remains **ON HOLD** until one of the following occurs:

1. **WebRTC-Only Node Architecture** is designed and implemented
2. **Subdomain Service** infrastructure is deployed
3. **Alternative Transport** (Tor, etc.) is integrated
4. **Browser WSS Requirement** changes (unlikely)

The installer code will remain in the repository as reference for when this issue is resolved.

---

**Related Issues:**
- npm audit security vulnerabilities (2025-12-04)
- WSS requirement for browser connections
- NAT traversal and port forwarding complexity
- Dynamic IP address challenges for home users

**Next Steps:**
1. Remove `nat-upnp` dependency to fix security vulnerabilities
2. Document WSS requirement in CLAUDE.md
3. Revisit community nodes when alternative solution is identified
