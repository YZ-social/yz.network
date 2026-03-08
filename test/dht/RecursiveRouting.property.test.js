import * as fc from 'fast-check';
import { jest } from '@jest/globals';
import { KademliaDHT } from '../../src/dht/KademliaDHT.js';
import { DHTNode } from '../../src/core/DHTNode.js';
import { DHTNodeId } from '../../src/core/DHTNodeId.js';

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

describe('Recursive Routing Property Tests', () => {
  describe('Property 11: Recursive Forwarding', () => {
    test('request forwarded to closer peer if exists', async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 1, max: 5 }), async (n) => {
          const dht = createMockDHT();
          const target = new DHTNodeId();
          const localDistance = dht.localNodeId.xorDistance(target);
          const forwardedMessages = [];
          dht.sendMessage = jest.fn().mockImplementation((peerId, message) => {
            forwardedMessages.push({ peerId, message });
            return Promise.resolve();
          });
          let closerNodeId = null;
          for (let i = 0; i < 100; i++) {
            const testId = new DHTNodeId();
            if (testId.xorDistance(target).compare(localDistance) < 0) {
              closerNodeId = testId;
              break;
            }
          }
          if (!closerNodeId) return true;
          const closerPeer = new DHTNode(closerNodeId, 'closer-endpoint');
          closerPeer.isAlive = true;
          dht.routingTable.addNode(closerPeer);
          dht.isPeerConnected = jest.fn().mockImplementation(peerId => peerId === closerNodeId.toString());
          const message = {
            type: 'recursive_find_node',
            target: target.toString(),
            requestId: 'test-1',
            hopCount: 0,
            originatorId: new DHTNodeId().toString()
          };
          await dht.handleRecursiveFindNode(new DHTNodeId().toString(), message);
          return forwardedMessages.some(m => m.peerId === closerNodeId.toString() && m.message.type === 'recursive_find_node');
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('Property 14: Maximum Hop Limit', () => {
    test('no forwarding when hopCount >= 20', async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 20, max: 50 }), async (hopCount) => {
          const dht = createMockDHT();
          const target = new DHTNodeId();
          const sentMessages = [];
          dht.sendMessage = jest.fn().mockImplementation((peerId, message) => {
            sentMessages.push({ peerId, message });
            return Promise.resolve();
          });
          const originatorId = new DHTNodeId().toString();
          dht.isPeerConnected = jest.fn().mockImplementation(peerId => peerId === originatorId);
          const message = {
            type: 'recursive_find_node',
            target: target.toString(),
            requestId: 'test-2',
            hopCount: hopCount,
            originatorId: originatorId
          };
          await dht.handleRecursiveFindNode(new DHTNodeId().toString(), message);
          const forwardedFindNode = sentMessages.find(m => m.message.type === 'recursive_find_node');
          const sentResponse = sentMessages.find(m => m.message.type === 'recursive_find_node_response');
          return forwardedFindNode === undefined && sentResponse !== undefined;
        }),
        { numRuns: 100 }
      );
    });

    test('maxRecursiveHops is exactly 20', () => {
      const dht = createMockDHT();
      expect(dht.maxRecursiveHops).toBe(20);
    });
  });

  describe('Property 15: Recursive Termination', () => {
    test('response contains requestId for correlation', async () => {
      await fc.assert(
        fc.asyncProperty(fc.string({ minLength: 8, maxLength: 32 }), async (requestId) => {
          const dht = createMockDHT();
          const target = new DHTNodeId();
          const sentMessages = [];
          dht.sendMessage = jest.fn().mockImplementation((peerId, message) => {
            sentMessages.push({ peerId, message });
            return Promise.resolve();
          });
          const originatorId = new DHTNodeId().toString();
          dht.isPeerConnected = jest.fn().mockImplementation(peerId => peerId === originatorId);
          const message = {
            type: 'recursive_find_node',
            target: target.toString(),
            requestId: requestId,
            hopCount: 0,
            originatorId: originatorId
          };
          await dht.handleRecursiveFindNode(new DHTNodeId().toString(), message);
          const sentResponse = sentMessages.find(m => m.message.type === 'recursive_find_node_response');
          if (sentResponse) {
            return sentResponse.message.requestId === requestId;
          }
          return true;
        }),
        { numRuns: 100 }
      );
    });
  });
});
