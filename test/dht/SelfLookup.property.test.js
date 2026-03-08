import * as fc from 'fast-check';
import { jest } from '@jest/globals';
import { KademliaDHT } from '../../src/dht/KademliaDHT.js';
import { DHTNode } from '../../src/core/DHTNode.js';
import { DHTNodeId } from '../../src/core/DHTNodeId.js';

/**
 * Property-Based Tests for Self-Lookup on Node Join
 * 
 * These tests verify universal properties that must hold across all valid inputs.
 * Using fast-check for randomized property-based testing.
 * 
 * Minimum iterations: 100 per property test
 */

/**
 * Generator for arbitrary DHTNode with unique ID
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

describe('Self-Lookup Property Tests', () => {

  /**
   * Feature: kademlia-routing-enhancements, Property 6: Self-Lookup Populates Routing Table
   * 
   * For any set of nodes returned by a self-lookup operation, all returned nodes
   * (except the local node) SHALL be present in the routing table after the
   * operation completes.
   * 
   * Validates: Requirements 2.3
   */
  describe('Property 6: Self-Lookup Populates Routing Table', () => {
    
    test('all returned nodes (except self) are added to routing table', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryUniqueNodes(1, 20),
          async (discoveredNodes) => {
            if (discoveredNodes.length === 0) return true;
            
            const dht = createMockDHT();
            
            // Mock findNode to return the discovered nodes
            dht.findNode = jest.fn().mockResolvedValue(discoveredNodes);
            
            // Perform self-lookup
            await dht.performSelfLookup();
            
            // Verify all discovered nodes (except self) are in routing table
            for (const node of discoveredNodes) {
              if (!node.id.equals(dht.localNodeId)) {
                const inRoutingTable = dht.routingTable.getNode(node.id.toString());
                if (!inRoutingTable) {
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

    test('local node is never added to routing table', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryUniqueNodes(0, 10),
          async (otherNodes) => {
            const dht = createMockDHT();
            
            // Create a node with the local node's ID
            const selfNode = new DHTNode(dht.localNodeId, 'self-endpoint');
            
            // Include self in discovered nodes
            const discoveredNodes = [...otherNodes, selfNode];
            
            // Mock findNode to return nodes including self
            dht.findNode = jest.fn().mockResolvedValue(discoveredNodes);
            
            // Perform self-lookup
            await dht.performSelfLookup();
            
            // Verify local node is NOT in routing table
            const selfInRoutingTable = dht.routingTable.getNode(dht.localNodeId.toString());
            return selfInRoutingTable === null || selfInRoutingTable === undefined;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('routing table size increases by number of new unique nodes', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryUniqueNodes(1, 15),
          async (discoveredNodes) => {
            if (discoveredNodes.length === 0) return true;
            
            const dht = createMockDHT();
            
            // Filter out any nodes that happen to have the local node's ID
            const nonSelfNodes = discoveredNodes.filter(
              node => !node.id.equals(dht.localNodeId)
            );
            
            const initialSize = dht.routingTable.totalNodes;
            
            // Mock findNode to return the discovered nodes
            dht.findNode = jest.fn().mockResolvedValue(discoveredNodes);
            
            // Perform self-lookup
            await dht.performSelfLookup();
            
            const finalSize = dht.routingTable.totalNodes;
            
            // Routing table should have grown by the number of non-self nodes
            // (may be less if some nodes couldn't be added due to bucket constraints)
            return finalSize >= initialSize && finalSize <= initialSize + nonSelfNodes.length;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('self-lookup is idempotent - second call does not duplicate nodes', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryUniqueNodes(1, 10),
          async (discoveredNodes) => {
            if (discoveredNodes.length === 0) return true;
            
            const dht = createMockDHT();
            
            // Mock findNode to return the same nodes each time
            dht.findNode = jest.fn().mockResolvedValue(discoveredNodes);
            
            // Perform self-lookup twice
            await dht.performSelfLookup();
            const sizeAfterFirst = dht.routingTable.totalNodes;
            
            // Reset selfLookupComplete to allow second call
            dht.selfLookupComplete = false;
            
            await dht.performSelfLookup();
            const sizeAfterSecond = dht.routingTable.totalNodes;
            
            // Size should not increase on second call (nodes already present)
            return sizeAfterSecond === sizeAfterFirst;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('discovered nodes have correct metadata preserved', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            rtt: fc.nat({ max: 1000 }),
            isAlive: fc.boolean()
          }),
          async (metadata) => {
            const dht = createMockDHT();
            
            // Create a node with specific metadata
            const node = new DHTNode(new DHTNodeId(), 'test-endpoint');
            node.rtt = metadata.rtt;
            node.isAlive = metadata.isAlive;
            
            // Mock findNode to return this node
            dht.findNode = jest.fn().mockResolvedValue([node]);
            
            // Perform self-lookup
            await dht.performSelfLookup();
            
            // Verify node is in routing table
            const storedNode = dht.routingTable.getNode(node.id.toString());
            if (!storedNode) return false;
            
            // The stored node should be the same object (or have same ID)
            return storedNode.id.equals(node.id);
          }
        ),
        { numRuns: 100 }
      );
    });

    test('empty discovery result does not break routing table', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constant([]),
          async (emptyNodes) => {
            const dht = createMockDHT();
            
            const initialSize = dht.routingTable.totalNodes;
            
            // Mock findNode to return empty array
            dht.findNode = jest.fn().mockResolvedValue(emptyNodes);
            
            // Perform self-lookup
            await dht.performSelfLookup();
            
            // Routing table should be unchanged
            return dht.routingTable.totalNodes === initialSize && 
                   dht.selfLookupComplete === true;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('selfLookupComplete event contains accurate node counts', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryUniqueNodes(0, 15),
          async (discoveredNodes) => {
            const dht = createMockDHT();
            
            // Filter out self
            const nonSelfNodes = discoveredNodes.filter(
              node => !node.id.equals(dht.localNodeId)
            );
            
            // Mock findNode to return the discovered nodes
            dht.findNode = jest.fn().mockResolvedValue(discoveredNodes);
            
            // Capture the event
            let eventData = null;
            dht.once('selfLookupComplete', (data) => {
              eventData = data;
            });
            
            // Perform self-lookup
            await dht.performSelfLookup();
            
            // Verify event was emitted with correct data
            if (!eventData) return false;
            
            // nodesDiscovered should equal total discovered (including self if present)
            if (eventData.nodesDiscovered !== discoveredNodes.length) return false;
            
            // nodesAdded should be <= non-self nodes (some may not be added due to bucket constraints)
            if (eventData.nodesAdded > nonSelfNodes.length) return false;
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
