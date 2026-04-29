/**
 * RelayProtocol - Message type definitions and utilities for WebSocket relay system
 * 
 * This module defines the relay protocol messages used for browser-to-browser
 * communication when direct WebRTC connections fail (e.g., symmetric NAT).
 * 
 * Message Flow:
 * 1. Browser A sends relay_request to relay node
 * 2. Relay node responds with relay_ack (success/failure)
 * 3. Browser A/B send relay_forward messages through relay
 * 4. Periodic relay_ping/relay_pong for health monitoring
 * 5. relay_close to tear down session
 * 
 * See: .kiro/specs/symmetric-nat-relay/design.md for detailed rationale
 */

/**
 * Relay message types
 */
export const RelayMessageType = {
  // Request relay setup (browser → relay node)
  REQUEST: 'relay_request',
  
  // Forward encrypted payload through relay
  FORWARD: 'relay_forward',
  
  // Acknowledge relay setup (relay node → browser)
  ACK: 'relay_ack',
  
  // Relay teardown
  CLOSE: 'relay_close',
  
  // Health check ping
  PING: 'relay_ping',
  
  // Health check pong response
  PONG: 'relay_pong'
};

/**
 * Relay session states
 */
export const RelaySessionState = {
  PENDING: 'pending',     // Request sent, waiting for ack
  ACTIVE: 'active',       // Session established and working
  FAILED: 'failed',       // Session failed to establish
  CLOSING: 'closing',     // Close requested, waiting for cleanup
  CLOSED: 'closed'        // Session terminated
};

/**
 * Relay rejection reasons
 */
export const RelayRejectionReason = {
  NOT_RELAY_CAPABLE: 'not_relay_capable',
  CAPACITY_REACHED: 'capacity_reached',
  TARGET_NOT_FOUND: 'target_not_found',
  TARGET_NOT_CONNECTED: 'target_not_connected',
  INVALID_SESSION: 'invalid_session',
  UNAUTHORIZED: 'unauthorized',
  TIMEOUT: 'timeout'
};

/**
 * Relay close reasons
 */
export const RelayCloseReason = {
  MANUAL: 'manual',                   // Explicit close by peer
  TIMEOUT: 'timeout',                 // Session inactivity timeout
  PEER_DISCONNECTED: 'peer_disconnected',
  RELAY_DISCONNECTED: 'relay_disconnected',
  PATH_UPGRADE: 'path_upgrade',       // Upgraded to direct WebRTC
  FAILOVER: 'failover',               // Switching to different relay
  ERROR: 'error'
};

// ============================================================================
// Message Factory Functions
// ============================================================================

/**
 * Create a relay request message
 * @param {string} targetPeerId - Peer to connect to via relay
 * @param {string} sessionId - Unique session identifier
 * @param {Object} [options] - Additional options
 * @param {Object} [options.publicKey] - ECDH public key (JWK) for end-to-end encryption
 * @returns {Object} Relay request message
 */
export function createRelayRequest(targetPeerId, sessionId, options = {}) {
  const message = {
    type: RelayMessageType.REQUEST,
    targetPeerId,
    sessionId,
    timestamp: Date.now()
  };
  
  // Include public key for end-to-end encryption if provided
  if (options.publicKey) {
    message.publicKey = options.publicKey;
  }
  
  // Copy other options except publicKey (already handled)
  const { publicKey, ...otherOptions } = options;
  Object.assign(message, otherOptions);
  
  return message;
}

/**
 * Create a relay forward message
 * @param {string} sessionId - Session identifier
 * @param {string} to - Target peer ID
 * @param {*} payload - Encrypted payload to forward (opaque to relay)
 * @param {string} [from] - Source peer ID (set by relay node)
 * @returns {Object} Relay forward message
 */
export function createRelayForward(sessionId, to, payload, from = null) {
  const message = {
    type: RelayMessageType.FORWARD,
    sessionId,
    to,
    payload
  };
  
  if (from) {
    message.from = from;
  }
  
  return message;
}

/**
 * Create a relay acknowledgment message
 * @param {string} sessionId - Session identifier
 * @param {boolean} success - Whether relay setup succeeded
 * @param {string} [error] - Error message if failed
 * @param {Object} [metadata] - Additional metadata (relay node info, etc.)
 * @param {Object} [metadata.publicKey] - ECDH public key (JWK) for end-to-end encryption
 * @returns {Object} Relay ack message
 */
export function createRelayAck(sessionId, success, error = null, metadata = {}) {
  const message = {
    type: RelayMessageType.ACK,
    sessionId,
    success,
    timestamp: Date.now()
  };
  
  if (!success && error) {
    message.error = error;
  }
  
  // Include public key for end-to-end encryption if provided in metadata
  if (metadata.publicKey) {
    message.publicKey = metadata.publicKey;
  }
  
  // Include other metadata
  const { publicKey, ...otherMetadata } = metadata;
  if (Object.keys(otherMetadata).length > 0) {
    message.metadata = otherMetadata;
  }
  
  return message;
}

/**
 * Create a relay close message
 * @param {string} sessionId - Session identifier
 * @param {string} [reason] - Close reason (from RelayCloseReason)
 * @returns {Object} Relay close message
 */
export function createRelayClose(sessionId, reason = RelayCloseReason.MANUAL) {
  return {
    type: RelayMessageType.CLOSE,
    sessionId,
    reason,
    timestamp: Date.now()
  };
}

/**
 * Create a relay ping message (health check)
 * @param {string} sessionId - Session identifier
 * @param {string} pingId - Unique ping identifier for matching pong
 * @returns {Object} Relay ping message
 */
export function createRelayPing(sessionId, pingId) {
  return {
    type: RelayMessageType.PING,
    sessionId,
    pingId,
    timestamp: Date.now()
  };
}

/**
 * Create a relay pong message (health check response)
 * @param {string} sessionId - Session identifier
 * @param {string} pingId - Ping identifier being responded to
 * @param {number} originalTimestamp - Timestamp from the ping message
 * @returns {Object} Relay pong message
 */
export function createRelayPong(sessionId, pingId, originalTimestamp) {
  return {
    type: RelayMessageType.PONG,
    sessionId,
    pingId,
    timestamp: originalTimestamp,
    respondedAt: Date.now()
  };
}

// ============================================================================
// Message Validation Functions
// ============================================================================

/**
 * Check if a message is a relay protocol message
 * @param {Object} message - Message to check
 * @returns {boolean} True if this is a relay message
 */
export function isRelayMessage(message) {
  if (!message || typeof message !== 'object') {
    return false;
  }
  
  return Object.values(RelayMessageType).includes(message.type);
}

/**
 * Validate a relay request message
 * @param {Object} message - Message to validate
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateRelayRequest(message) {
  if (message.type !== RelayMessageType.REQUEST) {
    return { valid: false, error: 'Invalid message type' };
  }
  
  if (!message.targetPeerId || typeof message.targetPeerId !== 'string') {
    return { valid: false, error: 'Missing or invalid targetPeerId' };
  }
  
  if (!message.sessionId || typeof message.sessionId !== 'string') {
    return { valid: false, error: 'Missing or invalid sessionId' };
  }
  
  return { valid: true };
}

/**
 * Validate a relay forward message
 * @param {Object} message - Message to validate
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateRelayForward(message) {
  if (message.type !== RelayMessageType.FORWARD) {
    return { valid: false, error: 'Invalid message type' };
  }
  
  if (!message.sessionId || typeof message.sessionId !== 'string') {
    return { valid: false, error: 'Missing or invalid sessionId' };
  }
  
  if (message.payload === undefined) {
    return { valid: false, error: 'Missing payload' };
  }
  
  return { valid: true };
}

/**
 * Validate a relay ack message
 * @param {Object} message - Message to validate
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateRelayAck(message) {
  if (message.type !== RelayMessageType.ACK) {
    return { valid: false, error: 'Invalid message type' };
  }
  
  if (!message.sessionId || typeof message.sessionId !== 'string') {
    return { valid: false, error: 'Missing or invalid sessionId' };
  }
  
  if (typeof message.success !== 'boolean') {
    return { valid: false, error: 'Missing or invalid success field' };
  }
  
  return { valid: true };
}

/**
 * Validate a relay close message
 * @param {Object} message - Message to validate
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateRelayClose(message) {
  if (message.type !== RelayMessageType.CLOSE) {
    return { valid: false, error: 'Invalid message type' };
  }
  
  if (!message.sessionId || typeof message.sessionId !== 'string') {
    return { valid: false, error: 'Missing or invalid sessionId' };
  }
  
  return { valid: true };
}

/**
 * Validate a relay ping message
 * @param {Object} message - Message to validate
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateRelayPing(message) {
  if (message.type !== RelayMessageType.PING) {
    return { valid: false, error: 'Invalid message type' };
  }
  
  if (!message.sessionId || typeof message.sessionId !== 'string') {
    return { valid: false, error: 'Missing or invalid sessionId' };
  }
  
  if (!message.pingId || typeof message.pingId !== 'string') {
    return { valid: false, error: 'Missing or invalid pingId' };
  }
  
  return { valid: true };
}

/**
 * Validate a relay pong message
 * @param {Object} message - Message to validate
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateRelayPong(message) {
  if (message.type !== RelayMessageType.PONG) {
    return { valid: false, error: 'Invalid message type' };
  }
  
  if (!message.sessionId || typeof message.sessionId !== 'string') {
    return { valid: false, error: 'Missing or invalid sessionId' };
  }
  
  if (!message.pingId || typeof message.pingId !== 'string') {
    return { valid: false, error: 'Missing or invalid pingId' };
  }
  
  return { valid: true };
}

/**
 * Validate any relay message based on its type
 * @param {Object} message - Message to validate
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateRelayMessage(message) {
  if (!message || typeof message !== 'object') {
    return { valid: false, error: 'Message must be an object' };
  }
  
  switch (message.type) {
    case RelayMessageType.REQUEST:
      return validateRelayRequest(message);
    case RelayMessageType.FORWARD:
      return validateRelayForward(message);
    case RelayMessageType.ACK:
      return validateRelayAck(message);
    case RelayMessageType.CLOSE:
      return validateRelayClose(message);
    case RelayMessageType.PING:
      return validateRelayPing(message);
    case RelayMessageType.PONG:
      return validateRelayPong(message);
    default:
      return { valid: false, error: `Unknown relay message type: ${message.type}` };
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Generate a unique session ID
 * @returns {string} Unique session identifier
 */
export function generateSessionId() {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return `relay_${timestamp}_${random}`;
}

/**
 * Generate a unique ping ID
 * @returns {string} Unique ping identifier
 */
export function generatePingId() {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `ping_${timestamp}_${random}`;
}

/**
 * Extract session ID from a relay message
 * @param {Object} message - Relay message
 * @returns {string|null} Session ID or null if not found
 */
export function getSessionId(message) {
  if (!message || typeof message !== 'object') {
    return null;
  }
  return message.sessionId || null;
}

/**
 * Get human-readable description of a relay message
 * @param {Object} message - Relay message
 * @returns {string} Description
 */
export function describeRelayMessage(message) {
  if (!isRelayMessage(message)) {
    return 'Not a relay message';
  }
  
  const sessionShort = message.sessionId ? message.sessionId.substring(0, 12) + '...' : 'unknown';
  
  switch (message.type) {
    case RelayMessageType.REQUEST:
      return `RELAY_REQUEST to ${message.targetPeerId?.substring(0, 8)}... (session: ${sessionShort})`;
    case RelayMessageType.FORWARD:
      return `RELAY_FORWARD to ${message.to?.substring(0, 8) || 'unknown'}... (session: ${sessionShort})`;
    case RelayMessageType.ACK:
      return `RELAY_ACK ${message.success ? 'SUCCESS' : 'FAILED'} (session: ${sessionShort})`;
    case RelayMessageType.CLOSE:
      return `RELAY_CLOSE reason=${message.reason || 'unknown'} (session: ${sessionShort})`;
    case RelayMessageType.PING:
      return `RELAY_PING (session: ${sessionShort}, ping: ${message.pingId?.substring(0, 8)}...)`;
    case RelayMessageType.PONG:
      return `RELAY_PONG (session: ${sessionShort}, ping: ${message.pingId?.substring(0, 8)}...)`;
    default:
      return `Unknown relay message type: ${message.type}`;
  }
}

// Default export for convenience
export default {
  // Message types
  RelayMessageType,
  RelaySessionState,
  RelayRejectionReason,
  RelayCloseReason,
  
  // Factory functions
  createRelayRequest,
  createRelayForward,
  createRelayAck,
  createRelayClose,
  createRelayPing,
  createRelayPong,
  
  // Validation functions
  isRelayMessage,
  validateRelayMessage,
  validateRelayRequest,
  validateRelayForward,
  validateRelayAck,
  validateRelayClose,
  validateRelayPing,
  validateRelayPong,
  
  // Utility functions
  generateSessionId,
  generatePingId,
  getSessionId,
  describeRelayMessage
};
