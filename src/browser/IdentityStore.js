/**
 * IdentityStore - Manages cryptographic identity for DHT nodes in the browser
 *
 * Stores:
 * - Private/public key pair (ECDSA P-256)
 * - Node ID (derived from public key hash)
 * - Metadata (created, last used)
 *
 * Storage: IndexedDB (persistent across sessions)
 */

import crypto from 'crypto-js';

const DB_NAME = 'yz-network-identity';
const DB_VERSION = 1;
const STORE_NAME = 'identity';

export class IdentityStore {
  constructor(options = {}) {
    this.db = null;
    this.identity = null;

    // Support tab-specific identities for testing multiple clients in same browser
    // If useTabIdentity is true, generate unique ID per tab using sessionStorage
    this.useTabIdentity = options.useTabIdentity || false;
    this.storageKey = this.useTabIdentity ? this.getOrCreateTabId() : 'default';

    if (this.useTabIdentity) {
      console.log(`🔑 IdentityStore: Using tab-specific identity (key: ${this.storageKey})`);
    }
  }

  /**
   * Get or create a unique ID for this browser tab/window
   * Stored in sessionStorage (cleared when tab closes)
   */
  getOrCreateTabId() {
    let tabId = sessionStorage.getItem('yz-network-tab-id');
    if (!tabId) {
      tabId = `tab_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      sessionStorage.setItem('yz-network-tab-id', tabId);
      console.log(`🆕 Generated new tab ID: ${tabId}`);
    }
    return tabId;
  }

  /**
   * Initialize IndexedDB connection
   */
  async initialize() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => reject(new Error('Failed to open IndexedDB'));

      request.onsuccess = (event) => {
        this.db = event.target.result;
        console.log('✅ IdentityStore: IndexedDB connected');
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        // Create identity object store
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
          store.createIndex('nodeId', 'nodeId', { unique: true });
          console.log('✅ IdentityStore: Created object store');
        }
      };
    });
  }

  /**
   * Check if identity exists in storage
   */
  async exists() {
    if (!this.db) {
      await this.initialize();
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([STORE_NAME], 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(this.storageKey);

      request.onsuccess = () => {
        resolve(!!request.result);
      };

      request.onerror = () => reject(new Error('Failed to check identity existence'));
    });
  }

  /**
   * Generate new cryptographic identity
   */
  async generate() {
    console.log('🔑 IdentityStore: Generating new identity...');

    // Generate ECDSA P-256 key pair
    const keyPair = await window.crypto.subtle.generateKey(
      {
        name: 'ECDSA',
        namedCurve: 'P-256'
      },
      true, // extractable (allows backup/export)
      ['sign', 'verify']
    );

    // Export keys to JWK format
    const privateKeyJwk = await window.crypto.subtle.exportKey('jwk', keyPair.privateKey);
    const publicKeyJwk = await window.crypto.subtle.exportKey('jwk', keyPair.publicKey);

    // Derive node ID from public key hash
    const nodeId = await this.deriveNodeId(publicKeyJwk);

    const identity = {
      id: this.storageKey, // Tab-specific or browser-wide identity
      privateKey: privateKeyJwk,
      publicKey: publicKeyJwk,
      nodeId: nodeId,
      createdAt: Date.now(),
      lastUsed: Date.now()
    };

    console.log(`✅ IdentityStore: Generated identity with node ID: ${nodeId.substring(0, 16)}...`);

    this.identity = identity;
    return identity;
  }

  /**
   * Derive 160-bit Kademlia node ID from public key
   */
  async deriveNodeId(publicKeyJwk) {
    // Encode public key as bytes
    const publicKeyBytes = this.encodePublicKey(publicKeyJwk);

    // SHA-256 hash
    const hashBuffer = await window.crypto.subtle.digest('SHA-256', publicKeyBytes);
    const hashArray = Array.from(new Uint8Array(hashBuffer));

    // Convert to hex and take first 160 bits (40 hex characters)
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    const nodeId = hashHex.substring(0, 40);

    return nodeId;
  }

  /**
   * Encode public key JWK to bytes for hashing
   */
  encodePublicKey(publicKeyJwk) {
    // Encode public key coordinates (x, y) as bytes
    const xBytes = this.base64UrlToBytes(publicKeyJwk.x);
    const yBytes = this.base64UrlToBytes(publicKeyJwk.y);

    // Concatenate x and y coordinates
    const combined = new Uint8Array(xBytes.length + yBytes.length);
    combined.set(xBytes, 0);
    combined.set(yBytes, xBytes.length);

    return combined;
  }

  /**
   * Convert base64url to Uint8Array
   */
  base64UrlToBytes(base64url) {
    // Convert base64url to base64
    const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');

    // Decode base64
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
  }

  /**
   * Save identity to IndexedDB
   */
  async save(identity) {
    if (!this.db) {
      await this.initialize();
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.put(identity);

      request.onsuccess = () => {
        console.log(`✅ IdentityStore: Saved identity ${identity.nodeId.substring(0, 16)}...`);
        this.identity = identity;
        resolve(identity);
      };

      request.onerror = () => reject(new Error('Failed to save identity'));
    });
  }

  /**
   * Load identity from IndexedDB
   */
  async load() {
    if (!this.db) {
      await this.initialize();
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([STORE_NAME], 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(this.storageKey);

      request.onsuccess = () => {
        if (request.result) {
          // Update last used timestamp
          const identity = request.result;
          identity.lastUsed = Date.now();
          this.save(identity); // Fire and forget

          this.identity = identity;
          console.log(`✅ IdentityStore: Loaded identity ${identity.nodeId.substring(0, 16)}...`);
          resolve(identity);
        } else {
          resolve(null);
        }
      };

      request.onerror = () => reject(new Error('Failed to load identity'));
    });
  }

  /**
   * Get or create identity (convenience method)
   */
  async getOrCreate() {
    const exists = await this.exists();

    if (exists) {
      return await this.load();
    } else {
      const identity = await this.generate();
      await this.save(identity);
      return identity;
    }
  }

  /**
   * Sign data with private key
   */
  async sign(data) {
    if (!this.identity) {
      throw new Error('No identity loaded');
    }

    // Import private key
    const privateKey = await window.crypto.subtle.importKey(
      'jwk',
      this.identity.privateKey,
      {
        name: 'ECDSA',
        namedCurve: 'P-256'
      },
      false,
      ['sign']
    );

    // Sign data
    const encoder = new TextEncoder();
    const dataBytes = typeof data === 'string' ? encoder.encode(data) : data;

    const signature = await window.crypto.subtle.sign(
      {
        name: 'ECDSA',
        hash: { name: 'SHA-256' }
      },
      privateKey,
      dataBytes
    );

    // Convert to base64
    const signatureArray = Array.from(new Uint8Array(signature));
    const signatureHex = signatureArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return signatureHex;
  }

  /**
   * Verify signature with public key
   */
  static async verify(data, signatureHex, publicKeyJwk) {
    // Import public key
    const publicKey = await window.crypto.subtle.importKey(
      'jwk',
      publicKeyJwk,
      {
        name: 'ECDSA',
        namedCurve: 'P-256'
      },
      false,
      ['verify']
    );

    // Convert hex signature to bytes
    const signatureBytes = new Uint8Array(signatureHex.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));

    // Prepare data
    const encoder = new TextEncoder();
    const dataBytes = typeof data === 'string' ? encoder.encode(data) : data;

    // Verify
    return await window.crypto.subtle.verify(
      {
        name: 'ECDSA',
        hash: { name: 'SHA-256' }
      },
      publicKey,
      signatureBytes,
      dataBytes
    );
  }

  /**
   * Export identity for backup (returns plain object)
   */
  async export() {
    if (!this.identity) {
      throw new Error('No identity loaded');
    }

    return {
      privateKey: this.identity.privateKey,
      publicKey: this.identity.publicKey,
      nodeId: this.identity.nodeId,
      createdAt: this.identity.createdAt,
      exportedAt: Date.now()
    };
  }

  /**
   * Import identity from backup
   */
  async import(backup) {
    // Validate backup structure
    if (!backup.privateKey || !backup.publicKey || !backup.nodeId) {
      throw new Error('Invalid backup format');
    }

    // Verify node ID matches public key
    const derivedNodeId = await this.deriveNodeId(backup.publicKey);
    if (derivedNodeId !== backup.nodeId) {
      throw new Error('Node ID does not match public key');
    }

    // Create identity object
    const identity = {
      id: this.storageKey,
      privateKey: backup.privateKey,
      publicKey: backup.publicKey,
      nodeId: backup.nodeId,
      createdAt: backup.createdAt || Date.now(),
      lastUsed: Date.now()
    };

    // Save to IndexedDB
    await this.save(identity);
    console.log(`✅ IdentityStore: Imported identity ${identity.nodeId.substring(0, 16)}...`);

    return identity;
  }

  /**
   * Delete identity (careful!)
   */
  async delete() {
    if (!this.db) {
      await this.initialize();
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.delete(this.storageKey);

      request.onsuccess = () => {
        console.log('🗑️ IdentityStore: Deleted identity');
        this.identity = null;
        resolve();
      };

      request.onerror = () => reject(new Error('Failed to delete identity'));
    });
  }

  /**
   * Get current identity info (without private key)
   */
  getInfo() {
    if (!this.identity) {
      return null;
    }

    return {
      nodeId: this.identity.nodeId,
      publicKey: this.identity.publicKey,
      createdAt: this.identity.createdAt,
      lastUsed: this.identity.lastUsed
    };
  }
}
