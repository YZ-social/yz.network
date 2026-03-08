# Implementation Plan: Kademlia Routing Enhancements

## Overview

This implementation plan covers six Kademlia DHT enhancements: replacement caches for k-buckets, self-lookup on node join, proximity routing, recursive routing mode, proximity neighbor selection (PNS), and liveness over proximity enforcement. Tasks are ordered to build incrementally, with foundational changes (KBucket) first, then KademliaDHT enhancements, and finally RoutingTable improvements.

## Tasks

- [ ] 1. Implement Replacement Cache for KBucket
  - [ ] 1.1 Add replacementCache array and helper methods to KBucket
    - Add `replacementCache = []` property to constructor
    - Implement `addToReplacementCache(node)` method with LRU eviction
    - Implement `getReplacementCache()` and `replacementCacheSize()` methods
    - Modify `addNode()` to call `addToReplacementCache()` when bucket is full
    - _Requirements: 1.1, 1.2, 1.5_

  - [ ] 1.2 Implement replacement cache promotion on node failure
    - Implement `promoteFromReplacementCache()` method (promotes most recently seen)
    - Implement `handleNodeFailure(nodeId)` method that removes failed node and promotes from cache
    - Ensure promoted node is removed from replacement cache
    - _Requirements: 1.3, 1.4_

  - [ ] 1.3 Write property tests for replacement cache (Properties 1-5)
    - **Property 1: Replacement Cache Overflow Storage** - overflow nodes go to cache
    - **Property 2: Replacement Cache Size Invariant** - cache never exceeds k entries
    - **Property 3: Replacement Cache Promotion on Failure** - most recent promoted, removed from cache
    - **Property 4: Replacement Cache LRU Ordering** - re-seen nodes move to end
    - **Property 5: Replacement Cache Prefix Isolation** - nodes stay within bucket's prefix range
    - **Validates: Requirements 1.1-1.6**

- [ ] 2. Checkpoint - Verify KBucket replacement cache
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 3. Implement Self-Lookup on Node Join
  - [ ] 3.1 Add self-lookup state and configuration to KademliaDHT
    - Add `selfLookupComplete`, `selfLookupRetries`, `maxSelfLookupRetries` properties
    - _Requirements: 2.5_

  - [ ] 3.2 Implement performSelfLookup() method
    - Call `findNode(this.localNodeId)` after bootstrap connection
    - Add all discovered nodes (except self) to routing table
    - Emit 'selfLookupComplete' event with nodesDiscovered count
    - Implement retry logic with exponential backoff (1s, 2s, 4s)
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

  - [ ] 3.3 Integrate self-lookup into start() method
    - Call `performSelfLookup()` after first bootstrap connection established
    - _Requirements: 2.2_

  - [ ] 3.4 Write unit tests for self-lookup
    - Test self-lookup triggers after bootstrap connection
    - Test 'selfLookupComplete' event emission
    - Test retry behavior with exponential backoff
    - **Validates: Requirements 2.1-2.5**

  - [ ] 3.5 Write property test for self-lookup (Property 6)
    - **Property 6: Self-Lookup Populates Routing Table** - all returned nodes added to routing table
    - **Validates: Requirements 2.3**

- [ ] 4. Implement Proximity Routing
  - [ ] 4.1 Implement selectNextHopWithProximity() method
    - Filter candidates to those that reduce XOR distance to target
    - Calculate average RTT for nodes without RTT data
    - Sort by XOR distance (primary), then RTT (secondary)
    - Return best candidate or null if none valid
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

  - [ ] 4.2 Integrate proximity routing into findNode()
    - Use `selectNextHopWithProximity()` when selecting next hop candidates
    - _Requirements: 3.1, 3.2_

  - [ ] 4.3 Write property tests for proximity routing (Properties 7-10)
    - **Property 7: XOR Distance Filtering** - selected candidate has smaller XOR distance than local
    - **Property 8: RTT Tie-Breaking** - lowest RTT selected among equal XOR distance
    - **Property 9: Default RTT for Unknown Nodes** - unknown RTT treated as average
    - **Property 10: XOR Distance Supremacy** - XOR-reducing candidate always selected over better-RTT non-reducing
    - **Validates: Requirements 3.1-3.5**

- [ ] 5. Checkpoint - Verify proximity routing
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 6. Implement Recursive Routing Mode
  - [ ] 6.1 Add recursive routing configuration to KademliaDHT
    - Add `routingMode` option (default: 'recursive')
    - Add `maxRecursiveHops` constant (20)
    - _Requirements: 4.7, 4.8_

  - [ ] 6.2 Implement handleRecursiveFindNode() method
    - Parse target, requestId, hopCount, originatorId from message
    - Check hop limit and return closest nodes if exceeded
    - Find closer connected peers using proximity routing
    - Forward to next hop with incremented hopCount
    - Verify XOR distance strictly decreases before forwarding
    - _Requirements: 4.2, 4.3, 4.4, 4.5_

  - [ ] 6.3 Implement sendRecursiveResponse() method
    - Send response back to originator with closest nodes found
    - Use overlay routing if originator not directly connected
    - _Requirements: 4.6_

  - [ ] 6.4 Implement handleRecursiveFindNodeResponse() method
    - Process response from recursive query
    - Add discovered nodes to routing table
    - _Requirements: 4.6_

  - [ ] 6.5 Integrate recursive message handling into handlePeerMessage()
    - Add cases for 'recursive_find_node' and 'recursive_find_node_response'
    - _Requirements: 4.1, 4.2_

  - [ ] 6.6 Write property tests for recursive routing (Properties 11-15)
    - **Property 11: Recursive Forwarding** - request forwarded to closer peer if exists
    - **Property 12: Strict XOR Distance Reduction** - next hop strictly closer than current
    - **Property 13: Hop Counter Presence** - message contains hopCount field
    - **Property 14: Maximum Hop Limit** - no forwarding when hopCount >= 20
    - **Property 15: Recursive Termination** - closest nodes returned when no closer peer
    - **Validates: Requirements 4.2-4.6**

  - [ ] 6.7 Write unit tests for recursive routing configuration
    - Test routingMode option works
    - Test default is 'recursive'
    - **Validates: Requirements 4.7, 4.8**

- [ ] 7. Checkpoint - Verify recursive routing
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 8. Implement Proximity Neighbor Selection (PNS) in RoutingTable
  - [ ] 8.1 Add PNS configuration to RoutingTable
    - Add `pnsEnabled` option (default: false)
    - Add `pnsProbeInterval` option (default: 60000ms)
    - _Requirements: 5.5, 5.6_

  - [ ] 8.2 Implement rankBucketByRTT() method
    - Sort bucket nodes by RTT (ascending) when PNS enabled
    - Preserve liveness priority (live nodes before dead nodes)
    - _Requirements: 5.1_

  - [ ] 8.3 Implement performPNSProbes() method
    - Probe nodes without recent RTT data (limited to 3 per bucket)
    - Re-rank bucket after probes complete
    - _Requirements: 5.2_

  - [ ] 8.4 Integrate PNS ranking into addNode()
    - Call `rankBucketByRTT()` after adding node when PNS enabled
    - _Requirements: 5.1_

  - [ ] 8.5 Write property tests for PNS (Properties 16-18)
    - **Property 16: PNS Bucket RTT Ordering** - nodes ordered by RTT when PNS enabled
    - **Property 17: Bucket Structure Immutability** - bucket count/prefix unchanged by RTT updates
    - **Property 18: XOR Distance Priority Over RTT** - worse XOR never replaces better XOR
    - **Validates: Requirements 5.1, 5.3, 5.4**

  - [ ] 8.6 Write unit tests for PNS configuration
    - Test pnsEnabled defaults to false
    - Test pnsEnabled option works
    - Test limited probe behavior
    - **Validates: Requirements 5.5, 5.6, 5.2**

- [ ] 9. Implement Liveness Over Proximity Enforcement
  - [ ] 9.1 Implement isNodeLive() method in RoutingTable
    - Check isAlive flag AND lastSeen within ping interval (5 minutes)
    - _Requirements: 6.1, 6.2, 6.3_

  - [ ] 9.2 Implement shouldReplaceNode() method
    - Never replace live node with unknown-liveness candidate
    - Never replace recently-seen node regardless of RTT
    - Only replace if existing node failed liveness (failureCount >= 3)
    - _Requirements: 6.1, 6.2, 6.3_

  - [ ] 9.3 Enhance addNode() with liveness priority
    - Use `shouldReplaceNode()` before evicting bucket members
    - Promote from replacement cache before accepting new nodes
    - Add to replacement cache if all bucket nodes are live
    - _Requirements: 6.1, 6.4_

  - [ ] 9.4 Write property tests for liveness enforcement (Properties 19-22)
    - **Property 19: Liveness Priority Over RTT** - dead node evicted regardless of RTT
    - **Property 20: Live Node Protection** - unknown-liveness never replaces live node
    - **Property 21: Recently-Seen Protection** - recent node never replaced regardless of RTT
    - **Property 22: Cache Promotion Priority** - cache promotion before new node acceptance
    - **Validates: Requirements 6.1-6.4**

- [ ] 10. Final Checkpoint - Full integration verification
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 11. Integration wiring and final cleanup
  - [ ] 11.1 Wire KBucket replacement cache into RoutingTable
    - Update RoutingTable to use KBucket.handleNodeFailure() on liveness failures
    - Ensure bucket operations use replacement cache properly
    - _Requirements: 1.3, 6.4_

  - [ ] 11.2 Wire self-lookup and proximity routing together
    - Ensure self-lookup uses proximity routing for next-hop selection
    - _Requirements: 2.1, 3.1_

  - [ ] 11.3 Write integration tests
    - Test end-to-end recursive routing across multiple nodes
    - Test self-lookup network convergence
    - Test replacement cache under node churn
    - Test PNS ranking stability under RTT updates
    - **Validates: Requirements 1.1-6.5**

- [ ] 12. Final Checkpoint - All tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The implementation builds incrementally: KBucket → KademliaDHT → RoutingTable
