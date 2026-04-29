/**
 * Unit tests for RelayManager relay node selection algorithm
 * 
 * Tests the scoring algorithm that selects optimal relay nodes based on:
 * 1. Connection status (connected to both peers, target only, local only, or neither)
 * 2. Current load (relayLoad 0-1)
 * 3. Latency (RTT in ms)
 * 4. Available capacity
 */

import { RelayManager } from '../../src/network/RelayManager.js';

describe('RelayManager - Relay Node Selection', () => {
  let relayManager;

  beforeEach(() => {
    relayManager = new RelayManager();
    relayManager.initialize('local-node-id', false);
  });

  afterEach(() => {
    relayManager.destroy();
  });

  describe('_selectRelayNode scoring algorithm', () => {
    it('should return null when no relay nodes available', async () => {
      const result = await relayManager._selectRelayNode('target-peer');
      expect(result).toBeNull();
    });

    it('should select the only available relay node', async () => {
      relayManager.updateRelayNodes([{
        nodeId: 'relay-1',
        metadata: {
          canRelay: true,
          publicAddress: 'wss://relay1.example.com',
          relayLoad: 0.1,
          relayCapacity: 100
        }
      }]);

      const result = await relayManager._selectRelayNode('target-peer');
      expect(result).not.toBeNull();
      expect(result.nodeId).toBe('relay-1');
    });

    it('should prefer relay with lower load', async () => {
      relayManager.updateRelayNodes([
        {
          nodeId: 'relay-high-load',
          metadata: {
            canRelay: true,
            publicAddress: 'wss://relay1.example.com',
            relayLoad: 0.9, // 90% load
            relayCapacity: 100
          }
        },
        {
          nodeId: 'relay-low-load',
          metadata: {
            canRelay: true,
            publicAddress: 'wss://relay2.example.com',
            relayLoad: 0.1, // 10% load
            relayCapacity: 100
          }
        }
      ]);

      const result = await relayManager._selectRelayNode('target-peer');
      expect(result.nodeId).toBe('relay-low-load');
    });

    it('should prefer relay with lower latency', async () => {
      relayManager.updateRelayNodes([
        {
          nodeId: 'relay-high-latency',
          metadata: {
            canRelay: true,
            publicAddress: 'wss://relay1.example.com',
            relayLoad: 0.5,
            relayCapacity: 100
          },
          rtt: 200 // 200ms
        },
        {
          nodeId: 'relay-low-latency',
          metadata: {
            canRelay: true,
            publicAddress: 'wss://relay2.example.com',
            relayLoad: 0.5,
            relayCapacity: 100
          },
          rtt: 20 // 20ms
        }
      ]);

      const result = await relayManager._selectRelayNode('target-peer');
      expect(result.nodeId).toBe('relay-low-latency');
    });

    it('should prefer relay with higher available capacity', async () => {
      relayManager.updateRelayNodes([
        {
          nodeId: 'relay-low-capacity',
          metadata: {
            canRelay: true,
            publicAddress: 'wss://relay1.example.com',
            relayLoad: 0.5,
            relayCapacity: 20 // Only 10 slots available
          }
        },
        {
          nodeId: 'relay-high-capacity',
          metadata: {
            canRelay: true,
            publicAddress: 'wss://relay2.example.com',
            relayLoad: 0.5,
            relayCapacity: 200 // 100 slots available
          }
        }
      ]);

      const result = await relayManager._selectRelayNode('target-peer');
      expect(result.nodeId).toBe('relay-high-capacity');
    });

    it('should strongly prefer relay connected to both peers', async () => {
      // Set up local connected peers
      relayManager.updateLocalConnectedPeers(['relay-both']);
      
      // Set up connection checker that says relay-both is connected to target
      relayManager.setConnectionChecker((relayNodeId, peerId) => {
        return relayNodeId === 'relay-both' && peerId === 'target-peer';
      });

      relayManager.updateRelayNodes([
        {
          nodeId: 'relay-neither',
          metadata: {
            canRelay: true,
            publicAddress: 'wss://relay1.example.com',
            relayLoad: 0.1, // Very low load
            relayCapacity: 100
          },
          rtt: 10 // Very low latency
        },
        {
          nodeId: 'relay-both',
          metadata: {
            canRelay: true,
            publicAddress: 'wss://relay2.example.com',
            relayLoad: 0.5, // Higher load
            relayCapacity: 100
          },
          rtt: 50 // Higher latency
        }
      ]);

      const result = await relayManager._selectRelayNode('target-peer');
      // relay-both should win despite worse load/latency due to +50 connection bonus
      expect(result.nodeId).toBe('relay-both');
    });

    it('should prefer relay connected to target over relay connected to local', async () => {
      // Set up local connected peers (only relay-local)
      relayManager.updateLocalConnectedPeers(['relay-local']);
      
      // Set up connection checker that says relay-target is connected to target
      relayManager.setConnectionChecker((relayNodeId, peerId) => {
        return relayNodeId === 'relay-target' && peerId === 'target-peer';
      });

      relayManager.updateRelayNodes([
        {
          nodeId: 'relay-local',
          metadata: {
            canRelay: true,
            publicAddress: 'wss://relay1.example.com',
            relayLoad: 0.3,
            relayCapacity: 100
          }
        },
        {
          nodeId: 'relay-target',
          metadata: {
            canRelay: true,
            publicAddress: 'wss://relay2.example.com',
            relayLoad: 0.3,
            relayCapacity: 100
          }
        }
      ]);

      const result = await relayManager._selectRelayNode('target-peer');
      // relay-target gets +30 bonus, relay-local gets +20 bonus
      expect(result.nodeId).toBe('relay-target');
    });

    it('should prefer relay connected to local over unconnected relay', async () => {
      // Set up local connected peers
      relayManager.updateLocalConnectedPeers(['relay-local']);

      relayManager.updateRelayNodes([
        {
          nodeId: 'relay-none',
          metadata: {
            canRelay: true,
            publicAddress: 'wss://relay1.example.com',
            relayLoad: 0.3,
            relayCapacity: 100
          }
        },
        {
          nodeId: 'relay-local',
          metadata: {
            canRelay: true,
            publicAddress: 'wss://relay2.example.com',
            relayLoad: 0.3,
            relayCapacity: 100
          }
        }
      ]);

      const result = await relayManager._selectRelayNode('target-peer');
      // relay-local gets +20 bonus
      expect(result.nodeId).toBe('relay-local');
    });

    it('should use connectedPeers from relay node metadata as fallback', async () => {
      // No connection checker set, but relay node reports its connected peers
      relayManager.updateRelayNodes([
        {
          nodeId: 'relay-with-target',
          metadata: {
            canRelay: true,
            publicAddress: 'wss://relay1.example.com',
            relayLoad: 0.5,
            relayCapacity: 100,
            connectedPeers: ['target-peer', 'other-peer'] // Reports connected to target
          }
        },
        {
          nodeId: 'relay-without-target',
          metadata: {
            canRelay: true,
            publicAddress: 'wss://relay2.example.com',
            relayLoad: 0.3, // Lower load
            relayCapacity: 100,
            connectedPeers: ['some-other-peer']
          }
        }
      ]);

      const result = await relayManager._selectRelayNode('target-peer');
      // relay-with-target should win due to +30 connection bonus
      expect(result.nodeId).toBe('relay-with-target');
    });

    it('should balance connection bonus against load/latency penalties', async () => {
      relayManager.updateLocalConnectedPeers(['relay-connected']);

      relayManager.updateRelayNodes([
        {
          nodeId: 'relay-connected',
          metadata: {
            canRelay: true,
            publicAddress: 'wss://relay1.example.com',
            relayLoad: 0.95, // Very high load (penalty: -47.5)
            relayCapacity: 100
          },
          rtt: 300 // Very high latency (penalty: -30)
        },
        {
          nodeId: 'relay-unconnected',
          metadata: {
            canRelay: true,
            publicAddress: 'wss://relay2.example.com',
            relayLoad: 0.1, // Low load (penalty: -5)
            relayCapacity: 100
          },
          rtt: 10 // Low latency (penalty: -1)
        }
      ]);

      const result = await relayManager._selectRelayNode('target-peer');
      // relay-connected: 100 + 20 (local) - 47.5 (load) - 30 (latency) + ~1 (capacity) ≈ 43.5
      // relay-unconnected: 100 + 0 - 5 (load) - 1 (latency) + ~9 (capacity) ≈ 103
      // Unconnected relay should win due to much better load/latency
      expect(result.nodeId).toBe('relay-unconnected');
    });
  });

  describe('updateLocalConnectedPeers', () => {
    it('should accept array of peer IDs', () => {
      relayManager.updateLocalConnectedPeers(['peer-1', 'peer-2', 'peer-3']);
      expect(relayManager._localConnectedPeers.has('peer-1')).toBe(true);
      expect(relayManager._localConnectedPeers.has('peer-2')).toBe(true);
      expect(relayManager._localConnectedPeers.has('peer-3')).toBe(true);
    });

    it('should accept Set of peer IDs', () => {
      relayManager.updateLocalConnectedPeers(new Set(['peer-a', 'peer-b']));
      expect(relayManager._localConnectedPeers.has('peer-a')).toBe(true);
      expect(relayManager._localConnectedPeers.has('peer-b')).toBe(true);
    });

    it('should replace previous connected peers', () => {
      relayManager.updateLocalConnectedPeers(['peer-1', 'peer-2']);
      relayManager.updateLocalConnectedPeers(['peer-3']);
      expect(relayManager._localConnectedPeers.has('peer-1')).toBe(false);
      expect(relayManager._localConnectedPeers.has('peer-3')).toBe(true);
    });
  });

  describe('setConnectionChecker', () => {
    it('should use provided callback for connection checks', async () => {
      let checkerCalled = false;
      let checkerArgs = null;
      
      const mockChecker = (relayNodeId, peerId) => {
        checkerCalled = true;
        checkerArgs = { relayNodeId, peerId };
        return relayNodeId === 'relay-1' && peerId === 'target-peer';
      };

      relayManager.setConnectionChecker(mockChecker);
      relayManager.updateRelayNodes([{
        nodeId: 'relay-1',
        metadata: {
          canRelay: true,
          publicAddress: 'wss://relay1.example.com',
          relayLoad: 0.5,
          relayCapacity: 100
        }
      }]);

      await relayManager._selectRelayNode('target-peer');
      
      expect(checkerCalled).toBe(true);
      expect(checkerArgs.relayNodeId).toBe('relay-1');
      expect(checkerArgs.peerId).toBe('target-peer');
    });
  });

  describe('updateRelayNodes with connectedPeers', () => {
    it('should store connectedPeers as Set for efficient lookup', () => {
      relayManager.updateRelayNodes([{
        nodeId: 'relay-1',
        metadata: {
          canRelay: true,
          publicAddress: 'wss://relay1.example.com',
          relayLoad: 0.5,
          relayCapacity: 100,
          connectedPeers: ['peer-a', 'peer-b', 'peer-c']
        }
      }]);

      const relayNode = relayManager._relayNodes.get('relay-1');
      expect(relayNode.connectedPeers).toBeInstanceOf(Set);
      expect(relayNode.connectedPeers.has('peer-a')).toBe(true);
      expect(relayNode.connectedPeers.has('peer-b')).toBe(true);
      expect(relayNode.connectedPeers.has('peer-c')).toBe(true);
    });

    it('should handle missing connectedPeers gracefully', () => {
      relayManager.updateRelayNodes([{
        nodeId: 'relay-1',
        metadata: {
          canRelay: true,
          publicAddress: 'wss://relay1.example.com',
          relayLoad: 0.5,
          relayCapacity: 100
          // No connectedPeers
        }
      }]);

      const relayNode = relayManager._relayNodes.get('relay-1');
      expect(relayNode.connectedPeers).toBeNull();
    });
  });
});
