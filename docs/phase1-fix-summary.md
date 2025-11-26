# Phase 1 Fix: PassiveBridgeNode Inheritance Correction

## Date: 2025-01-25

## Problem

PassiveBridgeNode was extending `DHTClient` instead of `NodeDHTClient`, causing it to miss critical WebSocket server setup and bootstrap metadata.

**Symptom**: Browsers couldn't connect to bridge nodes because metadata lacked WebSocket addresses:
```javascript
📋 Received inviter metadata from 0ee32303...
   Listening address: undefined  ← PROBLEM
   Node type: bridge
```

## Root Cause

`PassiveBridgeNode extends DHTClient` didn't inherit `getBootstrapMetadata()` from `NodeDHTClient`, which provides:
- `listeningAddress` - Internal Docker WebSocket address
- `publicWssAddress` - External browser WSS address
- WebSocket capabilities declaration

## Changes Made

### File: `src/bridge/PassiveBridgeNode.js`

#### 1. Fixed Inheritance (Line 1, 13)
```diff
- import { DHTClient } from '../core/DHTClient.js';
+ import { NodeDHTClient } from '../node/NodeDHTClient.js';

- export class PassiveBridgeNode extends DHTClient {
+ export class PassiveBridgeNode extends NodeDHTClient {
```

#### 2. Removed Duplicate Connection Manager Creation (Lines 14-42)
**Before**: Manually created connection manager in constructor
```javascript
// OLD CODE (REMOVED):
this.connectionManager = ConnectionManagerFactory.createForConnection('nodejs', 'browser', {
  maxConnections: this.options.maxConnections,
  port: this.bridgePort,
  host: this.bridgeHost,
  enableServer: true,
  ...options.connectionOptions
});
```

**After**: Let NodeDHTClient create it via super() options
```javascript
// NEW CODE:
super({
  port: options.bridgePort || options.port || 8083,
  websocketPort: options.bridgePort || options.port || 8083,
  websocketHost: options.bridgeHost || options.host || '0.0.0.0',
  publicAddress: options.publicAddress,
  publicWssAddress: options.publicWssAddress,
  ...options
});

// NodeDHTClient will create connection manager in start() method
```

#### 3. Updated getDHTOptions() (Lines 103-113)
```diff
  getDHTOptions() {
    return {
      ...super.getDHTOptions(),
      passiveMode: true,
      disableStorage: true,
      disableRouting: true,
      disableLookups: true,
      enableConnections: true
-     serverConnectionManager: this.connectionManager
+     // serverConnectionManager removed - NodeDHTClient handles this
    };
  }
```

#### 4. Simplified start() Method (Lines 186-209)
**Before**: Manually initialized connection manager and waited for WebSocket
```javascript
// OLD CODE (REMOVED):
this.connectionManager.initialize(this.dht.localNodeId.toString());
await this.connectionManager.waitForWebSocketInitialization();
```

**After**: NodeDHTClient.start() handles all initialization
```javascript
// NEW CODE:
// Call superclass start to create DHT and connection manager
// NodeDHTClient.start() handles:
// - Crypto setup
// - Connection manager creation
// - WebSocket server startup
// - DHT initialization
await super.start();

// this.connectionManager is now set and ready
```

## What PassiveBridgeNode Now Inherits

From `NodeDHTClient`:
- ✅ WebSocket server creation and initialization
- ✅ `getBootstrapMetadata()` with WebSocket addresses
- ✅ Node.js crypto configuration (Ed25519)
- ✅ Connection manager lifecycle management
- ✅ Proper bootstrap metadata structure

From `DHTClient` (via NodeDHTClient):
- ✅ Generic DHT initialization (start/stop)
- ✅ Common operations (store, get, invitations)
- ✅ Event emitter functionality

## Expected Results

### 1. Bridge Node Metadata Now Includes WebSocket Addresses
```javascript
// Before (BROKEN):
{
  nodeType: 'bridge',
  capabilities: ['websocket', 'observer']
  // Missing: listeningAddress, publicWssAddress
}

// After (FIXED):
{
  nodeType: 'nodejs',  // Inherited from NodeDHTClient
  listeningAddress: 'ws://bridge-node-1:8083',       // Internal Docker
  publicWssAddress: 'wss://imeyouwe.com/bridge1',    // External browser
  capabilities: ['websocket', 'relay'],
  canRelay: true,
  canAcceptConnections: true,
  canInitiateConnections: true
}
```

### 2. Browser Connection Flow Now Works
```
Browser → Bootstrap Server → Receives Invitation with WebSocket Address
   ↓
Browser → Connects to wss://imeyouwe.com/bridge1
   ↓
Bridge Node → Accepts WebSocket connection
   ↓
Browser ↔ Bridge Node ↔ Genesis Node DHT Connection Established ✅
```

### 3. No Duplicate Connection Manager Code
- Single source of truth: `NodeDHTClient.start()`
- No manual initialization required
- Proper lifecycle management

## Testing Checklist

### Local Testing
- [ ] Bridge node starts without errors
- [ ] Bridge node WebSocket server listens on correct port
- [ ] Bridge node advertises correct addresses in metadata
- [ ] Bootstrap server can connect to bridge node
- [ ] Bridge node accepts bootstrap authentication

### Docker Testing
- [ ] `docker-compose up` starts all services
- [ ] Bridge nodes healthy: `docker exec yz-bridge-node-1 wget -q -O- http://127.0.0.1:9090/health`
- [ ] Bootstrap server healthy
- [ ] Genesis node can connect to bridge

### Browser Testing
- [ ] Browser connects to bootstrap server
- [ ] Browser receives invitation from genesis node
- [ ] **Browser receives WebSocket address in invitation** (CRITICAL)
- [ ] Browser successfully connects to genesis node via bridge
- [ ] DHT network forms correctly

## Deployment Steps

### 1. Rebuild Docker Image
```bash
docker build -t itsmeront/yz-dht-node:latest .
docker push itsmeront/yz-dht-node:latest
```

### 2. Deploy to Oracle Cloud
```bash
ssh ubuntu@imeyouwe.com
cd yz.network
docker-compose -f docker-compose.production.yml pull
docker-compose -f docker-compose.production.yml down
docker-compose -f docker-compose.production.yml up -d
```

### 3. Verify Bridge Node Health
```bash
# Check bridge node 1
docker exec yz-bridge-node-1 wget -q -O- http://127.0.0.1:9090/health

# Check bridge node 2
docker exec yz-bridge-node-2 wget -q -O- http://127.0.0.1:9090/health

# Expected output:
{"healthy":true,"uptime":5432,"connectedPeers":0,"timestamp":1737841234567,"nodeType":"bridge"}
```

### 4. Test Browser Connectivity
```bash
# Open browser console
# Visit: https://imeyouwe.com

# Expected in console:
📋 Received inviter metadata from 0ee32303...
   Listening address: ws://bridge-node-1:8083  ✅ NOW PRESENT
   Public WSS address: wss://imeyouwe.com/bridge1  ✅ NOW PRESENT
   Node type: nodejs
```

## Rollback Plan

If deployment fails:
```bash
# Revert to previous Docker image
docker-compose -f docker-compose.production.yml down
docker pull itsmeront/yz-dht-node:previous-tag
docker-compose -f docker-compose.production.yml up -d
```

## Risk Assessment

**Risk Level**: LOW

**Reasons**:
- Changes are localized to PassiveBridgeNode only
- Fixes known bug (missing WebSocket addresses)
- Uses established pattern from NodeDHTClient
- No changes to protocol or message format
- Can be easily reverted

## Related Documentation

- **Full Proposal**: `docs/proposals/dht-client-class-refactoring.md`
- **Architecture**: `CLAUDE.md` (DHT Client Class Hierarchy section)
- **Issue**: Browser connectivity broken - missing WebSocket addresses in metadata

## Status

- [x] Code changes completed
- [ ] Local testing
- [ ] Docker image rebuilt
- [ ] Deployed to Oracle Cloud
- [ ] Browser connectivity verified
- [ ] Documentation updated

## Next Steps (Phase 2)

After Phase 1 is verified working:
1. Merge ActiveDHTNode functionality into NodeDHTClient
2. Extract MetricsCollector to separate plugin class
3. Update docker-compose.yml to use NodeDHTClient with options
4. Delete ActiveDHTNode.js

See: `docs/proposals/dht-client-class-refactoring.md` for Phase 2 details
