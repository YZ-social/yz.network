/**
 * Pub/Sub Integration Debug Tests
 * 
 * Focused tests for debugging specific Pub/Sub integration issues
 * without requiring full DHT network setup.
 */

import { test, expect } from '@jest/globals';
import { DHTNodeId } from '../../src/core/DHTNodeId.js';

// Mock document for tab visibility testing
global.document = {
  hidden: false,
  addEventListener: () => {},
  dispatchEvent: () => {}
};

describe('Pub/Sub Integration Debug', () => {
  test('should apply inactive tab filtering in findNode', async () => {
    // Create a mock DHT with findNode method
    const mockDHT = {
      localNodeId: new DHTNodeId(),
      options: { k: 3, alpha: 2 },
      transportOptions: { maxConnections: 50 },
      routingTable: {
        findClosestNodes: (target, limit) => {
          // Return mock nodes with different tab visibility states
          return [
            {
              id: new DHTNodeId(),
              metadata: { nodeType: 'browser', tabVisible: true }
            },
            {
              id: new DHTNodeId(), 
              metadata: { nodeType: 'browser', tabVisible: false }
            },
            {
              id: new DHTNodeId(),
              metadata: { nodeType: 'nodejs', tabVisible: true }
            }
          ].map(node => ({
            ...node,
            id: {
              ...node.id,
              toString: () => node.id.toString(),
              xorDistance: (target) => new DHTNodeId(),
              equals: (other) => false
            }
          }));
        },
        getBucketIndex: () => 0,
        getNode: (peerId) => {
          // Return mock node with metadata
          const mockNodes = {
            'browser-active': { metadata: { nodeType: 'browser', tabVisible: true } },
            'browser-inactive': { metadata: { nodeType: 'browser', tabVisible: false } },
            'nodejs-server': { metadata: { nodeType: 'nodejs', tabVisible: true } }
          };
          return mockNodes[peerId] || null;
        }
      },
      bucketLastActivity: new Map(),
      isPeerConnected: () => false,
      getConnectedPeers: () => [],
      sendFindNode: async () => ({ nodes: [] })
    };

    // Test the filtering logic directly
    const allCandidates = [
      { id: { toString: () => 'browser-active' } },
      { id: { toString: () => 'browser-inactive' } },
      { id: { toString: () => 'nodejs-server' } }
    ];

    const filterInactiveTabs = (candidates) => {
      return candidates.filter(node => {
        const peerId = node.id.toString();
        const peerNode = mockDHT.routingTable.getNode(peerId);
        
        // Node.js nodes are always active
        if (peerNode?.metadata?.nodeType === 'nodejs') {
          return true;
        }
        
        // Browser nodes: check tab visibility
        if (peerNode?.metadata?.nodeType === 'browser') {
          const tabVisible = peerNode.metadata?.tabVisible;
          if (tabVisible === false) {
            console.log(`🚫 [findNode] Excluding inactive browser tab ${peerId}`);
            return false;
          }
        }
        
        return true;
      });
    };

    const filteredCandidates = filterInactiveTabs(allCandidates);

    // Should include active browser and nodejs server, exclude inactive browser
    expect(filteredCandidates.length).toBe(2);
    expect(filteredCandidates.some(c => c.id.toString() === 'browser-active')).toBe(true);
    expect(filteredCandidates.some(c => c.id.toString() === 'nodejs-server')).toBe(true);
    expect(filteredCandidates.some(c => c.id.toString() === 'browser-inactive')).toBe(false);
  });

  test('should handle BrowserDHTClient PubSub registration', async () => {
    // Mock BrowserDHTClient with PubSub registry
    const mockClient = {
      pubsubClients: new Set(),
      savedSubscriptions: [],
      
      registerPubSubClient(pubsubClient) {
        this.pubsubClients.add(pubsubClient);
      },
      
      unregisterPubSubClient(pubsubClient) {
        this.pubsubClients.delete(pubsubClient);
      },
      
      // Simulate saving subscriptions before disconnect
      saveSubscriptions() {
        this.savedSubscriptions = [];
        
        for (const pubsubClient of this.pubsubClients) {
          const subscriptions = pubsubClient.getSubscriptions?.() || [];
          const clientSubscriptions = subscriptions.map(sub => ({
            topicID: sub.topicID,
            listeners: pubsubClient.listeners?.(sub.topicID) || [],
            clientId: pubsubClient.nodeID
          }));
          this.savedSubscriptions.push(...clientSubscriptions);
        }
        
        return this.savedSubscriptions.length;
      }
    };

    // Mock PubSubClient
    const mockPubSubClient = {
      nodeID: 'test-node-123',
      getSubscriptions: () => [
        { topicID: 'topic1' },
        { topicID: 'topic2' }
      ],
      listeners: (topic) => [`listener-${topic}-1`, `listener-${topic}-2`],
      subscribe: async (topic) => {},
      on: (topic, listener) => {}
    };

    // Test registration
    mockClient.registerPubSubClient(mockPubSubClient);
    expect(mockClient.pubsubClients.size).toBe(1);
    expect(mockClient.pubsubClients.has(mockPubSubClient)).toBe(true);

    // Test subscription saving
    const savedCount = mockClient.saveSubscriptions();
    expect(savedCount).toBe(2);
    expect(mockClient.savedSubscriptions).toHaveLength(2);
    expect(mockClient.savedSubscriptions[0].topicID).toBe('topic1');
    expect(mockClient.savedSubscriptions[0].clientId).toBe('test-node-123');
    expect(mockClient.savedSubscriptions[0].listeners).toHaveLength(2);

    // Test unregistration
    mockClient.unregisterPubSubClient(mockPubSubClient);
    expect(mockClient.pubsubClients.size).toBe(0);
  });

  test('should handle message delivery with connection manager integration', async () => {
    // Mock DHT with message sending capability
    const sentMessages = [];
    const mockDHT = {
      sendMessage: async (peerId, message) => {
        sentMessages.push({ peerId, message });
      }
    };

    // Mock MessageDelivery
    const MessageDelivery = class {
      constructor(dht, localNodeId) {
        this.dht = dht;
        this.localNodeId = localNodeId;
      }

      async pushMessageToSubscriber(subscriberID, topicID, message) {
        const pushMessage = {
          type: 'pubsub_push',
          topicID,
          message,
          pushedAt: Date.now()
        };
        
        await this.dht.sendMessage(subscriberID, pushMessage);
      }
    };

    const messageDelivery = new MessageDelivery(mockDHT, 'publisher-123');
    
    // Test push message delivery
    await messageDelivery.pushMessageToSubscriber(
      'subscriber-456',
      'test-topic',
      { messageID: 'msg-123', data: 'test-data' }
    );

    // Verify message was sent through DHT
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].peerId).toBe('subscriber-456');
    expect(sentMessages[0].message.type).toBe('pubsub_push');
    expect(sentMessages[0].message.topicID).toBe('test-topic');
    expect(sentMessages[0].message.message.messageID).toBe('msg-123');
  });

  test('should handle Docker networking metadata correctly', async () => {
    // Mock node with Docker networking metadata
    const mockNode = {
      id: new DHTNodeId(),
      metadata: {
        nodeType: 'nodejs',
        containerName: 'node1',
        externalAddress: 'imeyouwe.com/node1',
        internalAddress: 'node1:8080'
      }
    };

    // Test that Docker metadata doesn't interfere with Pub/Sub operations
    const isValidForPubSub = (node) => {
      // Node.js nodes are always valid for Pub/Sub coordination
      if (node.metadata?.nodeType === 'nodejs') {
        return true;
      }
      
      // Browser nodes need tab visibility check
      if (node.metadata?.nodeType === 'browser') {
        return node.metadata?.tabVisible !== false;
      }
      
      return true; // Default to valid if no metadata
    };

    expect(isValidForPubSub(mockNode)).toBe(true);
    
    // Test that external address is preserved
    expect(mockNode.metadata.externalAddress).toBe('imeyouwe.com/node1');
    expect(mockNode.metadata.containerName).toBe('node1');
  });

  test('should handle garbage collection state correctly', async () => {
    // Mock coordinator and message collection for garbage collection testing
    const mockCoordinator = {
      topicID: 'test-topic',
      version: 1,
      currentMessages: 'msg-collection-123',
      currentSubscribers: 'sub-collection-456'
    };

    const mockMessageCollection = {
      messages: [
        { messageID: 'msg1', expiresAt: Date.now() - 1000 }, // Expired
        { messageID: 'msg2', expiresAt: Date.now() + 10000 }, // Active
        { messageID: 'msg3', expiresAt: Date.now() - 2000 }  // Expired
      ]
    };

    // Test garbage collection logic
    const now = Date.now();
    const activeMessages = mockMessageCollection.messages.filter(
      msg => msg.expiresAt > now
    );
    const expiredMessages = mockMessageCollection.messages.filter(
      msg => msg.expiresAt <= now
    );

    expect(activeMessages).toHaveLength(1);
    expect(activeMessages[0].messageID).toBe('msg2');
    expect(expiredMessages).toHaveLength(2);
    expect(expiredMessages.map(m => m.messageID)).toEqual(['msg1', 'msg3']);
  });
});