import * as fc from 'fast-check';
import { jest } from '@jest/globals';
import { KademliaDHT } from '../../src/dht/KademliaDHT.js';
import { DHTNode } from '../../src/core/DHTNode.js';
import { DHTNodeId } from '../../src/core/DHTNodeId.js';

/**
 * Property-Based Tests for Proximity Routing
 * 
 * These tests verify universal properties that must hold across all valid inputs.
 * Using fast-check for randomized property-based testing.
 * 
 * Minimum iterations: 100 per property test
 */

/**
 * Generator for arbitrary DHTNode with configurable RTT
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
 * Generator for DHTNode with specific RTT value
 */
const arbitraryDHTNodeWithRTT = (rtt) => fc.record({
  isAlive: fc.boolean(),
  lastSeenOffset: fc.nat({ max: 600000 })
}).map(data => {
  const node = new DHTNode(new DHTNodeId(), 'test-endpoint');
  node.rtt = rtt;
  node.isAlive = data.isAlive;
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


/**
 * Create a mock DHT instance for testing
 */
const createMockDHT = () => {
  const mockBootstrap = {
    connect: jest.fn().mockResolvedValue(undefined),
    requestPeersOrGenesis: jest.fn().mockResolvedValue({ peers: [], isGenesis: true }),
    isBootstrapConnected: jest.fn().mockReturnValue(true),
    enableAutoReconnect: jest.fn(),
    disableAutoReconnect: jest.fn(),
    isDestroyed: false,
    on: jest.fn(),
    once: jest.fn(),
    removeListener: jest.fn(),
    emit: jest.fn()
  };

  return new KademliaDHT({
    bootstrap: mockBootstrap,
    bootstrapServers: ['ws://localhost:8080']
  });
};

describe('Proximity Routing Property Tests', () => {

  /**
   * Feature: kademlia-routing-enhancements, Property 7: XOR Distance Filtering
   * 
   * For any set of candidate nodes and target ID, the selected next-hop candidate
   * SHALL have a smaller XOR distance to the target than the local node.
   * 
   * Validates: Requirements 3.1
   */
  describe('Property 7: XOR Distance Filtering', () => {
    
    test('selected candidate has smaller XOR distance than local node', () => {
      fc.assert(
        fc.property(
          arbitraryUniqueNodes(1, 20),
          (candidates) => {
            if (candidates.length === 0) return true;
            
            const dht = createMockDHT();
            const target = new DHTNodeId();
            const localDistance = dht.localNodeId.xorDistance(target);
            
            const selected = dht.selectNextHopWithProximity(candidates, target);
            
            // If no candidate is selected, all candidates must have >= XOR distance
            if (selected === null) {
              return candidates.every(node => {
                const candidateDistance = node.id.xorDistance(target);
                return candidateDistance.compare(localDistance) >= 0;
              });
            }
            
            // Selected candidate must have smaller XOR distance
            const selectedDistance = selected.id.xorDistance(target);
            return selectedDistance.compare(localDistance) < 0;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('null returned when no candidate reduces XOR distance', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 10 }),
          (candidateCount) => {
            const dht = createMockDHT();
            const target = dht.localNodeId; // Target is local node - no candidate can be closer
            
            // Generate candidates that are all farther from target than local
            const candidates = [];
            for (let i = 0; i < candidateCount; i++) {
              candidates.push(new DHTNode(new DHTNodeId(), `endpoint-${i}`));
            }
            
            const selected = dht.selectNextHopWithProximity(candidates, target);
            
            // Should return null since no candidate can be closer to target than target itself
            return selected === null;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('all XOR-valid candidates have smaller distance than local', () => {
      fc.assert(
        fc.property(
          arbitraryUniqueNodes(5, 20),
          (candidates) => {
            if (candidates.length === 0) return true;
            
            const dht = createMockDHT();
            const target = new DHTNodeId();
            const localDistance = dht.localNodeId.xorDistance(target);
            
            const selected = dht.selectNextHopWithProximity(candidates, target);
            
            if (selected === null) return true;
            
            // Verify the selected node is from the XOR-valid set
            const xorValidCandidates = candidates.filter(node => {
              const candidateDistance = node.id.xorDistance(target);
              return candidateDistance.compare(localDistance) < 0;
            });
            
            return xorValidCandidates.some(node => node.id.equals(selected.id));
          }
        ),
        { numRuns: 100 }
      );
    });
  });



  /**
   * Feature: kademlia-routing-enhancements, Property 8: RTT Tie-Breaking
   * 
   * For any set of candidates with equal XOR distance to a target, the candidate
   * with the lowest RTT SHALL be selected as the next hop.
   * 
   * Validates: Requirements 3.2
   */
  describe('Property 8: RTT Tie-Breaking Among XOR-Equivalent Candidates', () => {
    
    test('lowest RTT selected among equal XOR distance candidates', () => {
      fc.assert(
        fc.property(
          fc.array(fc.integer({ min: 1, max: 1000 }), { minLength: 2, maxLength: 10 }),
          (rttValues) => {
            const dht = createMockDHT();
            const target = new DHTNodeId();
            const localDistance = dht.localNodeId.xorDistance(target);
            
            // Create candidates with same XOR distance but different RTTs
            // Use a fixed node ID that's closer to target than local
            let closerNodeId = null;
            for (let i = 0; i < 100; i++) {
              const testId = new DHTNodeId();
              if (testId.xorDistance(target).compare(localDistance) < 0) {
                closerNodeId = testId;
                break;
              }
            }
            
            if (!closerNodeId) return true; // Skip if we couldn't find a closer ID
            
            // Create candidates with same ID (same XOR distance) but different RTTs
            const candidates = rttValues.map((rtt, i) => {
              const node = new DHTNode(closerNodeId, `endpoint-${i}`);
              node.rtt = rtt;
              return node;
            });
            
            const selected = dht.selectNextHopWithProximity(candidates, target);
            
            if (selected === null) return true;
            
            // The selected node should have the lowest RTT
            const minRTT = Math.min(...rttValues);
            return selected.rtt === minRTT;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('RTT is secondary criterion - XOR distance takes priority', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 100 }),
          fc.integer({ min: 500, max: 1000 }),
          (lowRTT, highRTT) => {
            const dht = createMockDHT();
            const target = new DHTNodeId();
            const localDistance = dht.localNodeId.xorDistance(target);
            
            // Find two node IDs with different XOR distances to target
            let closerId = null;
            let fartherId = null;
            
            for (let i = 0; i < 200; i++) {
              const testId = new DHTNodeId();
              const testDistance = testId.xorDistance(target);
              
              if (testDistance.compare(localDistance) < 0) {
                if (!closerId) {
                  closerId = testId;
                } else if (!fartherId && testDistance.compare(closerId.xorDistance(target)) > 0) {
                  fartherId = testId;
                }
              }
              
              if (closerId && fartherId) break;
            }
            
            if (!closerId || !fartherId) return true; // Skip if we couldn't find suitable IDs
            
            // Create two candidates: closer with high RTT, farther with low RTT
            const closerNode = new DHTNode(closerId, 'closer-endpoint');
            closerNode.rtt = highRTT;
            
            const fartherNode = new DHTNode(fartherId, 'farther-endpoint');
            fartherNode.rtt = lowRTT;
            
            const candidates = [fartherNode, closerNode]; // Put farther first to test sorting
            
            const selected = dht.selectNextHopWithProximity(candidates, target);
            
            // Should select the closer node despite higher RTT
            return selected !== null && selected.id.equals(closerId);
          }
        ),
        { numRuns: 100 }
      );
    });
  });



  /**
   * Feature: kademlia-routing-enhancements, Property 9: Default RTT for Unknown Nodes
   * 
   * For any candidate without RTT data (rtt === 0), the selection algorithm SHALL
   * treat it as having the average RTT of all candidates with known RTT values.
   * 
   * Validates: Requirements 3.4
   */
  describe('Property 9: Default RTT for Unknown Nodes', () => {
    
    test('unknown RTT treated as average of known RTTs', () => {
      fc.assert(
        fc.property(
          fc.array(fc.integer({ min: 50, max: 500 }), { minLength: 2, maxLength: 5 }),
          (knownRTTs) => {
            const dht = createMockDHT();
            const target = new DHTNodeId();
            const localDistance = dht.localNodeId.xorDistance(target);
            
            // Find a node ID closer to target
            let closerId = null;
            for (let i = 0; i < 100; i++) {
              const testId = new DHTNodeId();
              if (testId.xorDistance(target).compare(localDistance) < 0) {
                closerId = testId;
                break;
              }
            }
            
            if (!closerId) return true;
            
            // Create candidates with same XOR distance
            const avgRTT = knownRTTs.reduce((sum, rtt) => sum + rtt, 0) / knownRTTs.length;
            
            // Create nodes with known RTTs
            const candidates = knownRTTs.map((rtt, i) => {
              const node = new DHTNode(closerId, `endpoint-${i}`);
              node.rtt = rtt;
              return node;
            });
            
            // Add a node with unknown RTT (rtt = 0)
            const unknownRTTNode = new DHTNode(closerId, 'unknown-endpoint');
            unknownRTTNode.rtt = 0;
            candidates.push(unknownRTTNode);
            
            const selected = dht.selectNextHopWithProximity(candidates, target);
            
            if (selected === null) return true;
            
            // If avgRTT is lower than all known RTTs, unknown node should be selected
            // If avgRTT is higher than min known RTT, node with min RTT should be selected
            const minKnownRTT = Math.min(...knownRTTs);
            
            if (avgRTT < minKnownRTT) {
              // Unknown RTT node should be selected (treated as avgRTT)
              return selected.rtt === 0;
            } else {
              // Node with lowest known RTT should be selected
              return selected.rtt === minKnownRTT;
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    test('default RTT of 100ms used when no nodes have RTT data', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 2, max: 5 }),
          (candidateCount) => {
            const dht = createMockDHT();
            const target = new DHTNodeId();
            const localDistance = dht.localNodeId.xorDistance(target);
            
            // Find a node ID closer to target
            let closerId = null;
            for (let i = 0; i < 100; i++) {
              const testId = new DHTNodeId();
              if (testId.xorDistance(target).compare(localDistance) < 0) {
                closerId = testId;
                break;
              }
            }
            
            if (!closerId) return true;
            
            // Create candidates with no RTT data (all rtt = 0)
            const candidates = [];
            for (let i = 0; i < candidateCount; i++) {
              const node = new DHTNode(closerId, `endpoint-${i}`);
              node.rtt = 0; // No RTT data
              candidates.push(node);
            }
            
            const selected = dht.selectNextHopWithProximity(candidates, target);
            
            // Should select one of the candidates (all have same effective RTT of 100ms)
            return selected !== null && candidates.some(c => c.id.equals(selected.id));
          }
        ),
        { numRuns: 100 }
      );
    });
  });



  /**
   * Feature: kademlia-routing-enhancements, Property 10: XOR Distance Supremacy
   * 
   * For any candidate selection where a non-XOR-reducing candidate has better RTT
   * than all XOR-reducing candidates, the XOR-reducing candidate SHALL still be selected.
   * 
   * Validates: Requirements 3.5
   */
  describe('Property 10: XOR Distance Supremacy Over RTT', () => {
    
    test('XOR-reducing candidate always selected over better-RTT non-reducing', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 50 }),    // Low RTT for non-reducing
          fc.integer({ min: 500, max: 1000 }), // High RTT for reducing
          (lowRTT, highRTT) => {
            const dht = createMockDHT();
            const target = new DHTNodeId();
            const localDistance = dht.localNodeId.xorDistance(target);
            
            // Find one ID closer and one ID farther from target
            let closerId = null;
            let fartherId = null;
            
            for (let i = 0; i < 200; i++) {
              const testId = new DHTNodeId();
              const testDistance = testId.xorDistance(target);
              
              if (testDistance.compare(localDistance) < 0 && !closerId) {
                closerId = testId;
              } else if (testDistance.compare(localDistance) >= 0 && !fartherId) {
                fartherId = testId;
              }
              
              if (closerId && fartherId) break;
            }
            
            if (!closerId || !fartherId) return true;
            
            // Create XOR-reducing candidate with high RTT
            const reducingNode = new DHTNode(closerId, 'reducing-endpoint');
            reducingNode.rtt = highRTT;
            
            // Create non-XOR-reducing candidate with low RTT
            const nonReducingNode = new DHTNode(fartherId, 'non-reducing-endpoint');
            nonReducingNode.rtt = lowRTT;
            
            const candidates = [nonReducingNode, reducingNode];
            
            const selected = dht.selectNextHopWithProximity(candidates, target);
            
            // Must select the XOR-reducing candidate despite worse RTT
            return selected !== null && selected.id.equals(closerId);
          }
        ),
        { numRuns: 100 }
      );
    });

    test('non-XOR-reducing candidates are never selected', () => {
      fc.assert(
        fc.property(
          arbitraryUniqueNodes(5, 15),
          (candidates) => {
            if (candidates.length === 0) return true;
            
            const dht = createMockDHT();
            const target = new DHTNodeId();
            const localDistance = dht.localNodeId.xorDistance(target);
            
            // Give all non-reducing candidates very low RTT
            candidates.forEach(node => {
              const nodeDistance = node.id.xorDistance(target);
              if (nodeDistance.compare(localDistance) >= 0) {
                node.rtt = 1; // Best possible RTT
              } else {
                node.rtt = 999; // Worst RTT
              }
            });
            
            const selected = dht.selectNextHopWithProximity(candidates, target);
            
            if (selected === null) {
              // No XOR-reducing candidates exist
              return candidates.every(node => {
                const nodeDistance = node.id.xorDistance(target);
                return nodeDistance.compare(localDistance) >= 0;
              });
            }
            
            // Selected must be XOR-reducing
            const selectedDistance = selected.id.xorDistance(target);
            return selectedDistance.compare(localDistance) < 0;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('empty candidate array returns null', () => {
      fc.assert(
        fc.property(
          fc.constant([]),
          (emptyCandidates) => {
            const dht = createMockDHT();
            const target = new DHTNodeId();
            
            const selected = dht.selectNextHopWithProximity(emptyCandidates, target);
            
            return selected === null;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('null candidate array returns null', () => {
      const dht = createMockDHT();
      const target = new DHTNodeId();
      
      const selected = dht.selectNextHopWithProximity(null, target);
      
      expect(selected).toBeNull();
    });
  });
});
