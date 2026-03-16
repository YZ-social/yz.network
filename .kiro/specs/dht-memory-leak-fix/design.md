# DHT Memory Leak Fix Design

## Overview

This design addresses critical memory leaks and stability issues in the DHT system causing 160-186 restarts per node over ~5 days. The fix targets four root causes: uncleared interval timers, unbounded Map growth, detached DHT message handlers after restart, and stale browser peer accumulation. The approach ensures proper resource cleanup while preserving all existing maintenance functionality.

## Glossary

- **Bug_Condition (C)**: The condition that triggers memory leaks - interval timers not stored/cleared, Maps growing unbounded, handlers not reattached, stale peers accumulating
- **Property (P)**: Stable memory usage with proper cleanup of all resources on stop() and bounded Map growth during operation
- **Preservation**: All maintenance tasks continue to function normally during operation; only cleanup behavior changes
- **KademliaDHT**: The main DHT class in `src/dht/KademliaDHT.js` managing distributed hash table operations
- **OverlayNetwork**: The overlay network class in `src/network/OverlayNetwork.js` managing direct peer connections
- **RoutingTable**: The routing table class in `src/dht/RoutingTable.js` managing k-bucket peer storage
- **ConnectionManager**: Base class in `src/network/ConnectionManager.js` handling peer connections and message routing

## Bug Details

### Bug Condition

The bug manifests when DHT nodes run for extended periods (hours/days) and accumulate memory from:
1. Interval timers that are never cleared on stop()
2. Maps that grow unbounded without proper cleanup
3. DHT message handlers that are not reattached after OOM restart
4. Stale browser peer entries that accumulate in routing tables

**Formal Specification:**
```
FUNCTION isBugCondition(input)
  INPUT: input of type { operation: string, state: DHT_State }
  OUTPUT: boolean
  
  RETURN (input.operation == 'stop' AND hasUncleanedIntervalTimers(input.state))
         OR (input.operation == 'running' AND hasUnboundedMapGrowth(input.state))
         OR (input.operation == 'restart' AND hasDetachedMessageHandlers(input.state))
         OR (input.operation == 'peerDisconnect' AND hasStalePeerEntries(input.state))
END FUNCTION
```

### Examples

- `KademliaDHT.stop()` called → `republishDataTimer`, `cleanupTrackingMapsTimer`, `cleanupTimer`, `routingMaintenanceTimer`, `staleCleanupTimer` continue running
- `OverlayNetwork.stop()` called → `keepAliveTimer`, `routingCacheCleanupTimer`, `connectionHealthTimer` continue running
- Node runs for 24 hours → `pendingRequests` Map grows to thousands of entries from timed-out requests
- Node restarts after OOM → DHT messages arrive but no listeners attached, messages dropped
- Browser peer disconnects → Routing table continues connection attempts to stale entry

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- `republishData()` continues to run at configured interval during normal operation
- `cleanupTrackingMaps()` continues to run every 5 minutes during normal operation
- `maintainRoutingTableConnections()` continues to run at configured interval during normal operation
- `cleanupStaleConnections()` continues to run at configured interval during normal operation
- `sendKeepAlives()` continues to run at configured interval during normal operation
- `cleanupRoutingCache()` continues to run every 5 minutes during normal operation
- `checkConnectionHealth()` continues to run every 30 seconds during normal operation
- Valid pending requests continue to be processed correctly before timeout

**Scope:**
All inputs that do NOT involve stop(), restart, or peer disconnection should be completely unaffected by this fix. This includes:
- Normal DHT operations (store, find_node, find_value)
- Normal peer connections and message routing
- Normal maintenance task execution

## Hypothesized Root Cause

Based on the bug description, the most likely issues are:

1. **Untracked Interval Timers**: `startMaintenanceTasks()` in both `KademliaDHT` and `OverlayNetwork` call `setInterval()` without storing the returned timer IDs. The `stop()` methods cannot clear these timers because they have no references to them.

2. **Missing Timer Cleanup in stop()**: `KademliaDHT.stop()` only clears `bootstrapRetryTimer` and `refreshTimer`. It does not clear the 5 timers created in `startMaintenanceTasks()`. `OverlayNetwork.stop()` clears no timers at all.

3. **Unbounded pendingRequests Growth**: When requests timeout, the cleanup may not always remove entries from `pendingRequests` Map, causing unbounded growth.

4. **Handler Attachment Race Condition**: After OOM restart, connection managers may be recreated without the `_dhtMessageHandlerAttached` flag being properly reset, causing handlers to not be reattached.

5. **Stale Peer Accumulation**: `RoutingTable.removeStaleNodes()` uses a time-based approach but doesn't account for browser peers that disconnect without proper cleanup.

## Correctness Properties

Property 1: Bug Condition - Timer Cleanup on Stop

_For any_ call to `KademliaDHT.stop()` or `OverlayNetwork.stop()`, the fixed function SHALL clear all interval timers created by `startMaintenanceTasks()` by calling `clearInterval()` on each stored timer reference.

**Validates: Requirements 2.1, 2.2, 2.3**

Property 2: Preservation - Maintenance Tasks During Operation

_For any_ DHT node running normally (not stopped), the fixed code SHALL continue to execute all maintenance tasks (`republishData`, `cleanupTrackingMaps`, `cleanup`, `maintainRoutingTableConnections`, `cleanupStaleConnections`, `sendKeepAlives`, `cleanupRoutingCache`, `checkConnectionHealth`) at their configured intervals, preserving existing maintenance behavior.

**Validates: Requirements 3.1, 3.2, 3.3, 3.8**

Property 3: Bug Condition - Bounded Map Growth

_For any_ DHT node running for extended periods, the fixed function SHALL ensure `pendingRequests` entries are always removed on timeout, preventing unbounded Map growth.

**Validates: Requirements 2.4, 2.5**

Property 4: Preservation - Valid Request Processing

_For any_ valid pending request that receives a response before timeout, the fixed code SHALL continue to process the response correctly and resolve the request, preserving existing request/response behavior.

**Validates: Requirements 3.4, 3.5**

Property 5: Bug Condition - Handler Reattachment

_For any_ node restart after OOM, the fixed function SHALL ensure `dhtMessage` event listeners are properly attached to all connection managers, preventing message drops.

**Validates: Requirements 2.6, 2.7**

Property 6: Preservation - Normal Message Routing

_For any_ DHT message arriving during normal operation (no restart), the fixed code SHALL continue to route messages to the DHT for processing via the `dhtMessage` event, preserving existing message handling.

**Validates: Requirements 3.6**

Property 7: Bug Condition - Stale Peer Cleanup

_For any_ browser peer disconnection, the fixed function SHALL remove stale entries from the routing table and stop connection attempts to those peers.

**Validates: Requirements 2.8**

Property 8: Preservation - Active Peer Maintenance

_For any_ actively connected browser peer, the fixed code SHALL continue to maintain their routing table entries and allow message exchange, preserving existing peer management.

**Validates: Requirements 3.7**

## Fix Implementation

### Changes Required

**File**: `src/dht/KademliaDHT.js`

**Function**: `startMaintenanceTasks()`

**Specific Changes**:
1. **Store Timer References**: Store all `setInterval()` return values in instance properties:
   - `this.republishDataTimer = setInterval(...)`
   - `this.cleanupTrackingMapsTimer = setInterval(...)`
   - `this.cleanupTimer = setInterval(...)`
   - `this.routingMaintenanceTimer = setInterval(...)`
   - `this.staleCleanupTimer = setInterval(...)`

**Function**: `stop()`

**Specific Changes**:
2. **Clear All Timers**: Add cleanup for all stored timer references:
   ```javascript
   if (this.republishDataTimer) {
     clearInterval(this.republishDataTimer);
     this.republishDataTimer = null;
   }
   // ... repeat for all timers
   ```

3. **Clear DHT Offer Polling Timer**: Ensure `dhtOfferPollingInterval` is also cleared:
   ```javascript
   this.stopDHTOfferPolling();
   ```

4. **Clear Ping Maintenance Timer**: Ensure `pingMaintenanceTimer` is cleared:
   ```javascript
   if (this.pingMaintenanceTimer) {
     clearTimeout(this.pingMaintenanceTimer);
     this.pingMaintenanceTimer = null;
   }
   ```

---

**File**: `src/network/OverlayNetwork.js`

**Function**: `startMaintenanceTasks()`

**Specific Changes**:
5. **Store Timer References**: Store all `setInterval()` return values:
   - `this.keepAliveTimer = setInterval(...)`
   - `this.routingCacheCleanupTimer = setInterval(...)`
   - `this.connectionHealthTimer = setInterval(...)`

**Function**: `stop()`

**Specific Changes**:
6. **Clear All Timers**: Add cleanup for all stored timer references:
   ```javascript
   if (this.keepAliveTimer) {
     clearInterval(this.keepAliveTimer);
     this.keepAliveTimer = null;
   }
   // ... repeat for all timers
   ```

---

**File**: `src/dht/KademliaDHT.js`

**Function**: `cleanupTrackingMaps()`

**Specific Changes**:
7. **Ensure pendingRequests Cleanup**: Add explicit cleanup of timed-out `pendingRequests` entries:
   ```javascript
   // Clean up timed-out pending requests
   const requestTimeout = this.options.requestTimeout || 10000;
   for (const [requestId, request] of this.pendingRequests.entries()) {
     if (now - request.timestamp > requestTimeout * 2) {
       this.pendingRequests.delete(requestId);
       cleaned++;
     }
   }
   ```

8. **Add failedPeerQueries Cleanup**: Clean up stale entries from `failedPeerQueries`:
   ```javascript
   if (this.failedPeerQueries) {
     for (const [peerId, timestamp] of this.failedPeerQueries.entries()) {
       if (timestamp < tenMinutesAgo) {
         this.failedPeerQueries.delete(peerId);
         cleaned++;
       }
     }
   }
   ```

---

**File**: `src/network/ConnectionManager.js`

**Function**: `handleMessage()` (or new helper function)

**Specific Changes**:
9. **Add Handler Verification**: Add a method to verify and reattach handlers if needed:
   ```javascript
   ensureDHTMessageHandler() {
     if (this.listenerCount('dhtMessage') === 0) {
       console.warn(`⚠️ No DHT message handlers - triggering reattachment`);
       this.emit('handlerDetached', { manager: this });
     }
   }
   ```

---

**File**: `src/dht/RoutingTable.js`

**Function**: `removeStaleNodes()`

**Specific Changes**:
10. **Improve Stale Detection**: Add connection-based stale detection for browser peers:
    ```javascript
    removeStaleNodes(maxAge = 15 * 60 * 1000, connectionManager = null) {
      // Existing time-based removal
      // Plus: Remove nodes that are disconnected and haven't been seen recently
      if (connectionManager) {
        const connectedPeers = new Set(connectionManager.getConnectedPeers());
        // Remove nodes not in connected set and older than maxAge
      }
    }
    ```

---

**File**: `src/dht/KademliaDHT.js`

**Function**: `getOrCreatePeerNode()` or new `ensureHandlersAttached()`

**Specific Changes**:
11. **Force Handler Reattachment**: Add logic to detect and fix detached handlers:
    ```javascript
    // Check if handler is actually attached (not just flagged)
    if (peerNode.connectionManager._dhtMessageHandlerAttached) {
      const actualListeners = peerNode.connectionManager.listenerCount('dhtMessage');
      if (actualListeners === 0) {
        // Flag is stale - reset and reattach
        peerNode.connectionManager._dhtMessageHandlerAttached = false;
      }
    }
    ```

## Testing Strategy

### Validation Approach

The testing strategy follows a two-phase approach: first, surface counterexamples that demonstrate the bug on unfixed code, then verify the fix works correctly and preserves existing behavior.

### Exploratory Bug Condition Checking

**Goal**: Surface counterexamples that demonstrate the bug BEFORE implementing the fix. Confirm or refute the root cause analysis. If we refute, we will need to re-hypothesize.

**Test Plan**: Write tests that call `stop()` and verify timer cleanup, run nodes for extended periods and monitor Map sizes, simulate restarts and verify handler attachment.

**Test Cases**:
1. **Timer Leak Test**: Call `KademliaDHT.stop()` and verify all interval timers are cleared (will fail on unfixed code - timers continue running)
2. **OverlayNetwork Timer Test**: Call `OverlayNetwork.stop()` and verify all interval timers are cleared (will fail on unfixed code)
3. **Map Growth Test**: Run DHT for extended period with many timeouts and verify `pendingRequests` size is bounded (will fail on unfixed code)
4. **Handler Detachment Test**: Simulate OOM restart and verify DHT messages are processed (will fail on unfixed code - messages dropped)

**Expected Counterexamples**:
- After `stop()`, maintenance tasks continue executing
- `pendingRequests.size` grows unbounded over time
- After restart, `listenerCount('dhtMessage')` returns 0

### Fix Checking

**Goal**: Verify that for all inputs where the bug condition holds, the fixed function produces the expected behavior.

**Pseudocode:**
```
FOR ALL input WHERE isBugCondition(input) DO
  IF input.operation == 'stop' THEN
    result := stop_fixed()
    ASSERT allTimersCleared(result)
  ELSE IF input.operation == 'running' THEN
    result := runForPeriod_fixed(24_hours)
    ASSERT pendingRequests.size < MAX_BOUNDED_SIZE
  ELSE IF input.operation == 'restart' THEN
    result := restart_fixed()
    ASSERT listenerCount('dhtMessage') > 0
  ELSE IF input.operation == 'peerDisconnect' THEN
    result := handleDisconnect_fixed(peerId)
    ASSERT NOT routingTable.hasNode(peerId)
  END IF
END FOR
```

### Preservation Checking

**Goal**: Verify that for all inputs where the bug condition does NOT hold, the fixed function produces the same result as the original function.

**Pseudocode:**
```
FOR ALL input WHERE NOT isBugCondition(input) DO
  ASSERT originalFunction(input) = fixedFunction(input)
END FOR
```

**Testing Approach**: Property-based testing is recommended for preservation checking because:
- It generates many test cases automatically across the input domain
- It catches edge cases that manual unit tests might miss
- It provides strong guarantees that behavior is unchanged for all non-buggy inputs

**Test Plan**: Observe behavior on UNFIXED code first for normal DHT operations, then write property-based tests capturing that behavior.

**Test Cases**:
1. **Maintenance Task Preservation**: Verify all maintenance tasks execute at correct intervals during normal operation
2. **Request Processing Preservation**: Verify valid requests are processed correctly before timeout
3. **Message Routing Preservation**: Verify DHT messages are routed correctly during normal operation
4. **Active Peer Preservation**: Verify actively connected peers remain in routing table

### Unit Tests

- Test `KademliaDHT.stop()` clears all 5 maintenance timers plus `refreshTimer`, `bootstrapRetryTimer`, `pingMaintenanceTimer`, `dhtOfferPollingInterval`
- Test `OverlayNetwork.stop()` clears all 3 maintenance timers
- Test `pendingRequests` entries are removed on timeout
- Test `cleanupTrackingMaps()` removes orphaned entries from all Maps
- Test DHT message handlers are reattached after simulated restart
- Test stale browser peers are removed from routing table on disconnect

### Property-Based Tests

- Generate random sequences of start/stop operations and verify no timer leaks
- Generate random request/timeout patterns and verify `pendingRequests` size stays bounded
- Generate random peer connect/disconnect patterns and verify routing table stays clean
- Generate random message sequences and verify all messages are processed (no drops)

### Integration Tests

- Test full DHT lifecycle: start → run maintenance → stop → verify cleanup
- Test OOM restart scenario: start → simulate OOM → restart → verify message handling
- Test long-running stability: start → run for extended period → verify memory stable
- Test browser peer churn: connect browsers → disconnect → verify routing table cleanup
