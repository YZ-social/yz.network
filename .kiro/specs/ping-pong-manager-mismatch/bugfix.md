# Ping/Pong Manager Mismatch Bug

## Status: RESOLVED ✅

## Summary
Ping messages were being sent from one ConnectionManager instance, but pong responses were arriving at a DIFFERENT ConnectionManager instance that didn't have the pending request. This caused all pings to timeout even though the pongs were successfully sent and received.

## Root Cause
Two separate ping mechanisms existed with separate `pendingRequests` maps:
1. `KademliaDHT.sendPing()` - fire-and-forget, responses never tracked
2. `ConnectionManager.ping()` - tracked responses in `ConnectionManager.pendingRequests`, but pong responses arrived at different manager instances

When a peer reconnects or when incoming connections are established, multiple ConnectionManager instances could exist for the same peer. The ping was sent from one manager, but the pong arrived at a different manager that didn't have the pending request.

## Solution Implemented

### Unified Ping System
Created a single, unified ping mechanism that routes all pings through `KademliaDHT.pingPeer()`:

1. **New `KademliaDHT.pingPeer()` method** - Uses `sendRequestWithResponse()` which stores pending requests in `KademliaDHT.pendingRequests` (a single, centralized map)

2. **Ping callback mechanism** - `WebSocketConnectionManager.setPingCallback()` allows the DHT to inject its `pingPeer` method into connection managers

3. **Modified `sendPingToConnectedPeer()`** - Now uses the pingCallback instead of `ConnectionManager.ping()`

4. **Pong routing via dhtMessage** - Pong messages are emitted as `dhtMessage` events, which route to `KademliaDHT.handlePong()` where the pending request is resolved

### Key Changes
- `src/dht/KademliaDHT.js`:
  - Added `pingPeer()` method with proper response tracking and RTT recording
  - Removed deprecated `sendPing()` method
  - Added pingCallback setup in `onAttachDHTHandler` and `getOrCreatePeerNode()`
  - `handlePong()` now resolves pending requests from `KademliaDHT.pendingRequests`

- `src/network/WebSocketConnectionManager.js`:
  - Added `setPingCallback()` method
  - Modified `sendPingToConnectedPeer()` to use pingCallback

- `src/network/ConnectionManager.js`:
  - `ping()` method retained for testing but documented as not for production use
  - Removed diagnostic logging (PING_SEND, PING_SUCCESS, PING_FAIL)
  - Removed misleading UNMATCHED_PONG warnings

### Why This Works
- Single `pendingRequests` map in `KademliaDHT` (not per-manager)
- Pong responses route through `dhtMessage` event to `KademliaDHT.handlePong()`
- `handlePong()` checks `KademliaDHT.pendingRequests` and resolves the correct request
- RTT metrics are recorded in global metrics for dashboard display

## Verification
Production metrics show ping latencies being recorded correctly (1-8ms typical), confirming the unified ping system is working.

## Files Modified
- `src/dht/KademliaDHT.js`
- `src/network/WebSocketConnectionManager.js`
- `src/network/ConnectionManager.js`

## Related Issues
This was similar to the DHT handler attachment bug (`.kiro/specs/dht-handler-attachment-fix/`) where DHT message handlers were attached to the wrong manager instance.
