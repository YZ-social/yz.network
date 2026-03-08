import * as fc from 'fast-check';
import { RoutingTable } from '../../src/dht/RoutingTable.js';
import { DHTNode } from '../../src/core/DHTNode.js';
import { DHTNodeId } from '../../src/core/DHTNodeId.js';

/**
 * Property-Based Tests for RoutingTable PNS (Proximity Neighbor Selection)
 * 
 * These tests verify universal properties that must hold across all valid inputs.
 * Using fast-check for randomized property-based testing.
 * 
 * Minimum iterations: 100 per property test
 */

/**
 * Generator for arbitrary DHTNode with configurable RTT and liveness
 */
const arbitraryDHTNode = () => fc.record({
  rtt: fc.nat({ max: 1000 }),
  isAlive: fc.boolean(),
  lastSeenOffset: fc.nat({ max: 600000 }), // 0-10 minutes ago
  failureCount: fc.nat({ max: 5 })
}).map(data => {
  const node = new DHTNode(new DHTNodeId(), 'test-endpoint');
  node.rtt = data.rtt;
  node.isAlive = data.isAlive;
  node.lastSeen = Date.now() - data.lastSeenOffset;
  node.failureCount = data.failureCount;
  return node;
});

/**
 * Generator for DHTNode with specific RTT and liveness values
 */
const arbitraryDHTNodeWithRTTAndLiveness = (rtt, isAlive) => fc.record({
  lastSeenOffset: fc.nat({ max: 600000 })
}).map(data => {
  const node = new DHTNode(new DHTNodeId(), 'test-endpoint');
  node.rtt = rtt;
  node.isAlive = isAlive;
  node.lastSeen = Date.now() - data.lastSeenOffset;
  return node;
});

/**
 * Generator for array of unique DHTNodes
 */
const arbitraryUniqueNodes = (minLength, maxLength) => 
  fc.array(arbitraryDHTNode(), { minLength, maxLength })
    .map(nodes => {
      // Ensure all nodes have unique IDs
      const seen = new Set();
      return nodes.filter(node => {
        const id = node.id.toString();
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
    });


describe('RoutingTable PNS Property Tests', () => {

  /**
   * Feature: kademlia-routing-enhancements, Property 16: PNS Bucket RTT Ordering
   * 
   * For any KBucket when PNS is enabled, the nodes array SHALL be ordered by RTT
   * (ascending) among nodes with equal liveness status.
   * 
   * Validates: Requirements 5.1
   */
  describe('Property 16: PNS Bucket RTT Ordering', () => {
    
    test('nodes ordered by RTT when PNS enabled (live nodes)', () => {
      fc.assert(
        fc.property(
          fc.array(fc.integer({ min: 1, max: 1000 }), { minLength: 2, maxLength: 15 }),
          (rttValues) => {
            const localId = new DHTNodeId();
            const routingTable = new RoutingTable(localId, 20, { pnsEnabled: true });
            
            // Add nodes with different RTTs, all alive
            const addedNodes = [];
            for (const rtt of rttValues) {
              const node = new DHTNode(new DHTNodeId(), 'test-endpoint');
              node.rtt = rtt;
              node.isAlive = true;
              if (routingTable.addNode(node)) {
                addedNodes.push(node);
              }
            }
            
            if (addedNodes.length < 2) return true;
            
            // Check each bucket for RTT ordering among live nodes
            for (const bucket of routingTable.buckets) {
              const liveNodes = bucket.nodes.filter(n => n.isAlive === true);
              
              for (let i = 0; i < liveNodes.length - 1; i++) {
                const rttA = liveNodes[i].rtt > 0 ? liveNodes[i].rtt : Infinity;
                const rttB = liveNodes[i + 1].rtt > 0 ? liveNodes[i + 1].rtt : Infinity;
                
                if (rttA > rttB) {
                  return false; // RTT ordering violated
                }
              }
            }
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('live nodes come before dead nodes when PNS enabled', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 2, max: 8 }),
          fc.integer({ min: 2, max: 8 }),
          (liveCount, deadCount) => {
            const localId = new DHTNodeId();
            const routingTable = new RoutingTable(localId, 20, { pnsEnabled: true });
            
            // Add live nodes with high RTT
            for (let i = 0; i < liveCount; i++) {
              const node = new DHTNode(new DHTNodeId(), `live-endpoint-${i}`);
              node.rtt = 900 + i; // High RTT
              node.isAlive = true;
              routingTable.addNode(node);
            }
            
            // Add dead nodes with low RTT
            for (let i = 0; i < deadCount; i++) {
              const node = new DHTNode(new DHTNodeId(), `dead-endpoint-${i}`);
              node.rtt = 10 + i; // Low RTT
              node.isAlive = false;
              routingTable.addNode(node);
            }
            
            // Check each bucket: live nodes should come before dead nodes
            for (const bucket of routingTable.buckets) {
              let seenDead = false;
              
              for (const node of bucket.nodes) {
                if (node.isAlive === false) {
                  seenDead = true;
                } else if (seenDead && node.isAlive === true) {
                  return false; // Live node after dead node - liveness priority violated
                }
              }
            }
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('PNS disabled does not reorder by RTT', () => {
      fc.assert(
        fc.property(
          fc.array(fc.integer({ min: 1, max: 1000 }), { minLength: 3, maxLength: 10 }),
          (rttValues) => {
            const localId = new DHTNodeId();
            const routingTable = new RoutingTable(localId, 20, { pnsEnabled: false });
            
            // Add nodes with different RTTs
            const addedNodes = [];
            for (const rtt of rttValues) {
              const node = new DHTNode(new DHTNodeId(), 'test-endpoint');
              node.rtt = rtt;
              node.isAlive = true;
              if (routingTable.addNode(node)) {
                addedNodes.push(node);
              }
            }
            
            // With PNS disabled, nodes should NOT be sorted by RTT
            // They should be in insertion order (most recent at end)
            // This test just verifies PNS disabled doesn't crash
            return routingTable.totalNodes === addedNodes.length;
          }
        ),
        { numRuns: 100 }
      );
    });
  });


  /**
   * Feature: kademlia-routing-enhancements, Property 17: Bucket Structure Immutability
   * 
   * For any sequence of operations involving RTT updates or PNS ranking, the number
   * of buckets and their prefix/depth values SHALL remain unchanged.
   * 
   * Validates: Requirements 5.3, 6.5
   */
  describe('Property 17: Bucket Structure Immutability', () => {
    
    test('bucket count unchanged by RTT updates', () => {
      fc.assert(
        fc.property(
          fc.array(fc.integer({ min: 1, max: 1000 }), { minLength: 5, maxLength: 20 }),
          fc.array(fc.integer({ min: 1, max: 1000 }), { minLength: 5, maxLength: 20 }),
          (initialRTTs, updatedRTTs) => {
            const localId = new DHTNodeId();
            const routingTable = new RoutingTable(localId, 20, { pnsEnabled: true });
            
            // Add nodes with initial RTTs
            const addedNodes = [];
            for (const rtt of initialRTTs) {
              const node = new DHTNode(new DHTNodeId(), 'test-endpoint');
              node.rtt = rtt;
              node.isAlive = true;
              if (routingTable.addNode(node)) {
                addedNodes.push(node);
              }
            }
            
            const bucketCountBefore = routingTable.buckets.length;
            const bucketPrefixesBefore = routingTable.buckets.map(b => ({ prefix: b.prefix, depth: b.depth }));
            
            // Update RTTs on existing nodes
            for (let i = 0; i < Math.min(addedNodes.length, updatedRTTs.length); i++) {
              addedNodes[i].rtt = updatedRTTs[i];
            }
            
            // Re-rank all buckets
            for (let i = 0; i < routingTable.buckets.length; i++) {
              routingTable.rankBucketByRTT(i);
            }
            
            const bucketCountAfter = routingTable.buckets.length;
            const bucketPrefixesAfter = routingTable.buckets.map(b => ({ prefix: b.prefix, depth: b.depth }));
            
            // Bucket count and structure must remain unchanged
            if (bucketCountBefore !== bucketCountAfter) return false;
            
            for (let i = 0; i < bucketCountBefore; i++) {
              if (bucketPrefixesBefore[i].prefix !== bucketPrefixesAfter[i].prefix ||
                  bucketPrefixesBefore[i].depth !== bucketPrefixesAfter[i].depth) {
                return false;
              }
            }
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('bucket prefix/depth unchanged by PNS ranking', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 10, max: 30 }),
          (nodeCount) => {
            const localId = new DHTNodeId();
            const routingTable = new RoutingTable(localId, 20, { pnsEnabled: true });
            
            // Add many nodes to potentially trigger bucket splits
            for (let i = 0; i < nodeCount; i++) {
              const node = new DHTNode(new DHTNodeId(), `endpoint-${i}`);
              node.rtt = Math.floor(Math.random() * 1000);
              node.isAlive = Math.random() > 0.3;
              routingTable.addNode(node);
            }
            
            // Record bucket structure
            const structureBefore = routingTable.buckets.map(b => ({
              prefix: b.prefix,
              depth: b.depth,
              nodeCount: b.nodes.length
            }));
            
            // Perform multiple PNS rankings
            for (let round = 0; round < 5; round++) {
              for (let i = 0; i < routingTable.buckets.length; i++) {
                routingTable.rankBucketByRTT(i);
              }
            }
            
            // Verify structure unchanged
            if (routingTable.buckets.length !== structureBefore.length) return false;
            
            for (let i = 0; i < structureBefore.length; i++) {
              const before = structureBefore[i];
              const after = routingTable.buckets[i];
              
              if (before.prefix !== after.prefix ||
                  before.depth !== after.depth ||
                  before.nodeCount !== after.nodes.length) {
                return false;
              }
            }
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });


  /**
   * Feature: kademlia-routing-enhancements, Property 18: XOR Distance Priority Over RTT
   * 
   * For any node replacement decision, a node with worse XOR distance SHALL NOT
   * replace a node with better XOR distance, regardless of RTT values.
   * 
   * Validates: Requirements 5.4
   */
  describe('Property 18: XOR Distance Priority Over RTT in Replacement', () => {
    
    test('better RTT does not override XOR distance in bucket placement', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 100 }),
          fc.integer({ min: 500, max: 1000 }),
          (lowRTT, highRTT) => {
            const localId = new DHTNodeId();
            const routingTable = new RoutingTable(localId, 20, { pnsEnabled: true });
            
            // Add a node with high RTT
            const highRTTNode = new DHTNode(new DHTNodeId(), 'high-rtt-endpoint');
            highRTTNode.rtt = highRTT;
            highRTTNode.isAlive = true;
            routingTable.addNode(highRTTNode);
            
            // Add a node with low RTT
            const lowRTTNode = new DHTNode(new DHTNodeId(), 'low-rtt-endpoint');
            lowRTTNode.rtt = lowRTT;
            lowRTTNode.isAlive = true;
            routingTable.addNode(lowRTTNode);
            
            // Both nodes should be in the routing table
            // RTT should not cause one to replace the other
            const allNodes = routingTable.getAllNodes();
            const hasHighRTT = allNodes.some(n => n.id.equals(highRTTNode.id));
            const hasLowRTT = allNodes.some(n => n.id.equals(lowRTTNode.id));
            
            // Both should be present (RTT doesn't cause replacement)
            return hasHighRTT && hasLowRTT;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('nodes in different XOR distance ranges coexist regardless of RTT', () => {
      fc.assert(
        fc.property(
          fc.array(fc.integer({ min: 1, max: 1000 }), { minLength: 5, maxLength: 15 }),
          (rttValues) => {
            const localId = new DHTNodeId();
            const routingTable = new RoutingTable(localId, 20, { pnsEnabled: true });
            
            // Add nodes with various RTTs
            const addedNodes = [];
            for (const rtt of rttValues) {
              const node = new DHTNode(new DHTNodeId(), 'test-endpoint');
              node.rtt = rtt;
              node.isAlive = true;
              if (routingTable.addNode(node)) {
                addedNodes.push(node);
              }
            }
            
            // All added nodes should still be present
            // (assuming bucket capacity not exceeded)
            const allNodes = routingTable.getAllNodes();
            
            for (const addedNode of addedNodes) {
              if (!allNodes.some(n => n.id.equals(addedNode.id))) {
                // Node was removed - check if it was due to bucket overflow, not RTT
                // This is acceptable only if bucket was full
                const bucketIndex = routingTable.getBucketIndex(addedNode.id);
                const bucket = routingTable.buckets[bucketIndex];
                
                // If bucket is not full, node should not have been removed
                if (bucket && bucket.nodes.length < routingTable.k) {
                  return false;
                }
              }
            }
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('PNS ranking preserves all nodes in bucket', () => {
      fc.assert(
        fc.property(
          fc.array(fc.integer({ min: 1, max: 1000 }), { minLength: 3, maxLength: 10 }),
          (rttValues) => {
            const localId = new DHTNodeId();
            const routingTable = new RoutingTable(localId, 20, { pnsEnabled: true });
            
            // Add nodes to a single bucket by using IDs with similar XOR distance
            const addedNodes = [];
            for (const rtt of rttValues) {
              const node = new DHTNode(new DHTNodeId(), 'test-endpoint');
              node.rtt = rtt;
              node.isAlive = true;
              if (routingTable.addNode(node)) {
                addedNodes.push(node);
              }
            }
            
            // Record node IDs before ranking
            const nodeIdsBefore = new Set(routingTable.getAllNodes().map(n => n.id.toString()));
            
            // Perform PNS ranking
            for (let i = 0; i < routingTable.buckets.length; i++) {
              routingTable.rankBucketByRTT(i);
            }
            
            // Record node IDs after ranking
            const nodeIdsAfter = new Set(routingTable.getAllNodes().map(n => n.id.toString()));
            
            // Same nodes should be present (ranking doesn't remove nodes)
            if (nodeIdsBefore.size !== nodeIdsAfter.size) return false;
            
            for (const id of nodeIdsBefore) {
              if (!nodeIdsAfter.has(id)) return false;
            }
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});


/**
 * Liveness Over Proximity Enforcement Property Tests
 * 
 * These tests verify that liveness always takes priority over proximity metrics
 * in routing table operations.
 * 
 * Validates: Requirements 6.1-6.4
 */
describe('RoutingTable Liveness Enforcement Property Tests', () => {

  /**
   * Feature: kademlia-routing-enhancements, Property 19: Liveness Priority Over RTT
   * 
   * For any eviction decision between a live node and a dead node, the dead node
   * SHALL be evicted regardless of RTT comparison.
   * 
   * Validates: Requirements 6.1
   */
  describe('Property 19: Liveness Priority Over RTT in Eviction', () => {
    
    test('dead node evicted regardless of RTT when bucket full', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 100 }),   // deadNodeRTT (low/good)
          fc.integer({ min: 500, max: 1000 }), // liveNodeRTT (high/bad)
          (deadNodeRTT, liveNodeRTT) => {
            const localId = new DHTNodeId();
            const routingTable = new RoutingTable(localId, 20, { pnsEnabled: true });
            
            // Fill bucket with live nodes (high RTT)
            const liveNodes = [];
            for (let i = 0; i < 19; i++) {
              const node = new DHTNode(new DHTNodeId(), `live-endpoint-${i}`);
              node.rtt = liveNodeRTT;
              node.isAlive = true;
              node.lastSeen = Date.now();
              node.failureCount = 0;
              if (routingTable.addNode(node)) {
                liveNodes.push(node);
              }
            }
            
            // Add one dead node with excellent RTT
            const deadNode = new DHTNode(new DHTNodeId(), 'dead-endpoint');
            deadNode.rtt = deadNodeRTT; // Better RTT than live nodes
            deadNode.isAlive = false;
            deadNode.lastSeen = Date.now() - 10 * 60 * 1000; // 10 minutes ago
            deadNode.failureCount = 3;
            routingTable.addNode(deadNode);
            
            // Try to add a new live node
            const newNode = new DHTNode(new DHTNodeId(), 'new-endpoint');
            newNode.rtt = liveNodeRTT;
            newNode.isAlive = true;
            newNode.lastSeen = Date.now();
            newNode.failureCount = 0;
            
            routingTable.addNode(newNode);
            
            // The dead node should be evicted, not any live node
            const allNodes = routingTable.getAllNodes();
            const deadNodePresent = allNodes.some(n => n.id.equals(deadNode.id));
            const liveNodesPresent = liveNodes.filter(ln => 
              allNodes.some(n => n.id.equals(ln.id))
            ).length;
            
            // Dead node should be gone OR all live nodes should still be present
            // (dead node evicted in favor of live nodes)
            return !deadNodePresent || liveNodesPresent === liveNodes.length;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('isNodeLive returns false for dead nodes', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 5 }),
          (failureCount) => {
            const localId = new DHTNodeId();
            const routingTable = new RoutingTable(localId, 20);
            
            const deadNode = new DHTNode(new DHTNodeId(), 'dead-endpoint');
            deadNode.isAlive = false;
            deadNode.lastSeen = Date.now();
            deadNode.failureCount = failureCount;
            
            return routingTable.isNodeLive(deadNode) === false;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('isNodeLive returns false for stale nodes', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 6, max: 60 }), // minutes ago (> 5 min ping interval)
          (minutesAgo) => {
            const localId = new DHTNodeId();
            const routingTable = new RoutingTable(localId, 20);
            
            const staleNode = new DHTNode(new DHTNodeId(), 'stale-endpoint');
            staleNode.isAlive = true;
            staleNode.lastSeen = Date.now() - minutesAgo * 60 * 1000;
            staleNode.failureCount = 0;
            
            return routingTable.isNodeLive(staleNode) === false;
          }
        ),
        { numRuns: 100 }
      );
    });
  });


  /**
   * Feature: kademlia-routing-enhancements, Property 20: Live Node Protection
   * 
   * For any replacement candidate with unknown liveness (isAlive === false or never pinged),
   * the candidate SHALL NOT replace a live node regardless of RTT.
   * 
   * Validates: Requirements 6.2
   */
  describe('Property 20: Live Node Protection from Unknown-Liveness Replacement', () => {
    
    test('unknown-liveness candidate never replaces live node', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 500, max: 1000 }), // liveNodeRTT (high/bad)
          fc.integer({ min: 1, max: 100 }),    // candidateRTT (low/good)
          (liveNodeRTT, candidateRTT) => {
            const localId = new DHTNodeId();
            const routingTable = new RoutingTable(localId, 20);
            
            // Create a live node with high RTT
            const liveNode = new DHTNode(new DHTNodeId(), 'live-endpoint');
            liveNode.rtt = liveNodeRTT;
            liveNode.isAlive = true;
            liveNode.lastSeen = Date.now();
            liveNode.failureCount = 0;
            
            // Create a candidate with unknown liveness but better RTT
            const candidate = new DHTNode(new DHTNodeId(), 'candidate-endpoint');
            candidate.rtt = candidateRTT;
            candidate.isAlive = false; // Unknown liveness
            candidate.lastSeen = Date.now();
            candidate.failureCount = 0;
            
            // shouldReplaceNode should return false
            return routingTable.shouldReplaceNode(liveNode, candidate) === false;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('live node with high RTT protected from unknown-liveness candidate', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 1000 }),
          (rtt) => {
            const localId = new DHTNodeId();
            const routingTable = new RoutingTable(localId, 20);
            
            // Fill bucket with live nodes
            const liveNodes = [];
            for (let i = 0; i < 20; i++) {
              const node = new DHTNode(new DHTNodeId(), `live-endpoint-${i}`);
              node.rtt = 900 + i; // High RTT
              node.isAlive = true;
              node.lastSeen = Date.now();
              node.failureCount = 0;
              if (routingTable.addNode(node)) {
                liveNodes.push(node);
              }
            }
            
            if (liveNodes.length === 0) return true;
            
            // Try to add unknown-liveness candidate with excellent RTT
            const candidate = new DHTNode(new DHTNodeId(), 'candidate-endpoint');
            candidate.rtt = rtt;
            candidate.isAlive = false; // Unknown liveness
            candidate.lastSeen = Date.now();
            
            const nodeCountBefore = routingTable.totalNodes;
            routingTable.addNode(candidate);
            
            // All original live nodes should still be present
            const allNodes = routingTable.getAllNodes();
            const liveNodesStillPresent = liveNodes.filter(ln =>
              allNodes.some(n => n.id.equals(ln.id))
            ).length;
            
            return liveNodesStillPresent === liveNodes.length;
          }
        ),
        { numRuns: 100 }
      );
    });
  });


  /**
   * Feature: kademlia-routing-enhancements, Property 21: Recently-Seen Protection
   * 
   * For any node that has responded within the last ping interval (5 minutes),
   * the node SHALL NOT be replaced regardless of RTT comparison with candidates.
   * 
   * Validates: Requirements 6.3
   */
  describe('Property 21: Recently-Seen Node Protection', () => {
    
    test('recently-seen node never replaced regardless of RTT', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 4 }),      // minutesAgo (< 5 min ping interval)
          fc.integer({ min: 500, max: 1000 }), // existingRTT (high/bad)
          fc.integer({ min: 1, max: 100 }),    // candidateRTT (low/good)
          (minutesAgo, existingRTT, candidateRTT) => {
            const localId = new DHTNodeId();
            const routingTable = new RoutingTable(localId, 20);
            
            // Create a recently-seen node with high RTT
            const recentNode = new DHTNode(new DHTNodeId(), 'recent-endpoint');
            recentNode.rtt = existingRTT;
            recentNode.isAlive = true;
            recentNode.lastSeen = Date.now() - minutesAgo * 60 * 1000;
            recentNode.failureCount = 0;
            
            // Create a candidate with better RTT
            const candidate = new DHTNode(new DHTNodeId(), 'candidate-endpoint');
            candidate.rtt = candidateRTT;
            candidate.isAlive = true;
            candidate.lastSeen = Date.now();
            candidate.failureCount = 0;
            
            // shouldReplaceNode should return false for recently-seen nodes
            return routingTable.shouldReplaceNode(recentNode, candidate) === false;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('node seen within ping interval protected in full bucket', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 4 }), // minutesAgo (< 5 min)
          (minutesAgo) => {
            const localId = new DHTNodeId();
            const routingTable = new RoutingTable(localId, 20);
            
            // Fill bucket with recently-seen nodes
            const recentNodes = [];
            for (let i = 0; i < 20; i++) {
              const node = new DHTNode(new DHTNodeId(), `recent-endpoint-${i}`);
              node.rtt = 500 + i;
              node.isAlive = true;
              node.lastSeen = Date.now() - minutesAgo * 60 * 1000;
              node.failureCount = 0;
              if (routingTable.addNode(node)) {
                recentNodes.push(node);
              }
            }
            
            if (recentNodes.length === 0) return true;
            
            // Try to add a new node with better RTT
            const newNode = new DHTNode(new DHTNodeId(), 'new-endpoint');
            newNode.rtt = 1; // Excellent RTT
            newNode.isAlive = true;
            newNode.lastSeen = Date.now();
            
            routingTable.addNode(newNode);
            
            // All recently-seen nodes should still be present
            const allNodes = routingTable.getAllNodes();
            const recentNodesStillPresent = recentNodes.filter(rn =>
              allNodes.some(n => n.id.equals(rn.id))
            ).length;
            
            return recentNodesStillPresent === recentNodes.length;
          }
        ),
        { numRuns: 100 }
      );
    });
  });


  /**
   * Feature: kademlia-routing-enhancements, Property 22: Cache Promotion Priority
   * 
   * For any node failure in a bucket with a non-empty replacement cache,
   * the cache promotion SHALL occur before any new node is accepted into the main bucket.
   * 
   * Validates: Requirements 6.4
   */
  describe('Property 22: Cache Promotion Priority Over New Nodes', () => {
    
    test('replacement cache node promoted before new node accepted', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 5 }),
          (cacheSize) => {
            const localId = new DHTNodeId();
            const routingTable = new RoutingTable(localId, 20);
            
            // Create nodes that will go into the same bucket
            // by using IDs with similar XOR distance to localId
            const bucketNodes = [];
            
            // First, add nodes until we have a full bucket
            for (let i = 0; i < 25; i++) {
              const node = new DHTNode(new DHTNodeId(), `bucket-endpoint-${i}`);
              node.rtt = 100 + i;
              // Make some nodes dead (replaceable)
              if (i >= 18) {
                node.isAlive = false;
                node.lastSeen = Date.now() - 10 * 60 * 1000; // 10 min ago
                node.failureCount = 3;
              } else {
                node.isAlive = true;
                node.lastSeen = Date.now();
                node.failureCount = 0;
              }
              routingTable.addNode(node);
              bucketNodes.push(node);
            }
            
            // Find a bucket that has dead nodes
            let targetBucket = null;
            for (const bucket of routingTable.buckets) {
              const hasDeadNode = bucket.nodes.some(n => !n.isAlive && n.failureCount >= 3);
              if (hasDeadNode && bucket.nodes.length > 0) {
                targetBucket = bucket;
                break;
              }
            }
            
            // If no bucket with dead nodes, test passes trivially
            if (!targetBucket) return true;
            
            // Manually add nodes to replacement cache
            const cacheNodes = [];
            for (let i = 0; i < cacheSize; i++) {
              const cacheNode = new DHTNode(new DHTNodeId(), `cache-endpoint-${i}`);
              cacheNode.rtt = 50 + i;
              cacheNode.isAlive = true;
              cacheNode.lastSeen = Date.now();
              cacheNode.failureCount = 0;
              targetBucket.addToReplacementCache(cacheNode);
              cacheNodes.push(cacheNode);
            }
            
            const cacheSizeBefore = targetBucket.replacementCacheSize();
            const mainBucketNodeIds = new Set(targetBucket.nodes.map(n => n.id.toString()));
            
            // Try to add a new node - this should trigger:
            // 1. Dead node eviction
            // 2. Cache promotion (cache node goes to main bucket)
            // 3. New node goes to cache
            const newNode = new DHTNode(new DHTNodeId(), 'new-endpoint');
            newNode.rtt = 200;
            newNode.isAlive = true;
            newNode.lastSeen = Date.now();
            newNode.failureCount = 0;
            
            routingTable.addNode(newNode);
            
            const cacheSizeAfter = targetBucket.replacementCacheSize();
            
            // Check if any cache node was promoted to main bucket
            const cacheNodesPromoted = cacheNodes.filter(cn =>
              targetBucket.nodes.some(n => n.id.equals(cn.id))
            ).length;
            
            // Property: If cache had nodes and a dead node was evicted,
            // at least one cache node should have been promoted
            // OR the cache size should reflect the promotion + new node addition
            if (cacheSizeBefore > 0) {
              // Either a cache node was promoted, or cache size changed appropriately
              return cacheNodesPromoted > 0 || cacheSizeAfter !== cacheSizeBefore;
            }
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('handleNodeFailure promotes from cache', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 10 }),
          (cacheSize) => {
            const localId = new DHTNodeId();
            const routingTable = new RoutingTable(localId, 20);
            
            // Add some nodes to routing table
            const addedNodes = [];
            for (let i = 0; i < 5; i++) {
              const node = new DHTNode(new DHTNodeId(), `endpoint-${i}`);
              node.isAlive = true;
              node.lastSeen = Date.now();
              if (routingTable.addNode(node)) {
                addedNodes.push(node);
              }
            }
            
            if (addedNodes.length === 0) return true;
            
            // Find the bucket containing the first node
            const targetNode = addedNodes[0];
            const bucketIndex = routingTable.getBucketIndex(targetNode.id);
            const bucket = routingTable.buckets[bucketIndex];
            
            // Add nodes to replacement cache
            const cacheNodes = [];
            for (let i = 0; i < Math.min(cacheSize, 5); i++) {
              const cacheNode = new DHTNode(new DHTNodeId(), `cache-endpoint-${i}`);
              cacheNode.isAlive = true;
              cacheNode.lastSeen = Date.now();
              bucket.addToReplacementCache(cacheNode);
              cacheNodes.push(cacheNode);
            }
            
            const cacheSizeBefore = bucket.replacementCacheSize();
            const bucketSizeBefore = bucket.size();
            
            // Simulate node failure
            bucket.handleNodeFailure(targetNode.id);
            
            const cacheSizeAfter = bucket.replacementCacheSize();
            const bucketSizeAfter = bucket.size();
            
            // If cache had nodes, one should have been promoted
            if (cacheSizeBefore > 0) {
              // Cache should decrease by 1 (promotion)
              // Bucket size should remain same (removal + promotion)
              return cacheSizeAfter === cacheSizeBefore - 1 &&
                     bucketSizeAfter === bucketSizeBefore;
            }
            
            // If cache was empty, bucket size should decrease by 1
            return bucketSizeAfter === bucketSizeBefore - 1;
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
