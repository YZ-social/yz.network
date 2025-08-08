// Jest setup file for YZSocialC tests

// Mock WebRTC APIs for Node.js environment
global.RTCPeerConnection = class MockRTCPeerConnection {
  constructor() {
    this.connectionState = 'new';
    this.iceConnectionState = 'new';
    this.signalingState = 'stable';
    this.localDescription = null;
    this.remoteDescription = null;
    this.onicecandidate = null;
    this.ondatachannel = null;
    this.onconnectionstatechange = null;
  }
  
  createOffer() {
    return Promise.resolve({ type: 'offer', sdp: 'mock-offer-sdp' });
  }
  
  createAnswer() {
    return Promise.resolve({ type: 'answer', sdp: 'mock-answer-sdp' });
  }
  
  setLocalDescription(desc) {
    this.localDescription = desc;
    return Promise.resolve();
  }
  
  setRemoteDescription(desc) {
    this.remoteDescription = desc;
    return Promise.resolve();
  }
  
  addIceCandidate() {
    return Promise.resolve();
  }
  
  createDataChannel(label) {
    return new MockRTCDataChannel(label);
  }
  
  close() {
    this.connectionState = 'closed';
  }
};

global.RTCDataChannel = class MockRTCDataChannel {
  constructor(label) {
    this.label = label;
    this.readyState = 'connecting';
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
  }
  
  send(data) {
    // Mock send implementation
  }
  
  close() {
    this.readyState = 'closed';
  }
};

// Mock crypto for Node.js environment
if (!global.crypto) {
  global.crypto = {
    getRandomValues: (array) => {
      for (let i = 0; i < array.length; i++) {
        array[i] = Math.floor(Math.random() * 256);
      }
      return array;
    },
    subtle: {
      generateKey: () => Promise.resolve({}),
      sign: () => Promise.resolve(new ArrayBuffer(64)),
      verify: () => Promise.resolve(true),
      importKey: () => Promise.resolve({}),
      exportKey: () => Promise.resolve(new ArrayBuffer(32))
    }
  };
}

// Mock WebSocket for testing
global.WebSocket = class MockWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 1; // OPEN
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    
    // Simulate connection opening
    setTimeout(() => {
      if (this.onopen) this.onopen();
    }, 10);
  }
  
  send(data) {
    // Mock send implementation
  }
  
  close() {
    this.readyState = 3; // CLOSED
    if (this.onclose) this.onclose();
  }
};

// Console suppression for cleaner test output
const originalConsole = global.console;
global.console = {
  ...originalConsole,
  log: process.env.JEST_VERBOSE ? originalConsole.log : () => {},
  warn: process.env.JEST_VERBOSE ? originalConsole.warn : () => {},
  error: originalConsole.error // Always show errors
};

// Test timeout configured in jest.config.js