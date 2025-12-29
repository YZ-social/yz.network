import { ConnectionManagerFactory } from '../../src/network/ConnectionManagerFactory.js';
import { WebSocketConnectionManager } from '../../src/network/WebSocketConnectionManager.js';
import { WebRTCConnectionManager } from '../../src/network/WebRTCConnectionManager.js';
import { ConnectionManager } from '../../src/network/ConnectionManager.js';
import { jest } from '@jest/globals';

/**
 * Connection Manager Hierarchy Tests
 * 
 * Verifies that the connection manager hierarchy is preserved and functioning correctly:
 * - WebSocketConnectionManager functionality is intact
 * - WebRTCConnectionManager functionality is intact
 * - ConnectionManagerFactory routes to correct managers
 * - Backward compatibility with existing connection flows
 * - Manager-specific error reporting for connection failures
 * 
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5
 */
describe('Connection Manager Hierarchy', () => {
  beforeEach(() => {
    // Reset factory state before each test
    ConnectionManagerFactory.localNodeType = null;
    ConnectionManagerFactory.defaultOptions = {};
    ConnectionManagerFactory.managerCache.clear();
    ConnectionManagerFactory.globalMetadata.clear();
  });

  describe('ConnectionManagerFactory - Node Type Detection (Requirement 6.3)', () => {
    test('should detect nodejs environment correctly', () => {
      // In Jest/Node.js environment, should detect as nodejs
      const nodeType = ConnectionManagerFactory.detectNodeType();
      expect(nodeType).toBe('nodejs');
    });

    test('should initialize transports with detected node type', () => {
      ConnectionManagerFactory.initializeTransports({ testOption: true });
      
      expect(ConnectionManagerFactory.localNodeType).toBe('nodejs');
      expect(ConnectionManagerFactory.defaultOptions.testOption).toBe(true);
    });
  });

  describe('ConnectionManagerFactory - Manager Routing (Requirement 6.3)', () => {
    beforeEach(() => {
      ConnectionManagerFactory.initializeTransports();
    });

    test('should create WebSocketConnectionManager for nodejs → nodejs connections', () => {
      const manager = ConnectionManagerFactory.createForConnection('nodejs', 'nodejs');
      
      expect(manager).toBeInstanceOf(WebSocketConnectionManager);
      expect(manager.localNodeType).toBe('nodejs');
      expect(manager.targetNodeType).toBe('nodejs');
    });

    test('should create WebSocketConnectionManager for nodejs → browser connections', () => {
      const manager = ConnectionManagerFactory.createForConnection('nodejs', 'browser');
      
      expect(manager).toBeInstanceOf(WebSocketConnectionManager);
      expect(manager.localNodeType).toBe('nodejs');
      expect(manager.targetNodeType).toBe('browser');
    });

    // Note: Browser tests are skipped in Node.js environment
    // These would require jsdom or browser testing framework
    test.skip('should create WebSocketConnectionManager for browser → nodejs connections', () => {
      const manager = ConnectionManagerFactory.createForConnection('browser', 'nodejs');
      
      expect(manager).toBeInstanceOf(WebSocketConnectionManager);
      expect(manager.localNodeType).toBe('browser');
      expect(manager.targetNodeType).toBe('nodejs');
    });

    test('should create WebRTCConnectionManager for browser → browser connections', () => {
      const manager = ConnectionManagerFactory.createForConnection('browser', 'browser');
      
      expect(manager).toBeInstanceOf(WebRTCConnectionManager);
      // WebRTCConnectionManager stores options differently - verify it was created correctly
      expect(manager.rtcOptions).toBeDefined();
      expect(manager.rtcOptions.iceServers).toBeDefined();
    });

    test('should route to correct manager based on peer metadata', () => {
      const peerId = 'test-peer-123';
      
      // Test with nodejs metadata
      const nodejsMetadata = { nodeType: 'nodejs', listeningAddress: 'ws://localhost:8083' };
      const wsManager = ConnectionManagerFactory.getManagerForPeer(peerId, nodejsMetadata);
      expect(wsManager).toBeInstanceOf(WebSocketConnectionManager);
      
      // Test with bridge metadata (should be treated as nodejs)
      const bridgeMetadata = { nodeType: 'bridge', listeningAddress: 'ws://localhost:8084' };
      const bridgeManager = ConnectionManagerFactory.getManagerForPeer('bridge-peer', bridgeMetadata);
      expect(bridgeManager).toBeInstanceOf(WebSocketConnectionManager);
    });

    test('should infer nodejs type from listeningAddress metadata', () => {
      const peerId = 'server-peer-456';
      const metadata = { listeningAddress: 'ws://localhost:8083' }; // No explicit nodeType
      
      const manager = ConnectionManagerFactory.getManagerForPeer(peerId, metadata);
      expect(manager).toBeInstanceOf(WebSocketConnectionManager);
    });
  });

  describe('ConnectionManagerFactory - Metadata Management (Requirement 6.4)', () => {
    test('should store and retrieve global peer metadata', () => {
      const peerId = 'local-node-123';
      const metadata = {
        nodeType: 'nodejs',
        listeningAddress: 'ws://localhost:8083',
        isBridgeNode: false
      };
      
      ConnectionManagerFactory.setPeerMetadata(peerId, metadata);
      const retrieved = ConnectionManagerFactory.getPeerMetadata(peerId);
      
      expect(retrieved).toEqual(metadata);
    });

    test('should return null for unknown peer metadata', () => {
      const metadata = ConnectionManagerFactory.getPeerMetadata('unknown-peer');
      expect(metadata).toBeNull();
    });
  });

  describe('WebSocketConnectionManager - Functionality (Requirement 6.1)', () => {
    let wsManager;

    beforeEach(() => {
      wsManager = new WebSocketConnectionManager({
        localNodeType: 'nodejs',
        targetNodeType: 'nodejs',
        enableServer: false
      });
    });

    afterEach(() => {
      if (wsManager && !wsManager.isDestroyed) {
        wsManager.destroy();
      }
    });

    test('should extend ConnectionManager base class', () => {
      expect(wsManager).toBeInstanceOf(ConnectionManager);
    });

    test('should initialize with correct options', () => {
      expect(wsManager.localNodeType).toBe('nodejs');
      expect(wsManager.targetNodeType).toBe('nodejs');
      expect(wsManager.wsOptions.enableServer).toBe(false);
    });

    test('should initialize with local node ID', () => {
      const nodeId = 'test-node-id-123';
      wsManager.initialize(nodeId);
      
      expect(wsManager.localNodeId).toBe(nodeId);
    });

    test('should report disconnected state when no connection exists', () => {
      wsManager.initialize('test-node');
      expect(wsManager.isConnected()).toBe(false);
    });

    test('should return empty array for connected peers when disconnected', () => {
      wsManager.initialize('test-node');
      const peers = wsManager.getConnectedPeers();
      
      expect(peers).toEqual([]);
    });

    test('should provide connection statistics', () => {
      wsManager.initialize('test-node');
      const stats = wsManager.getStats();
      
      expect(stats.type).toBe('WebSocketConnectionManager');
      expect(stats.total).toBe(0);
      expect(stats.connected).toBe(0);
    });

    test('should throw error when creating connection without address', async () => {
      wsManager.initialize('test-node');
      
      await expect(wsManager.createConnection('peer-123', true, {}))
        .rejects.toThrow();
    });

    test('should emit initialized event on initialization', (done) => {
      wsManager.on('initialized', ({ localNodeId }) => {
        expect(localNodeId).toBe('test-node-456');
        done();
      });
      
      wsManager.initialize('test-node-456');
    });

    test('should handle destroy gracefully', () => {
      wsManager.initialize('test-node');
      wsManager.destroy();
      
      expect(wsManager.isDestroyed).toBe(true);
    });
  });

  describe('WebRTCConnectionManager - Functionality (Requirement 6.2)', () => {
    let rtcManager;

    beforeEach(() => {
      rtcManager = new WebRTCConnectionManager({
        localNodeType: 'browser',
        targetNodeType: 'browser'
      });
    });

    afterEach(() => {
      if (rtcManager && !rtcManager.isDestroyed) {
        rtcManager.destroy();
      }
    });

    test('should extend ConnectionManager base class', () => {
      expect(rtcManager).toBeInstanceOf(ConnectionManager);
    });

    test('should initialize with ICE servers configuration', () => {
      expect(rtcManager.rtcOptions.iceServers).toBeDefined();
      expect(rtcManager.rtcOptions.iceServers.length).toBeGreaterThan(0);
    });

    test('should initialize with local node ID', () => {
      const nodeId = 'browser-node-123';
      rtcManager.initialize(nodeId);
      
      expect(rtcManager.localNodeId).toBe(nodeId);
    });

    test('should report disconnected state when no connection exists', () => {
      rtcManager.initialize('test-browser');
      expect(rtcManager.isConnected()).toBe(false);
    });

    test('should return empty array for connected peers when disconnected', () => {
      rtcManager.initialize('test-browser');
      const peers = rtcManager.getConnectedPeers();
      
      expect(peers).toEqual([]);
    });

    test('should provide connection statistics', () => {
      rtcManager.initialize('test-browser');
      const stats = rtcManager.getStats();
      
      expect(stats.type).toBe('WebRTCConnectionManager');
      expect(stats.total).toBe(0);
      expect(stats.connected).toBe(0);
    });

    test('should track keep-alive state', () => {
      expect(rtcManager.keepAliveInterval).toBe(30000);
      expect(rtcManager.keepAliveIntervalHidden).toBe(10000);
      expect(rtcManager.keepAliveTimeout).toBe(60000);
    });

    test('should emit initialized event on initialization', (done) => {
      rtcManager.on('initialized', ({ localNodeId }) => {
        expect(localNodeId).toBe('browser-node-789');
        done();
      });
      
      rtcManager.initialize('browser-node-789');
    });

    test('should handle destroy gracefully', () => {
      rtcManager.initialize('test-browser');
      rtcManager.destroy();
      
      expect(rtcManager.isDestroyed).toBe(true);
    });
  });

  describe('Backward Compatibility (Requirement 6.4)', () => {
    test('should maintain peers getter for OverlayNetwork compatibility', () => {
      const manager = new WebSocketConnectionManager({
        localNodeType: 'nodejs',
        targetNodeType: 'nodejs',
        enableServer: false
      });
      manager.initialize('test-node');
      
      // peers getter should return a Map
      expect(manager.peers).toBeInstanceOf(Map);
      expect(manager.peers.size).toBe(0);
      
      manager.destroy();
    });

    test('should support sendData alias for sendMessage', () => {
      const manager = new WebSocketConnectionManager({
        localNodeType: 'nodejs',
        targetNodeType: 'nodejs',
        enableServer: false
      });
      manager.initialize('test-node');
      
      // sendData should exist as an alias
      expect(typeof manager.sendData).toBe('function');
      
      manager.destroy();
    });

    test('should support generateRequestId for request tracking', () => {
      const manager = new WebSocketConnectionManager({
        localNodeType: 'nodejs',
        targetNodeType: 'nodejs',
        enableServer: false
      });
      
      const requestId = manager.generateRequestId();
      
      expect(requestId).toMatch(/^req_\d+_[a-z0-9]+$/);
      
      manager.destroy();
    });
  });

  describe('Manager-Specific Error Reporting (Requirement 6.5)', () => {
    test('WebSocketConnectionManager should throw descriptive errors', async () => {
      const manager = new WebSocketConnectionManager({
        localNodeType: 'nodejs',
        targetNodeType: 'nodejs',
        enableServer: false
      });
      manager.initialize('test-node');
      
      // Should throw when trying to send without connection
      await expect(manager.sendMessage('peer-123', { type: 'test' }))
        .rejects.toThrow('No connection to peer');
      
      manager.destroy();
    });

    test('WebRTCConnectionManager should throw descriptive errors', async () => {
      const manager = new WebRTCConnectionManager({
        localNodeType: 'browser',
        targetNodeType: 'browser'
      });
      manager.initialize('test-browser');
      
      // Should throw when trying to send without connection
      await expect(manager.sendMessage('peer-456', { type: 'test' }))
        .rejects.toThrow('No connection to peer');
      
      manager.destroy();
    });

    test('should report manager type in statistics', () => {
      const wsManager = new WebSocketConnectionManager({
        localNodeType: 'nodejs',
        targetNodeType: 'nodejs',
        enableServer: false
      });
      
      const rtcManager = new WebRTCConnectionManager({
        localNodeType: 'browser',
        targetNodeType: 'browser'
      });
      
      expect(wsManager.getStats().type).toBe('WebSocketConnectionManager');
      expect(rtcManager.getStats().type).toBe('WebRTCConnectionManager');
      
      wsManager.destroy();
      rtcManager.destroy();
    });

    test('should emit peerDisconnected with reason on destroy', (done) => {
      const manager = new WebSocketConnectionManager({
        localNodeType: 'nodejs',
        targetNodeType: 'nodejs',
        enableServer: false
      });
      manager.initialize('test-node');
      manager.peerId = 'test-peer';
      
      manager.on('peerDisconnected', ({ peerId, reason }) => {
        expect(peerId).toBe('test-peer');
        expect(reason).toBe('manager_destroyed');
        done();
      });
      
      manager.destroyConnection('test-peer', 'manager_destroyed');
    });
  });

  describe('Single Connection Architecture', () => {
    test('WebSocketConnectionManager should handle single peer per instance', () => {
      const manager = new WebSocketConnectionManager({
        localNodeType: 'nodejs',
        targetNodeType: 'nodejs',
        enableServer: false
      });
      manager.initialize('local-node');
      
      // Initially no peer
      expect(manager.peerId).toBeNull();
      expect(manager.connection).toBeNull();
      
      manager.destroy();
    });

    test('WebRTCConnectionManager should handle single peer per instance', () => {
      const manager = new WebRTCConnectionManager({
        localNodeType: 'browser',
        targetNodeType: 'browser'
      });
      manager.initialize('local-browser');
      
      // Initially no peer
      expect(manager.peerId).toBeNull();
      expect(manager.connection).toBeNull();
      expect(manager.dataChannel).toBeNull();
      
      manager.destroy();
    });
  });

  describe('Protocol Message Handling', () => {
    test('should handle ping/pong protocol messages', async () => {
      const manager = new WebSocketConnectionManager({
        localNodeType: 'nodejs',
        targetNodeType: 'nodejs',
        enableServer: false
      });
      manager.initialize('test-node');
      
      // Simulate receiving a ping message
      const pongPromise = new Promise((resolve) => {
        // Mock the sendMessage to capture the pong response
        const mockSendMessage = jest.fn().mockResolvedValue(true);
        manager.sendMessage = mockSendMessage;
        manager.handlePing('peer-123', { type: 'ping', requestId: 'req_123', timestamp: Date.now() });
        
        // Check that sendMessage was called with pong
        setTimeout(() => {
          expect(mockSendMessage).toHaveBeenCalledWith('peer-123', expect.objectContaining({
            type: 'pong',
            requestId: 'req_123'
          }));
          resolve();
        }, 50);
      });
      
      await pongPromise;
      manager.destroy();
    });

    test('should emit dhtMessage for DHT protocol messages', (done) => {
      const manager = new WebSocketConnectionManager({
        localNodeType: 'nodejs',
        targetNodeType: 'nodejs',
        enableServer: false
      });
      manager.initialize('test-node');
      
      manager.on('dhtMessage', ({ peerId, message }) => {
        expect(peerId).toBe('peer-123');
        expect(message.type).toBe('find_node');
        done();
      });
      
      manager.handleMessage('peer-123', { type: 'find_node', targetId: 'target-456' });
      
      manager.destroy();
    });
  });
});
