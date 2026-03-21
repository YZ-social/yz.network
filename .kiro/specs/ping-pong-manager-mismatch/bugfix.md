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
