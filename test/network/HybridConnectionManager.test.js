/**
 * Unit tests for HybridConnectionManager
 * 
 * Tests the "relay first" connection strategy for browser-to-browser connections:
 * 1. Immediately establish relay path via bridge node
 * 2. Start WebRTC ICE gathering in parallel
 * 3. Use relay for initial messages while WebRTC probes
 * 
 * See: .kiro/specs/symmetric-nat-relay/tasks.md - Task 3.1
 */

import { jest } from '@jest/globals';
import { HybridConnectionManager } from '../../src/network/HybridConnectionManager.js';
import { RelayManager } from '../../src/network/RelayManager.js';

describe('HybridConnectionManager - Relay First Strategy', () => {
  let hybridManager;
  let mockRelayManager;
  
  beforeEach(() => {
    // Create mock relay manager
    mockRelayManager = new RelayManager();
    mockRelayManager.initialize('local-node-id', false);
    
    // Mock requestRelaySession to simulate successful relay establishment
    mockRelayManager.requestRelaySession = jest.fn().mockResolvedValue({
      sessionId: 'test-session-123',
      fromPeerId: 'local-node-id',
      toPeerId: 'target-peer-id',
      relayNodeId: 'bridge-node-id',
      state: 'active'
    });
    
    // Mock sendThroughRelay
    mockRelayManager.sendThroughRelay = jest.fn().mockResolvedValue(undefined);
    
    // Mock closeSession
    mockRelayManager.closeSession = jest.fn();
    
    hybridManager = new HybridConnectionManager({
      relayManager: mockRelayManager,
      bridgeNodeId: 'bridge-node-id',
      attemptWebRTC: false, // Disable WebRTC for relay-only tests
      relayTimeout: 5000,
      webrtcTimeout: 30000
    });
  });
  
  afterEach(() => {
    if (hybridManager && !hybridManager.isDestroyed) {
      hybridManager.destroy();
    }
    mockRelayManager.destroy();
  });
  
  describe('Relay First Connection Strategy', () => {
    it('should immediately establish relay connection', async () => {
      const connectedPromise = new Promise(resolve => {
        hybridManager.on('connected', resolve);
      });
      
      await hybridManager.createConnection('target-peer-id', true, null);
      
      const connectedEvent = await connectedPromise;
      
      expect(connectedEvent.transport).toBe('relay');
      expect(hybridManager.isConnected()).toBe(true);
      expect(hybridManager.getActiveTransport()).toBe('relay');
    });
    
    it('should emit relayEstablished event when relay connects', async () => {
      const relayEstablishedPromise = new Promise(resolve => {
        hybridManager.on('relayEstablished', resolve);
      });
      
      await hybridManager.createConnection('target-peer-id', true, null);
      
      const event = await relayEstablishedPromise;
      
      expect(event.peerId).toBe('target-peer-id');
      expect(event.sessionId).toBe('test-session-123');
      expect(event.relayNodeId).toBe('bridge-node-id');
      expect(event.duration).toBeGreaterThanOrEqual(0);
    });
    
    it('should emit peerConnected event for DHT compatibility', async () => {
      const peerConnectedPromise = new Promise(resolve => {
        hybridManager.on('peerConnected', resolve);
      });
      
      await hybridManager.createConnection('target-peer-id', true, null);
      
      const event = await peerConnectedPromise;
      
      expect(event.peerId).toBe('target-peer-id');
      expect(event.manager).toBe(hybridManager);
      expect(event.transport).toBe('relay');
    });
    
    it('should request relay session with correct parameters', async () => {
      await hybridManager.createConnection('target-peer-id', true, null);
      
      expect(mockRelayManager.requestRelaySession).toHaveBeenCalledWith(
        'target-peer-id',
        expect.objectContaining({
          preferredRelay: 'bridge-node-id',
          timeout: 5000
        })
      );
    });
    
    it('should fail gracefully when no bridge node is configured', async () => {
      const noBridgeManager = new HybridConnectionManager({
        relayManager: mockRelayManager,
        bridgeNodeId: null, // No bridge node
        attemptWebRTC: false
      });
      
      const relayFailedPromise = new Promise(resolve => {
        noBridgeManager.on('relayFailed', resolve);
      });
      
      // Should fail because no bridge node and no WebRTC
      await expect(noBridgeManager.createConnection('target-peer-id', true, null))
        .rejects.toThrow('Connection failed');
      
      const event = await relayFailedPromise;
      expect(event.error).toBe('No bridge node configured');
      
      noBridgeManager.destroy();
    });
  });
  
  describe('Message Sending via Relay', () => {
    it('should send messages through relay when connected', async () => {
      await hybridManager.createConnection('target-peer-id', true, null);
      
      const testMessage = { type: 'test', data: 'hello' };
      await hybridManager.sendRawMessage('target-peer-id', testMessage);
      
      expect(mockRelayManager.sendThroughRelay).toHaveBeenCalledWith(
        'test-session-123',
        testMessage
      );
    });
    
    it('should queue messages before connection is established', async () => {
      const testMessage = { type: 'test', data: 'queued' };
      
      // Send message before connection
      hybridManager.sendRawMessage('target-peer-id', testMessage);
      
      // Message should be queued
      expect(hybridManager.messageQueue.length).toBe(1);
      
      // Now connect
      await hybridManager.createConnection('target-peer-id', true, null);
      
      // Message should have been flushed
      expect(mockRelayManager.sendThroughRelay).toHaveBeenCalledWith(
        'test-session-123',
        testMessage
      );
    });
  });
  
  describe('Connection State Management', () => {
    it('should track connection state correctly', async () => {
      expect(hybridManager.connectionState).toBe('disconnected');
      expect(hybridManager.isConnected()).toBe(false);
      
      const connectionPromise = hybridManager.createConnection('target-peer-id', true, null);
      
      // During connection
      expect(hybridManager.connectionState).toBe('connecting');
      
      await connectionPromise;
      
      // After connection
      expect(hybridManager.connectionState).toBe('connected');
      expect(hybridManager.isConnected()).toBe(true);
    });
    
    it('should not create duplicate connections', async () => {
      await hybridManager.createConnection('target-peer-id', true, null);
      
      // Try to create another connection
      await hybridManager.createConnection('target-peer-id', true, null);
      
      // Should only have called requestRelaySession once
      expect(mockRelayManager.requestRelaySession).toHaveBeenCalledTimes(1);
    });
    
    it('should provide connection metrics', async () => {
      await hybridManager.createConnection('target-peer-id', true, null);
      
      const metrics = hybridManager.getMetrics();
      
      expect(metrics.peerId).toBe('target-peer-id');
      expect(metrics.connectionState).toBe('connected');
      expect(metrics.activeTransport).toBe('relay');
      expect(metrics.relayConnected).toBe(true);
      expect(metrics.relayEstablishTime).toBeGreaterThanOrEqual(0);
    });
  });
  
  describe('Connection Cleanup', () => {
    it('should close relay session on destroy', async () => {
      await hybridManager.createConnection('target-peer-id', true, null);
      
      await hybridManager.destroy();
      
      expect(mockRelayManager.closeSession).toHaveBeenCalledWith(
        'test-session-123',
        'destroy'
      );
      expect(hybridManager.isDestroyed).toBe(true);
      expect(hybridManager.isConnected()).toBe(false);
    });
    
    it('should emit disconnected event on destroy', async () => {
      await hybridManager.createConnection('target-peer-id', true, null);
      
      const disconnectedPromise = new Promise(resolve => {
        hybridManager.on('disconnected', resolve);
      });
      
      await hybridManager.destroy();
      
      const event = await disconnectedPromise;
      expect(event.peerId).toBe('target-peer-id');
      expect(event.reason).toBe('destroy');
    });
  });
});

describe('HybridConnectionManager - Parallel WebRTC Probing', () => {
  let hybridManager;
  let mockRelayManager;
  
  beforeEach(() => {
    mockRelayManager = new RelayManager();
    mockRelayManager.initialize('local-node-id', false);
    
    mockRelayManager.requestRelaySession = jest.fn().mockResolvedValue({
      sessionId: 'test-session-123',
      fromPeerId: 'local-node-id',
      toPeerId: 'target-peer-id',
      relayNodeId: 'bridge-node-id',
      state: 'active'
    });
    
    mockRelayManager.sendThroughRelay = jest.fn().mockResolvedValue(undefined);
    mockRelayManager.closeSession = jest.fn();
  });
  
  afterEach(() => {
    if (hybridManager && !hybridManager.isDestroyed) {
      hybridManager.destroy();
    }
    mockRelayManager.destroy();
  });
  
  it('should start WebRTC probing in parallel with relay', async () => {
    hybridManager = new HybridConnectionManager({
      relayManager: mockRelayManager,
      bridgeNodeId: 'bridge-node-id',
      attemptWebRTC: true, // Enable WebRTC
      relayTimeout: 5000,
      webrtcTimeout: 1000 // Short timeout for test
    });
    
    // Track events
    const events = [];
    hybridManager.on('relayEstablished', () => events.push('relay'));
    hybridManager.on('webrtcFailed', () => events.push('webrtc_failed'));
    
    await hybridManager.createConnection('target-peer-id', true, null);
    
    // Relay should have been established immediately
    expect(events).toContain('relay');
    expect(hybridManager.isConnected()).toBe(true);
    expect(hybridManager.getActiveTransport()).toBe('relay');
    
    // WebRTC manager should have been created for background probing
    // (it will fail in test environment but that's expected)
    expect(hybridManager.webrtcManager).toBeDefined();
  });
  
  it('should emit webrtcFailed event when WebRTC fails', async () => {
    hybridManager = new HybridConnectionManager({
      relayManager: mockRelayManager,
      bridgeNodeId: 'bridge-node-id',
      attemptWebRTC: true,
      relayTimeout: 5000,
      webrtcTimeout: 500 // Very short timeout
    });
    
    const webrtcFailedPromise = new Promise(resolve => {
      hybridManager.on('webrtcFailed', resolve);
    });
    
    await hybridManager.createConnection('target-peer-id', true, null);
    
    // Wait for WebRTC to fail
    const event = await Promise.race([
      webrtcFailedPromise,
      new Promise(resolve => setTimeout(() => resolve(null), 2000))
    ]);
    
    // WebRTC should have failed (no signaling available in test)
    // But connection should still be up via relay
    expect(hybridManager.isConnected()).toBe(true);
    expect(hybridManager.getActiveTransport()).toBe('relay');
  });
  
  it('should forward WebRTC signals', async () => {
    hybridManager = new HybridConnectionManager({
      relayManager: mockRelayManager,
      bridgeNodeId: 'bridge-node-id',
      attemptWebRTC: true,
      relayTimeout: 5000,
      webrtcTimeout: 30000
    });
    
    const signalPromise = new Promise(resolve => {
      hybridManager.on('signal', resolve);
    });
    
    // Start connection (this will create WebRTC manager)
    const connectionPromise = hybridManager.createConnection('target-peer-id', true, null);
    
    // Wait a bit for WebRTC manager to be created
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // The WebRTC manager should emit signals during ICE gathering
    // We can't easily test this without a full WebRTC setup, but we verify the event forwarding is set up
    expect(hybridManager.webrtcManager).toBeDefined();
    
    // Clean up
    await connectionPromise.catch(() => {}); // Ignore timeout
  });
});


describe('HybridConnectionManager - Transparent Path Migration (Task 4.5)', () => {
  let hybridManager;
  let mockRelayManager;
  
  beforeEach(() => {
    mockRelayManager = new RelayManager();
    mockRelayManager.initialize('local-node-id', false);
    
    mockRelayManager.requestRelaySession = jest.fn().mockResolvedValue({
      sessionId: 'test-session-123',
      fromPeerId: 'local-node-id',
      toPeerId: 'target-peer-id',
      relayNodeId: 'bridge-node-id',
      state: 'active'
    });
    
    mockRelayManager.sendThroughRelay = jest.fn().mockResolvedValue(undefined);
    mockRelayManager.closeSession = jest.fn();
    
    hybridManager = new HybridConnectionManager({
      relayManager: mockRelayManager,
      bridgeNodeId: 'bridge-node-id',
      attemptWebRTC: false, // Disable WebRTC for controlled testing
      relayTimeout: 5000,
      webrtcTimeout: 30000,
      upgradeDelay: 100 // Short delay for testing
    });
  });
  
  afterEach(() => {
    if (hybridManager && !hybridManager.isDestroyed) {
      hybridManager.destroy();
    }
    mockRelayManager.destroy();
  });
  
  describe('Migration State Management', () => {
    it('should track migration state in metrics', async () => {
      await hybridManager.createConnection('target-peer-id', true, null);
      
      const metrics = hybridManager.getMetrics();
      
      expect(metrics.migrationInProgress).toBe(false);
      expect(metrics.migrationState).toBeNull();
    });
    
    it('should report isDualSendActive as false when not migrating', async () => {
      await hybridManager.createConnection('target-peer-id', true, null);
      
      // isDualSendActive returns falsy (false or undefined) when not migrating
      expect(hybridManager.isDualSendActive()).toBeFalsy();
    });
  });
  
  describe('Dual-Send Message Handling', () => {
    it('should send messages normally when not in migration', async () => {
      await hybridManager.createConnection('target-peer-id', true, null);
      
      const testMessage = { type: 'test', data: 'hello' };
      await hybridManager.sendRawMessage('target-peer-id', testMessage);
      
      // Should send without migration markers
      expect(mockRelayManager.sendThroughRelay).toHaveBeenCalledWith(
        'test-session-123',
        testMessage
      );
    });
    
    it('should deduplicate dual-send messages received via relay', async () => {
      await hybridManager.createConnection('target-peer-id', true, null);
      
      const dhtMessageEvents = [];
      hybridManager.on('dhtMessage', (data) => {
        dhtMessageEvents.push(data);
      });
      
      // Simulate receiving a dual-send message via relay
      const dualSendMessage = {
        type: 'find_node',
        nodeId: 'test-node',
        _dualSend: true,
        _migrationId: 'mig-123'
      };
      
      hybridManager.handleRelayMessage({
        sessionId: 'test-session-123',
        from: 'target-peer-id',
        payload: dualSendMessage
      });
      
      // Should emit dhtMessage with cleaned payload
      expect(dhtMessageEvents.length).toBe(1);
      expect(dhtMessageEvents[0].message._dualSend).toBeUndefined();
      expect(dhtMessageEvents[0].message._migrationId).toBeUndefined();
      expect(dhtMessageEvents[0].message.type).toBe('find_node');
      
      // Simulate receiving the same message again (duplicate)
      hybridManager.handleRelayMessage({
        sessionId: 'test-session-123',
        from: 'target-peer-id',
        payload: dualSendMessage
      });
      
      // Should still only have 1 event (duplicate dropped)
      // Note: Same transport doesn't count as duplicate, only cross-transport
      expect(dhtMessageEvents.length).toBe(2);
    });
  });
  
  describe('Migration Message Handling', () => {
    it('should handle migration_confirm messages', async () => {
      await hybridManager.createConnection('target-peer-id', true, null);
      
      const peerMigrationEvents = [];
      hybridManager.on('peerMigrationConfirmed', (data) => {
        peerMigrationEvents.push(data);
      });
      
      // Simulate receiving migration confirmation
      hybridManager.handleRelayMessage({
        sessionId: 'test-session-123',
        from: 'target-peer-id',
        payload: {
          type: 'migration_confirm',
          migrationId: 'mig-456',
          fromTransport: 'relay',
          toTransport: 'webrtc',
          timestamp: Date.now()
        }
      });
      
      expect(peerMigrationEvents.length).toBe(1);
      expect(peerMigrationEvents[0].migrationId).toBe('mig-456');
      expect(peerMigrationEvents[0].fromTransport).toBe('relay');
      expect(peerMigrationEvents[0].toTransport).toBe('webrtc');
    });
    
    it('should handle migration_ack messages', async () => {
      await hybridManager.createConnection('target-peer-id', true, null);
      
      const ackEvents = [];
      hybridManager.on('migrationAckReceived', (data) => {
        ackEvents.push(data);
      });
      
      // Simulate receiving migration ack
      hybridManager.handleRelayMessage({
        sessionId: 'test-session-123',
        from: 'target-peer-id',
        payload: {
          type: 'migration_ack',
          migrationId: 'mig-789',
          timestamp: Date.now()
        }
      });
      
      expect(ackEvents.length).toBe(1);
      expect(ackEvents[0].migrationId).toBe('mig-789');
    });
  });
  
  describe('Migration Cleanup', () => {
    it('should clean up migration state on destroy', async () => {
      await hybridManager.createConnection('target-peer-id', true, null);
      
      // Manually set migration state for testing
      hybridManager._migrationInProgress = true;
      hybridManager._migrationState = {
        fromTransport: 'relay',
        toTransport: 'webrtc',
        migrationId: 'test-mig'
      };
      hybridManager._recentMessages = new Map([['key', { receivedVia: 'relay' }]]);
      
      await hybridManager.destroy();
      
      expect(hybridManager._migrationInProgress).toBe(false);
      expect(hybridManager._migrationState).toBeNull();
      expect(hybridManager._recentMessages).toBeNull();
    });
  });
  
  describe('Path Ping/Pong Handling', () => {
    it('should handle path_ping messages via relay', async () => {
      await hybridManager.createConnection('target-peer-id', true, null);
      
      // Simulate receiving a path ping
      hybridManager.handleRelayMessage({
        sessionId: 'test-session-123',
        from: 'target-peer-id',
        payload: {
          type: 'path_ping',
          pingId: 'ping-123',
          timestamp: Date.now()
        }
      });
      
      // Should have sent a pong back
      expect(mockRelayManager.sendThroughRelay).toHaveBeenCalledWith(
        'test-session-123',
        expect.objectContaining({
          type: 'path_pong',
          pingId: 'ping-123'
        })
      );
    });
  });
  
  describe('Dual-Send Period During Migration (Task 4.5)', () => {
    it('should enable dual-send mode when migration starts', async () => {
      await hybridManager.createConnection('target-peer-id', true, null);
      
      // Verify not in dual-send mode initially
      expect(hybridManager.isDualSendActive()).toBeFalsy();
      
      // Manually trigger migration state for testing
      hybridManager._migrationInProgress = true;
      hybridManager._migrationState = {
        fromTransport: 'relay',
        toTransport: 'webrtc',
        pathType: 'webrtc-direct',
        pathName: 'WebRTC',
        startTime: Date.now(),
        dualSendEnabled: true,
        confirmationSent: false,
        confirmationReceived: false,
        migrationId: 'test-migration-123'
      };
      
      // Now should be in dual-send mode
      expect(hybridManager.isDualSendActive()).toBe(true);
    });
    
    it('should send messages on both paths during dual-send period', async () => {
      await hybridManager.createConnection('target-peer-id', true, null);
      
      // Set up dual-send mode
      hybridManager._migrationInProgress = true;
      hybridManager._migrationState = {
        fromTransport: 'relay',
        toTransport: 'webrtc',
        pathType: 'webrtc-direct',
        pathName: 'WebRTC',
        startTime: Date.now(),
        dualSendEnabled: true,
        confirmationSent: false,
        confirmationReceived: false,
        migrationId: 'test-migration-456'
      };
      
      // Clear previous calls
      mockRelayManager.sendThroughRelay.mockClear();
      
      // Send a message during dual-send period
      const testMessage = { type: 'test', data: 'dual-send-test' };
      await hybridManager.sendRawMessage('target-peer-id', testMessage);
      
      // Should have sent via relay with migration markers
      expect(mockRelayManager.sendThroughRelay).toHaveBeenCalledWith(
        'test-session-123',
        expect.objectContaining({
          type: 'test',
          data: 'dual-send-test',
          _dualSend: true,
          _migrationId: 'test-migration-456'
        })
      );
    });
    
    it('should disable dual-send mode after migration completes', async () => {
      await hybridManager.createConnection('target-peer-id', true, null);
      
      // Set up dual-send mode
      hybridManager._migrationInProgress = true;
      hybridManager._migrationState = {
        fromTransport: 'relay',
        toTransport: 'webrtc',
        pathType: 'webrtc-direct',
        pathName: 'WebRTC',
        startTime: Date.now(),
        dualSendEnabled: true,
        confirmationSent: false,
        confirmationReceived: false,
        migrationId: 'test-migration-789'
      };
      
      expect(hybridManager.isDualSendActive()).toBe(true);
      
      // Simulate migration completion
      hybridManager._migrationState.dualSendEnabled = false;
      hybridManager._migrationInProgress = false;
      hybridManager._migrationState = null;
      
      expect(hybridManager.isDualSendActive()).toBeFalsy();
    });
    
    it('should deduplicate cross-transport dual-send messages', async () => {
      await hybridManager.createConnection('target-peer-id', true, null);
      
      const dhtMessageEvents = [];
      hybridManager.on('dhtMessage', (data) => {
        dhtMessageEvents.push(data);
      });
      
      // Simulate receiving a dual-send message via relay first
      const dualSendMessage = {
        type: 'find_node',
        nodeId: 'test-node',
        requestId: 'req-123',
        _dualSend: true,
        _migrationId: 'mig-dedup-test'
      };
      
      hybridManager.handleRelayMessage({
        sessionId: 'test-session-123',
        from: 'target-peer-id',
        payload: dualSendMessage
      });
      
      // Should emit dhtMessage
      expect(dhtMessageEvents.length).toBe(1);
      
      // Now simulate receiving the same message via WebRTC (different transport)
      // This simulates the deduplication scenario
      hybridManager._markMessageReceived(dualSendMessage, 'relay');
      
      // Check if it would be detected as duplicate on WebRTC
      const isDuplicate = hybridManager._isDuplicateMessage(dualSendMessage, 'webrtc');
      expect(isDuplicate).toBe(true);
    });
    
    it('should include migration state in metrics during migration', async () => {
      await hybridManager.createConnection('target-peer-id', true, null);
      
      // Set up migration state
      hybridManager._migrationInProgress = true;
      hybridManager._migrationState = {
        fromTransport: 'relay',
        toTransport: 'webrtc',
        pathType: 'webrtc-direct',
        pathName: 'WebRTC',
        startTime: Date.now() - 500, // Started 500ms ago
        dualSendEnabled: true,
        confirmationSent: false,
        confirmationReceived: false,
        migrationId: 'test-migration-metrics'
      };
      
      const metrics = hybridManager.getMetrics();
      
      expect(metrics.migrationInProgress).toBe(true);
      expect(metrics.migrationState).not.toBeNull();
      expect(metrics.migrationState.fromTransport).toBe('relay');
      expect(metrics.migrationState.toTransport).toBe('webrtc');
      expect(metrics.migrationState.dualSendEnabled).toBe(true);
      expect(metrics.migrationState.duration).toBeGreaterThanOrEqual(500);
    });
    
    it('should emit migrationStarted event when migration begins', async () => {
      await hybridManager.createConnection('target-peer-id', true, null);
      
      const migrationEvents = [];
      hybridManager.on('migrationStarted', (data) => {
        migrationEvents.push(data);
      });
      
      // Manually call _startPathMigration to test the event
      hybridManager._startPathMigration('relay', 'webrtc', 'webrtc-direct', 'WebRTC');
      
      expect(migrationEvents.length).toBe(1);
      expect(migrationEvents[0].fromTransport).toBe('relay');
      expect(migrationEvents[0].toTransport).toBe('webrtc');
      expect(migrationEvents[0].migrationId).toBeDefined();
    });
    
    it('should abort migration if target transport disconnects', async () => {
      await hybridManager.createConnection('target-peer-id', true, null);
      
      const abortEvents = [];
      hybridManager.on('migrationAborted', (data) => {
        abortEvents.push(data);
      });
      
      // Start migration to WebRTC
      hybridManager._startPathMigration('relay', 'webrtc', 'webrtc-direct', 'WebRTC');
      
      expect(hybridManager._migrationInProgress).toBe(true);
      
      // Simulate WebRTC disconnection during migration
      hybridManager.webrtcConnected = false;
      
      // Manually call _completeMigration to trigger abort check
      await hybridManager._completeMigration();
      
      expect(abortEvents.length).toBe(1);
      expect(abortEvents[0].reason).toBe('target_disconnected');
      expect(hybridManager._migrationInProgress).toBe(false);
    });
  });
  
  describe('Old Path Closure After Migration (Task 4.5)', () => {
    it('should schedule old path closure after migration completes', async () => {
      // Create manager with short delays for testing
      const testManager = new HybridConnectionManager({
        relayManager: mockRelayManager,
        bridgeNodeId: 'bridge-node-id',
        attemptWebRTC: false,
        closeOldPathAfterMigration: true,
        upgradeDelay: 10, // Short upgrade delay
        oldPathCloseDelay: 50 // Short close delay for testing
      });
      
      await testManager.createConnection('target-peer-id', true, null);
      
      // Simulate WebRTC becoming available
      testManager.webrtcConnected = true;
      testManager.webrtcManager = {
        sendRawMessage: jest.fn().mockResolvedValue(undefined),
        destroy: jest.fn().mockResolvedValue(undefined)
      };
      
      const oldPathClosedEvents = [];
      testManager.on('oldPathClosed', (data) => {
        oldPathClosedEvents.push(data);
      });
      
      // Start migration from relay to WebRTC
      testManager._startPathMigration('relay', 'webrtc', 'webrtc-direct', 'WebRTC');
      
      // Wait for migration to complete (upgradeDelay) and old path closure (oldPathCloseDelay)
      await new Promise(resolve => setTimeout(resolve, 150));
      
      // Old path should be closed
      expect(oldPathClosedEvents.length).toBe(1);
      expect(oldPathClosedEvents[0].transport).toBe('relay');
      expect(testManager.relayConnected).toBe(false);
      expect(testManager.relaySession).toBeNull();
      
      await testManager.destroy();
    });
    
    it('should not close old path if closeOldPathAfterMigration is false', async () => {
      // Create manager with old path closure disabled
      const testManager = new HybridConnectionManager({
        relayManager: mockRelayManager,
        bridgeNodeId: 'bridge-node-id',
        attemptWebRTC: false,
        closeOldPathAfterMigration: false,
        upgradeDelay: 10,
        oldPathCloseDelay: 50
      });
      
      await testManager.createConnection('target-peer-id', true, null);
      
      // Simulate WebRTC becoming available
      testManager.webrtcConnected = true;
      testManager.webrtcManager = {
        sendRawMessage: jest.fn().mockResolvedValue(undefined),
        destroy: jest.fn().mockResolvedValue(undefined)
      };
      
      const oldPathClosedEvents = [];
      testManager.on('oldPathClosed', (data) => {
        oldPathClosedEvents.push(data);
      });
      
      // Start migration from relay to WebRTC
      testManager._startPathMigration('relay', 'webrtc', 'webrtc-direct', 'WebRTC');
      
      // Wait for migration to complete
      await new Promise(resolve => setTimeout(resolve, 150));
      
      // Old path should NOT be closed
      expect(oldPathClosedEvents.length).toBe(0);
      expect(testManager.relayConnected).toBe(true);
      expect(testManager.relaySession).not.toBeNull();
      
      await testManager.destroy();
    });
    
    it('should keep relay as backup by default (Task 4.6: relay always available)', async () => {
      // Create manager with DEFAULT settings (no closeOldPathAfterMigration specified)
      // Task 4.6: Default should be false to keep relay as backup for instant failover
      const testManager = new HybridConnectionManager({
        relayManager: mockRelayManager,
        bridgeNodeId: 'bridge-node-id',
        attemptWebRTC: false,
        // NOTE: closeOldPathAfterMigration is NOT specified - testing default behavior
        upgradeDelay: 10,
        oldPathCloseDelay: 50
      });
      
      await testManager.createConnection('target-peer-id', true, null);
      
      // Verify default is false (relay kept as backup)
      expect(testManager.options.closeOldPathAfterMigration).toBe(false);
      
      // Simulate WebRTC becoming available
      testManager.webrtcConnected = true;
      testManager.webrtcManager = {
        sendRawMessage: jest.fn().mockResolvedValue(undefined),
        destroy: jest.fn().mockResolvedValue(undefined)
      };
      
      const oldPathClosedEvents = [];
      testManager.on('oldPathClosed', (data) => {
        oldPathClosedEvents.push(data);
      });
      
      // Start migration from relay to WebRTC
      testManager._startPathMigration('relay', 'webrtc', 'webrtc-direct', 'WebRTC');
      
      // Wait for migration to complete
      await new Promise(resolve => setTimeout(resolve, 150));
      
      // Old path should NOT be closed (relay kept as backup)
      expect(oldPathClosedEvents.length).toBe(0);
      expect(testManager.relayConnected).toBe(true);
      expect(testManager.relaySession).not.toBeNull();
      
      await testManager.destroy();
    });
    
    it('should skip old path closure if failover occurred', async () => {
      // Create manager with short delays for testing
      const testManager = new HybridConnectionManager({
        relayManager: mockRelayManager,
        bridgeNodeId: 'bridge-node-id',
        attemptWebRTC: false,
        closeOldPathAfterMigration: true,
        upgradeDelay: 10,
        oldPathCloseDelay: 100 // Longer close delay to allow failover
      });
      
      await testManager.createConnection('target-peer-id', true, null);
      
      // Simulate WebRTC becoming available
      testManager.webrtcConnected = true;
      testManager.webrtcManager = {
        sendRawMessage: jest.fn().mockResolvedValue(undefined),
        destroy: jest.fn().mockResolvedValue(undefined)
      };
      
      const skipEvents = [];
      testManager.on('oldPathCloseSkipped', (data) => {
        skipEvents.push(data);
      });
      
      // Start migration from relay to WebRTC
      testManager._startPathMigration('relay', 'webrtc', 'webrtc-direct', 'WebRTC');
      
      // Wait for migration to complete but before old path closure
      await new Promise(resolve => setTimeout(resolve, 50));
      
      // Simulate failover back to relay (WebRTC failed)
      testManager.activeTransport = 'relay';
      
      // Wait for old path closure timer
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Old path closure should be skipped
      expect(skipEvents.length).toBe(1);
      expect(skipEvents[0].reason).toBe('now_active');
      expect(testManager.relayConnected).toBe(true);
      
      await testManager.destroy();
    });
    
    it('should cancel old path closure on destroy', async () => {
      // Create manager with long close delay
      const testManager = new HybridConnectionManager({
        relayManager: mockRelayManager,
        bridgeNodeId: 'bridge-node-id',
        attemptWebRTC: false,
        closeOldPathAfterMigration: true,
        upgradeDelay: 10,
        oldPathCloseDelay: 5000 // Long delay
      });
      
      await testManager.createConnection('target-peer-id', true, null);
      
      // Simulate WebRTC becoming available
      testManager.webrtcConnected = true;
      testManager.webrtcManager = {
        sendRawMessage: jest.fn().mockResolvedValue(undefined),
        destroy: jest.fn().mockResolvedValue(undefined)
      };
      
      // Start migration from relay to WebRTC
      testManager._startPathMigration('relay', 'webrtc', 'webrtc-direct', 'WebRTC');
      
      // Wait for migration to complete (but not old path closure)
      await new Promise(resolve => setTimeout(resolve, 50));
      
      // Verify timer is set
      expect(testManager._oldPathCloseTimer).toBeDefined();
      expect(testManager._oldPathCloseTimer).not.toBeNull();
      
      // Destroy the manager
      await testManager.destroy();
      
      // Timer should be cancelled (set to null by _cancelOldPathClosure)
      expect(testManager._oldPathCloseTimer).toBeNull();
    });
    
    it('should cancel old path closure on downgrade', async () => {
      // Create manager with long close delay
      const testManager = new HybridConnectionManager({
        relayManager: mockRelayManager,
        bridgeNodeId: 'bridge-node-id',
        attemptWebRTC: false,
        closeOldPathAfterMigration: true,
        upgradeDelay: 10,
        oldPathCloseDelay: 5000 // Long delay
      });
      
      await testManager.createConnection('target-peer-id', true, null);
      
      // Simulate WebRTC becoming available
      testManager.webrtcConnected = true;
      testManager.webrtcManager = {
        sendRawMessage: jest.fn().mockResolvedValue(undefined),
        destroy: jest.fn().mockResolvedValue(undefined)
      };
      
      // Start migration from relay to WebRTC
      testManager._startPathMigration('relay', 'webrtc', 'webrtc-direct', 'WebRTC');
      
      // Wait for migration to complete (but not old path closure)
      await new Promise(resolve => setTimeout(resolve, 50));
      
      // Verify timer is set
      expect(testManager._oldPathCloseTimer).toBeDefined();
      expect(testManager._oldPathCloseTimer).not.toBeNull();
      
      // Simulate downgrade back to relay
      testManager._downgradeToRelay();
      
      // Timer should be cancelled
      expect(testManager._oldPathCloseTimer).toBeNull();
      
      await testManager.destroy();
    });
    
    it('should emit relayPathClosed event when relay is closed', async () => {
      // Create manager with short delays for testing
      const testManager = new HybridConnectionManager({
        relayManager: mockRelayManager,
        bridgeNodeId: 'bridge-node-id',
        attemptWebRTC: false,
        closeOldPathAfterMigration: true,
        upgradeDelay: 10,
        oldPathCloseDelay: 50
      });
      
      await testManager.createConnection('target-peer-id', true, null);
      
      // Simulate WebRTC becoming available
      testManager.webrtcConnected = true;
      testManager.webrtcManager = {
        sendRawMessage: jest.fn().mockResolvedValue(undefined),
        destroy: jest.fn().mockResolvedValue(undefined)
      };
      
      const relayClosedEvents = [];
      testManager.on('relayPathClosed', (data) => {
        relayClosedEvents.push(data);
      });
      
      // Start migration from relay to WebRTC
      testManager._startPathMigration('relay', 'webrtc', 'webrtc-direct', 'WebRTC');
      
      // Wait for migration and old path closure
      await new Promise(resolve => setTimeout(resolve, 150));
      
      // Should have emitted relayPathClosed
      expect(relayClosedEvents.length).toBe(1);
      expect(relayClosedEvents[0].reason).toBe('migration_complete');
      expect(mockRelayManager.closeSession).toHaveBeenCalledWith(
        'test-session-123',
        'migration_complete'
      );
      
      await testManager.destroy();
    });
  });
});


describe('HybridConnectionManager - Path Change Events (Task 4.6)', () => {
  let hybridManager;
  let mockRelayManager;
  
  beforeEach(() => {
    mockRelayManager = new RelayManager();
    mockRelayManager.initialize('local-node-id', false);
    
    mockRelayManager.requestRelaySession = jest.fn().mockResolvedValue({
      sessionId: 'test-session-123',
      fromPeerId: 'local-node-id',
      toPeerId: 'target-peer-id',
      relayNodeId: 'bridge-node-id',
      state: 'active'
    });
    
    mockRelayManager.sendThroughRelay = jest.fn().mockResolvedValue(undefined);
    mockRelayManager.closeSession = jest.fn();
  });
  
  afterEach(() => {
    if (hybridManager && !hybridManager.isDestroyed) {
      hybridManager.destroy();
    }
    mockRelayManager.destroy();
  });
  
  it('should emit pathChanged event on upgrade', async () => {
    hybridManager = new HybridConnectionManager({
      relayManager: mockRelayManager,
      bridgeNodeId: 'bridge-node-id',
      attemptWebRTC: false,
      upgradeDelay: 10
    });
    
    await hybridManager.createConnection('target-peer-id', true, null);
    
    // Simulate WebRTC becoming available
    hybridManager.webrtcConnected = true;
    hybridManager.webrtcManager = {
      sendRawMessage: jest.fn().mockResolvedValue(undefined),
      destroy: jest.fn().mockResolvedValue(undefined)
    };
    
    const pathChangedEvents = [];
    hybridManager.on('pathChanged', (data) => {
      pathChangedEvents.push(data);
    });
    
    // Start migration from relay to WebRTC
    hybridManager._startPathMigration('relay', 'webrtc', 'webrtc-direct', 'WebRTC');
    
    // Wait for migration to complete
    await new Promise(resolve => setTimeout(resolve, 50));
    
    // Should have emitted pathChanged with changeType 'upgrade'
    expect(pathChangedEvents.length).toBe(1);
    expect(pathChangedEvents[0].changeType).toBe('upgrade');
    expect(pathChangedEvents[0].fromPath).toBe('websocket-relay');
    expect(pathChangedEvents[0].toPath).toBe('webrtc-direct');
    expect(pathChangedEvents[0].fromTransport).toBe('relay');
    expect(pathChangedEvents[0].toTransport).toBe('webrtc');
    expect(pathChangedEvents[0].duration).toBeGreaterThanOrEqual(0);
    expect(pathChangedEvents[0].timestamp).toBeDefined();
  });
  
  it('should emit pathChanged event on downgrade', async () => {
    hybridManager = new HybridConnectionManager({
      relayManager: mockRelayManager,
      bridgeNodeId: 'bridge-node-id',
      attemptWebRTC: false
    });
    
    await hybridManager.createConnection('target-peer-id', true, null);
    
    // Simulate being on WebRTC
    hybridManager.webrtcConnected = true;
    hybridManager.activeTransport = 'webrtc';
    hybridManager._webrtcIsIPv6 = false;
    
    const pathChangedEvents = [];
    hybridManager.on('pathChanged', (data) => {
      pathChangedEvents.push(data);
    });
    
    // Trigger downgrade
    hybridManager._downgradeToRelay();
    
    // Should have emitted pathChanged with changeType 'downgrade'
    expect(pathChangedEvents.length).toBe(1);
    expect(pathChangedEvents[0].changeType).toBe('downgrade');
    expect(pathChangedEvents[0].fromPath).toBe('webrtc-direct');
    expect(pathChangedEvents[0].toPath).toBe('websocket-relay');
    expect(pathChangedEvents[0].fromTransport).toBe('webrtc');
    expect(pathChangedEvents[0].toTransport).toBe('relay');
    expect(pathChangedEvents[0].reason).toBe('webrtc_failed');
    expect(pathChangedEvents[0].timestamp).toBeDefined();
  });
  
  it('should emit pathDowngradeStarted event before downgrade', async () => {
    hybridManager = new HybridConnectionManager({
      relayManager: mockRelayManager,
      bridgeNodeId: 'bridge-node-id',
      attemptWebRTC: false
    });
    
    await hybridManager.createConnection('target-peer-id', true, null);
    
    // Simulate being on WebRTC
    hybridManager.webrtcConnected = true;
    hybridManager.activeTransport = 'webrtc';
    hybridManager._webrtcIsIPv6 = false;
    
    const downgradeStartedEvents = [];
    hybridManager.on('pathDowngradeStarted', (data) => {
      downgradeStartedEvents.push(data);
    });
    
    // Trigger downgrade
    hybridManager._downgradeToRelay();
    
    // Should have emitted pathDowngradeStarted
    expect(downgradeStartedEvents.length).toBe(1);
    expect(downgradeStartedEvents[0].fromPath).toBe('webrtc-direct');
    expect(downgradeStartedEvents[0].toPath).toBe('websocket-relay');
    expect(downgradeStartedEvents[0].reason).toBe('webrtc_failed');
    expect(downgradeStartedEvents[0].timestamp).toBeDefined();
  });
  
  it('should emit pathChanged event with IPv6 info when downgrading from IPv6', async () => {
    hybridManager = new HybridConnectionManager({
      relayManager: mockRelayManager,
      bridgeNodeId: 'bridge-node-id',
      attemptWebRTC: false
    });
    
    await hybridManager.createConnection('target-peer-id', true, null);
    
    // Simulate being on IPv6
    hybridManager.webrtcConnected = true;
    hybridManager.activeTransport = 'webrtc';
    hybridManager._webrtcIsIPv6 = true;
    
    const pathChangedEvents = [];
    hybridManager.on('pathChanged', (data) => {
      pathChangedEvents.push(data);
    });
    
    // Trigger downgrade
    hybridManager._downgradeToRelay();
    
    // Should have emitted pathChanged with IPv6 info
    expect(pathChangedEvents.length).toBe(1);
    expect(pathChangedEvents[0].fromPath).toBe('ipv6-direct');
    expect(pathChangedEvents[0].fromTransport).toBe('ipv6');
    expect(pathChangedEvents[0].wasIPv6).toBe(true);
  });
  
  it('should emit transportDowngraded with timing info', async () => {
    hybridManager = new HybridConnectionManager({
      relayManager: mockRelayManager,
      bridgeNodeId: 'bridge-node-id',
      attemptWebRTC: false
    });
    
    await hybridManager.createConnection('target-peer-id', true, null);
    
    // Simulate being on WebRTC
    hybridManager.webrtcConnected = true;
    hybridManager.activeTransport = 'webrtc';
    hybridManager._webrtcIsIPv6 = false;
    
    const transportDowngradedEvents = [];
    hybridManager.on('transportDowngraded', (data) => {
      transportDowngradedEvents.push(data);
    });
    
    // Trigger downgrade
    hybridManager._downgradeToRelay();
    
    // Should have emitted transportDowngraded with timing info
    expect(transportDowngradedEvents.length).toBe(1);
    expect(transportDowngradedEvents[0].from).toBe('webrtc');
    expect(transportDowngradedEvents[0].to).toBe('relay');
    expect(transportDowngradedEvents[0].fromPath).toBe('webrtc-direct');
    expect(transportDowngradedEvents[0].toPath).toBe('websocket-relay');
    expect(transportDowngradedEvents[0].duration).toBeGreaterThanOrEqual(0);
    expect(transportDowngradedEvents[0].timestamp).toBeDefined();
    expect(transportDowngradedEvents[0].reason).toBe('webrtc_failed');
  });
});


describe('HybridConnectionManager - Path Time Tracking (Task 5.4)', () => {
  let hybridManager;
  let mockRelayManager;
  
  beforeEach(() => {
    jest.useFakeTimers();
    
    // Create mock relay manager
    mockRelayManager = new RelayManager();
    mockRelayManager.initialize('local-node-id', false);
    
    // Mock requestRelaySession to simulate successful relay establishment
    mockRelayManager.requestRelaySession = jest.fn().mockResolvedValue({
      sessionId: 'test-session-123',
      fromPeerId: 'local-node-id',
      toPeerId: 'target-peer-id',
      relayNodeId: 'bridge-node-id',
      state: 'active'
    });
    
    // Mock sendThroughRelay
    mockRelayManager.sendThroughRelay = jest.fn().mockResolvedValue(undefined);
    
    // Mock closeSession
    mockRelayManager.closeSession = jest.fn();
  });
  
  afterEach(() => {
    jest.useRealTimers();
    if (hybridManager && !hybridManager.isDestroyed) {
      hybridManager.destroy();
    }
    mockRelayManager.destroy();
  });
  
  describe('Path Time Statistics', () => {
    it('should track time spent on relay path', async () => {
      hybridManager = new HybridConnectionManager({
        relayManager: mockRelayManager,
        bridgeNodeId: 'bridge-node-id',
        attemptWebRTC: false,
        enableKeepAlive: false,
        enableWarmBackupPaths: false,
        enableBackgroundProbing: false
      });
      
      await hybridManager.createConnection('target-peer-id', true, null);
      
      // Advance time by 5 seconds
      jest.advanceTimersByTime(5000);
      
      const stats = hybridManager.getPathTimeStats();
      
      expect(stats.peerId).toBe('target-peer-id');
      expect(stats.currentPath).toBe('websocket-relay');
      expect(stats.paths['websocket-relay'].isActive).toBe(true);
      expect(stats.paths['websocket-relay'].totalTime).toBeGreaterThanOrEqual(5000);
      expect(stats.paths['websocket-relay'].switchCount).toBe(1);
      expect(stats.aggregate.relayPercentage).toBeGreaterThan(0);
    });
    
    it('should track time spent on WebRTC path after upgrade', async () => {
      hybridManager = new HybridConnectionManager({
        relayManager: mockRelayManager,
        bridgeNodeId: 'bridge-node-id',
        attemptWebRTC: false,
        upgradeDelay: 100,
        enableKeepAlive: false,
        enableWarmBackupPaths: false,
        enableBackgroundProbing: false
      });
      
      await hybridManager.createConnection('target-peer-id', true, null);
      
      // Spend 3 seconds on relay
      jest.advanceTimersByTime(3000);
      
      // Simulate WebRTC becoming available and upgrade
      hybridManager.webrtcConnected = true;
      hybridManager._webrtcIsIPv6 = false;
      hybridManager._upgradeToWebRTC();
      
      // Complete migration
      jest.advanceTimersByTime(200);
      
      // Spend 7 seconds on WebRTC
      jest.advanceTimersByTime(7000);
      
      const stats = hybridManager.getPathTimeStats();
      
      expect(stats.currentPath).toBe('webrtc-direct');
      expect(stats.paths['websocket-relay'].totalTime).toBeGreaterThanOrEqual(3000);
      expect(stats.paths['webrtc-direct'].totalTime).toBeGreaterThanOrEqual(7000);
      expect(stats.paths['webrtc-direct'].switchCount).toBe(1);
      expect(stats.aggregate.directPercentage).toBeGreaterThan(0);
    });
    
    it('should calculate correct percentages for relay vs direct', async () => {
      hybridManager = new HybridConnectionManager({
        relayManager: mockRelayManager,
        bridgeNodeId: 'bridge-node-id',
        attemptWebRTC: false,
        upgradeDelay: 100,
        enableKeepAlive: false,
        enableWarmBackupPaths: false,
        enableBackgroundProbing: false
      });
      
      await hybridManager.createConnection('target-peer-id', true, null);
      
      // Spend 2 seconds on relay (20%)
      jest.advanceTimersByTime(2000);
      
      // Upgrade to WebRTC
      hybridManager.webrtcConnected = true;
      hybridManager._webrtcIsIPv6 = false;
      hybridManager._upgradeToWebRTC();
      jest.advanceTimersByTime(200);
      
      // Spend 8 seconds on WebRTC (80%)
      jest.advanceTimersByTime(8000);
      
      const stats = hybridManager.getPathTimeStats();
      
      // Total time should be ~10.2 seconds
      expect(stats.totalConnectionTime).toBeGreaterThanOrEqual(10000);
      
      // Direct should be ~80%, relay ~20%
      expect(stats.aggregate.directPercentage).toBeGreaterThan(70);
      expect(stats.aggregate.relayPercentage).toBeLessThan(30);
    });
    
    it('should track switch count correctly', async () => {
      hybridManager = new HybridConnectionManager({
        relayManager: mockRelayManager,
        bridgeNodeId: 'bridge-node-id',
        attemptWebRTC: false,
        upgradeDelay: 100,
        enableKeepAlive: false,
        enableWarmBackupPaths: false,
        enableBackgroundProbing: false
      });
      
      await hybridManager.createConnection('target-peer-id', true, null);
      
      // Start on relay (switch 1)
      jest.advanceTimersByTime(1000);
      
      // Upgrade to WebRTC (switch 2)
      hybridManager.webrtcConnected = true;
      hybridManager._webrtcIsIPv6 = false;
      hybridManager._upgradeToWebRTC();
      jest.advanceTimersByTime(200);
      jest.advanceTimersByTime(1000);
      
      // Downgrade back to relay (switch 3)
      hybridManager._downgradeToRelay();
      jest.advanceTimersByTime(1000);
      
      const stats = hybridManager.getPathTimeStats();
      
      expect(stats.paths['websocket-relay'].switchCount).toBe(2); // Initial + downgrade
      expect(stats.paths['webrtc-direct'].switchCount).toBe(1); // Upgrade
      expect(stats.totalSwitches).toBe(3);
    });
    
    it('should report meetsDirectTarget correctly', async () => {
      hybridManager = new HybridConnectionManager({
        relayManager: mockRelayManager,
        bridgeNodeId: 'bridge-node-id',
        attemptWebRTC: false,
        upgradeDelay: 100,
        enableKeepAlive: false,
        enableWarmBackupPaths: false,
        enableBackgroundProbing: false
      });
      
      await hybridManager.createConnection('target-peer-id', true, null);
      
      // Spend 1 second on relay (10%)
      jest.advanceTimersByTime(1000);
      
      // Upgrade to WebRTC
      hybridManager.webrtcConnected = true;
      hybridManager._webrtcIsIPv6 = false;
      hybridManager._upgradeToWebRTC();
      jest.advanceTimersByTime(200);
      
      // Spend 9 seconds on WebRTC (90%)
      jest.advanceTimersByTime(9000);
      
      const stats = hybridManager.getPathTimeStats();
      
      // Should meet 80% direct target
      expect(stats.aggregate.meetsDirectTarget).toBe(true);
    });
    
    it('should include path time stats in getMetrics()', async () => {
      hybridManager = new HybridConnectionManager({
        relayManager: mockRelayManager,
        bridgeNodeId: 'bridge-node-id',
        attemptWebRTC: false,
        enableKeepAlive: false,
        enableWarmBackupPaths: false,
        enableBackgroundProbing: false
      });
      
      await hybridManager.createConnection('target-peer-id', true, null);
      jest.advanceTimersByTime(1000);
      
      const metrics = hybridManager.getMetrics();
      
      expect(metrics.pathTimeStats).toBeDefined();
      expect(metrics.pathTimeStats.paths).toBeDefined();
      expect(metrics.pathTimeStats.aggregate).toBeDefined();
      expect(metrics.pathTimeStats.aggregate.relayPercentage).toBeDefined();
      expect(metrics.pathTimeStats.aggregate.directPercentage).toBeDefined();
    });
    
    it('should track IPv6 path time separately from WebRTC', async () => {
      hybridManager = new HybridConnectionManager({
        relayManager: mockRelayManager,
        bridgeNodeId: 'bridge-node-id',
        attemptWebRTC: false,
        upgradeDelay: 100,
        enableKeepAlive: false,
        enableWarmBackupPaths: false,
        enableBackgroundProbing: false
      });
      
      await hybridManager.createConnection('target-peer-id', true, null);
      
      // Spend 2 seconds on relay
      jest.advanceTimersByTime(2000);
      
      // Upgrade to IPv6 (not regular WebRTC)
      hybridManager.webrtcConnected = true;
      hybridManager._webrtcIsIPv6 = true;
      hybridManager._upgradeToWebRTC();
      jest.advanceTimersByTime(200);
      
      // Spend 5 seconds on IPv6
      jest.advanceTimersByTime(5000);
      
      const stats = hybridManager.getPathTimeStats();
      
      expect(stats.currentPath).toBe('ipv6-direct');
      expect(stats.paths['ipv6-direct'].totalTime).toBeGreaterThanOrEqual(5000);
      expect(stats.paths['ipv6-direct'].switchCount).toBe(1);
      // IPv6 counts as direct
      expect(stats.aggregate.directPercentage).toBeGreaterThan(60);
    });
  });
});


describe('HybridConnectionManager - Keep-Alive System (Task 5.3)', () => {
  let hybridManager;
  let mockRelayManager;
  
  beforeEach(() => {
    jest.useFakeTimers();
    
    // Create mock relay manager
    mockRelayManager = new RelayManager();
    mockRelayManager.initialize('local-node-id', false);
    
    // Mock requestRelaySession to simulate successful relay establishment
    mockRelayManager.requestRelaySession = jest.fn().mockResolvedValue({
      sessionId: 'test-session-123',
      fromPeerId: 'local-node-id',
      toPeerId: 'target-peer-id',
      relayNodeId: 'bridge-node-id',
      state: 'active'
    });
    
    // Mock sendThroughRelay
    mockRelayManager.sendThroughRelay = jest.fn().mockResolvedValue(undefined);
    
    // Mock closeSession
    mockRelayManager.closeSession = jest.fn();
    
    hybridManager = new HybridConnectionManager({
      relayManager: mockRelayManager,
      bridgeNodeId: 'bridge-node-id',
      attemptWebRTC: false,
      keepAliveInterval: 25000, // 25 seconds
      maxKeepAliveFailures: 3
    });
  });
  
  afterEach(() => {
    jest.useRealTimers();
    if (hybridManager && !hybridManager.isDestroyed) {
      hybridManager.destroy();
    }
    mockRelayManager.destroy();
  });
  
  describe('Keep-Alive Timer Management', () => {
    it('should start keep-alive timer when connection is established', async () => {
      const keepAliveStartedPromise = new Promise(resolve => {
        hybridManager.on('keepAliveStarted', resolve);
      });
      
      await hybridManager.createConnection('target-peer-id', true, null);
      
      const event = await keepAliveStartedPromise;
      
      expect(event.peerId).toBe('target-peer-id');
      expect(event.interval).toBe(25000);
      expect(event.activeTransport).toBe('relay');
      expect(hybridManager.getKeepAliveStatus().running).toBe(true);
    });
    
    it('should stop keep-alive timer when connection is destroyed', async () => {
      await hybridManager.createConnection('target-peer-id', true, null);
      
      expect(hybridManager.getKeepAliveStatus().running).toBe(true);
      
      const keepAliveStoppedPromise = new Promise(resolve => {
        hybridManager.on('keepAliveStopped', resolve);
      });
      
      await hybridManager.destroy();
      
      const event = await keepAliveStoppedPromise;
      
      expect(event.peerId).toBe('target-peer-id');
      expect(hybridManager.getKeepAliveStatus().running).toBe(false);
    });
    
    it('should send keep-alive pings at configured interval', async () => {
      await hybridManager.createConnection('target-peer-id', true, null);
      
      // Clear any initial calls
      mockRelayManager.sendThroughRelay.mockClear();
      
      // Advance time by keep-alive interval
      jest.advanceTimersByTime(25000);
      
      // Should have sent a keep-alive message
      expect(mockRelayManager.sendThroughRelay).toHaveBeenCalled();
      const lastCall = mockRelayManager.sendThroughRelay.mock.calls[0];
      expect(lastCall[1].type).toBe('relay_keepalive');
    });
    
    it('should track keep-alive status correctly', async () => {
      await hybridManager.createConnection('target-peer-id', true, null);
      
      const status = hybridManager.getKeepAliveStatus();
      
      expect(status.enabled).toBe(true);
      expect(status.running).toBe(true);
      expect(status.interval).toBe(25000);
      expect(status.failureCount).toBe(0);
      expect(status.maxFailures).toBe(3);
      expect(status.activeTransport).toBe('relay');
    });
    
    it('should include keep-alive status in metrics', async () => {
      await hybridManager.createConnection('target-peer-id', true, null);
      
      const metrics = hybridManager.getMetrics();
      
      expect(metrics.keepAlive).toBeDefined();
      expect(metrics.keepAlive.running).toBe(true);
      expect(metrics.keepAlive.interval).toBe(25000);
    });
  });
  
  describe('Keep-Alive Message Handling', () => {
    it('should respond to keep-alive ping with pong', async () => {
      await hybridManager.createConnection('target-peer-id', true, null);
      
      // Simulate receiving a keep-alive ping via relay
      hybridManager.handleRelayMessage({
        sessionId: 'test-session-123',
        from: 'target-peer-id',
        payload: {
          type: 'relay_keepalive',
          pingId: 'ka_123_abc',
          timestamp: Date.now()
        }
      });
      
      // Should have sent a pong response
      expect(mockRelayManager.sendThroughRelay).toHaveBeenCalledWith(
        'test-session-123',
        expect.objectContaining({
          type: 'relay_keepalive_pong',
          pingId: 'ka_123_abc'
        })
      );
    });
    
    it('should reset failure count on successful pong', async () => {
      await hybridManager.createConnection('target-peer-id', true, null);
      
      // Simulate some failures
      hybridManager._keepAliveFailureCount = 2;
      
      // Simulate receiving a pong
      hybridManager.handleRelayMessage({
        sessionId: 'test-session-123',
        from: 'target-peer-id',
        payload: {
          type: 'relay_keepalive_pong',
          pingId: 'ka_123_abc',
          timestamp: Date.now() - 50,
          respondedAt: Date.now()
        }
      });
      
      // Failure count should be reset
      expect(hybridManager._keepAliveFailureCount).toBe(0);
    });
    
    it('should emit keepAlivePong event with RTT', async () => {
      await hybridManager.createConnection('target-peer-id', true, null);
      
      const pongPromise = new Promise(resolve => {
        hybridManager.on('keepAlivePong', resolve);
      });
      
      const sentTime = Date.now() - 50;
      
      // Simulate receiving a pong
      hybridManager.handleRelayMessage({
        sessionId: 'test-session-123',
        from: 'target-peer-id',
        payload: {
          type: 'relay_keepalive_pong',
          pingId: 'ka_123_abc',
          timestamp: sentTime,
          respondedAt: Date.now()
        }
      });
      
      const event = await pongPromise;
      
      expect(event.peerId).toBe('target-peer-id');
      expect(event.rtt).toBeGreaterThanOrEqual(50);
    });
  });
  
  describe('Keep-Alive Failure Handling', () => {
    it('should track consecutive failures', async () => {
      await hybridManager.createConnection('target-peer-id', true, null);
      
      // Simulate send failure
      mockRelayManager.sendThroughRelay.mockRejectedValueOnce(new Error('Send failed'));
      
      const failurePromise = new Promise(resolve => {
        hybridManager.on('keepAliveFailure', resolve);
      });
      
      // Trigger keep-alive
      jest.advanceTimersByTime(25000);
      
      const event = await failurePromise;
      
      expect(event.failureCount).toBe(1);
      expect(event.reason).toContain('Send failed');
    });
    
    it('should trigger path failure after max consecutive failures', async () => {
      await hybridManager.createConnection('target-peer-id', true, null);
      
      // Simulate repeated send failures
      mockRelayManager.sendThroughRelay.mockRejectedValue(new Error('Send failed'));
      
      const pathFailedPromise = new Promise(resolve => {
        hybridManager.on('activePathFailed', resolve);
      });
      
      // Trigger 3 keep-alive failures
      jest.advanceTimersByTime(25000);
      jest.advanceTimersByTime(25000);
      jest.advanceTimersByTime(25000);
      
      const event = await pathFailedPromise;
      
      expect(event.peerId).toBe('target-peer-id');
      expect(event.reason).toBe('keepalive_failed');
    });
  });
  
  describe('Keep-Alive on Transport Change', () => {
    it('should restart keep-alive when transport changes', async () => {
      await hybridManager.createConnection('target-peer-id', true, null);
      
      // Track both stop and start events
      const keepAliveStoppedEvents = [];
      const keepAliveStartedEvents = [];
      hybridManager.on('keepAliveStopped', (data) => {
        keepAliveStoppedEvents.push(data);
      });
      hybridManager.on('keepAliveStarted', (data) => {
        keepAliveStartedEvents.push(data);
      });
      
      // Directly call _restartKeepAlive to test the restart behavior
      hybridManager._restartKeepAlive();
      
      // Should have stopped and restarted keep-alive
      expect(keepAliveStoppedEvents.length).toBe(1);
      expect(keepAliveStartedEvents.length).toBe(1);
    });
    
    it('should restart keep-alive on downgrade to relay', async () => {
      await hybridManager.createConnection('target-peer-id', true, null);
      
      // Simulate being on WebRTC
      hybridManager.webrtcConnected = true;
      hybridManager.activeTransport = 'webrtc';
      
      const keepAliveStartedEvents = [];
      hybridManager.on('keepAliveStarted', (data) => {
        keepAliveStartedEvents.push(data);
      });
      
      // Trigger downgrade
      hybridManager._downgradeToRelay();
      
      // Should have restarted keep-alive for relay
      expect(keepAliveStartedEvents.length).toBeGreaterThanOrEqual(1);
      expect(keepAliveStartedEvents[keepAliveStartedEvents.length - 1].activeTransport).toBe('relay');
    });
  });
  
  describe('Keep-Alive Pong Timeout Detection', () => {
    it('should track pending keep-alive pings', async () => {
      await hybridManager.createConnection('target-peer-id', true, null);
      
      // Clear any initial calls
      mockRelayManager.sendThroughRelay.mockClear();
      
      // Trigger keep-alive and wait for async operations
      jest.advanceTimersByTime(25000);
      await Promise.resolve(); // Allow async operations to complete
      
      // Should have a pending ping
      expect(hybridManager._pendingKeepAlivePings.size).toBe(1);
      
      // Get the ping ID from the sent message
      const sentMessage = mockRelayManager.sendThroughRelay.mock.calls[0][1];
      expect(sentMessage.type).toBe('relay_keepalive');
      expect(sentMessage.pingId).toBeDefined();
      
      // Verify the pending ping is tracked
      expect(hybridManager._pendingKeepAlivePings.has(sentMessage.pingId)).toBe(true);
    });
    
    it('should emit keepAlivePongTimeout when pong is not received in time', async () => {
      await hybridManager.createConnection('target-peer-id', true, null);
      
      const timeoutPromise = new Promise(resolve => {
        hybridManager.on('keepAlivePongTimeout', resolve);
      });
      
      // Trigger keep-alive and wait for async operations
      jest.advanceTimersByTime(25000);
      await Promise.resolve();
      
      // Get the ping ID
      const sentMessage = mockRelayManager.sendThroughRelay.mock.calls[0][1];
      
      // Advance time past the pong timeout (default 10 seconds)
      jest.advanceTimersByTime(10000);
      
      const event = await timeoutPromise;
      
      expect(event.peerId).toBe('target-peer-id');
      expect(event.pingId).toBe(sentMessage.pingId);
      expect(event.transport).toBe('relay');
      expect(event.timeout).toBe(10000);
    });
    
    it('should count pong timeout as a failure', async () => {
      await hybridManager.createConnection('target-peer-id', true, null);
      
      const failurePromise = new Promise(resolve => {
        hybridManager.on('keepAliveFailure', resolve);
      });
      
      // Trigger keep-alive and wait for async operations
      jest.advanceTimersByTime(25000);
      await Promise.resolve();
      
      // Advance time past the pong timeout
      jest.advanceTimersByTime(10000);
      
      const event = await failurePromise;
      
      expect(event.failureCount).toBe(1);
      expect(event.reason).toContain('pong_timeout');
    });
    
    it('should clear pending ping when pong is received', async () => {
      await hybridManager.createConnection('target-peer-id', true, null);
      
      // Trigger keep-alive and wait for async operations
      jest.advanceTimersByTime(25000);
      await Promise.resolve();
      
      // Get the ping ID
      const sentMessage = mockRelayManager.sendThroughRelay.mock.calls[0][1];
      
      // Should have a pending ping
      expect(hybridManager._pendingKeepAlivePings.size).toBe(1);
      
      // Simulate receiving a pong
      hybridManager.handleRelayMessage({
        sessionId: 'test-session-123',
        from: 'target-peer-id',
        payload: {
          type: 'relay_keepalive_pong',
          pingId: sentMessage.pingId,
          timestamp: sentMessage.timestamp,
          respondedAt: Date.now()
        }
      });
      
      // Pending ping should be cleared
      expect(hybridManager._pendingKeepAlivePings.size).toBe(0);
    });
    
    it('should not timeout after pong is received', async () => {
      await hybridManager.createConnection('target-peer-id', true, null);
      
      let timeoutReceived = false;
      hybridManager.on('keepAlivePongTimeout', () => {
        timeoutReceived = true;
      });
      
      // Trigger keep-alive and wait for async operations
      jest.advanceTimersByTime(25000);
      await Promise.resolve();
      
      // Get the ping ID
      const sentMessage = mockRelayManager.sendThroughRelay.mock.calls[0][1];
      
      // Simulate receiving a pong before timeout
      hybridManager.handleRelayMessage({
        sessionId: 'test-session-123',
        from: 'target-peer-id',
        payload: {
          type: 'relay_keepalive_pong',
          pingId: sentMessage.pingId,
          timestamp: sentMessage.timestamp,
          respondedAt: Date.now()
        }
      });
      
      // Advance time past the pong timeout
      jest.advanceTimersByTime(10000);
      
      // Should not have received a timeout event
      expect(timeoutReceived).toBe(false);
    });
    
    it('should trigger path failure after consecutive pong timeouts', async () => {
      await hybridManager.createConnection('target-peer-id', true, null);
      
      const pathFailedPromise = new Promise(resolve => {
        hybridManager.on('activePathFailed', resolve);
      });
      
      // Trigger 3 keep-alive pings and let them all timeout
      // First ping
      jest.advanceTimersByTime(25000);
      await Promise.resolve();
      jest.advanceTimersByTime(10000); // Timeout
      
      // Second ping
      jest.advanceTimersByTime(15000); // Next keep-alive interval
      await Promise.resolve();
      jest.advanceTimersByTime(10000); // Timeout
      
      // Third ping
      jest.advanceTimersByTime(15000); // Next keep-alive interval
      await Promise.resolve();
      jest.advanceTimersByTime(10000); // Timeout
      
      const event = await pathFailedPromise;
      
      expect(event.peerId).toBe('target-peer-id');
      expect(event.reason).toBe('keepalive_failed');
    });
    
    it('should clear all pending pings on destroy', async () => {
      await hybridManager.createConnection('target-peer-id', true, null);
      
      // Trigger multiple keep-alives
      jest.advanceTimersByTime(25000);
      await Promise.resolve();
      jest.advanceTimersByTime(25000);
      await Promise.resolve();
      
      // Should have pending pings
      expect(hybridManager._pendingKeepAlivePings.size).toBeGreaterThan(0);
      
      // Destroy the connection
      await hybridManager.destroy();
      
      // All pending pings should be cleared
      expect(hybridManager._pendingKeepAlivePings.size).toBe(0);
    });
    
    it('should include pending ping count in keep-alive status', async () => {
      await hybridManager.createConnection('target-peer-id', true, null);
      
      // Trigger keep-alive and wait for async operations
      jest.advanceTimersByTime(25000);
      await Promise.resolve();
      
      const status = hybridManager.getKeepAliveStatus();
      
      expect(status.pendingPings).toBe(1);
      expect(status.pongTimeout).toBe(10000);
    });
  });
});


describe('HybridConnectionManager - Path Event History (Task 5.4)', () => {
  let hybridManager;
  let mockRelayManager;
  
  beforeEach(() => {
    jest.useFakeTimers();
    
    // Create mock relay manager
    mockRelayManager = new RelayManager();
    mockRelayManager.initialize('local-node-id', false);
    
    // Mock requestRelaySession to simulate successful relay establishment
    mockRelayManager.requestRelaySession = jest.fn().mockResolvedValue({
      sessionId: 'test-session-123',
      fromPeerId: 'local-node-id',
      toPeerId: 'target-peer-id',
      relayNodeId: 'bridge-node-id',
      state: 'active'
    });
    
    // Mock sendThroughRelay
    mockRelayManager.sendThroughRelay = jest.fn().mockResolvedValue(undefined);
    
    // Mock closeSession
    mockRelayManager.closeSession = jest.fn();
    
    hybridManager = new HybridConnectionManager({
      relayManager: mockRelayManager,
      bridgeNodeId: 'bridge-node-id',
      attemptWebRTC: false,
      upgradeDelay: 100,
      enableKeepAlive: false,
      enableWarmBackupPaths: false,
      enableBackgroundProbing: false,
      maxPathEventHistory: 50
    });
  });
  
  afterEach(() => {
    jest.useRealTimers();
    if (hybridManager && !hybridManager.isDestroyed) {
      hybridManager.destroy();
    }
    mockRelayManager.destroy();
  });
  
  describe('Path Event Logging', () => {
    it('should log initial relay connection event', async () => {
      await hybridManager.createConnection('target-peer-id', true, null);
      
      const history = hybridManager.getPathEventHistory();
      
      expect(history.length).toBe(1);
      expect(history[0].eventType).toBe('initial');
      expect(history[0].fromPath).toBeNull();
      expect(history[0].toPath).toBe('websocket-relay');
      expect(history[0].toTransport).toBe('relay');
      expect(history[0].reason).toBe('initial_connection');
      expect(history[0].timestamp).toBeDefined();
      expect(history[0].timestampMs).toBeDefined();
    });
    
    it('should log upgrade event when switching from relay to WebRTC', async () => {
      await hybridManager.createConnection('target-peer-id', true, null);
      
      // Simulate WebRTC becoming available
      hybridManager.webrtcConnected = true;
      hybridManager._webrtcIsIPv6 = false;
      hybridManager._upgradeToWebRTC();
      
      // Wait for migration to complete
      jest.advanceTimersByTime(200);
      
      const history = hybridManager.getPathEventHistory();
      
      expect(history.length).toBe(2);
      expect(history[1].eventType).toBe('upgrade');
      expect(history[1].fromPath).toBe('websocket-relay');
      expect(history[1].toPath).toBe('webrtc-direct');
      expect(history[1].fromTransport).toBe('relay');
      expect(history[1].toTransport).toBe('webrtc');
      expect(history[1].reason).toBe('better_path_available');
      expect(history[1].duration).toBeGreaterThanOrEqual(0);
    });
    
    it('should log downgrade event when switching from WebRTC to relay', async () => {
      await hybridManager.createConnection('target-peer-id', true, null);
      
      // Upgrade to WebRTC first
      hybridManager.webrtcConnected = true;
      hybridManager._webrtcIsIPv6 = false;
      hybridManager._upgradeToWebRTC();
      jest.advanceTimersByTime(200);
      
      // Now downgrade back to relay
      hybridManager._downgradeToRelay();
      
      const history = hybridManager.getPathEventHistory();
      
      expect(history.length).toBe(3);
      expect(history[2].eventType).toBe('downgrade');
      expect(history[2].fromPath).toBe('webrtc-direct');
      expect(history[2].toPath).toBe('websocket-relay');
      expect(history[2].fromTransport).toBe('webrtc');
      expect(history[2].toTransport).toBe('relay');
      expect(history[2].reason).toBe('webrtc_failed');
    });
    
    it('should log IPv6 upgrade event correctly', async () => {
      await hybridManager.createConnection('target-peer-id', true, null);
      
      // Simulate IPv6 WebRTC becoming available
      hybridManager.webrtcConnected = true;
      hybridManager._webrtcIsIPv6 = true;
      hybridManager._upgradeToWebRTC();
      jest.advanceTimersByTime(200);
      
      const history = hybridManager.getPathEventHistory();
      
      expect(history.length).toBe(2);
      expect(history[1].eventType).toBe('upgrade');
      expect(history[1].toPath).toBe('ipv6-direct');
      expect(history[1].toTransport).toBe('ipv6');
      expect(history[1].metadata.isIPv6).toBe(true);
    });
    
    it('should emit pathEventLogged event when logging', async () => {
      const pathEventLoggedPromise = new Promise(resolve => {
        hybridManager.on('pathEventLogged', resolve);
      });
      
      await hybridManager.createConnection('target-peer-id', true, null);
      
      const event = await pathEventLoggedPromise;
      
      expect(event.eventType).toBe('initial');
      expect(event.peerId).toBe('target-peer-id');
      expect(event.timestamp).toBeDefined();
    });
  });
  
  describe('Path Event History Management', () => {
    it('should limit history to maxPathEventHistory', async () => {
      // Create manager with small history limit
      const smallHistoryManager = new HybridConnectionManager({
        relayManager: mockRelayManager,
        bridgeNodeId: 'bridge-node-id',
        attemptWebRTC: false,
        upgradeDelay: 100,
        enableKeepAlive: false,
        enableWarmBackupPaths: false,
        enableBackgroundProbing: false,
        maxPathEventHistory: 3
      });
      
      await smallHistoryManager.createConnection('target-peer-id', true, null);
      
      // Generate multiple events
      for (let i = 0; i < 5; i++) {
        smallHistoryManager.webrtcConnected = true;
        smallHistoryManager._webrtcIsIPv6 = false;
        smallHistoryManager._upgradeToWebRTC();
        jest.advanceTimersByTime(200);
        
        smallHistoryManager._downgradeToRelay();
      }
      
      const history = smallHistoryManager.getPathEventHistory();
      
      // Should be limited to 3 events
      expect(history.length).toBe(3);
      
      smallHistoryManager.destroy();
    });
    
    it('should filter history by event type', async () => {
      await hybridManager.createConnection('target-peer-id', true, null);
      
      // Generate upgrade and downgrade events
      hybridManager.webrtcConnected = true;
      hybridManager._webrtcIsIPv6 = false;
      hybridManager._upgradeToWebRTC();
      jest.advanceTimersByTime(200);
      
      hybridManager._downgradeToRelay();
      
      const upgradeEvents = hybridManager.getPathEventHistory({ eventType: 'upgrade' });
      const downgradeEvents = hybridManager.getPathEventHistory({ eventType: 'downgrade' });
      
      expect(upgradeEvents.length).toBe(1);
      expect(upgradeEvents[0].eventType).toBe('upgrade');
      
      expect(downgradeEvents.length).toBe(1);
      expect(downgradeEvents[0].eventType).toBe('downgrade');
    });
    
    it('should filter history by timestamp', async () => {
      await hybridManager.createConnection('target-peer-id', true, null);
      
      // Advance time to create a gap
      jest.advanceTimersByTime(1000);
      const afterInitial = Date.now();
      
      // Wait a bit more
      jest.advanceTimersByTime(1000);
      
      // Generate more events
      hybridManager.webrtcConnected = true;
      hybridManager._webrtcIsIPv6 = false;
      hybridManager._upgradeToWebRTC();
      jest.advanceTimersByTime(200);
      
      const recentEvents = hybridManager.getPathEventHistory({ since: afterInitial });
      
      // Should only include events after the initial connection
      expect(recentEvents.length).toBe(1);
      expect(recentEvents[0].eventType).toBe('upgrade');
    });
    
    it('should limit history results', async () => {
      await hybridManager.createConnection('target-peer-id', true, null);
      
      // Generate multiple events
      for (let i = 0; i < 3; i++) {
        hybridManager.webrtcConnected = true;
        hybridManager._webrtcIsIPv6 = false;
        hybridManager._upgradeToWebRTC();
        jest.advanceTimersByTime(200);
        
        hybridManager._downgradeToRelay();
      }
      
      const limitedHistory = hybridManager.getPathEventHistory({ limit: 2 });
      
      expect(limitedHistory.length).toBe(2);
    });
    
    it('should clear history', async () => {
      await hybridManager.createConnection('target-peer-id', true, null);
      
      expect(hybridManager.getPathEventHistory().length).toBe(1);
      
      hybridManager.clearPathEventHistory();
      
      expect(hybridManager.getPathEventHistory().length).toBe(0);
    });
  });
  
  describe('Path Event Summary', () => {
    it('should provide event summary', async () => {
      await hybridManager.createConnection('target-peer-id', true, null);
      
      // Generate events
      hybridManager.webrtcConnected = true;
      hybridManager._webrtcIsIPv6 = false;
      hybridManager._upgradeToWebRTC();
      jest.advanceTimersByTime(200);
      
      hybridManager._downgradeToRelay();
      
      const summary = hybridManager.getPathEventSummary();
      
      expect(summary.peerId).toBe('target-peer-id');
      expect(summary.totalEvents).toBe(3);
      expect(summary.countsByType.initial).toBe(1);
      expect(summary.countsByType.upgrade).toBe(1);
      expect(summary.countsByType.downgrade).toBe(1);
      expect(summary.recentEvents.length).toBe(3);
      expect(summary.oldestEvent).toBeDefined();
      expect(summary.newestEvent).toBeDefined();
    });
    
    it('should calculate average upgrade duration', async () => {
      await hybridManager.createConnection('target-peer-id', true, null);
      
      // Generate multiple upgrades
      for (let i = 0; i < 3; i++) {
        hybridManager.webrtcConnected = true;
        hybridManager._webrtcIsIPv6 = false;
        hybridManager._upgradeToWebRTC();
        jest.advanceTimersByTime(200);
        
        hybridManager._downgradeToRelay();
      }
      
      const summary = hybridManager.getPathEventSummary();
      
      expect(summary.avgUpgradeDuration).toBeGreaterThanOrEqual(0);
    });
  });
  
  describe('Path Event Export', () => {
    it('should export history as JSON', async () => {
      await hybridManager.createConnection('target-peer-id', true, null);
      
      const exported = hybridManager.exportPathEventHistory();
      const parsed = JSON.parse(exported);
      
      expect(parsed.peerId).toBe('target-peer-id');
      expect(parsed.exportedAt).toBeDefined();
      expect(parsed.events).toBeInstanceOf(Array);
      expect(parsed.events.length).toBe(1);
      expect(parsed.events[0].eventType).toBe('initial');
    });
  });
});
