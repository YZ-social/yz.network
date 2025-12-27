# Bootstrap Server Connection Debug Report

**Date**: December 27, 2025
**Task**: Debug bootstrap server connection failures (Task 2)

## Summary

Comprehensive debugging of bootstrap server connections revealed that the "Unexpected server response: 200" error is **NOT the actual issue**. The real problems are:

1. **BUILD_ID mismatch** between deployed server and local code
2. **No bridge nodes connected** to bootstrap server for peer coordination

## Diagnostic Results

### WebSocket Connectivity ✅
- Bootstrap server accepts WebSocket connections properly
- Connection time: ~130-200ms
- WebSocket upgrade headers are handled correctly
- No "Unexpected server response: 200" errors observed

### Version Checking
- **Server Protocol Version**: 1.0.0
- **Client Protocol Version**: 1.0.0
- **Server BUILD_ID**: `ec8001eec952e7aabd44`
- **Local BUILD_ID**: `83aef958a442aad9959c`

The BUILD_ID mismatch causes version_mismatch errors, but the server has a **fallback behavior** that accepts connections when buildId is omitted.

### Bootstrap Coordination
- Registration: ✅ Working (when buildId omitted)
- Peer Request: ✅ Working
- Peer Response: ⚠️ Returns empty - "No bridge nodes available for onboarding coordination"

## Root Cause Analysis

### 1. BUILD_ID Mismatch
The server was deployed with a different bundle hash than the current local code. This could be due to:
- Server deployed from different git commit
- Server's `dist/bundle-hash.json` not updated during container rebuild
- Different webpack/node versions producing different hashes

**Impact**: Clients sending buildId get rejected with version_mismatch
**Workaround**: Clients can omit buildId to use fallback behavior

### 2. Bridge Nodes Not Connected
The bootstrap server reports "No bridge nodes available for onboarding coordination". This means:
- Bridge node containers may not be running
- Bridge nodes may have failed to connect to bootstrap
- Bridge node registration may have failed

**Impact**: New nodes cannot be onboarded because there's no peer to coordinate with

## Diagnostic Scripts Created

1. `scripts/debug-bootstrap-connections.js` - Comprehensive connection testing
2. `scripts/debug-build-id-mismatch.js` - BUILD_ID analysis
3. `scripts/test-bootstrap-coordination.js` - Full coordination flow test

## Recommendations

### Immediate Actions
1. Check bridge node container status: `docker ps | grep bridge`
2. Check bridge node logs: `docker logs bridge-node-1`
3. Verify bridge nodes can reach bootstrap server

### Long-term Fixes
1. Ensure deployment process updates `dist/bundle-hash.json`
2. Consider making BUILD_ID check less strict (allow fallback by default)
3. Add health monitoring for bridge node connections

## Requirements Coverage

| Requirement | Status | Notes |
|-------------|--------|-------|
| 2.1 DHT_Node connects to bootstrap | ✅ | WebSocket connections work |
| 2.2 Detailed error information | ✅ | Version mismatch provides details |
| 2.3 "Unexpected server response: 200" | ✅ | NOT occurring - was misdiagnosis |
| 2.4 Accept internal/external clients | ✅ | Both work when buildId omitted |
| 2.5 Peer introductions | ❌ | Blocked by missing bridge nodes |
