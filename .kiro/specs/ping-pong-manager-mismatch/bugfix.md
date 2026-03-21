# Ping/Pong Manager Mismatch Bug

## Summary
Ping messages are being sent from one ConnectionManager instance, but pong responses are arriving at a DIFFERENT ConnectionManager instance that doesn't have the pending request. This causes all pings to timeout even though the pongs are successfully sent and received.

## Evidence

### Diagnostic Logging Added
Added `UNMATCHED_PONG` warning in `ConnectionManager.handleMessage()` when a pong arrives but doesn't match any pending request.

### Production Logs (after hours of running)

**bridge-node-1:**
- 1372 ping failures (`Failed to ping X: Request ping to X timed out after 5000ms`)
- 56 unmatched pongs with KademliaDHT requestId format (`9a76b80d_630`)

**dht-node-1:**
- 3011 unmatched pongs with ConnectionManager requestId format (`req_1774102477927_mx1ftxsw1`)
- All have `pendingRequests.size=0`

### Key Observation
The pongs ARE arriving (we see UNMATCHED_PONG logs), but they arrive at a manager with `pendingRequests.size=0`. This means:
1. Manager A sends ping, stores request in `Manager_A.pendingRequests`
2. Pong arrives at Manager B, which checks `Manager_B.pendingRequests` (empty)
3. Pong is unmatched, Manager A times out

## Two Separate Ping Mechanisms

### 1. KademliaDHT.sendPing() (fire-and-forget)
- Location: `src/dht/KademliaDHT.js` line 2994
- RequestId format: `nodeId_counter` (e.g., `9a76b80d_630`)
- Uses `this.sendMessage()` which is fire-and-forget
- Does NOT track responses in any pendingRequests map
- Called on new peer connection (line 2059) and in maintenance loop (line 6734)
- Pongs arrive but are always unmatched (expected - no tracking)

### 2. ConnectionManager.ping() (request/response)
- Location: `src/network/ConnectionManager.js` line 329
- RequestId format: `req_timestamp_random` (e.g., `req_1774102477927_mx1ftxsw1`)
- Uses `this.sendRequest()` which stores in `this.pendingRequests`
- Called by `WebSocketConnectionManager.sendPingToConnectedPeer()` every 30 seconds
- Pongs arrive but at WRONG manager instance (bug)

## Root Cause Analysis

### Architecture
- Each peer connection gets a dedicated `WebSocketConnectionManager` instance
- `setupConnection()` attaches message handler to WebSocket: `ws.on('message', (data) => this.handleMessage(...))`
- `setupConnection()` also calls `this.startPing()` which starts 30-second ping interval

### The Bug
When a peer reconnects:
1. New manager is created for the new connection
2. Old manager should be destroyed via `DHTNode.setupConnection()` which calls `stopPing()` and `destroy()`
3. BUT: The ping sent by the NEW manager's pong is arriving at a DIFFERENT manager

### Possible Causes
1. **Multiple managers for same peer**: Despite cleanup code, multiple managers may exist
2. **Message handler on wrong manager**: The WebSocket message handler might be attached to a different manager than the one sending pings
3. **Outgoing vs incoming connection mismatch**: Node A initiates connection to Node B, but Node B's response comes back on a different path

## Relevant Files

- `src/network/ConnectionManager.js` - Base class with `ping()`, `sendRequest()`, `handleMessage()`
- `src/network/WebSocketConnectionManager.js` - `startPing()`, `sendPingToConnectedPeer()`, `setupConnection()`
- `src/dht/KademliaDHT.js` - `sendPing()` (fire-and-forget), `sendMessage()`
- `src/dht/RoutingTable.js` - `handlePeerConnected()` which manages manager lifecycle
- `src/core/DHTNode.js` - `setupConnection()` which destroys old manager

## Network Health
Despite ping failures:
- DHT messages (find_node, find_node_response) work correctly
- 17 stable connections on bridge-node-1
- No stale connections detected
- Full mesh connectivity achieved

## Diagnostic Code Added
```javascript
// In ConnectionManager.handleMessage(), after pendingRequests check:
if (message.type === 'pong') {
  console.warn(`⚠️ UNMATCHED_PONG: requestId=${message.requestId} from ${peerId.substring(0, 8)}... pendingRequests.size=${this.pendingRequests.size}`);
}
```

## Next Steps to Investigate

1. **Add logging to identify which manager sends ping vs receives pong**
   - Log manager instance ID when sending ping
   - Log manager instance ID when receiving pong
   
2. **Check if outgoing connections have different manager than incoming**
   - Node A connects to Node B (outgoing from A's perspective)
   - Node B accepts connection (incoming from B's perspective)
   - Are pings sent on outgoing manager but pongs received on incoming?

3. **Verify manager lifecycle on reconnection**
   - Is old manager fully destroyed before new one starts pinging?
   - Are there race conditions in manager replacement?

4. **Consider consolidating ping mechanisms**
   - Remove `KademliaDHT.sendPing()` (fire-and-forget)
   - Use only `ConnectionManager.ping()` with proper response tracking

## Related Bugs
This is similar to the DHT handler attachment bug (`.kiro/specs/dht-handler-attachment-fix/`) where DHT message handlers were attached to the wrong manager instance.

---

## Additional Issue: Self-Message Bug (discovered during investigation)

### Symptoms
- Logs show: `⚠️ Attempted to look up local node ID afa8b3e6... in routing table - returning null`
- Logs show: `❌ Failed to send store_response to afa8b3e6...: No connection to peer afa8b3e6...`
- Logs show: `Error handling message from afa8b3e6f68b5a66ebf672df91ca209844b2a633`
- Node afa8b3e6 is dht-node-1's OWN node ID

### Analysis
A node is receiving DHT messages (specifically `store` requests) where the `peerId` parameter is set to its own local node ID. This causes:
1. `handlePeerMessage()` tries to look up the peer in routing table → warning (local node not in routing table)
2. `handleStore()` tries to send `store_response` back to the "peer" → fails (no connection to self)

### Possible Causes
1. **Routed message with wrong source**: OverlayNetwork routes messages and sets `source` from the message. If a node sends a routed message to itself, the source would be its own ID.
2. **Connection manager with wrong peerId**: A connection manager might have `this.peerId` set to the local node's ID instead of the remote peer's ID.
3. **find_node_response includes local node**: When a peer responds to find_node, it might include the querying node in the results.

### Evidence from Logs
The self-lookup warnings appear:
- After "replication failures" during store operations
- Before "Failed to send store_response to afa8b3e6"
- Alongside UNMATCHED_PONG warnings

This suggests the issue is related to the store replication process, where the local node might be included in the list of nodes to replicate to.

---

## Additional Issue: Connection Count Discrepancy

### Symptom
Dashboard shows 20 connections per node, but only 17 peers exist in the network.

### Analysis
`getConnectedPeers()` in KademliaDHT.js checks two sources:
1. `this.routingTable.getAllNodes()` - nodes with connected managers
2. `this.peerNodes` Map - additional peer nodes not in routing table

If the same peer exists in both places with different manager instances, it could be counted twice.

### Potential Fix
Ensure `getConnectedPeers()` deduplicates by peer ID, not by manager instance.
