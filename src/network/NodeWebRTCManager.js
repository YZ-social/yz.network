/**
 * Node.js WebRTC Manager using werift library
 * 
 * Subclasses the existing WebRTCManager to reuse all bootstrap signaling logic,
 * connection management, and DHT integration. Only overrides the WebRTC 
 * implementation to use werift instead of native browser APIs.
 */

import { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate } from 'werift';
import { WebRTCManager } from './WebRTCManager.js';

/**
 * Node.js WebRTC Manager that extends WebRTCManager with werift implementation
 * Sets up werift globals so the parent class can use them transparently
 */
export class NodeWebRTCManager extends WebRTCManager {
  constructor(options = {}) {
    // Set up werift globals for Node.js before calling parent constructor
    NodeWebRTCManager.setupWeriftGlobals();
    
    // Call parent constructor with same options
    super(options);
    
    console.log('🚀 NodeWebRTCManager initialized for Node.js with werift');
  }
  
  /**
   * Set up werift WebRTC globals so parent class can use them transparently
   */
  static setupWeriftGlobals() {
    if (typeof window === 'undefined') {
      // Only set up in Node.js environment
      global.RTCPeerConnection = RTCPeerConnection;
      global.RTCSessionDescription = RTCSessionDescription;
      global.RTCIceCandidate = RTCIceCandidate;
      console.log('🚀 Set up werift WebRTC globals for Node.js');
    }
  }

  // No need to override specific methods since we set up globals
  // The parent WebRTCManager will use our werift globals automatically

  /**
   * Override: Log when we're using werift implementation
   */
  initialize(localNodeId) {
    super.initialize(localNodeId);
    console.log('🚀 Using werift WebRTC implementation for Node.js');
  }

  /**
   * Override: Destroy method to clean up werift connections
   */
  destroy() {
    console.log('Destroying NodeWebRTCManager');
    super.destroy();
  }

}

export default NodeWebRTCManager;