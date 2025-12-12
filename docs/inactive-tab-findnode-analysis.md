# Inactive Tab FindNode Participation Analysis

## Your Question
> If a browser is on an inactive tab, can it still participate in findNode?

## Short Answer
**IT DEPENDS** - on browser throttling behavior:

1. **If tab can still process messages** (light throttling): YES, participates normally
2. **If tab is heavily throttled** (deep sleep): NO, appears as active peer but doesn't respond
3. **Result**: Inactive tabs CAN be returned in `find_node` responses but MAY NOT process subsequent messages

---

## How FindNode Works

### Step 1: Request Sent to Connected Peer
```javascript
// Requester sends find_node to connected peer
await this.sendMessage(peerId, {
  type: 'find_node',
  target: targetId.toString(),
  requestId: requestId
});
```

### Step 2: Peer Processes Request
**File**: `src/dht/KademliaDHT.js` line 2705-2733

```javascript
async handleFindNode(peerId, message) {
  console.log(`📥 FIND_NODE: Request received from ${peerId.substring(0, 8)}...`);

  const targetId = DHTNodeId.fromString(message.target);

  // Search routing table for k-closest nodes
  const closestNodes = this.routingTable.findClosestNodes(targetId, this.options.k);

  // Send response with node list
  const response = {
    type: 'find_node_response',
    requestId: message.requestId,
    nodes: closestNodes.map(node => node.toCompact())
  };

  await this.sendMessage(peerId, response);
}
```

**Key Point**: `find_node` response contains **whatever is in the routing table**, regardless of:
- Whether those nodes are currently active
- Whether those nodes are on inactive tabs
- Whether those nodes can process messages

### Step 3: Requester Receives Response
```javascript
// Response contains list of nodes (IDs + metadata)
{
  type: 'find_node_response',
  requestId: '...',
  nodes: [
    { id: 'a1b2c3d4...', metadata: { nodeType: 'browser', tabVisible: false, ... } },
    { id: 'e5f6g7h8...', metadata: { nodeType: 'nodejs', ... } },
    ...
  ]
}
```

---

## The Problem: Stale Routing Table Entries

### Why Inactive Tabs Appear in Find_Node Results:

1. **Browser tab becomes inactive** (user switches tabs)
2. **Tab visibility changes** but node stays in other peers' routing tables
3. **Peer sends find_node request** to someone who has this node in their routing table
4. **Responder returns inactive tab** in the node list (it's in their routing table)
5. **Requester receives inactive tab** as a candidate
6. **Requester tries to use inactive tab** (onboarding, pub/sub, etc.)
7. **Message send FAILS or DELAYS** because inactive tab is throttled

### Example Scenario:
```
Time T0: Browser tab is ACTIVE
  - Participates in DHT
  - Added to many peers' routing tables
  - Metadata: { tabVisible: true }

Time T1: User switches tabs → Browser tab becomes INACTIVE
  - Tab is throttled by browser
  - Ping/pong still works (eventually) → metadata updates: { tabVisible: false }
  - Still in routing tables of other peers

Time T2: Someone calls findNode(topicID)
  - Gets response including inactive tab
  - Metadata shows: { tabVisible: false }
  - But node is in the results!

Time T3: Tries to use inactive tab as helper/initiator
  - Sends message to inactive tab
  - Message delayed or fails (browser throttling)
  - Helper/initiator doesn't respond
```

---

## Browser Throttling Behavior

### Light Throttling (Typical):
- Timers slowed down (1s → 1-2s)
- Message processing delayed (100ms → 500ms)
- **WebRTC connections still work**
- **Can process find_node requests** (eventually)
- **Can process ping/pong** (eventually)
- **Metadata updates on next ping cycle**

**Result**: Tab appears in find_node, metadata shows `tabVisible: false`, can warn before using

### Heavy Throttling (Deep Sleep):
- Browser pauses execution
- Message queue frozen
- WebRTC connections may close
- **Cannot process find_node requests**
- **Cannot process ping/pong**
- **Metadata never updates**

**Result**: Tab appears in find_node with stale metadata `tabVisible: true`, looks active but isn't

---

## Current Mitigation

### 1. Metadata Includes Tab Visibility (✅ IMPLEMENTED)
**Our recent change**: Ping/pong now carries `tabVisible` flag

```javascript
// In pong response (KademliaDHT.js line 2347)
metaFlags |= 0x01; // Bit 0 = tabVisible

// In pong handler (KademliaDHT.js line 2373)
node.metadata.tabVisible = (message.metaFlags & 0x01) !== 0;
```

**Benefit**: If inactive tab can still process pings, metadata will update and we can filter it out.

### 2. Hard Disqualifiers Filter Inactive Tabs (✅ IMPLEMENTED)
**Our recent change**: Onboarding helper selection filters out `tabVisible: false`

```javascript
// PassiveBridgeNode.js line 658
if (peer.metadata?.nodeType === 'browser' && peer.metadata?.tabVisible === false) {
  console.log(`❌ Disqualifying ${peerId} - inactive browser tab`);
  return false;
}
```

**Benefit**: Even if inactive tab appears in find_node response, we don't select it.

---

## Remaining Gap: Deeply Throttled Tabs

### Problem:
1. Tab becomes inactive (heavily throttled)
2. **Ping/pong stops working** → metadata never updates
3. **Metadata still shows `tabVisible: true`** (stale)
4. Tab appears in find_node responses as "active"
5. **We can't detect it's inactive** (stale metadata)

### Evidence This Might Happen:
- Browser DevTools shows tabs in "discarded" state
- Chrome aggressively throttles background tabs (especially mobile)
- Safari pauses inactive tabs after 30 seconds
- Edge similar behavior to Chrome

### Current State:
**We rely on pings to update metadata** - if pings stop working, metadata becomes stale.

---

## Proposed Additional Mitigations

### Option 1: Freshness Check (RECOMMENDED)

When evaluating find_node results, check how fresh the metadata is:

```javascript
// In helper/initiator selection
const now = Date.now();
const metadataAge = now - (peer.lastSeen || 0);

// Disqualify if metadata is too old (stale)
if (metadataAge > 60000) { // 60 seconds
  console.log(`❌ Disqualifying ${peerId} - stale metadata (${metadataAge}ms old)`);
  return false;
}
```

**Benefit**: Filters out deeply throttled tabs that can't update metadata
**Trade-off**: May disqualify legitimate nodes with slow ping cycles

### Option 2: Active Connection Preference

Prefer nodes we're actively connected to:

```javascript
// In helper/initiator selection
const isConnected = this.dht.isPeerConnected(peer.id.toString());

// Boost score for connected peers
const connectionBonus = isConnected ? 10 : 0;
const totalScore = uptimeScore - rttPenalty + nodeTypeBonus + connectionBonus;
```

**Benefit**: Connected nodes are definitely reachable
**Trade-off**: May create connection clustering

### Option 3: Periodic Routing Table Cleanup

More aggressive staleness removal:

```javascript
// Remove nodes that haven't been seen in 2 minutes
this.routingTable.removeStaleNodes(120000);
```

**Benefit**: Routing tables stay fresh
**Trade-off**: May remove legitimate nodes with intermittent connectivity

---

## Interaction with Our Fixes

### Our Hard Disqualifiers Work When:
✅ Inactive tab can still process pings (light throttling)
✅ Metadata updates via ping/pong
✅ `tabVisible` flag is fresh

### Our Hard Disqualifiers DON'T Work When:
❌ Inactive tab is heavily throttled (deep sleep)
❌ Pings don't get processed
❌ Metadata becomes stale (`tabVisible: true` but actually inactive)

---

## Testing Recommendations

### Test 1: Light Throttling (Should Pass)
```
1. Open browser tab
2. Join DHT
3. Switch to different tab (light throttle)
4. Wait 30 seconds (for ping cycle)
5. Check if tabVisible updates to false
6. Verify hard disqualifiers filter it out
```

**Expected**: ✅ Filter works, inactive tab not selected

### Test 2: Heavy Throttling (May Fail)
```
1. Open browser tab
2. Join DHT
3. Minimize browser window (heavy throttle)
4. Wait 30 seconds
5. Check if tabVisible updates
6. Try to use as helper/initiator
```

**Expected**: ⚠️ May appear active but fail to respond

### Test 3: Browser Discarded State
```
1. Open many tabs (force browser to discard some)
2. Check if discarded tabs removed from routing tables
3. Try to use discarded tab
```

**Expected**: ❌ Discarded tab appears in find_node but can't respond

---

## Recommendations

### Short Term (Already Done):
1. ✅ Tab visibility in metadata
2. ✅ Hard disqualifiers for inactive tabs
3. ✅ Works for light throttling

### Medium Term (Should Add):
1. **Metadata freshness check** - disqualify if `lastSeen` > 60s old
2. **Connection preference** - boost score for connected peers
3. **Apply to pub/sub** - filter initiators same as helpers

### Long Term (Nice to Have):
1. Active reachability testing before selection
2. Fallback if selected peer doesn't respond
3. Routing table cleanup based on freshness

---

## Summary

**Question**: Can inactive tabs participate in findNode?

**Answer**:
- **In Responses**: YES - inactive tabs appear in find_node results (from routing tables)
- **In Processing**: DEPENDS - light throttling allows processing, heavy throttling prevents it
- **Metadata Updates**: DEPENDS - light throttling allows ping/pong, heavy throttling blocks it

**Our Fixes Work When**: Inactive tabs can still process pings (light throttling)

**Our Fixes DON'T Work When**: Tabs are heavily throttled and can't update metadata

**Recommended Addition**: Check metadata freshness (`lastSeen`) to filter deeply throttled tabs
