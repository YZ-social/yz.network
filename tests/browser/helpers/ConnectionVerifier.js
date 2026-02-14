/**
 * ConnectionVerifier - Verifies connection types in browser tests
 * 
 * Validates that browser-to-browser connections use WebRTC and
 * browser-to-nodejs connections use WebSocket per architecture requirements.
 * 
 * Requirements: 1.1, 1.2, 1.3
 */

/**
 * Connection type constants
 */
export const ConnectionType = {
  WEBRTC: 'webrtc',
  WEBSOCKET: 'websocket',
  UNKNOWN: 'unknown'
};

/**
 * ConnectionVerifier class for inspecting and verifying connection types
 */
export class ConnectionVerifier {
  /**
   * Get connection type for a specific peer
   * @param {import('@playwright/test').Page} page - Playwright page instance
   * @param {string} peerId - Target peer ID
   * @returns {Promise<string>} Connection type ('webrtc', 'websocket', or 'unknown')
   */
  static async getConnectionType(page, peerId) {
    return await page.evaluate((targetPeerId) => {
      const dht = window.YZSocialC?.dht;
      if (!dht || !dht.routingTable) {
        return 'unknown';
      }

      const peerNode = dht.routingTable.getNode(targetPeerId);
      if (!peerNode || !peerNode.connectionManager) {
        return 'unknown';
      }

      const managerType = peerNode.connectionManager.constructor.name;
      if (managerType === 'WebRTCConnectionManager') {
        return 'webrtc';
      } else if (managerType === 'WebSocketConnectionManager') {
        return 'websocket';
      }
      return 'unknown';
    }, peerId);
  }

  /**
   * Verify browser-to-browser connection uses WebRTC
   * @param {import('@playwright/test').Page} page - Playwright page instance
   * @param {string} peerId - Target browser peer ID
   * @returns {Promise<{valid: boolean, connectionType: string, error?: string}>}
   */
  static async verifyWebRTCConnection(page, peerId) {
    const connectionType = await this.getConnectionType(page, peerId);
    
    if (connectionType === ConnectionType.WEBRTC) {
      return { valid: true, connectionType };
    }
    
    return {
      valid: false,
      connectionType,
      error: `Expected WebRTC connection for browser-to-browser, got ${connectionType}`
    };
  }

  /**
   * Verify browser-to-nodejs connection uses WebSocket
   * @param {import('@playwright/test').Page} page - Playwright page instance
   * @param {string} peerId - Target Node.js peer ID
   * @returns {Promise<{valid: boolean, connectionType: string, error?: string}>}
   */
  static async verifyWebSocketConnection(page, peerId) {
    const connectionType = await this.getConnectionType(page, peerId);
    
    if (connectionType === ConnectionType.WEBSOCKET) {
      return { valid: true, connectionType };
    }
    
    return {
      valid: false,
      connectionType,
      error: `Expected WebSocket connection for browser-to-nodejs, got ${connectionType}`
    };
  }

  /**
   * Get all peer connections with their types
   * @param {import('@playwright/test').Page} page - Playwright page instance
   * @returns {Promise<Array<{peerId: string, connectionType: string, nodeType: string, isConnected: boolean}>>}
   */
  static async getAllConnectionTypes(page) {
    return await page.evaluate(() => {
      const dht = window.YZSocialC?.dht;
      if (!dht || !dht.routingTable) {
        return [];
      }

      const connections = [];
      const allNodes = dht.routingTable.getAllNodes();

      for (const node of allNodes) {
        const peerId = node.id.toString();
        let connectionType = 'unknown';
        let isConnected = false;

        if (node.connectionManager) {
          const managerType = node.connectionManager.constructor.name;
          if (managerType === 'WebRTCConnectionManager') {
            connectionType = 'webrtc';
          } else if (managerType === 'WebSocketConnectionManager') {
            connectionType = 'websocket';
          }
          isConnected = node.connectionManager.isConnected();
        }

        // Get node type from metadata
        const nodeType = node.metadata?.nodeType || 'unknown';

        connections.push({
          peerId,
          connectionType,
          nodeType,
          isConnected
        });
      }

      return connections;
    });
  }

  /**
   * Verify all connections match expected types based on node types
   * Browser-to-Browser should be WebRTC, Browser-to-NodeJS should be WebSocket
   * @param {import('@playwright/test').Page} page - Playwright page instance
   * @returns {Promise<{valid: boolean, connections: Array, errors: Array<string>}>}
   */
  static async verifyAllConnectionTypes(page) {
    const connections = await this.getAllConnectionTypes(page);
    const errors = [];

    for (const conn of connections) {
      if (!conn.isConnected) {
        continue; // Skip disconnected peers
      }

      // Browser-to-Browser should use WebRTC
      if (conn.nodeType === 'browser' && conn.connectionType !== 'webrtc') {
        errors.push(
          `Peer ${conn.peerId.substring(0, 8)}... is browser but uses ${conn.connectionType} (expected webrtc)`
        );
      }

      // Browser-to-NodeJS should use WebSocket
      if ((conn.nodeType === 'nodejs' || conn.nodeType === 'nodejs-active' || conn.nodeType === 'bridge') 
          && conn.connectionType !== 'websocket') {
        errors.push(
          `Peer ${conn.peerId.substring(0, 8)}... is ${conn.nodeType} but uses ${conn.connectionType} (expected websocket)`
        );
      }
    }

    return {
      valid: errors.length === 0,
      connections,
      errors
    };
  }

  /**
   * Get connection summary for logging/reporting
   * @param {import('@playwright/test').Page} page - Playwright page instance
   * @returns {Promise<{total: number, webrtc: number, websocket: number, unknown: number, connected: number}>}
   */
  static async getConnectionSummary(page) {
    const connections = await this.getAllConnectionTypes(page);
    
    return {
      total: connections.length,
      webrtc: connections.filter(c => c.connectionType === 'webrtc').length,
      websocket: connections.filter(c => c.connectionType === 'websocket').length,
      unknown: connections.filter(c => c.connectionType === 'unknown').length,
      connected: connections.filter(c => c.isConnected).length
    };
  }
}
