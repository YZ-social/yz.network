# Onboarding Helper Selection Improvements

## Problem Summary

During demo failure investigation, we found that browser clients were selected as onboarding helpers but failed to process `create_invitation_for_peer` messages. The root causes:

1. **Browser Tab Visibility**: Inactive browser tabs have slow/unreliable bootstrap reconnection
2. **5-Second Registration Timeout**: Too tight for backgrounded tabs (throttled by browser)
3. **No Tab Visibility in Metadata**: Bridge cannot see if browser tab is active when selecting helpers
4. **No Quality Filtering**: First 3 candidates selected without considering tab state or node stability

## Current Implementation (Already Completed)

### Multi-Candidate Selection with Scoring
- Select up to 3 candidates from active DHT members
- Score by uptime (1 point/min, max 60) and RTT (-1 point/100ms, max -50)
- Try candidates in order with 10s timeout
- Automatically retry next candidate if current one fails

**Location**: `src/bridge/PassiveBridgeNode.js` lines 651-759

## Proposed Enhancements

### 1. Add Tab Visibility to Browser Metadata

**File**: `src/browser/BrowserDHTClient.js` - `getBootstrapMetadata()` method

```javascript
getBootstrapMetadata() {
  return {
    ...super.getBootstrapMetadata(),
    publicKey: this.identity?.publicKey,
    verified: !!this.identity,
    tabVisible: typeof document !== 'undefined' ? !document.hidden : true  // ADD THIS
  };
}
```

This allows the bridge to see which browser tabs are currently active/visible.

### 2. Tiered Filtering Strategy

**File**: `src/bridge/PassiveBridgeNode.js` - `handleGetOnboardingPeer()` method

#### Tier 1: Hard Disqualifiers (BEFORE selecting first 3)
Filter out peers that should never be selected:

```javascript
const qualifiedPeers = activePeers.filter(peer => {
  const peerId = peer.id.toString().substring(0, 8);

  // Disqualify inactive browser tabs
  if (peer.metadata?.nodeType === 'browser' && peer.metadata?.tabVisible === false) {
    console.log(`❌ Disqualifying ${peerId} - inactive browser tab`);
    return false;
  }

  // Disqualify very new nodes (< 30 seconds uptime - might be unstable)
  const uptime = Date.now() - (peer.metadata?.startTime || Date.now());
  if (uptime < 30000) {
    console.log(`❌ Disqualifying ${peerId} - too new (${(uptime/1000).toFixed(1)}s uptime)`);
    return false;
  }

  return true;
});
```

#### Tier 2: Select 3-5 Candidates
Take first 3-5 from qualified peers (after disqualifiers applied)

#### Tier 3: Enhanced Scoring
Add node type bonus as tiebreaker:

```javascript
const scoredCandidates = candidates.map(peer => {
  // Existing uptime and RTT scoring...
  const uptimeScore = Math.min(uptimeMinutes, 60);
  const rttPenalty = Math.min(rtt / 100, 50);

  // NEW: Node type bonus (Node.js more reliable than browser)
  const nodeTypeBonus = peer.metadata?.nodeType === 'nodejs' ? 5 : 0;

  const totalScore = uptimeScore - rttPenalty + nodeTypeBonus;

  return { peer, uptimeMs, rtt, nodeType: peer.metadata?.nodeType, totalScore };
});
```

### 3. Adaptive Timeout Strategy

Different timeouts based on candidate quality and position:

```javascript
// Helper function to determine timeout per candidate
const getTimeoutForCandidate = (candidate, candidateIndex, totalCandidates) => {
  // First candidate (best scored): 10s timeout - should be reliable, fail fast
  if (candidateIndex === 0) return 10000;

  // Last resort (all others failed): Give more time if needed
  if (candidateIndex === totalCandidates - 1) {
    // Browser as last resort: 20s (may need time to wake up inactive tab)
    // Node.js as last resort: 10s (should be reliable even as backup)
    return candidate.nodeType === 'browser' ? 20000 : 10000;
  }

  // Middle candidates: Standard 10s timeout
  return 10000;
};

// Use in retry loop:
for (let i = 0; i < scoredCandidates.length; i++) {
  const candidate = scoredCandidates[i];
  const timeout = getTimeoutForCandidate(candidate, i, scoredCandidates.length);

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Helper timeout after ${timeout}ms`)), timeout)
  );

  await Promise.race([sendPromise, timeoutPromise]);
  // ... rest of retry logic
}
```

## Selection Criteria (Priority Order)

### Hard Disqualifiers (Eliminate Before Ranking)
1. ❌ Bridge nodes
2. ❌ Not connected to bridge
3. ❌ **Inactive browser tabs** (`nodeType === 'browser' && tabVisible === false`)
4. ❌ **Very new nodes** (uptime < 30 seconds)
5. ❌ **High failure rate** (future: track helper success/failure rates)

### Scoring Criteria (For Remaining Candidates)
1. **Uptime** (1 point/min, max 60 points) - Primary: stability
2. **RTT** (-1 point/100ms, max -50 penalty) - Secondary: responsiveness
3. **Node type** (+5 bonus for Node.js) - Tiebreaker: Node.js more reliable

### Timeout Strategy
- **First candidate**: 10s (best scored, should succeed quickly)
- **Middle candidates**: 10s (standard timeout)
- **Last candidate**: 20s for browser, 10s for Node.js (last resort gets more patience)

## Benefits

✅ **Inactive tabs never selected as first choice** - Better UX for new users
✅ **Node.js naturally preferred** - Higher uptime scores + node type bonus
✅ **Fast failure on good candidates** - 10s timeout for reliable helpers
✅ **Graceful degradation** - More patience (20s) for last-resort browser helpers
✅ **Scalability** - Works with 1000s of browser nodes (scoring handles it)
✅ **No hard exclusion of browsers** - They can still help, just deprioritized

## Why This Matters

### Current Problem (Demo Failure)
- 7-8 browser tabs open during demo
- Some tabs backgrounded/inactive
- Bridge selected inactive browser as helper
- Helper failed to reconnect to bootstrap within 5s
- New user stuck waiting, couldn't join
- Bad first impression

### With Enhancements
- Bridge detects inactive tabs, skips them
- Selects active browser or Node.js peer
- Helper reconnects quickly (< 5s)
- New user joins smoothly
- Good first impression

## Implementation Files

1. **`src/browser/BrowserDHTClient.js`** (lines 138-144)
   - Add `tabVisible` to `getBootstrapMetadata()`

2. **`src/bridge/PassiveBridgeNode.js`** (lines 651-759)
   - Add hard disqualifier filter before selecting candidates
   - Add node type bonus to scoring
   - Add adaptive timeout based on candidate position and type

3. **Update peer metadata handling** (if needed)
   - Ensure `tabVisible` propagates through metadata system
   - Verify metadata updates when tab visibility changes

## Testing Recommendations

1. **Multi-tab scenario**: Open 5 browser tabs, background 3, verify active ones selected first
2. **All inactive tabs**: Background all browser tabs, verify Node.js peers selected
3. **Last resort browser**: Only inactive browsers available, verify 20s timeout used
4. **Very new nodes**: Start new peer, verify it's not selected until 30s uptime
5. **Timeout cascade**: Kill first helper, verify retry to second within 10s

## Bootstrap Reconnection Timeout

**Current**: 5 seconds for registration confirmation
**Question**: Should we increase this for better reliability?

**Analysis**:
- 5s is tight for backgrounded tabs (browser throttling)
- 10s would be safer but slower failure detection
- Current fix (better selection) may be sufficient
- Can increase if still seeing issues after enhanced filtering

**Recommendation**: Keep 5s timeout, let enhanced selection do its job. Monitor after deployment.

## Open Questions

1. Should we track helper success/failure rates for future selection?
2. Should we update `tabVisible` in metadata when visibility changes (via periodic updates)?
3. Should we add retry logic at bootstrap level if helper fails?
4. Should very new nodes (< 30s) be completely disqualified or just heavily penalized in scoring?

## Next Steps

1. ✅ Implement multi-candidate selection with scoring (COMPLETED)
2. 🔄 Add `tabVisible` to browser metadata
3. 🔄 Add hard disqualifier filter (inactive tabs, new nodes)
4. 🔄 Add node type bonus to scoring
5. 🔄 Implement adaptive timeout strategy
6. 🔄 Test with multi-tab scenario
7. 🔄 Deploy and monitor helper selection success rate
