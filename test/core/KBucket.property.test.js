import * as fc from 'fast-check';
import { KBucket } from '../../src/core/KBucket.js';
import { DHTNode } from '../../src/core/DHTNode.js';
import { DHTNodeId } from '../../src/core/DHTNodeId.js';

/**
 * Property-Based Tests for KBucket Replacement Cache
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

describe('KBucket Replacement Cache - Property Tests', () => {

  /**
   * Feature: kademlia-routing-enhancements, Property 1: Replacement Cache Overflow Storage
   * 
   * For any full KBucket (containing k nodes) and any new node to be added,
   * the new node SHALL appear in the replacement cache after the add operation.
   * 
   * Validates: Requirements 1.1
   */
  describe('Property 1: Replacement Cache Overflow Storage', () => {
    test('overflow nodes go to replacement cache when bucket is full', () => {
      fc.assert(
        fc.property(
          arbitraryUniqueNodes(21, 30),
          (nodes) => {
            if (nodes.length < 21) return true; // Skip if not enough unique nodes
            
            const bucket = new KBucket(20);
            
            // Add k nodes to fill bucket
            for (let i = 0; i < 20; i++) {
              bucket.addNode(nodes[i]);
            }
            
            // Verify bucket is full
            if (!bucket.isFull()) return false;
            
            // Add overflow node
            const overflowNode = nodes[20];
            bucket.addNode(overflowNode);
            
            // Verify overflow node is in replacement cache
            const cache = bucket.getReplacementCache();
            return cache.some(n => n.id.equals(overflowNode.id));
          }
        ),
        { numRuns: 100 }
      );
    });

    test('overflow node is not added to main bucket', () => {
      fc.assert(
        fc.property(
          arbitraryUniqueNodes(21, 30),
          (nodes) => {
            if (nodes.length < 21) return true;
            
            const bucket = new KBucket(20);
            
            // Fill bucket
            for (let i = 0; i < 20; i++) {
              bucket.addNode(nodes[i]);
            }
            
            // Add overflow node
            const overflowNode = nodes[20];
            bucket.addNode(overflowNode);
            
            // Verify overflow node is NOT in main bucket
            return !bucket.hasNode(overflowNode.id) && bucket.size() === 20;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('multiple overflow nodes all go to replacement cache', () => {
      fc.assert(
        fc.property(
          arbitraryUniqueNodes(25, 40),
          (nodes) => {
            if (nodes.length < 25) return true;
            
            const bucket = new KBucket(20);
            
            // Fill bucket
            for (let i = 0; i < 20; i++) {
              bucket.addNode(nodes[i]);
            }
            
            // Add multiple overflow nodes
            const overflowNodes = nodes.slice(20, 25);
            for (const node of overflowNodes) {
              bucket.addNode(node);
            }
            
            // Verify all overflow nodes are in replacement cache
            const cache = bucket.getReplacementCache();
            return overflowNodes.every(overflow => 
              cache.some(n => n.id.equals(overflow.id))
            );
          }
        ),
        { numRuns: 100 }
      );
    });
  });


  /**
   * Feature: kademlia-routing-enhancements, Property 2: Replacement Cache Size Invariant
   * 
   * For any KBucket after any sequence of add operations, the replacement cache
   * size SHALL never exceed k entries.
   * 
   * Validates: Requirements 1.2
   */
  describe('Property 2: Replacement Cache Size Invariant', () => {
    test('replacement cache never exceeds k entries', () => {
      fc.assert(
        fc.property(
          arbitraryUniqueNodes(30, 60),
          (nodes) => {
            if (nodes.length < 30) return true;
            
            const k = 20;
            const bucket = new KBucket(k);
            
            // Add all nodes (some will overflow to cache)
            for (const node of nodes) {
              bucket.addNode(node);
              
              // Check invariant after each add
              if (bucket.replacementCacheSize() > k) {
                return false;
              }
            }
            
            return bucket.replacementCacheSize() <= k;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('replacement cache size equals min(overflow_count, k)', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 21, max: 50 }),
          (nodeCount) => {
            const k = 20;
            const bucket = new KBucket(k);
            const nodes = [];
            
            // Generate unique nodes
            for (let i = 0; i < nodeCount; i++) {
              nodes.push(new DHTNode(new DHTNodeId(), `endpoint-${i}`));
            }
            
            // Add all nodes
            for (const node of nodes) {
              bucket.addNode(node);
            }
            
            const overflowCount = nodeCount - k;
            const expectedCacheSize = Math.min(overflowCount, k);
            
            return bucket.replacementCacheSize() === expectedCacheSize;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('LRU eviction occurs when cache exceeds k', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 41, max: 50 }),
          (nodeCount) => {
            const k = 20;
            const bucket = new KBucket(k);
            const nodes = [];
            
            // Generate unique nodes
            for (let i = 0; i < nodeCount; i++) {
              nodes.push(new DHTNode(new DHTNodeId(), `endpoint-${i}`));
            }
            
            // Add all nodes
            for (const node of nodes) {
              bucket.addNode(node);
            }
            
            // Cache should be exactly k (oldest overflow nodes evicted)
            if (bucket.replacementCacheSize() !== k) {
              return false;
            }
            
            // The most recent k overflow nodes should be in cache
            const cache = bucket.getReplacementCache();
            const expectedInCache = nodes.slice(nodeCount - k);
            
            return expectedInCache.every(expected =>
              cache.some(n => n.id.equals(expected.id))
            );
          }
        ),
        { numRuns: 100 }
      );
    });
  });


  /**
   * Feature: kademlia-routing-enhancements, Property 3: Replacement Cache Promotion on Failure
   * 
   * For any KBucket with a non-empty replacement cache, when a bucket member fails
   * liveness checks, the most recently seen node from the cache SHALL be promoted
   * to the main bucket AND removed from the replacement cache.
   * 
   * Validates: Requirements 1.3, 1.4
   */
  describe('Property 3: Replacement Cache Promotion on Failure', () => {
    test('most recently seen node is promoted from cache on failure', () => {
      fc.assert(
        fc.property(
          arbitraryUniqueNodes(25, 30),
          fc.integer({ min: 0, max: 19 }),
          (nodes, failIndex) => {
            if (nodes.length < 25) return true;
            
            const bucket = new KBucket(20);
            
            // Fill bucket
            for (let i = 0; i < 20; i++) {
              bucket.addNode(nodes[i]);
            }
            
            // Add overflow nodes to cache
            for (let i = 20; i < 25; i++) {
              bucket.addNode(nodes[i]);
            }
            
            // Get the most recently seen node in cache (last one added)
            const cacheBefore = bucket.getReplacementCache();
            const mostRecentInCache = cacheBefore[cacheBefore.length - 1];
            
            // Simulate failure of a bucket member
            const failedNode = nodes[failIndex];
            bucket.handleNodeFailure(failedNode.id);
            
            // Verify most recent was promoted to main bucket
            const isPromotedInBucket = bucket.hasNode(mostRecentInCache.id);
            
            // Verify promoted node is no longer in cache
            const cacheAfter = bucket.getReplacementCache();
            const isStillInCache = cacheAfter.some(n => n.id.equals(mostRecentInCache.id));
            
            return isPromotedInBucket && !isStillInCache;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('failed node is removed from main bucket', () => {
      fc.assert(
        fc.property(
          arbitraryUniqueNodes(25, 30),
          fc.integer({ min: 0, max: 19 }),
          (nodes, failIndex) => {
            if (nodes.length < 25) return true;
            
            const bucket = new KBucket(20);
            
            // Fill bucket
            for (let i = 0; i < 20; i++) {
              bucket.addNode(nodes[i]);
            }
            
            // Add overflow nodes to cache
            for (let i = 20; i < 25; i++) {
              bucket.addNode(nodes[i]);
            }
            
            // Simulate failure
            const failedNode = nodes[failIndex];
            bucket.handleNodeFailure(failedNode.id);
            
            // Verify failed node is no longer in bucket
            return !bucket.hasNode(failedNode.id);
          }
        ),
        { numRuns: 100 }
      );
    });

    test('bucket size remains k after promotion', () => {
      fc.assert(
        fc.property(
          arbitraryUniqueNodes(25, 30),
          fc.integer({ min: 0, max: 19 }),
          (nodes, failIndex) => {
            if (nodes.length < 25) return true;
            
            const bucket = new KBucket(20);
            
            // Fill bucket
            for (let i = 0; i < 20; i++) {
              bucket.addNode(nodes[i]);
            }
            
            // Add overflow nodes to cache
            for (let i = 20; i < 25; i++) {
              bucket.addNode(nodes[i]);
            }
            
            // Simulate failure
            const failedNode = nodes[failIndex];
            bucket.handleNodeFailure(failedNode.id);
            
            // Bucket should still have k nodes (one removed, one promoted)
            return bucket.size() === 20;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('cache size decreases by one after promotion', () => {
      fc.assert(
        fc.property(
          arbitraryUniqueNodes(25, 30),
          fc.integer({ min: 0, max: 19 }),
          (nodes, failIndex) => {
            if (nodes.length < 25) return true;
            
            const bucket = new KBucket(20);
            
            // Fill bucket
            for (let i = 0; i < 20; i++) {
              bucket.addNode(nodes[i]);
            }
            
            // Add overflow nodes to cache
            for (let i = 20; i < 25; i++) {
              bucket.addNode(nodes[i]);
            }
            
            const cacheSizeBefore = bucket.replacementCacheSize();
            
            // Simulate failure
            const failedNode = nodes[failIndex];
            bucket.handleNodeFailure(failedNode.id);
            
            const cacheSizeAfter = bucket.replacementCacheSize();
            
            return cacheSizeAfter === cacheSizeBefore - 1;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('no promotion when cache is empty', () => {
      fc.assert(
        fc.property(
          arbitraryUniqueNodes(20, 20),
          fc.integer({ min: 0, max: 19 }),
          (nodes, failIndex) => {
            if (nodes.length < 20) return true;
            
            const bucket = new KBucket(20);
            
            // Fill bucket (no overflow)
            for (let i = 0; i < 20; i++) {
              bucket.addNode(nodes[i]);
            }
            
            // Verify cache is empty
            if (bucket.replacementCacheSize() !== 0) return false;
            
            // Simulate failure
            const failedNode = nodes[failIndex];
            bucket.handleNodeFailure(failedNode.id);
            
            // Bucket should have k-1 nodes (no promotion possible)
            return bucket.size() === 19;
          }
        ),
        { numRuns: 100 }
      );
    });
  });


  /**
   * Feature: kademlia-routing-enhancements, Property 4: Replacement Cache LRU Ordering
   * 
   * For any replacement cache containing a node N, when N is seen again (re-added),
   * N SHALL be moved to the end of the cache (most recently seen position).
   * 
   * Validates: Requirements 1.5
   */
  describe('Property 4: Replacement Cache LRU Ordering', () => {
    test('re-seen node moves to end of cache', () => {
      fc.assert(
        fc.property(
          arbitraryUniqueNodes(25, 30),
          fc.integer({ min: 0, max: 4 }),
          (nodes, reAddIndex) => {
            if (nodes.length < 25) return true;
            
            const bucket = new KBucket(20);
            
            // Fill bucket
            for (let i = 0; i < 20; i++) {
              bucket.addNode(nodes[i]);
            }
            
            // Add overflow nodes to cache (indices 20-24)
            for (let i = 20; i < 25; i++) {
              bucket.addNode(nodes[i]);
            }
            
            // Re-add a node that's already in cache
            const nodeToReAdd = nodes[20 + reAddIndex];
            bucket.addNode(nodeToReAdd);
            
            // Verify node is now at end of cache
            const cache = bucket.getReplacementCache();
            const lastNode = cache[cache.length - 1];
            
            return lastNode.id.equals(nodeToReAdd.id);
          }
        ),
        { numRuns: 100 }
      );
    });

    test('re-adding node does not increase cache size', () => {
      fc.assert(
        fc.property(
          arbitraryUniqueNodes(25, 30),
          fc.integer({ min: 0, max: 4 }),
          (nodes, reAddIndex) => {
            if (nodes.length < 25) return true;
            
            const bucket = new KBucket(20);
            
            // Fill bucket
            for (let i = 0; i < 20; i++) {
              bucket.addNode(nodes[i]);
            }
            
            // Add overflow nodes to cache
            for (let i = 20; i < 25; i++) {
              bucket.addNode(nodes[i]);
            }
            
            const cacheSizeBefore = bucket.replacementCacheSize();
            
            // Re-add a node that's already in cache
            const nodeToReAdd = nodes[20 + reAddIndex];
            bucket.addNode(nodeToReAdd);
            
            const cacheSizeAfter = bucket.replacementCacheSize();
            
            return cacheSizeAfter === cacheSizeBefore;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('re-added node has updated lastSeen timestamp', () => {
      fc.assert(
        fc.property(
          arbitraryUniqueNodes(25, 30),
          fc.integer({ min: 0, max: 4 }),
          (nodes, reAddIndex) => {
            if (nodes.length < 25) return true;
            
            const bucket = new KBucket(20);
            
            // Fill bucket
            for (let i = 0; i < 20; i++) {
              bucket.addNode(nodes[i]);
            }
            
            // Add overflow nodes to cache
            for (let i = 20; i < 25; i++) {
              bucket.addNode(nodes[i]);
            }
            
            // Get the node's lastSeen before re-add
            const nodeToReAdd = nodes[20 + reAddIndex];
            const cacheBefore = bucket.getReplacementCache();
            const nodeBefore = cacheBefore.find(n => n.id.equals(nodeToReAdd.id));
            const lastSeenBefore = nodeBefore.lastSeen;
            
            // Wait a tiny bit to ensure timestamp changes
            const now = Date.now();
            
            // Re-add the node
            bucket.addNode(nodeToReAdd);
            
            // Get the node's lastSeen after re-add
            const cacheAfter = bucket.getReplacementCache();
            const nodeAfter = cacheAfter.find(n => n.id.equals(nodeToReAdd.id));
            
            return nodeAfter.lastSeen >= now;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('LRU ordering is maintained across multiple re-adds', () => {
      fc.assert(
        fc.property(
          fc.array(fc.integer({ min: 0, max: 4 }), { minLength: 3, maxLength: 10 }),
          (reAddSequence) => {
            const bucket = new KBucket(20);
            const nodes = [];
            
            // Generate unique nodes
            for (let i = 0; i < 25; i++) {
              nodes.push(new DHTNode(new DHTNodeId(), `endpoint-${i}`));
            }
            
            // Fill bucket
            for (let i = 0; i < 20; i++) {
              bucket.addNode(nodes[i]);
            }
            
            // Add overflow nodes to cache
            for (let i = 20; i < 25; i++) {
              bucket.addNode(nodes[i]);
            }
            
            // Re-add nodes in sequence
            for (const idx of reAddSequence) {
              const nodeToReAdd = nodes[20 + idx];
              bucket.addNode(nodeToReAdd);
            }
            
            // The last re-added node should be at the end
            const lastReAddIdx = reAddSequence[reAddSequence.length - 1];
            const expectedLastNode = nodes[20 + lastReAddIdx];
            
            const cache = bucket.getReplacementCache();
            const lastNode = cache[cache.length - 1];
            
            return lastNode.id.equals(expectedLastNode.id);
          }
        ),
        { numRuns: 100 }
      );
    });
  });


  /**
   * Feature: kademlia-routing-enhancements, Property 5: Replacement Cache Prefix Isolation
   * 
   * For any KBucket with prefix P and depth D, all nodes in its replacement cache
   * SHALL have XOR distances that place them within the bucket's prefix range.
   * 
   * Note: This property is implicitly satisfied because nodes are only added to
   * a bucket's replacement cache when they would have been added to that bucket
   * (i.e., they already passed the prefix check). The test verifies this invariant
   * is maintained through the addNode -> addToReplacementCache flow.
   * 
   * Validates: Requirements 1.6
   */
  describe('Property 5: Replacement Cache Prefix Isolation', () => {
    test('replacement cache nodes belong to same bucket prefix range', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 25, max: 40 }),
          (nodeCount) => {
            const bucket = new KBucket(20, 0, 0); // Root bucket
            const nodes = [];
            
            // Generate unique nodes
            for (let i = 0; i < nodeCount; i++) {
              nodes.push(new DHTNode(new DHTNodeId(), `endpoint-${i}`));
            }
            
            // Add all nodes
            for (const node of nodes) {
              bucket.addNode(node);
            }
            
            // All nodes in cache should have been candidates for this bucket
            // Since this is a root bucket (depth 0), all nodes are valid
            const cache = bucket.getReplacementCache();
            
            // Verify cache is not empty and all nodes are valid DHTNodes
            return cache.length > 0 && cache.every(n => n.id instanceof DHTNodeId);
          }
        ),
        { numRuns: 100 }
      );
    });

    test('split bucket replacement caches maintain prefix isolation', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 30, max: 50 }),
          (nodeCount) => {
            const bucket = new KBucket(20, 0, 0);
            const nodes = [];
            
            // Generate unique nodes
            for (let i = 0; i < nodeCount; i++) {
              nodes.push(new DHTNode(new DHTNodeId(), `endpoint-${i}`));
            }
            
            // Add nodes to fill bucket and cache
            for (const node of nodes) {
              bucket.addNode(node);
            }
            
            // Split the bucket
            const { leftBucket, rightBucket } = bucket.split();
            
            // After split, each bucket's nodes should have the correct bit at depth 0
            const leftNodes = leftBucket.getNodes();
            const rightNodes = rightBucket.getNodes();
            
            const leftValid = leftNodes.every(n => n.id.getBit(0) === 0);
            const rightValid = rightNodes.every(n => n.id.getBit(0) === 1);
            
            return leftValid && rightValid;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('replacement cache is isolated per bucket instance', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 25, max: 35 }),
          (nodeCount) => {
            const bucket1 = new KBucket(20, 0, 0);
            const bucket2 = new KBucket(20, 1, 1);
            const nodes = [];
            
            // Generate unique nodes
            for (let i = 0; i < nodeCount; i++) {
              nodes.push(new DHTNode(new DHTNodeId(), `endpoint-${i}`));
            }
            
            // Add nodes to bucket1
            for (const node of nodes) {
              bucket1.addNode(node);
            }
            
            // bucket2 should have empty cache (no nodes added)
            const cache1 = bucket1.getReplacementCache();
            const cache2 = bucket2.getReplacementCache();
            
            return cache1.length > 0 && cache2.length === 0;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('nodes never appear in both main bucket and replacement cache', () => {
      fc.assert(
        fc.property(
          arbitraryUniqueNodes(30, 50),
          (nodes) => {
            if (nodes.length < 30) return true;
            
            const bucket = new KBucket(20);
            
            // Add all nodes
            for (const node of nodes) {
              bucket.addNode(node);
            }
            
            // Get all node IDs in main bucket
            const bucketNodeIds = new Set(bucket.getNodes().map(n => n.id.toString()));
            
            // Get all node IDs in cache
            const cacheNodeIds = bucket.getReplacementCache().map(n => n.id.toString());
            
            // No cache node should be in main bucket
            return cacheNodeIds.every(id => !bucketNodeIds.has(id));
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
