/**
 * Property-Based Tests for DHT Handler Attachment Fix
 * 
 * These tests verify that DHT message handlers are correctly attached to
 * connection managers for incoming WebSocket connections.
 * 
 * Bug Condition: When an incoming WebSocket connection is established,
 * the dedicated peerManager should have DHT message handlers attached.
 * The bug occurs when handlers are attached to a different manager instance.
 * 
 * Property 1: Bug Condition - For any incoming connection, the dedicated
 * peerManager should have listenerCount('dhtMessage') > 0 after handlePeerConnected()
 * 
 * Property 2: Preservation - Outgoing connections, existing nodes, and
 * bootstrap connections should continue to work unchanged.
 */

import * as fc from 'fast-check';
import { RoutingTable } from '../../src/dht/RoutingTable.js';
import { DHTNodeId } from '../../src/core/DHTNodeId.js';
import { DHTNode } from '../../src/core/DHTNode.js';
import { ConnectionManager } from '../../src/network/ConnectionManager.js';
import { EventEmitter } from 'events';

/**
 * Mock WebSocket for testing
 */
class MockWebSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1; // OPEN
    this.sentMessages = [];
  }
  
  send(data) {
    this.sentMessages.push(data);
  }
  
  close() {
    this.readyState = 3; // CLOSED
  }
}

/**
 * Mock Connection Manager that simulates WebSocketConnectionManager behavior
 */
class MockConnectionManager extends ConnectionManager {
  constructor(options = {}) {
    super(options);
    this.localNodeType = options.localNodeType || 'nodejs';
    this.targetNodeType = options.targetNodeType || 'nodejs';
    this.webSocketInitialized = true;
  }
  
  async createConnection(peerId, initiator = true) {
    this.peerId = peerId;
    this.connectionState = 'connected';
  }
  
  async sendRawMessage(peerId, message) {
    // Mock implementation
  }
  
  isConnected() {
    return this.connectionState === 'connected';
  }
  
  destroyConnection(peerId, reason = 'manual') {
    this.connectionState = 'disconnected';
    this.connection = null;
  }
}

/**
 * Generate valid 40-character hex node IDs for testing
 * Uses DHTNodeId which generates cryptographically random IDs
 */
const nodeIdArbitrary = fc.constant(null).map(() => new DHTNodeId().toString());

/**
 * Generate a mock incoming connection scenario
 */
const incomingConnectionArbitrary = fc.record({
  localNodeId: fc.constant(null).map(() => new DHTNodeId().toString()),
  peerNodeId: fc.constant(null).map(() => new DHTNodeId().toString()),
  metadata: fc.record({
    nodeType: fc.constantFrom('nodejs', 'browser'),
    isBridgeNode: fc.boolean()
  })
});

/**
 * Helper function to set up the onAttachDHTHandler callback on a RoutingTable
 * This simulates what KademliaDHT.setupRoutingTableEventHandlers() does
 */
function setupDHTHandlerCallback(routingTable) {
  routingTable.onAttachDHTHandler = (manager, peerId) => {
    if (!manager) {
      return;
    }
    
    // Guard against duplicate handler attachment
    if (manager._dhtMessageHandlerAttached) {
      const actualListeners = manager.listenerCount('dhtMessage');
      if (actualListeners > 0) {
        return;
      }
      // Stale flag - reset and reattach
      manager._dhtMessageHandlerAttached = false;
    }
    
    // Attach the DHT message handler
    manager.on('dhtMessage', ({ peerId: msgPeerId, message, sourceManager }) => {
      // Handler attached - this is what we're testing for
    });
    
    manager._dhtMessageHandlerAttached = true;
  };
}

describe('DHT Handler Attachment - Bug Condition Exploration', () => {
  /**
   * Task 1: Bug Condition Exploration Test
   * 
   * These tests verify that the onAttachDHTHandler callback mechanism works correctly.
   * The fix ensures DHT message handlers are attached to the dedicated peerManager
   * BEFORE setupConnection() is called.
   */
  describe('Property 1: DHT Handler Attachment for Incoming Connections', () => {
    
    test('should attach DHT message handler to dedicated peerManager after handlePeerConnected()', () => {
      fc.assert(
        fc.property(incomingConnectionArbitrary, ({ localNodeId, peerNodeId, metadata }) => {
          // Setup: Create routing table and mock connection manager
          const routingTable = new RoutingTable(DHTNodeId.fromHex(localNodeId), 20);
          
          // CRITICAL: Set up the onAttachDHTHandler callback (simulating KademliaDHT setup)
          setupDHTHandlerCallback(routingTable);
          
          // Create dedicated peerManager (simulating what handleIncomingConnection does)
          const peerManager = new MockConnectionManager({
            localNodeType: 'nodejs',
            targetNodeType: metadata.nodeType,
            enableServer: false
          });
          peerManager.initialize(localNodeId);
          
          // Create mock WebSocket connection
          const mockWs = new MockWebSocket();
          
          // Track if onNodeAdded callback was called
          let onNodeAddedCalled = false;
          routingTable.onNodeAdded = (eventType, data) => {
            if (eventType === 'nodeAdded') {
              onNodeAddedCalled = true;
            }
          };
          
          // Call handlePeerConnected (this is what WebSocketConnectionManager does)
          routingTable.handlePeerConnected(peerNodeId, mockWs, peerManager, false, metadata);
          
          // The dedicated peerManager should have DHT message handler attached
          // via the onAttachDHTHandler callback called in handlePeerConnected()
          const listenerCount = peerManager.listenerCount('dhtMessage');
          const handlerFlag = peerManager._dhtMessageHandlerAttached || false;
          
          // Property: After handlePeerConnected(), the dedicated peerManager MUST have
          // DHT message handlers attached
          expect(listenerCount).toBeGreaterThan(0);
          expect(handlerFlag).toBe(true);
        }),
        { numRuns: 50 }
      );
    });
    
    test('should attach DHT handler even when node is added to replacement cache (bucket full)', () => {
      // Setup: Create routing table with k=2 (small bucket for easy filling)
      const localNodeId = '0'.repeat(40);
      const routingTable = new RoutingTable(DHTNodeId.fromHex(localNodeId), 2);
      
      // CRITICAL: Set up the onAttachDHTHandler callback (simulating KademliaDHT setup)
      setupDHTHandlerCallback(routingTable);
      
      // Fill the bucket with 2 nodes (k=2)
      for (let i = 0; i < 2; i++) {
        const fillerId = (i + 1).toString(16).padStart(40, '0');
        const fillerNode = new DHTNode(fillerId);
        fillerNode.isAlive = true;
        fillerNode.lastSeen = Date.now();
        routingTable.addNode(fillerNode);
      }
      
      // Verify bucket is full
      expect(routingTable.totalNodes).toBe(2);
      
      // Now try to add a new peer via handlePeerConnected
      // This peer should go to replacement cache since bucket is full
      const newPeerId = '3'.repeat(40);
      const peerManager = new MockConnectionManager({
        localNodeType: 'nodejs',
        targetNodeType: 'nodejs',
        enableServer: false
      });
      peerManager.initialize(localNodeId);
      
      const mockWs = new MockWebSocket();
      
      // Track if onNodeAdded was called
      let onNodeAddedCalled = false;
      routingTable.onNodeAdded = (eventType, data) => {
        if (eventType === 'nodeAdded') {
          onNodeAddedCalled = true;
        }
      };
      
      // Call handlePeerConnected
      routingTable.handlePeerConnected(newPeerId, mockWs, peerManager, false, { nodeType: 'nodejs' });
      
      // The fix ensures that even when node goes to replacement cache,
      // the dedicated peerManager has DHT message handlers attached
      // via the onAttachDHTHandler callback called BEFORE addNode()
      
      // Property: Even when node goes to replacement cache, the dedicated peerManager
      // MUST have DHT message handlers attached
      const listenerCount = peerManager.listenerCount('dhtMessage');
      const handlerFlag = peerManager._dhtMessageHandlerAttached || false;
      
      expect(listenerCount).toBeGreaterThan(0);
      expect(handlerFlag).toBe(true);
    });
    
    test('should process DHT messages received on dedicated peerManager', () => {
      // Setup
      const localNodeId = '0'.repeat(40);
      const peerNodeId = '1'.repeat(40);
      const routingTable = new RoutingTable(DHTNodeId.fromHex(localNodeId), 20);
      
      // CRITICAL: Set up the onAttachDHTHandler callback (simulating KademliaDHT setup)
      setupDHTHandlerCallback(routingTable);
      
      const peerManager = new MockConnectionManager({
        localNodeType: 'nodejs',
        targetNodeType: 'nodejs',
        enableServer: false
      });
      peerManager.initialize(localNodeId);
      
      const mockWs = new MockWebSocket();
      
      // Set up onNodeAdded callback
      routingTable.onNodeAdded = (eventType, data) => {
        // This is what KademliaDHT.handlePeerConnected would do
      };
      
      // Call handlePeerConnected
      routingTable.handlePeerConnected(peerNodeId, mockWs, peerManager, false, { nodeType: 'nodejs' });
      
      // Track if dhtMessage event is received
      let dhtMessageReceived = false;
      let receivedMessage = null;
      
      // Add another listener to verify the handler is working
      peerManager.on('dhtMessage', ({ peerId, message }) => {
        dhtMessageReceived = true;
        receivedMessage = message;
      });
      
      // Simulate receiving a DHT message (find_node - this type emits dhtMessage)
      // Note: ping is handled directly by handlePing, not emitted as dhtMessage
      const findNodeMessage = {
        type: 'find_node',
        requestId: 'test_123',
        from: peerNodeId,
        targetId: localNodeId,
        timestamp: Date.now()
      };
      
      // This is what happens when WebSocket receives a message
      // handleMessage() should emit 'dhtMessage' event for find_node type
      peerManager.handleMessage(peerNodeId, findNodeMessage);
      
      // Property: DHT messages received on peerManager should be processed
      // This requires a handler to be attached BEFORE messages arrive
      expect(dhtMessageReceived).toBe(true);
      expect(receivedMessage).toEqual(findNodeMessage);
    });
  });
});

describe('DHT Handler Attachment - Preservation Tests', () => {
  /**
   * Task 2: Preservation Property Tests
   * 
   * These tests verify that existing behavior is preserved for:
   * - Outgoing connections
   * - Existing nodes with managers
   * - Bootstrap connections
   * 
   * These tests should PASS on both unfixed and fixed code.
   */
  
  describe('Property 2: Preservation - Outgoing Connection Behavior', () => {
    
    test('should ignore bootstrap connections in routing table', () => {
      fc.assert(
        fc.property(nodeIdArbitrary, (localNodeId) => {
          const routingTable = new RoutingTable(DHTNodeId.fromHex(localNodeId), 20);
          
          // Bootstrap connections have IDs like "bootstrap_1234567890"
          const bootstrapPeerId = `bootstrap_${Date.now()}`;
          const peerManager = new MockConnectionManager({
            localNodeType: 'nodejs',
            targetNodeType: 'nodejs'
          });
          peerManager.initialize(localNodeId);
          
          const mockWs = new MockWebSocket();
          
          // Track if onNodeAdded was called
          let onNodeAddedCalled = false;
          routingTable.onNodeAdded = (eventType, data) => {
            if (eventType === 'nodeAdded') {
              onNodeAddedCalled = true;
            }
          };
          
          // Call handlePeerConnected with bootstrap ID
          routingTable.handlePeerConnected(bootstrapPeerId, mockWs, peerManager, false, null);
          
          // Preservation: Bootstrap connections should be ignored
          expect(onNodeAddedCalled).toBe(false);
          expect(routingTable.totalNodes).toBe(0);
        }),
        { numRuns: 20 }
      );
    });
    
    test('should reject invalid node IDs', () => {
      const localNodeId = '0'.repeat(40);
      const routingTable = new RoutingTable(DHTNodeId.fromHex(localNodeId), 20);
      
      const invalidIds = [
        'short',
        '0'.repeat(39), // Too short
        '0'.repeat(41), // Too long
        'zzzz'.repeat(10), // Invalid hex (lowercase z is not valid hex)
        // Note: null and undefined are handled by the peerId?.startsWith check
        ''
      ];
      
      for (const invalidId of invalidIds) {
        const peerManager = new MockConnectionManager({
          localNodeType: 'nodejs',
          targetNodeType: 'nodejs'
        });
        peerManager.initialize(localNodeId);
        
        const mockWs = new MockWebSocket();
        
        let onNodeAddedCalled = false;
        routingTable.onNodeAdded = (eventType, data) => {
          if (eventType === 'nodeAdded') {
            onNodeAddedCalled = true;
          }
        };
        
        // Should not throw, just ignore invalid IDs
        routingTable.handlePeerConnected(invalidId, mockWs, peerManager, false, null);
        
        // Preservation: Invalid IDs should be rejected
        expect(onNodeAddedCalled).toBe(false);
      }
    });
    
    test('should update existing node connection when node already exists', () => {
      const localNodeId = '0'.repeat(40);
      const peerNodeId = '1'.repeat(40);
      const routingTable = new RoutingTable(DHTNodeId.fromHex(localNodeId), 20);
      
      // First connection
      const peerManager1 = new MockConnectionManager({
        localNodeType: 'nodejs',
        targetNodeType: 'nodejs'
      });
      peerManager1.initialize(localNodeId);
      const mockWs1 = new MockWebSocket();
      
      let nodeAddedCount = 0;
      routingTable.onNodeAdded = (eventType, data) => {
        if (eventType === 'nodeAdded') {
          nodeAddedCount++;
        }
      };
      
      // First handlePeerConnected
      routingTable.handlePeerConnected(peerNodeId, mockWs1, peerManager1, false, { nodeType: 'nodejs' });
      expect(nodeAddedCount).toBe(1);
      
      // Second connection (reconnection)
      const peerManager2 = new MockConnectionManager({
        localNodeType: 'nodejs',
        targetNodeType: 'nodejs'
      });
      peerManager2.initialize(localNodeId);
      const mockWs2 = new MockWebSocket();
      
      // Second handlePeerConnected - should update existing node, not add new
      routingTable.handlePeerConnected(peerNodeId, mockWs2, peerManager2, false, { nodeType: 'nodejs' });
      
      // Preservation: Should not add duplicate node
      expect(nodeAddedCount).toBe(1); // Still 1, not 2
      expect(routingTable.totalNodes).toBe(1);
      
      // The existing node should have updated connection manager
      const node = routingTable.getNode(peerNodeId);
      expect(node).toBeDefined();
      expect(node.connectionManager).toBe(peerManager2);
    });
    
    test('should call onNodeAdded callback when node is successfully added to main bucket', () => {
      fc.assert(
        fc.property(incomingConnectionArbitrary, ({ localNodeId, peerNodeId, metadata }) => {
          const routingTable = new RoutingTable(DHTNodeId.fromHex(localNodeId), 20);
          
          const peerManager = new MockConnectionManager({
            localNodeType: 'nodejs',
            targetNodeType: metadata.nodeType
          });
          peerManager.initialize(localNodeId);
          
          const mockWs = new MockWebSocket();
          
          let onNodeAddedCalled = false;
          let addedPeerId = null;
          routingTable.onNodeAdded = (eventType, data) => {
            if (eventType === 'nodeAdded') {
              onNodeAddedCalled = true;
              addedPeerId = data.peerId;
            }
          };
          
          routingTable.handlePeerConnected(peerNodeId, mockWs, peerManager, false, metadata);
          
          // Preservation: onNodeAdded should be called when node is added to main bucket
          // (This may not always be true if bucket is full, but with k=20 and empty table, it should)
          expect(onNodeAddedCalled).toBe(true);
          expect(addedPeerId).toBe(peerNodeId);
        }),
        { numRuns: 30 }
      );
    });
  });
});
