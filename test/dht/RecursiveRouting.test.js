import { jest } from '@jest/globals';
import { KademliaDHT } from '../../src/dht/KademliaDHT.js';
import { DHTNode } from '../../src/core/DHTNode.js';
import { DHTNodeId } from '../../src/core/DHTNodeId.js';

/**
 * Unit Tests for Recursive Routing Configuration
 * 
 * Tests the recursive routing mode configuration options.
 * 
 * Validates: Requirements 4.7, 4.8
 */

describe('Recursive Routing Configuration', () => {
  let mockBootstrap;

  beforeEach(() => {
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
  });

  describe('routingMode option', () => {
    /**
     * Requirement 4.8: Default to recursive routing mode
     */
    test('should default to recursive routing mode', () => {
      const dht = new KademliaDHT({
        bootstrap: mockBootstrap,
        bootstrapServers: ['ws://localhost:8080']
      });

      expect(dht.routingMode).toBe('recursive');
    });

    /**
     * Requirement 4.7: Support configuration option for routing mode
     */
    test('should accept recursive routing mode option', () => {
      const dht = new KademliaDHT({
        bootstrap: mockBootstrap,
        bootstrapServers: ['ws://localhost:8080'],
        routingMode: 'recursive'
      });

      expect(dht.routingMode).toBe('recursive');
    });

    /**
     * Requirement 4.7: Support iterative routing mode option
     */
    test('should accept iterative routing mode option', () => {
      const dht = new KademliaDHT({
        bootstrap: mockBootstrap,
        bootstrapServers: ['ws://localhost:8080'],
        routingMode: 'iterative'
      });

      expect(dht.routingMode).toBe('iterative');
    });

    test('should preserve custom routing mode through initialization', () => {
      const dht = new KademliaDHT({
        bootstrap: mockBootstrap,
        bootstrapServers: ['ws://localhost:8080'],
        routingMode: 'iterative'
      });

      // Verify it's not overwritten
      expect(dht.routingMode).toBe('iterative');
    });
  });

  describe('maxRecursiveHops constant', () => {
    /**
     * Requirement 4.5: Maximum of 20 hops
     */
    test('should have maxRecursiveHops set to 20', () => {
      const dht = new KademliaDHT({
        bootstrap: mockBootstrap,
        bootstrapServers: ['ws://localhost:8080']
      });

      expect(dht.maxRecursiveHops).toBe(20);
    });

    test('maxRecursiveHops should be a constant (not configurable)', () => {
      const dht = new KademliaDHT({
        bootstrap: mockBootstrap,
        bootstrapServers: ['ws://localhost:8080'],
        maxRecursiveHops: 50 // Try to override
      });

      // Should still be 20 (constant, not configurable)
      expect(dht.maxRecursiveHops).toBe(20);
    });
  });

  describe('handleRecursiveFindNode method', () => {
    test('should exist on KademliaDHT instance', () => {
      const dht = new KademliaDHT({
        bootstrap: mockBootstrap,
        bootstrapServers: ['ws://localhost:8080']
      });

      expect(typeof dht.handleRecursiveFindNode).toBe('function');
    });
  });

  describe('sendRecursiveResponse method', () => {
    test('should exist on KademliaDHT instance', () => {
      const dht = new KademliaDHT({
        bootstrap: mockBootstrap,
        bootstrapServers: ['ws://localhost:8080']
      });

      expect(typeof dht.sendRecursiveResponse).toBe('function');
    });
  });

  describe('handleRecursiveFindNodeResponse method', () => {
    test('should exist on KademliaDHT instance', () => {
      const dht = new KademliaDHT({
        bootstrap: mockBootstrap,
        bootstrapServers: ['ws://localhost:8080']
      });

      expect(typeof dht.handleRecursiveFindNodeResponse).toBe('function');
    });
  });
});

describe('Recursive Routing Message Handling', () => {
  let dht;
  let mockBootstrap;

  beforeEach(() => {
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

    dht = new KademliaDHT({
      bootstrap: mockBootstrap,
      bootstrapServers: ['ws://localhost:8080']
    });
  });

  describe('handlePeerMessage routing', () => {
    test('should route recursive_find_node to handleRecursiveFindNode', async () => {
      const handleSpy = jest.spyOn(dht, 'handleRecursiveFindNode').mockResolvedValue();
      
      const message = {
        type: 'recursive_find_node',
        target: new DHTNodeId().toString(),
        requestId: 'test-123',
        hopCount: 0,
        originatorId: new DHTNodeId().toString()
      };

      // Use a valid 40-char hex peer ID
      const peerId = new DHTNodeId().toString();
      await dht.handlePeerMessage(peerId, message);

      expect(handleSpy).toHaveBeenCalledWith(peerId, message, null);
    });

    test('should route recursive_find_node_response to handleRecursiveFindNodeResponse', async () => {
      const handleSpy = jest.spyOn(dht, 'handleRecursiveFindNodeResponse').mockResolvedValue();
      
      const message = {
        type: 'recursive_find_node_response',
        requestId: 'test-123',
        nodes: [],
        lastHopId: new DHTNodeId().toString()
      };

      // Use a valid 40-char hex peer ID
      const peerId = new DHTNodeId().toString();
      await dht.handlePeerMessage(peerId, message);

      expect(handleSpy).toHaveBeenCalledWith(peerId, message);
    });
  });

  describe('handleRecursiveFindNode behavior', () => {
    test('should reject invalid hopCount', async () => {
      const sendSpy = jest.spyOn(dht, 'sendMessage').mockResolvedValue();
      
      const message = {
        type: 'recursive_find_node',
        target: new DHTNodeId().toString(),
        requestId: 'test-123',
        hopCount: -1, // Invalid
        originatorId: new DHTNodeId().toString()
      };

      await dht.handleRecursiveFindNode(new DHTNodeId().toString(), message);

      // Should not send any message for invalid hopCount
      expect(sendSpy).not.toHaveBeenCalled();
    });

    test('should use originatorId from message if provided', async () => {
      const sendSpy = jest.spyOn(dht, 'sendMessage').mockResolvedValue();
      
      const originatorId = new DHTNodeId().toString();
      dht.isPeerConnected = jest.fn().mockImplementation(peerId => 
        peerId === originatorId
      );
      
      const message = {
        type: 'recursive_find_node',
        target: new DHTNodeId().toString(),
        requestId: 'test-123',
        hopCount: 0,
        originatorId: originatorId
      };

      await dht.handleRecursiveFindNode(new DHTNodeId().toString(), message);

      // Response should be sent to originatorId
      expect(sendSpy).toHaveBeenCalledWith(
        originatorId,
        expect.objectContaining({
          type: 'recursive_find_node_response'
        })
      );
    });

    test('should fall back to peerId if originatorId not provided', async () => {
      const sendSpy = jest.spyOn(dht, 'sendMessage').mockResolvedValue();
      const senderPeerId = new DHTNodeId().toString();
      
      dht.isPeerConnected = jest.fn().mockImplementation(peerId => 
        peerId === senderPeerId
      );
      
      const message = {
        type: 'recursive_find_node',
        target: new DHTNodeId().toString(),
        requestId: 'test-123',
        hopCount: 0
        // No originatorId
      };

      await dht.handleRecursiveFindNode(senderPeerId, message);

      // Response should be sent to sender-peer (fallback)
      expect(sendSpy).toHaveBeenCalledWith(
        senderPeerId,
        expect.objectContaining({
          type: 'recursive_find_node_response'
        })
      );
    });
  });

  describe('handleRecursiveFindNodeResponse behavior', () => {
    test('should add discovered nodes to routing table', async () => {
      const addNodeSpy = jest.spyOn(dht.routingTable, 'addNode');
      
      const nodeId1 = new DHTNodeId();
      const nodeId2 = new DHTNodeId();
      
      const message = {
        type: 'recursive_find_node_response',
        requestId: 'test-123',
        nodes: [
          { id: nodeId1.toString(), endpoint: 'endpoint-1', rtt: 50, isAlive: true },
          { id: nodeId2.toString(), endpoint: 'endpoint-2', rtt: 100, isAlive: true }
        ],
        lastHopId: 'last-hop-id'
      };

      await dht.handleRecursiveFindNodeResponse('sender-peer', message);

      // Should have attempted to add both nodes
      expect(addNodeSpy).toHaveBeenCalledTimes(2);
    });

    test('should skip self node in response', async () => {
      const addNodeSpy = jest.spyOn(dht.routingTable, 'addNode');
      
      const message = {
        type: 'recursive_find_node_response',
        requestId: 'test-123',
        nodes: [
          { id: dht.localNodeId.toString(), endpoint: 'self-endpoint', rtt: 0, isAlive: true }
        ],
        lastHopId: 'last-hop-id'
      };

      await dht.handleRecursiveFindNodeResponse('sender-peer', message);

      // Should not add self
      expect(addNodeSpy).not.toHaveBeenCalled();
    });

    test('should handle empty nodes array', async () => {
      const message = {
        type: 'recursive_find_node_response',
        requestId: 'test-123',
        nodes: [],
        lastHopId: 'last-hop-id'
      };

      // Should not throw
      await expect(dht.handleRecursiveFindNodeResponse('sender-peer', message))
        .resolves.not.toThrow();
    });

    test('should handle missing nodes array', async () => {
      const message = {
        type: 'recursive_find_node_response',
        requestId: 'test-123',
        lastHopId: 'last-hop-id'
        // No nodes array
      };

      // Should not throw
      await expect(dht.handleRecursiveFindNodeResponse('sender-peer', message))
        .resolves.not.toThrow();
    });

    test('should resolve pending request if exists', async () => {
      const resolveCallback = jest.fn();
      const requestId = 'pending-request-123';
      
      // Set up pending request
      dht.pendingRequests.set(requestId, {
        resolve: resolveCallback,
        reject: jest.fn(),
        timeout: setTimeout(() => {}, 10000)
      });

      const nodeId = new DHTNodeId();
      const message = {
        type: 'recursive_find_node_response',
        requestId: requestId,
        nodes: [
          { id: nodeId.toString(), endpoint: 'endpoint-1', rtt: 50, isAlive: true }
        ],
        lastHopId: 'last-hop-id'
      };

      await dht.handleRecursiveFindNodeResponse('sender-peer', message);

      // Should have resolved the pending request
      expect(resolveCallback).toHaveBeenCalled();
      expect(dht.pendingRequests.has(requestId)).toBe(false);
    });
  });
});
