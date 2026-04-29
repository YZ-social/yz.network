/**
 * RelayEncryption - End-to-end encryption for relay payloads
 * 
 * Ensures relay nodes cannot see plaintext of forwarded messages.
 * Uses ECDH key exchange + AES-GCM symmetric encryption.
 * 
 * Flow:
 * 1. Peers exchange ECDH public keys during relay session setup
 * 2. Each peer derives a shared secret using ECDH
 * 3. Shared secret is used to derive AES-GCM key
 * 4. All relay payloads are encrypted with AES-GCM before sending
 * 
 * Security properties:
 * - Relay nodes see only opaque ciphertext
 * - Forward secrecy per session (new keys each session)
 * - Authenticated encryption (AES-GCM provides integrity)
 */

/**
 * Generate an ECDH key pair for relay session encryption
 * @returns {Promise<{publicKey: CryptoKey, privateKey: CryptoKey, publicKeyJwk: Object}>}
 */
export async function generateKeyPair() {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: 'ECDH',
      namedCurve: 'P-256'
    },
    true, // extractable (needed to export public key)
    ['deriveKey', 'deriveBits']
  );
  
  // Export public key as JWK for transmission
  const publicKeyJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  
  return {
    publicKey: keyPair.publicKey,
    privateKey: keyPair.privateKey,
    publicKeyJwk
  };
}

/**
 * Import a peer's public key from JWK format
 * @param {Object} publicKeyJwk - Public key in JWK format
 * @returns {Promise<CryptoKey>}
 */
export async function importPublicKey(publicKeyJwk) {
  return crypto.subtle.importKey(
    'jwk',
    publicKeyJwk,
    {
      name: 'ECDH',
      namedCurve: 'P-256'
    },
    true,
    []
  );
}

/**
 * Derive a shared AES-GCM key from ECDH key exchange
 * @param {CryptoKey} privateKey - Our ECDH private key
 * @param {CryptoKey} peerPublicKey - Peer's ECDH public key
 * @returns {Promise<CryptoKey>} AES-GCM key for encryption/decryption
 */
export async function deriveSharedKey(privateKey, peerPublicKey) {
  return crypto.subtle.deriveKey(
    {
      name: 'ECDH',
      public: peerPublicKey
    },
    privateKey,
    {
      name: 'AES-GCM',
      length: 256
    },
    false, // not extractable
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypt a payload for relay transmission
 * @param {CryptoKey} sharedKey - AES-GCM key from deriveSharedKey
 * @param {any} payload - Payload to encrypt (will be JSON serialized)
 * @returns {Promise<{ciphertext: string, iv: string}>} Base64-encoded ciphertext and IV
 */
export async function encryptPayload(sharedKey, payload) {
  // Serialize payload to JSON, then to bytes
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  
  // Generate random IV (12 bytes for AES-GCM)
  const iv = crypto.getRandomValues(new Uint8Array(12));
  
  // Encrypt with AES-GCM
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv
    },
    sharedKey,
    plaintext
  );
  
  // Return base64-encoded for JSON transmission
  return {
    ciphertext: arrayBufferToBase64(ciphertext),
    iv: arrayBufferToBase64(iv)
  };
}

/**
 * Decrypt a relay payload
 * @param {CryptoKey} sharedKey - AES-GCM key from deriveSharedKey
 * @param {string} ciphertext - Base64-encoded ciphertext
 * @param {string} iv - Base64-encoded IV
 * @returns {Promise<any>} Decrypted and parsed payload
 */
export async function decryptPayload(sharedKey, ciphertext, iv) {
  // Decode from base64
  const ciphertextBytes = base64ToArrayBuffer(ciphertext);
  const ivBytes = base64ToArrayBuffer(iv);
  
  // Decrypt with AES-GCM
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: ivBytes
    },
    sharedKey,
    ciphertextBytes
  );
  
  // Parse JSON payload
  const decoded = new TextDecoder().decode(plaintext);
  return JSON.parse(decoded);
}

/**
 * Create an encrypted relay payload wrapper
 * This is what gets sent through the relay - completely opaque to relay nodes
 * @param {CryptoKey} sharedKey - Shared encryption key
 * @param {any} payload - Original payload to encrypt
 * @returns {Promise<Object>} Encrypted payload wrapper
 */
export async function createEncryptedPayload(sharedKey, payload) {
  const { ciphertext, iv } = await encryptPayload(sharedKey, payload);
  return {
    encrypted: true,
    v: 1, // version for future compatibility
    ct: ciphertext,
    iv: iv
  };
}

/**
 * Decrypt an encrypted relay payload wrapper
 * @param {CryptoKey} sharedKey - Shared encryption key
 * @param {Object} encryptedPayload - Encrypted payload wrapper from createEncryptedPayload
 * @returns {Promise<any>} Original decrypted payload
 */
export async function decryptEncryptedPayload(sharedKey, encryptedPayload) {
  if (!encryptedPayload.encrypted) {
    // Not encrypted, return as-is (for backward compatibility)
    return encryptedPayload;
  }
  
  if (encryptedPayload.v !== 1) {
    throw new Error(`Unsupported encryption version: ${encryptedPayload.v}`);
  }
  
  return decryptPayload(sharedKey, encryptedPayload.ct, encryptedPayload.iv);
}

/**
 * Check if a payload is encrypted
 * @param {any} payload - Payload to check
 * @returns {boolean}
 */
export function isEncryptedPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return false;
  }
  return payload.encrypted === true &&
         typeof payload.ct === 'string' &&
         typeof payload.iv === 'string';
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Convert ArrayBuffer to base64 string
 * @param {ArrayBuffer} buffer
 * @returns {string}
 */
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Convert base64 string to ArrayBuffer
 * @param {string} base64
 * @returns {ArrayBuffer}
 */
function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

// ============================================================================
// Session Key Management
// ============================================================================

/**
 * RelaySessionKeys - Manages encryption keys for a relay session
 * 
 * Usage:
 *   const keys = new RelaySessionKeys();
 *   await keys.initialize();
 *   
 *   // Exchange public keys with peer (via relay_request/relay_ack)
 *   const myPublicKey = keys.getPublicKeyJwk();
 *   // ... send to peer ...
 *   // ... receive peer's public key ...
 *   await keys.setPeerPublicKey(peerPublicKeyJwk);
 *   
 *   // Now can encrypt/decrypt
 *   const encrypted = await keys.encrypt(payload);
 *   const decrypted = await keys.decrypt(encryptedPayload);
 */
export class RelaySessionKeys {
  constructor() {
    this._keyPair = null;
    this._peerPublicKey = null;
    this._sharedKey = null;
    this._initialized = false;
  }
  
  /**
   * Initialize by generating our key pair
   */
  async initialize() {
    this._keyPair = await generateKeyPair();
    this._initialized = true;
  }
  
  /**
   * Get our public key in JWK format for sending to peer
   * @returns {Object} Public key JWK
   */
  getPublicKeyJwk() {
    if (!this._initialized) {
      throw new Error('RelaySessionKeys not initialized');
    }
    return this._keyPair.publicKeyJwk;
  }
  
  /**
   * Set the peer's public key and derive shared secret
   * @param {Object} peerPublicKeyJwk - Peer's public key in JWK format
   */
  async setPeerPublicKey(peerPublicKeyJwk) {
    if (!this._initialized) {
      throw new Error('RelaySessionKeys not initialized');
    }
    
    this._peerPublicKey = await importPublicKey(peerPublicKeyJwk);
    this._sharedKey = await deriveSharedKey(
      this._keyPair.privateKey,
      this._peerPublicKey
    );
  }
  
  /**
   * Check if encryption is ready (both keys exchanged)
   * @returns {boolean}
   */
  isReady() {
    return this._sharedKey !== null;
  }
  
  /**
   * Encrypt a payload
   * @param {any} payload - Payload to encrypt
   * @returns {Promise<Object>} Encrypted payload wrapper
   */
  async encrypt(payload) {
    if (!this._sharedKey) {
      throw new Error('Shared key not established - call setPeerPublicKey first');
    }
    return createEncryptedPayload(this._sharedKey, payload);
  }
  
  /**
   * Decrypt a payload
   * @param {Object} encryptedPayload - Encrypted payload wrapper
   * @returns {Promise<any>} Decrypted payload
   */
  async decrypt(encryptedPayload) {
    if (!this._sharedKey) {
      throw new Error('Shared key not established - call setPeerPublicKey first');
    }
    return decryptEncryptedPayload(this._sharedKey, encryptedPayload);
  }
  
  /**
   * Clean up keys (call when session ends)
   */
  destroy() {
    this._keyPair = null;
    this._peerPublicKey = null;
    this._sharedKey = null;
    this._initialized = false;
  }
}

export default {
  generateKeyPair,
  importPublicKey,
  deriveSharedKey,
  encryptPayload,
  decryptPayload,
  createEncryptedPayload,
  decryptEncryptedPayload,
  isEncryptedPayload,
  RelaySessionKeys
};
