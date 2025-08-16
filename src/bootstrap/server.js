import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { resolve } from 'path';

/**
 * Bootstrap server for initial peer discovery and signaling
 * Only used for bootstrapping - DHT will handle signaling once established
 */
class BootstrapServer {
  constructor(options = {}) {
    this.options = {
      port: options.port || 8080,
      maxPeers: options.maxPeers || 1000,
      peerTimeout: options.peerTimeout || 5 * 60 * 1000, // 5 minutes
      cleanupInterval: options.cleanupInterval || 60 * 1000, // 1 minute
      createNewDHT: options.createNewDHT || false, // Genesis mode flag
      ...options
    };

    this.app = express();
    this.server = createServer(this.app);
    this.wss = new WebSocketServer({ server: this.server });
    
    this.peers = new Map(); // nodeId -> { ws, lastSeen, metadata, isGenesisPeer }
    this.connections = new Map(); // ws -> nodeId
    this.signalQueue = new Map(); // toPeer -> [signals...]
    this.waitingPeers = new Map(); // nodeId -> [waitingForNodeId...]
    this.joinRequests = new Map(); // targetNodeId -> [requestingNodeId...]
    
    // Genesis peer management
    this.genesisPeerAssigned = false;
    this.genesisPeerId = null;
    
    this.setupRoutes();
    this.setupWebSocket();
    this.startCleanupTimer();
  }

  /**
   * Setup HTTP routes
   */
  setupRoutes() {
    this.app.use(express.json());
    
    // Health check
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'ok',
        peers: this.peers.size,
        uptime: process.uptime(),
        timestamp: Date.now()
      });
    });

    // Get peer statistics
    this.app.get('/stats', (req, res) => {
      const peerStats = Array.from(this.peers.entries()).map(([nodeId, peer]) => ({
        nodeId: nodeId.substr(0, 8) + '...',
        lastSeen: peer.lastSeen,
        connected: peer.ws.readyState === 1
      }));

      res.json({
        totalPeers: this.peers.size,
        maxPeers: this.options.maxPeers,
        peerTimeout: this.options.peerTimeout,
        peers: peerStats
      });
    });
  }

  /**
   * Setup WebSocket handling
   */
  setupWebSocket() {
    this.wss.on('connection', (ws) => {
      console.log('New WebSocket connection');

      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleMessage(ws, message);
        } catch (error) {
          console.error('Error parsing message:', error);
          this.sendError(ws, 'Invalid JSON message');
        }
      });

      ws.on('close', () => {
        const nodeId = this.connections.get(ws);
        if (nodeId) {
          console.log(`Peer disconnected: ${nodeId}`);
          this.removePeer(nodeId);
          this.connections.delete(ws);
        }
      });

      ws.on('error', (error) => {
        console.error('WebSocket error:', error);
        const nodeId = this.connections.get(ws);
        if (nodeId) {
          this.removePeer(nodeId);
          this.connections.delete(ws);
        }
      });
    });
  }

  /**
   * Handle incoming WebSocket message
   */
  handleMessage(ws, message) {

    switch (message.type) {
      case 'register':
        this.handleRegister(ws, message);
        break;

      case 'get_peers':
        this.handleGetPeers(ws, message);
        break;

      case 'get_peers_or_genesis':
        this.handleGetPeersOrGenesis(ws, message);
        break;

      case 'forward_signal':
        this.handleForwardSignal(ws, message);
        break;

      case 'announce_independent':
        this.handleAnnounceIndependent(ws, message);
        break;

      case 'lookup_peer':
        this.handleLookupPeer(ws, message);
        break;

      case 'wait_for_peer':
        this.handleWaitForPeer(ws, message);
        break;

      case 'join_peer':
        this.handleJoinPeer(ws, message);
        break;

      case 'send_invitation':
        this.handleSendInvitation(ws, message);
        break;

      default:
        console.warn(`Unknown message type: ${message.type}`);
        this.sendError(ws, `Unknown message type: ${message.type}`);
    }
  }

  /**
   * Handle peer registration
   */
  handleRegister(ws, message) {
    const { nodeId } = message;

    if (!nodeId) {
      this.sendError(ws, 'nodeId is required');
      return;
    }

    if (this.peers.size >= this.options.maxPeers) {
      this.sendError(ws, 'Server at capacity');
      return;
    }

    // Remove existing peer if reconnecting
    if (this.peers.has(nodeId)) {
      this.removePeer(nodeId);
    }

    // Genesis peer assignment in createNewDHT mode
    let isGenesisPeer = false;
    if (this.options.createNewDHT && !this.genesisPeerAssigned) {
      isGenesisPeer = true;
      this.genesisPeerAssigned = true;
      this.genesisPeerId = nodeId;
      console.log(`🌟 GENESIS PEER ASSIGNED: ${nodeId} (first peer in createNewDHT mode)`);
    }

    // Register new peer
    const peerData = {
      ws,
      lastSeen: Date.now(),
      metadata: message.metadata || {},
      isGenesisPeer: isGenesisPeer
    };

    // Log WebSocket connection information if present
    if (peerData.metadata.nodeType === 'nodejs' && peerData.metadata.listeningAddress) {
      console.log(`📡 Node.js peer registered with WebSocket server: ${peerData.metadata.listeningAddress}`);
    } else if (peerData.metadata.nodeType === 'browser') {
      console.log(`🌐 Browser peer registered`);
    }

    this.peers.set(nodeId, peerData);
    
    this.connections.set(ws, nodeId);

    console.log(`Peer registered: ${nodeId} (${this.peers.size} total)${isGenesisPeer ? ' [GENESIS]' : ''}`);

    // Send registration confirmation
    this.sendMessage(ws, {
      type: 'registered',
      nodeId,
      peersOnline: this.peers.size,
      isGenesisPeer: isGenesisPeer
    });

    // Send any queued signals
    this.deliverQueuedSignals(nodeId);

    // Notify any peers waiting for this peer
    this.notifyWaitingPeers(nodeId);
  }

  /**
   * Update peer lastSeen timestamp for activity tracking
   */
  updatePeerActivity(nodeId) {
    const peer = this.peers.get(nodeId);
    if (peer) {
      peer.lastSeen = Date.now();
    }
  }

  /**
   * Handle get peers request
   */
  handleGetPeers(ws, message) {
    const requestingNodeId = this.connections.get(ws);
    if (!requestingNodeId) {
      this.sendError(ws, 'Not registered');
      return;
    }
    
    // Update lastSeen for peer activity
    this.updatePeerActivity(requestingNodeId);

    const maxPeers = Math.min(message.maxPeers || 20, 50);
    const availablePeers = Array.from(this.peers.entries())
      .filter(([nodeId, peer]) => {
        return nodeId !== requestingNodeId && 
               peer.ws.readyState === 1 &&
               (Date.now() - peer.lastSeen) < this.options.peerTimeout;
      })
      .map(([nodeId, peer]) => ({
        nodeId,
        lastSeen: peer.lastSeen,
        metadata: peer.metadata
      }));

    // Randomize and limit
    const shuffled = availablePeers.sort(() => Math.random() - 0.5);
    const selectedPeers = shuffled.slice(0, maxPeers);

    this.sendResponse(ws, message.requestId, {
      peers: selectedPeers,
      total: availablePeers.length
    });
  }

  /**
   * Handle get peers or genesis request
   */
  handleGetPeersOrGenesis(ws, message) {
    const requestingNodeId = this.connections.get(ws);
    if (!requestingNodeId) {
      this.sendError(ws, 'Not registered', message.requestId);
      return;
    }
    
    // Update lastSeen for peer activity
    this.updatePeerActivity(requestingNodeId);

    // Check if requesting peer is the genesis peer
    const requestingPeer = this.peers.get(requestingNodeId);
    const isGenesis = requestingPeer && requestingPeer.isGenesisPeer;

    const maxPeers = Math.min(message.maxPeers || 20, 50);
    const availablePeers = Array.from(this.peers.entries())
      .filter(([nodeId, peer]) => {
        return nodeId !== requestingNodeId && 
               peer.ws.readyState === 1 &&
               (Date.now() - peer.lastSeen) < this.options.peerTimeout;
      })
      .map(([nodeId, peer]) => ({
        nodeId,
        lastSeen: peer.lastSeen,
        metadata: peer.metadata
      }));

    // Randomize and limit
    const shuffled = availablePeers.sort(() => Math.random() - 0.5);
    const selectedPeers = shuffled.slice(0, maxPeers);

    this.sendResponse(ws, message.requestId, {
      peers: selectedPeers,
      total: availablePeers.length,
      isGenesis: isGenesis
    });
  }

  /**
   * Handle signal forwarding
   */
  handleForwardSignal(ws, message) {
    const { fromPeer, toPeer, signal } = message;
    const requestingNodeId = this.connections.get(ws);

    if (!requestingNodeId) {
      this.sendError(ws, 'Not registered');
      return;
    }

    if (requestingNodeId !== fromPeer) {
      this.sendError(ws, 'Can only send signals from your own nodeId');
      return;
    }
    
    // Update lastSeen for peer activity
    this.updatePeerActivity(requestingNodeId);

    const targetPeer = this.peers.get(toPeer);
    
    if (targetPeer && targetPeer.ws.readyState === 1) {
      // Forward signal immediately
      this.sendMessage(targetPeer.ws, {
        type: 'signal',
        fromPeer,
        toPeer,
        signal
      });

      this.sendResponse(ws, message.requestId, { delivered: true });
    } else {
      // Queue signal for later delivery
      if (!this.signalQueue.has(toPeer)) {
        this.signalQueue.set(toPeer, []);
      }
      
      this.signalQueue.get(toPeer).push({
        fromPeer,
        signal,
        timestamp: Date.now()
      });

      this.sendResponse(ws, message.requestId, { queued: true });
    }
  }

  /**
   * Handle independence announcement
   */
  handleAnnounceIndependent(ws, message) {
    const nodeId = this.connections.get(ws);
    if (!nodeId) {
      this.sendError(ws, 'Not registered');
      return;
    }

    console.log(`Peer ${nodeId} announced independence`);
    
    // Mark peer as independent but keep connection for emergency fallback
    const peer = this.peers.get(nodeId);
    if (peer) {
      peer.metadata.independent = true;
      peer.lastSeen = Date.now();
    }

    this.sendResponse(ws, message.requestId, { acknowledged: true });
  }

  /**
   * Deliver queued signals to a peer
   */
  deliverQueuedSignals(nodeId) {
    const signals = this.signalQueue.get(nodeId);
    if (!signals || signals.length === 0) return;

    const peer = this.peers.get(nodeId);
    if (!peer || peer.ws.readyState !== 1) return;

    console.log(`Delivering ${signals.length} queued signals to ${nodeId}`);

    for (const signal of signals) {
      this.sendMessage(peer.ws, {
        type: 'signal',
        fromPeer: signal.fromPeer,
        toPeer: nodeId,
        signal: signal.signal
      });
    }

    this.signalQueue.delete(nodeId);
  }

  /**
   * Remove a peer
   */
  removePeer(nodeId) {
    const peer = this.peers.get(nodeId);
    if (peer) {
      this.connections.delete(peer.ws);
      this.peers.delete(nodeId);
      console.log(`Removed peer: ${nodeId} (${this.peers.size} remaining)`);
    }
  }

  /**
   * Send message to WebSocket
   */
  sendMessage(ws, message) {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify(message));
    }
  }

  /**
   * Send response to request
   */
  sendResponse(ws, requestId, data) {
    this.sendMessage(ws, {
      type: 'response',
      requestId,
      success: true,
      data
    });
  }

  /**
   * Send error message
   */
  sendError(ws, error, requestId = null) {
    this.sendMessage(ws, {
      type: requestId ? 'response' : 'error',
      requestId,
      success: false,
      error
    });
  }

  /**
   * Start cleanup timer for stale peers and signals
   */
  startCleanupTimer() {
    setInterval(() => {
      this.cleanupStalePeers();
      this.cleanupStaleSignals();
    }, this.options.cleanupInterval);
  }

  /**
   * Remove stale peers
   */
  cleanupStalePeers() {
    const now = Date.now();
    let removed = 0;

    for (const [nodeId, peer] of this.peers.entries()) {
      if (peer.ws.readyState !== 1 || (now - peer.lastSeen) > this.options.peerTimeout) {
        this.removePeer(nodeId);
        removed++;
      }
    }

    if (removed > 0) {
      console.log(`Cleaned up ${removed} stale peers`);
    }
  }

  /**
   * Remove stale queued signals
   */
  cleanupStaleSignals() {
    const now = Date.now();
    const maxSignalAge = 5 * 60 * 1000; // 5 minutes
    let removed = 0;

    for (const [nodeId, signals] of this.signalQueue.entries()) {
      const freshSignals = signals.filter(signal => 
        (now - signal.timestamp) < maxSignalAge
      );

      if (freshSignals.length !== signals.length) {
        if (freshSignals.length === 0) {
          this.signalQueue.delete(nodeId);
        } else {
          this.signalQueue.set(nodeId, freshSignals);
        }
        removed += signals.length - freshSignals.length;
      }
    }

    if (removed > 0) {
      console.log(`Cleaned up ${removed} stale signals`);
    }
  }

  /**
   * Handle peer lookup request
   */
  handleLookupPeer(ws, message) {
    const { targetPeerId } = message;
    const requestingNodeId = this.connections.get(ws);

    if (!requestingNodeId) {
      this.sendError(ws, 'Not registered', message.requestId);
      return;
    }
    
    // Update lastSeen for peer activity
    this.updatePeerActivity(requestingNodeId);

    const targetPeer = this.peers.get(targetPeerId);
    const isOnline = targetPeer && 
                     targetPeer.ws.readyState === 1 &&
                     (Date.now() - targetPeer.lastSeen) < this.options.peerTimeout;

    this.sendResponse(ws, message.requestId, {
      targetPeerId,
      online: isOnline,
      metadata: isOnline ? targetPeer.metadata : null
    });
  }

  /**
   * Handle wait for peer request  
   */
  handleWaitForPeer(ws, message) {
    const { targetPeerId } = message;
    const requestingNodeId = this.connections.get(ws);

    if (!requestingNodeId) {
      this.sendError(ws, 'Not registered', message.requestId);
      return;
    }

    // Add to waiting list
    if (!this.waitingPeers.has(requestingNodeId)) {
      this.waitingPeers.set(requestingNodeId, []);
    }
    this.waitingPeers.get(requestingNodeId).push(targetPeerId);


    // Check if target is already online
    const targetPeer = this.peers.get(targetPeerId);
    if (targetPeer && targetPeer.ws.readyState === 1) {
      this.sendResponse(ws, message.requestId, {
        status: 'peer_available',
        targetPeerId
      });
    } else {
      this.sendResponse(ws, message.requestId, {
        status: 'waiting',
        targetPeerId
      });
    }
  }

  /**
   * Handle join peer request
   */
  handleJoinPeer(ws, message) {
    const { targetPeerId } = message;
    const requestingNodeId = this.connections.get(ws);

    if (!requestingNodeId) {
      this.sendError(ws, 'Not registered', message.requestId);
      return;
    }

    // Check if target peer is online
    const targetPeer = this.peers.get(targetPeerId);
    if (!targetPeer || targetPeer.ws.readyState !== 1) {
      this.sendError(ws, `Target peer ${targetPeerId} is not online`, message.requestId);
      return;
    }


    // Notify target peer about join request
    this.sendMessage(targetPeer.ws, {
      type: 'peer_joining',
      fromPeer: requestingNodeId,
      toPeer: targetPeerId
    });

    // Notify waiting peers if any
    if (this.waitingPeers.has(targetPeerId)) {
      const waitingList = this.waitingPeers.get(targetPeerId);
      if (waitingList.includes(requestingNodeId)) {
        this.sendMessage(targetPeer.ws, {
          type: 'peer_available',
          fromPeer: requestingNodeId,
          toPeer: targetPeerId
        });
      }
    }

    this.sendResponse(ws, message.requestId, {
      status: 'join_initiated',
      targetPeerId
    });
  }

  /**
   * Notify waiting peers when peer comes online
   */
  notifyWaitingPeers(nodeId) {
    // Check if anyone is waiting for this peer
    for (const [waitingNodeId, waitingList] of this.waitingPeers.entries()) {
      if (waitingList.includes(nodeId)) {
        const waitingPeer = this.peers.get(waitingNodeId);
        if (waitingPeer && waitingPeer.ws.readyState === 1) {
          this.sendMessage(waitingPeer.ws, {
            type: 'peer_available',
            targetPeerId: nodeId
          });
        }
      }
    }
  }

  /**
   * Handle invitation token sending
   */
  handleSendInvitation(ws, message) {
    const { targetPeerId, invitationToken } = message;
    const requestingNodeId = this.connections.get(ws);

    if (!requestingNodeId) {
      this.sendError(ws, 'Not registered', message.requestId);
      return;
    }

    if (!targetPeerId || !invitationToken) {
      this.sendError(ws, 'targetPeerId and invitationToken are required', message.requestId);
      return;
    }


    // Update lastSeen for peer activity
    this.updatePeerActivity(requestingNodeId);

    // Check if target peer is online
    const targetPeer = this.peers.get(targetPeerId);
    if (!targetPeer || targetPeer.ws.readyState !== 1) {
      this.sendError(ws, `Target peer ${targetPeerId} is not online`, message.requestId);
      return;
    }

    // Get inviter peer information for WebSocket coordination
    const inviterPeer = this.peers.get(requestingNodeId);
    const inviterMetadata = inviterPeer ? inviterPeer.metadata : {};

    // Forward the invitation token to the target peer with WebSocket coordination info
    const invitationMessage = {
      type: 'invitation_received',
      fromPeer: requestingNodeId,
      toPeer: targetPeerId,
      invitationToken: invitationToken,
      timestamp: Date.now()
    };

    // Include WebSocket connection coordination information
    if (inviterMetadata.nodeType === 'nodejs' && inviterMetadata.listeningAddress) {
      invitationMessage.websocketCoordination = {
        inviterNodeType: 'nodejs',
        inviterListeningAddress: inviterMetadata.listeningAddress,
        instructions: 'Connect to inviter WebSocket server after accepting invitation'
      };
      console.log(`🔗 Including WebSocket coordination for Node.js inviter: ${inviterMetadata.listeningAddress}`);
    } else if (inviterMetadata.nodeType === 'browser') {
      // Check if target is Node.js
      if (targetPeer.metadata.nodeType === 'nodejs' && targetPeer.metadata.listeningAddress) {
        invitationMessage.websocketCoordination = {
          inviterNodeType: 'browser',
          targetListeningAddress: targetPeer.metadata.listeningAddress,
          instructions: 'Inviter should connect to your WebSocket server after invitation acceptance'
        };
        console.log(`🔗 Including reverse WebSocket coordination for Browser → Node.js: ${targetPeer.metadata.listeningAddress}`);
      }
    }

    this.sendMessage(targetPeer.ws, invitationMessage);

    // Confirm to the inviter that the invitation was sent
    // Include target peer metadata so inviter knows how to connect
    const response = {
      success: true,
      targetPeerId: targetPeerId,
      message: 'Invitation token forwarded to target peer',
      targetPeerMetadata: targetPeer.metadata // Include target's metadata for transport selection
    };

    this.sendResponse(ws, message.requestId, response);

  }

  /**
   * Start the server
   */
  start() {
    return new Promise((resolve) => {
      this.server.listen(this.options.port, () => {
        console.log(`Bootstrap server listening on port ${this.options.port}`);
        console.log(`Max peers: ${this.options.maxPeers}`);
        console.log(`Peer timeout: ${this.options.peerTimeout}ms`);
        resolve();
      });
    });
  }

  /**
   * Stop the server
   */
  stop() {
    return new Promise((resolve) => {
      this.wss.close(() => {
        this.server.close(() => {
          console.log('Bootstrap server stopped');
          resolve();
        });
      });
    });
  }
}

// Start server if run directly
const __filename = fileURLToPath(import.meta.url);
const currentScript = resolve(process.argv[1]);
const thisScript = resolve(__filename);

if (currentScript === thisScript) {
  // Parse command line arguments
  const args = process.argv.slice(2);
  const createNewDHT = args.includes('-createNewDHT') || args.includes('--createNewDHT');
  
  if (createNewDHT) {
    console.log('🌟 Starting Bootstrap Server in CREATE_NEW_DHT mode');
    console.log('🔐 First peer to connect will be granted genesis privileges');
  } else {
    console.log('Starting Bootstrap Server in standard mode');
  }
  
  const server = new BootstrapServer({ createNewDHT });
  server.start().catch(console.error);

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('Shutting down bootstrap server...');
    await server.stop();
    process.exit(0);
  });
}

export { BootstrapServer };