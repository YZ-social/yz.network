/**
 * Invitation Token System for DHT Chain of Trust
 *
 * Provides cryptographic tokens that prove DHT membership and enable
 * decentralized peer invitation without central authority dependency.
 *
 * Uses progressive enhancement: native browser Ed25519 when available,
 * falls back to @noble/ed25519 library for universal compatibility.
 */
export class InvitationToken {
  static _nativeEd25519Support = null; // Cache detection result
  static _nobleEd25519 = null; // Lazy-loaded library

  /**
   * Check if browser has native Ed25519 support
   */
  static async checkNativeEd25519Support() {
    if (this._nativeEd25519Support !== null) {
      return this._nativeEd25519Support;
    }

    try {
      // Test if browser supports Ed25519 in Web Crypto API
      if (!window.crypto?.subtle) {
        this._nativeEd25519Support = false;
        return false;
      }

      // Try to generate an Ed25519 key pair
      const testKeyPair = await window.crypto.subtle.generateKey(
        { name: 'Ed25519' },
        false, // not extractable for test
        ['sign', 'verify']
      );

      this._nativeEd25519Support = testKeyPair !== null;
      console.log('🔐 Native Ed25519 support detected:', this._nativeEd25519Support);
      return this._nativeEd25519Support;
    } catch (error) {
      console.log('🔐 Native Ed25519 not supported, will use @noble/ed25519 library');
      this._nativeEd25519Support = false;
      return false;
    }
  }

  /**
   * Lazy-load @noble/ed25519 library
   */
  static async loadNobleEd25519() {
    if (this._nobleEd25519) {
      return this._nobleEd25519;
    }

    try {
      // Dynamic import for code splitting
      this._nobleEd25519 = await import('@noble/ed25519');

      // Configure for Node.js environment
      if (typeof process !== 'undefined' && process.versions && process.versions.node) {
        const crypto = await import('crypto');

        // Polyfill crypto.getRandomValues for Node.js
        if (typeof globalThis.crypto === 'undefined') {
          globalThis.crypto = {};
        }
        if (!globalThis.crypto.getRandomValues) {
          globalThis.crypto.getRandomValues = (arr) => {
            const bytes = crypto.randomBytes(arr.length);
            arr.set(bytes);
            return arr;
          };
          console.log('🔧 Added crypto.getRandomValues polyfill for Node.js');
        }

        if (this._nobleEd25519.ed25519) {
          // Handle both named and default exports
          const ed25519 = this._nobleEd25519.ed25519 || this._nobleEd25519;
          if (ed25519.etc && !ed25519.etc.sha512Sync) {
            ed25519.etc.sha512Sync = (...m) => crypto.createHash('sha512').update(Buffer.concat(m)).digest();
            console.log('🔧 Configured ed25519 sha512 for Node.js environment');
          }
        } else {
          // Direct access to the library
          if (this._nobleEd25519.etc && !this._nobleEd25519.etc.sha512Sync) {
            this._nobleEd25519.etc.sha512Sync = (...m) => crypto.createHash('sha512').update(Buffer.concat(m)).digest();
            console.log('🔧 Configured ed25519 sha512 for Node.js environment');
          }
        }
      }

      console.log('📚 Loaded @noble/ed25519 library for crypto operations');
      return this._nobleEd25519;
    } catch (error) {
      console.error('Failed to load @noble/ed25519 library:', error);
      throw new Error(`Crypto library loading failed: ${error.message}`);
    }
  }

  /**
   * Generate Ed25519 key pair using native browser API
   */
  static async generateKeyPairNative() {
    const keyPair = await window.crypto.subtle.generateKey(
      { name: 'Ed25519' },
      true, // extractable
      ['sign', 'verify']
    );

    // Export keys for storage/transmission
    // Use 'raw' format for Ed25519 to get the actual key bytes (32 bytes for public, 32 bytes for private)
    const publicKeyBuffer = await window.crypto.subtle.exportKey('raw', keyPair.publicKey);
    const privateKeyBuffer = await window.crypto.subtle.exportKey('pkcs8', keyPair.privateKey);

    // Convert to hex strings for consistency with library version
    const publicKey = Array.from(new Uint8Array(publicKeyBuffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    const privateKey = Array.from(new Uint8Array(privateKeyBuffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    const result = {
      publicKey,
      privateKey,
      publicKeyBytes: new Uint8Array(publicKeyBuffer), // Raw public key bytes
      cryptoKeys: keyPair, // Keep native crypto keys for signing
      isNative: true
    };


    return result;
  }

  /**
   * Generate Ed25519 key pair using @noble/ed25519 library
   */
  static async generateKeyPairLibrary() {
    const noble = await this.loadNobleEd25519();

    // Generate private key (32 bytes)
    const privateKeyBytes = noble.utils.randomPrivateKey();
    const publicKeyBytes = await noble.getPublicKey(privateKeyBytes);

    // Convert to hex strings
    const privateKey = Array.from(privateKeyBytes)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    const publicKey = Array.from(publicKeyBytes)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    return {
      publicKey,
      privateKey,
      privateKeyBytes, // Keep raw bytes for library signing
      publicKeyBytes,
      isNative: false
    };
  }

  /**
   * Generate a cryptographic key pair (progressive enhancement)
   */
  static async generateKeyPair() {
    console.log('🔐 Generating Ed25519 key pair...');

    try {
      const hasNativeSupport = await this.checkNativeEd25519Support();

      if (hasNativeSupport) {
        console.log('✅ Using native browser Ed25519');
        const keyPair = await this.generateKeyPairNative();
        return keyPair;
      } else {
        console.log('📚 Using @noble/ed25519 library');
        const keyPair = await this.generateKeyPairLibrary();
        return keyPair;
      }
    } catch (error) {
      console.error('❌ Key pair generation failed:', error);
      throw new Error(`Key generation failed: ${error.message}`);
    }
  }

  /**
   * Sign data using appropriate method (native or library)
   */
  static async signData(data, keyInfo) {
    const dataBytes = new TextEncoder().encode(data);

    if (keyInfo.isNative && keyInfo.cryptoKeys) {
      // Use native Web Crypto API
      const signatureBuffer = await window.crypto.subtle.sign(
        { name: 'Ed25519' },
        keyInfo.cryptoKeys.privateKey,
        dataBytes
      );
      return Array.from(new Uint8Array(signatureBuffer))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
    } else {
      // Use @noble/ed25519 library
      const noble = await this.loadNobleEd25519();

      // Handle different private key formats
      let privateKeyBytes;
      if (keyInfo.privateKeyBytes) {
        // Library-generated key with raw bytes
        privateKeyBytes = keyInfo.privateKeyBytes;
      } else if (keyInfo.privateKey) {
        // Key info object with hex string
        privateKeyBytes = this.hexToBytes(keyInfo.privateKey);
      } else {
        throw new Error('No private key available for signing');
      }

      const signatureBytes = await noble.sign(dataBytes, privateKeyBytes);
      return Array.from(signatureBytes)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
    }
  }

  /**
   * Verify signature using appropriate method (native or library)
   */
  static async verifySignature(data, signature, publicKey) {
    const dataBytes = new TextEncoder().encode(data);

    // Add validation before hex conversion
    if (!signature || typeof signature !== 'string') {
      return false;
    }

    const signatureBytes = this.hexToBytes(signature);

    try {
      // Try native first (if publicKey has crypto key info)
      if (publicKey && publicKey.cryptoKeys) {
        return await window.crypto.subtle.verify(
          { name: 'Ed25519' },
          publicKey.cryptoKeys.publicKey,
          signatureBytes,
          dataBytes
        );
      } else {
        // Use @noble/ed25519 library
        const noble = await this.loadNobleEd25519();

        // Handle different publicKey formats
        let publicKeyBytes;
        if (publicKey && publicKey.publicKeyBytes) {
          // Library-generated key with raw bytes
          publicKeyBytes = publicKey.publicKeyBytes;
        } else if (publicKey && publicKey.publicKey) {
          // Key info object with hex string
          publicKeyBytes = this.hexToBytes(publicKey.publicKey);
        } else if (typeof publicKey === 'string') {
          // Direct hex string
          publicKeyBytes = this.hexToBytes(publicKey);
        } else {
          throw new Error('Invalid public key format');
        }

        return await noble.verify(signatureBytes, dataBytes, publicKeyBytes);
      }
    } catch (error) {
      console.error('Signature verification failed:', error);
      return false;
    }
  }

  /**
   * Helper: Convert hex string to bytes
   */
  static hexToBytes(hex) {
    if (!hex || typeof hex !== 'string') {
      throw new Error(`Invalid hex string: ${hex}`);
    }
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
    }
    return bytes;
  }

  /**
   * Generate secure random nonce
   */
  static generateNonce() {
    const randomBytes = new Uint8Array(16);

    // Use crypto.getRandomValues in browsers, crypto.randomFillSync in Node.js
    if (typeof process === 'undefined' && window.crypto && window.crypto.getRandomValues) {
      // Browser environment
      window.crypto.getRandomValues(randomBytes);
    } else if (typeof global !== 'undefined' && global.crypto && global.crypto.getRandomValues) {
      // Node.js with global crypto
      global.crypto.getRandomValues(randomBytes);
    } else {
      // Node.js environment - use crypto module
      try {
        const crypto = require('crypto');
        crypto.randomFillSync(randomBytes);
      } catch (error) {
        // Fallback: use Math.random (less secure but works)
        for (let i = 0; i < randomBytes.length; i++) {
          randomBytes[i] = Math.floor(Math.random() * 256);
        }
      }
    }

    return Array.from(randomBytes)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /**
   * Create an invitation token from inviter to invitee
   *
   * @param {string} inviterNodeId - The node creating the invitation
   * @param {Object} inviterKeyInfo - Inviter's key info (from generateKeyPair)
   * @param {string} inviteeNodeId - The node being invited
   * @param {number} expiresInMs - Token expiration time (default 24 hours)
   * @returns {Object} Signed invitation token
   */
  static async createInvitationToken(inviterNodeId, inviterKeyInfo, inviteeNodeId, expiresInMs = 24 * 60 * 60 * 1000) {
    const now = Date.now();
    const nonce = this.generateNonce();

    const tokenData = {
      inviter: inviterNodeId,
      invitee: inviteeNodeId,
      timestamp: now,
      expires: now + expiresInMs,
      nonce: nonce,
      version: '1.0'
    };

    // Create signature of the token data
    const tokenString = JSON.stringify(tokenData);
    const signature = await this.signData(tokenString, inviterKeyInfo);

    return {
      ...tokenData,
      signature
    };
  }

  /**
   * Verify an invitation token's signature and validity
   *
   * @param {Object} token - The invitation token to verify
   * @param {string|Object} inviterPublicKey - Public key of the claimed inviter (hex string or key info)
   * @returns {Object} Validation result with success/error info
   */
  static async verifyToken(token, inviterPublicKey) {
    try {
      // Check token structure
      if (!token.inviter || !token.invitee || !token.signature || !token.nonce) {
        return { valid: false, error: 'Invalid token structure' };
      }

      // Check expiration
      if (Date.now() > token.expires) {
        return { valid: false, error: 'Token expired' };
      }

      // Verify signature
      const { signature, ...tokenData } = token;
      const tokenString = JSON.stringify(tokenData);

      const isValidSignature = await this.verifySignature(
        tokenString,
        signature,
        inviterPublicKey
      );

      if (!isValidSignature) {
        return { valid: false, error: 'Invalid signature' };
      }

      return { valid: true };
    } catch (error) {
      return { valid: false, error: `Verification failed: ${error.message}` };
    }
  }

  /**
   * Create a membership token (what nodes use to prove DHT membership)
   * This is given to a node when they successfully join the DHT
   *
   * @param {string} holderNodeId - The node receiving membership
   * @param {string} issuerNodeId - The node granting membership
   * @param {Object} issuerKeyInfo - Issuer's key info for signing
   * @param {boolean} isGenesis - Whether this is a genesis membership token
   * @returns {Object} Signed membership token
   */
  static async createMembershipToken(holderNodeId, issuerNodeId, issuerKeyInfo, isGenesis = false) {
    const now = Date.now();
    const nonce = this.generateNonce();

    const tokenData = {
      holder: holderNodeId,
      issuer: issuerNodeId,
      timestamp: now,
      type: 'membership',
      isGenesis: isGenesis,
      nonce: nonce,
      version: '1.0'
    };

    // Create signature of the token data
    const tokenString = JSON.stringify(tokenData);
    const signature = await this.signData(tokenString, issuerKeyInfo);

    return {
      ...tokenData,
      signature
    };
  }

  /**
   * Verify a membership token
   *
   * @param {Object} membershipToken - The membership token to verify
   * @param {string|Object} issuerPublicKey - Public key of the token issuer
   * @returns {Object} Validation result
   */
  static async verifyMembershipToken(membershipToken, issuerPublicKey) {
    try {
      // Check token structure
      if (!membershipToken.holder || !membershipToken.issuer || !membershipToken.signature) {
        return { valid: false, error: 'Invalid membership token structure' };
      }

      // Verify signature
      const { signature, ...tokenData } = membershipToken;
      const tokenString = JSON.stringify(tokenData);

      const isValidSignature = await this.verifySignature(
        tokenString,
        signature,
        issuerPublicKey
      );

      if (!isValidSignature) {
        return { valid: false, error: 'Invalid membership token signature' };
      }

      return { valid: true };
    } catch (error) {
      return { valid: false, error: `Membership token verification failed: ${error.message}` };
    }
  }

  /**
   * Generate a consumed token key for DHT storage
   */
  static getConsumedTokenKey(tokenNonce) {
    return `consumed_token:${tokenNonce}`;
  }

  /**
   * Generate a public key storage key for DHT
   */
  static getPublicKeyStorageKey(nodeId) {
    return `public_key:${nodeId}`;
  }

  /**
   * Create a special genesis membership token (self-signed)
   * Used only for the very first node in the network
   *
   * @param {string} genesisNodeId - The genesis node ID
   * @param {Object} genesisKeyInfo - Genesis node's key info (from generateKeyPair)
   * @returns {Object} Self-signed genesis membership token
   */
  static async createGenesisMembershipToken(genesisNodeId, genesisKeyInfo) {
    return await this.createMembershipToken(
      genesisNodeId,    // holder
      genesisNodeId,    // issuer (self-signed)
      genesisKeyInfo,
      true              // isGenesis
    );
  }
}

export default InvitationToken;
