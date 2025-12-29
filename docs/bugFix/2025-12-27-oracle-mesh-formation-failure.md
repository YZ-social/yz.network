# Oracle YZ Node Mesh Formation Failure - Root Cause Analysis

## Date: December 27, 2025

## Problem
- 13 out of 15 Oracle YZ nodes are unhealthy
- All nodes show 0 peer connections
- Dashboard shows only 2 healthy nodes
- Nodes cannot form a mesh network

## Root Causes Found

### Root Cause #1: BUILD_ID Version Mismatch ✅ FIXED

#### Discovery
Running the diagnostic script `scripts/debug-oracle-mesh-formation.js` revealed:
- All 18 nodes (genesis, 2 bridges, 15 DHT nodes) are unhealthy
- All nodes show `bootstrap ✗` (bootstrap connection failing)
- WebSocket connections to nodes work externally
- Cross-node connectivity works

#### The Actual Issue
When connecting to the bootstrap server, we receive:
```json
{
  "type": "version_mismatch",
  "clientVersion": "1.0.0",
  "clientBuildId": "diagnostic",
  "serverVersion": "1.0.0",
  "serverBuildId": "0a2d87da7ff14a6729a6",
  "message": "Bundle version mismatch. Please refresh your browser to get the latest version."
}
```

#### Solution Applied
Added volume mount for `bundle-hash.json` to all 15 DHT nodes in `docker-compose.nodes.yml`:
```yaml
volumes:
  - ./dist/bundle-hash.json:/app/dist/bundle-hash.json:ro
```

---

### Root Cause #2: Metadata Propagation Bug in DHT Handshakes ✅ FIXED

#### Discovery
After fixing BUILD_ID, bridge nodes still had 0 DHT peers. Logs showed:
```
📋 Verification: isBridgeNode=undefined for 779678f5
🔍 [DHT find_node] Non-browser peer 779678f5... - nodeType: undefined
Peer 779678f5: isBridge=false, isSelf=false, metadata.nodeType=undefined, metadata.isBridgeNode=undefined
```

The genesis node was sending `dht_peer_hello` with ONLY `membershipToken`:
```json
{
  "type": "dht_peer_hello",
  "peerId": "779678f5...",
  "metadata": {
    "membershipToken": {...}  // ONLY the token, no nodeType, no isBridgeNode!
  }
}
```

#### The Actual Issue
In `src/dht/KademliaDHT.js`, the `_setMembershipToken()` method was **overwriting** all metadata:

```javascript
// BROKEN CODE (before fix):
ConnectionManagerFactory.setPeerMetadata(this.localNodeId.toString(), {
  membershipToken: token  // This REPLACED all existing metadata!
});
```

The `start()` method correctly set metadata with `nodeType`, `isBridgeNode`, `listeningAddress`, etc.
But when `_setMembershipToken()` was called later, it replaced everything with just the token.

#### Solution Applied
Changed `_setMembershipToken()` to **merge** with existing metadata:

```javascript
// FIXED CODE:
const existingMetadata = ConnectionManagerFactory.getPeerMetadata(this.localNodeId.toString()) || {};
ConnectionManagerFactory.setPeerMetadata(this.localNodeId.toString(), {
  ...existingMetadata,  // Preserve existing metadata
  membershipToken: token
});
```

Also fixed the same issue in `src/bridge/PassiveBridgeNode.js`.

#### Files Modified
- `src/dht/KademliaDHT.js` - `_setMembershipToken()` now merges metadata
- `src/bridge/PassiveBridgeNode.js` - Bridge metadata now merges with existing

---

## How BUILD_ID Works
1. Webpack builds `bundle.HASH.js` and writes hash to `dist/bundle-hash.json`
2. Browser extracts BUILD_ID from script src (`bundle.HASH.js`)
3. Server reads BUILD_ID from `dist/bundle-hash.json` at startup
4. Client connects to bootstrap and sends both values in registration
5. Bootstrap checks BUILD_ID match (must match for synchronized deployment)
6. If mismatch, sends `version_mismatch` error

## Verification
After applying both fixes, run:
```bash
node scripts/debug-oracle-mesh-formation.js
```

Expected result:
- All nodes should show `bootstrap ✓`
- Genesis node metadata should include `nodeType`, `isBridgeNode`, `listeningAddress`
- Bridge nodes should receive proper metadata in `dht_peer_hello` handshakes
- Bridge nodes should have DHT peers (not 0)
- Health status should improve to healthy

## Deployment Steps

To apply these fixes on the Oracle server:

```bash
# 1. Pull the latest code with both fixes
git pull

# 2. Rebuild the JavaScript bundle
npm run build

# 3. Restart all containers to pick up the code changes
./RestartServerImproved.sh

# 4. Wait 60 seconds for nodes to start and connect
sleep 60

# 5. Verify nodes are healthy
node scripts/debug-oracle-mesh-formation.js
```

The nodes should now:
1. All read the same BUILD_ID from the mounted `dist/bundle-hash.json` file
2. Properly propagate metadata (nodeType, isBridgeNode, listeningAddress) in handshakes
3. Bridge nodes should be able to identify genesis peer and form DHT connections


---

### Root Cause #3: Duplicate Connection Manager Creation ✅ FIXED

#### Discovery
After fixing metadata propagation, `find_node` queries were still timing out. Logs showed:
```
⏰ find_node timeout for 26b4947c... (10000ms) - failure count: 19
```

But the connection manager showed the peer as connected.

#### The Actual Issue
In `KademliaDHT.getOrCreatePeerNode()`, when an incoming connection arrived, the code was creating a NEW connection manager even though one already existed:

```javascript
// BROKEN CODE (before fix):
if (!peerNode.connectionManager) {
  peerNode.connectionManager = ConnectionManagerFactory.createForConnection(...);
}
```

The problem: For incoming connections, `RoutingTable.handlePeerConnected()` already created a dedicated connection manager. But `getOrCreatePeerNode()` was checking `peerNode.connectionManager` which was undefined (the manager was stored elsewhere), so it created a NEW manager.

Result: DHT message handlers were attached to the NEW manager, but messages arrived on the ORIGINAL dedicated manager (which had 0 listeners).

#### Solution Applied
Check if `peerNode.connectionManager` already exists before creating a new one:

```javascript
// FIXED CODE:
if (peerNode.connectionManager) {
  console.log(`🔄 Using existing connection manager for ${peerId.substring(0, 8)}...`);
  // Still attach DHT handlers to existing manager
} else {
  peerNode.connectionManager = ConnectionManagerFactory.createForConnection(...);
}
```

#### Files Modified
- `src/dht/KademliaDHT.js` - `getOrCreatePeerNode()` now reuses existing connection managers

---

### Root Cause #4: DHT Message Handler Race Condition ✅ FIXED

#### Discovery
After fixing the duplicate connection manager issue, bridge nodes still showed `0 connected, 0 routing` peers even though WebSocket connections were established. Logs showed:
```
🔔 DEBUG: Emitting dhtMessage event for find_node from 627871f3 (manager: WebSocketConnectionManager, listeners: 0)
```

The connection manager was emitting `dhtMessage` events but there were **0 listeners** - the DHT message handler wasn't attached yet.

#### The Actual Issue
In `KademliaDHT.handlePeerConnected()`, the DHT message handler was attached inside a `setTimeout()` callback:

```javascript
// BROKEN CODE (before fix):
handlePeerConnected(peerId) {
  // Double-check connection with a small delay to ensure it's stable
  setTimeout(() => {
    // ... DHT handler attached here, AFTER messages already arrived
    this.getOrCreatePeerNode(peerId);
  }, ...);
}
```

This caused a race condition:
1. Incoming connection arrives
2. Connection manager starts receiving messages immediately
3. `find_node` messages arrive with 0 listeners (handler not attached yet)
4. `setTimeout` fires and attaches handler (too late!)

#### Solution Applied
Attach DHT message handlers IMMEDIATELY when peer connects, not after a delay:

```javascript
// FIXED CODE:
handlePeerConnected(peerId) {
  // CRITICAL FIX: Attach DHT message handlers IMMEDIATELY
  this.getOrCreatePeerNode(peerId);
  console.log(`✅ DHT handlers attached immediately for ${peerId.substring(0, 8)}`);
  
  // Double-check connection with a small delay (for other operations)
  setTimeout(() => {
    // ... other operations
  }, ...);
}
```

#### Files Modified
- `src/dht/KademliaDHT.js` - `handlePeerConnected()` now attaches handlers immediately

---

## Final Status (December 29, 2025)

After applying all four fixes:
- **All 15 DHT nodes are healthy** ✅
- **Genesis node is healthy** ✅
- **Both bridge nodes are healthy** ✅
- **Bootstrap server is healthy** ✅

The Oracle YZ mesh network is now fully operational.

### Commits
1. `60fde5e` - fix: metadata propagation bug in DHT peer handshakes
2. `28fd95d` - fix: prevent duplicate connection manager creation for incoming connections
3. `b830acf` - fix: attach DHT message handlers immediately on peer connection to prevent race condition
