/**
 * Browser DHT Client - Hybrid DHT node for browser environments
 *
 * This client connects to browser peers via WebRTC and Node.js peers via WebSocket.
 * Uses bootstrap server only for initial peer discovery and invitation exchange.
 *
 * Architecture:
 * - Browser-to-Browser: WebRTC DataChannels with keep-alive for inactive tabs
 * - Browser-to-Node.js: WebSocket client connections (Node.js acts as WebSocket server)
 */

import { DHTClient } from '../core/DHTClient.js';

/**
 * Browser DHT Client with WebRTC connection support
 */
export class BrowserDHTClient extends DHTClient {
  constructor(options = {}) {
    super(options);
  }

  getNodeType() {
    return 'browser';
  }

  getCapabilities() {
    return ['webrtc', 'websocket-client'];
  }

  canAcceptConnections() {
    return false;
  }

  canInitiateConnections() {
    return true;
  }

  /**
   * Override getStats to include browser-specific connection manager stats
   */
  getStats() {
    const baseStats = super.getStats();
    if (!this.dht) return baseStats;

    return {
      ...baseStats,
      connections: this.dht.getConnectionStats?.() || {},
      dht: {
        routingTableSize: this.dht.routingTable?.getAllNodes()?.length || 0,
        connectedPeers: this.getConnectedPeers().length
      }
    };
  }
}