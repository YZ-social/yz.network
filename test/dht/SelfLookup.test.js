import { jest } from '@jest/globals';
import { KademliaDHT } from '../../src/dht/KademliaDHT.js';
import { DHTNode } from '../../src/core/DHTNode.js';
import { DHTNodeId } from '../../src/core/DHTNodeId.js';

/**
 * Unit Tests for Self-Lookup on Node Join
 * 
 * Tests the self-lookup functionality that populates nearby buckets
 * when a node joins the DHT network.
 * 
 * Validates: Requirements 2.1-2.5
 */

describe('Self-Lookup on Node Join', () => {
  let dht;
  let mockBootstrap;

  beforeEach(() => {
    // Create mock bootstrap client
    mockBootstrap = {
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

    // Create DHT instance with mock bootstrap
    dht = new KademliaDHT({
      bootstrap: mockBootstrap,
      bootstrapServers: ['ws://localhost:8080']
    });
  });

  afterEach(async () => {
    if (dht && dht.isStarted) {
      await dht.stop();
    }
  });

  describe('Self-lookup state initialization', () => {
    test('should initialize selfLookupComplete to false', () => {
      expect(dht.selfLookupComplete).toBe(false);
    });

    test('should initialize selfLookupRetries to 0', () => {
      expect(dht.selfLookupRetries).toBe(0);
    });

    test('should initialize maxSelfLookupRetries to 3', () => {
      expect(dht.maxSelfLookupRetries).toBe(3);
    });
  });

  describe('performSelfLookup method', () => {
    test('should skip if selfLookupComplete is true', async () => {
      dht.selfLookupComplete = true;
      const findNodeSpy = jest.spyOn(dht, 'findNode');
      
      await dht.performSelfLookup();
      
      expect(findNodeSpy).not.toHaveBeenCalled();
    });

    test('should call findNode with local node ID', async () => {
      // Mock findNode to return empty array
      dht.findNode = jest.fn().mockResolvedValue([]);
      
      await dht.performSelfLookup();
      
      expect(dht.findNode).toHaveBeenCalledWith(
        dht.localNodeId,
        expect.objectContaining({
          timeout: 15000,
          allowRouting: true
        })
      );
    });

    test('should add discovered nodes to routing table (except self)', async () => {
      // Create mock discovered nodes
      const node1 = new DHTNode(new DHTNodeId(), 'endpoint-1');
      const node2 = new DHTNode(new DHTNodeId(), 'endpoint-2');
      const selfNode = new DHTNode(dht.localNodeId, 'self-endpoint');
      
      dht.findNode = jest.fn().mockResolvedValue([node1, node2, selfNode]);
      const addNodeSpy = jest.spyOn(dht.routingTable, 'addNode');
      
      await dht.performSelfLookup();
      
      // Should add node1 and node2, but not selfNode
      expect(addNodeSpy).toHaveBeenCalledWith(node1);
      expect(addNodeSpy).toHaveBeenCalledWith(node2);
      // selfNode should not be added (filtered out)
      const selfCalls = addNodeSpy.mock.calls.filter(
        call => call[0].id.equals(dht.localNodeId)
      );
      expect(selfCalls.length).toBe(0);
    });

    test('should set selfLookupComplete to true on success', async () => {
      dht.findNode = jest.fn().mockResolvedValue([]);
      
      await dht.performSelfLookup();
      
      expect(dht.selfLookupComplete).toBe(true);
    });
  });

  describe('selfLookupComplete event emission', () => {
    test('should emit selfLookupComplete event on success', async () => {
      const node1 = new DHTNode(new DHTNodeId(), 'endpoint-1');
      dht.findNode = jest.fn().mockResolvedValue([node1]);
      
      const eventPromise = new Promise(resolve => {
        dht.once('selfLookupComplete', resolve);
      });
      
      await dht.performSelfLookup();
      
      const eventData = await eventPromise;
      expect(eventData).toHaveProperty('nodesDiscovered');
      expect(eventData.nodesDiscovered).toBe(1);
    });

    test('should emit selfLookupComplete with nodesAdded count', async () => {
      const node1 = new DHTNode(new DHTNodeId(), 'endpoint-1');
      const node2 = new DHTNode(new DHTNodeId(), 'endpoint-2');
      dht.findNode = jest.fn().mockResolvedValue([node1, node2]);
      
      const eventPromise = new Promise(resolve => {
        dht.once('selfLookupComplete', resolve);
      });
      
      await dht.performSelfLookup();
      
      const eventData = await eventPromise;
      expect(eventData).toHaveProperty('nodesAdded');
      expect(eventData.nodesAdded).toBeGreaterThanOrEqual(0);
    });

    test('should emit selfLookupComplete with failed=true after max retries', async () => {
      jest.useFakeTimers();
      
      dht.findNode = jest.fn().mockRejectedValue(new Error('Network error'));
      
      const eventPromise = new Promise(resolve => {
        dht.on('selfLookupComplete', (data) => {
          if (data.failed) resolve(data);
        });
      });
      
      // Start self-lookup (will fail)
      dht.performSelfLookup();
      
      // Fast-forward through all retries (1s, 2s, 4s backoff)
      for (let i = 0; i < 3; i++) {
        await jest.runAllTimersAsync();
      }
      
      const eventData = await eventPromise;
      expect(eventData.failed).toBe(true);
      expect(eventData.nodesDiscovered).toBe(0);
      
      jest.useRealTimers();
    });
  });

  describe('Retry behavior with exponential backoff', () => {
    test('should retry on failure with exponential backoff', async () => {
      jest.useFakeTimers();
      
      let callCount = 0;
      dht.findNode = jest.fn().mockImplementation(() => {
        callCount++;
        if (callCount < 3) {
          return Promise.reject(new Error('Network error'));
        }
        return Promise.resolve([]);
      });
      
      // Start self-lookup (async, will fail first time)
      const lookupPromise = dht.performSelfLookup();
      await lookupPromise; // Wait for first attempt to complete
      
      // First call failed, retry scheduled
      expect(dht.findNode).toHaveBeenCalledTimes(1);
      expect(dht.selfLookupRetries).toBe(1);
      
      // Advance 1 second for first retry
      await jest.advanceTimersByTimeAsync(1000);
      expect(dht.findNode).toHaveBeenCalledTimes(2);
      expect(dht.selfLookupRetries).toBe(2);
      
      // Advance 2 seconds for second retry
      await jest.advanceTimersByTimeAsync(2000);
      expect(dht.findNode).toHaveBeenCalledTimes(3);
      
      // Third call succeeds
      expect(dht.selfLookupComplete).toBe(true);
      
      jest.useRealTimers();
    });

    test('should increment selfLookupRetries on each failure', async () => {
      jest.useFakeTimers();
      
      dht.findNode = jest.fn().mockRejectedValue(new Error('Network error'));
      
      // Start self-lookup and wait for first attempt
      await dht.performSelfLookup();
      expect(dht.selfLookupRetries).toBe(1);
      
      // First retry after 1s
      await jest.advanceTimersByTimeAsync(1000);
      expect(dht.selfLookupRetries).toBe(2);
      
      // Second retry after 2s
      await jest.advanceTimersByTimeAsync(2000);
      expect(dht.selfLookupRetries).toBe(3);
      
      // No more retries after max (selfLookupComplete is set)
      await jest.advanceTimersByTimeAsync(4000);
      expect(dht.selfLookupRetries).toBe(3);
      expect(dht.selfLookupComplete).toBe(true);
      
      jest.useRealTimers();
    });

    test('should stop retrying after maxSelfLookupRetries', async () => {
      jest.useFakeTimers();
      
      dht.findNode = jest.fn().mockRejectedValue(new Error('Network error'));
      
      // Start self-lookup
      await dht.performSelfLookup();
      
      // Run through all retries
      for (let i = 0; i < 5; i++) {
        await jest.advanceTimersByTimeAsync(5000);
      }
      
      // Should have been called exactly maxSelfLookupRetries times
      expect(dht.findNode).toHaveBeenCalledTimes(dht.maxSelfLookupRetries);
      expect(dht.selfLookupComplete).toBe(true); // Marked complete to prevent further retries
      
      jest.useRealTimers();
    });

    test('should use correct backoff intervals: 1s, 2s', async () => {
      jest.useFakeTimers();
      
      const setTimeoutCalls = [];
      const originalSetTimeout = global.setTimeout;
      jest.spyOn(global, 'setTimeout').mockImplementation((fn, delay) => {
        setTimeoutCalls.push(delay);
        return originalSetTimeout(fn, delay);
      });
      
      dht.findNode = jest.fn().mockRejectedValue(new Error('Network error'));
      
      // Start self-lookup and wait for first attempt
      await dht.performSelfLookup();
      
      // Check first retry scheduled for 1s (2^0 * 1000)
      expect(setTimeoutCalls).toContain(1000);
      
      await jest.advanceTimersByTimeAsync(1000);
      
      // Check second retry scheduled for 2s (2^1 * 1000)
      expect(setTimeoutCalls).toContain(2000);
      
      // After 3rd failure (max retries), no more retries are scheduled
      // The backoff would be 4s (2^2 * 1000) but we stop at maxSelfLookupRetries=3
      
      jest.restoreAllMocks();
      jest.useRealTimers();
    });
  });
});
