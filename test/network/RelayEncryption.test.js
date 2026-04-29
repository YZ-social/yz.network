/**
 * Tests for RelayEncryption module
 * 
 * Verifies end-to-end encryption for relay payloads using ECDH + AES-GCM
 */

import {
  generateKeyPair,
  importPublicKey,
  deriveSharedKey,
  encryptPayload,
  decryptPayload,
  createEncryptedPayload,
  decryptEncryptedPayload,
  isEncryptedPayload,
  RelaySessionKeys
} from '../../src/network/RelayEncryption.js';

describe('RelayEncryption', () => {
  describe('Key Generation', () => {
    it('should generate ECDH key pair', async () => {
      const keyPair = await generateKeyPair();
      
      expect(keyPair).toBeDefined();
      expect(keyPair.publicKey).toBeDefined();
      expect(keyPair.privateKey).toBeDefined();
      expect(keyPair.publicKeyJwk).toBeDefined();
      expect(keyPair.publicKeyJwk.kty).toBe('EC');
      expect(keyPair.publicKeyJwk.crv).toBe('P-256');
    });

    it('should generate different key pairs each time', async () => {
      const keyPair1 = await generateKeyPair();
      const keyPair2 = await generateKeyPair();
      
      expect(keyPair1.publicKeyJwk.x).not.toBe(keyPair2.publicKeyJwk.x);
    });
  });

  describe('Key Exchange', () => {
    it('should import public key from JWK', async () => {
      const keyPair = await generateKeyPair();
      const importedKey = await importPublicKey(keyPair.publicKeyJwk);
      
      expect(importedKey).toBeDefined();
      expect(importedKey.type).toBe('public');
    });

    it('should derive same shared key from both sides', async () => {
      // Simulate two peers
      const aliceKeys = await generateKeyPair();
      const bobKeys = await generateKeyPair();
      
      // Import each other's public keys
      const bobPublicForAlice = await importPublicKey(bobKeys.publicKeyJwk);
      const alicePublicForBob = await importPublicKey(aliceKeys.publicKeyJwk);
      
      // Derive shared keys
      const aliceSharedKey = await deriveSharedKey(aliceKeys.privateKey, bobPublicForAlice);
      const bobSharedKey = await deriveSharedKey(bobKeys.privateKey, alicePublicForBob);
      
      // Both should be able to encrypt/decrypt the same message
      const testPayload = { message: 'Hello, World!', timestamp: Date.now() };
      
      const encrypted = await encryptPayload(aliceSharedKey, testPayload);
      const decrypted = await decryptPayload(bobSharedKey, encrypted.ciphertext, encrypted.iv);
      
      expect(decrypted).toEqual(testPayload);
    });
  });

  describe('Encryption/Decryption', () => {
    let sharedKey;

    beforeEach(async () => {
      const aliceKeys = await generateKeyPair();
      const bobKeys = await generateKeyPair();
      const bobPublic = await importPublicKey(bobKeys.publicKeyJwk);
      sharedKey = await deriveSharedKey(aliceKeys.privateKey, bobPublic);
    });

    it('should encrypt and decrypt simple payload', async () => {
      const payload = { type: 'test', data: 'hello' };
      
      const encrypted = await encryptPayload(sharedKey, payload);
      expect(encrypted.ciphertext).toBeDefined();
      expect(encrypted.iv).toBeDefined();
      expect(typeof encrypted.ciphertext).toBe('string');
      expect(typeof encrypted.iv).toBe('string');
      
      const decrypted = await decryptPayload(sharedKey, encrypted.ciphertext, encrypted.iv);
      expect(decrypted).toEqual(payload);
    });

    it('should encrypt and decrypt complex payload', async () => {
      const payload = {
        type: 'dht_message',
        from: 'abc123',
        to: 'def456',
        data: {
          nested: {
            array: [1, 2, 3],
            boolean: true,
            null: null
          }
        }
      };
      
      const encrypted = await encryptPayload(sharedKey, payload);
      const decrypted = await decryptPayload(sharedKey, encrypted.ciphertext, encrypted.iv);
      
      expect(decrypted).toEqual(payload);
    });

    it('should produce different ciphertext for same payload (random IV)', async () => {
      const payload = { message: 'same message' };
      
      const encrypted1 = await encryptPayload(sharedKey, payload);
      const encrypted2 = await encryptPayload(sharedKey, payload);
      
      // IVs should be different
      expect(encrypted1.iv).not.toBe(encrypted2.iv);
      // Ciphertext should be different due to different IV
      expect(encrypted1.ciphertext).not.toBe(encrypted2.ciphertext);
      
      // But both should decrypt to same payload
      const decrypted1 = await decryptPayload(sharedKey, encrypted1.ciphertext, encrypted1.iv);
      const decrypted2 = await decryptPayload(sharedKey, encrypted2.ciphertext, encrypted2.iv);
      
      expect(decrypted1).toEqual(payload);
      expect(decrypted2).toEqual(payload);
    });

    it('should fail to decrypt with wrong key', async () => {
      const payload = { secret: 'data' };
      const encrypted = await encryptPayload(sharedKey, payload);
      
      // Generate a different key
      const otherKeys = await generateKeyPair();
      const otherKeys2 = await generateKeyPair();
      const otherPublic = await importPublicKey(otherKeys2.publicKeyJwk);
      const wrongKey = await deriveSharedKey(otherKeys.privateKey, otherPublic);
      
      await expect(
        decryptPayload(wrongKey, encrypted.ciphertext, encrypted.iv)
      ).rejects.toThrow();
    });
  });

  describe('Encrypted Payload Wrapper', () => {
    let sharedKey;

    beforeEach(async () => {
      const aliceKeys = await generateKeyPair();
      const bobKeys = await generateKeyPair();
      const bobPublic = await importPublicKey(bobKeys.publicKeyJwk);
      sharedKey = await deriveSharedKey(aliceKeys.privateKey, bobPublic);
    });

    it('should create encrypted payload wrapper', async () => {
      const payload = { message: 'test' };
      
      const wrapper = await createEncryptedPayload(sharedKey, payload);
      
      expect(wrapper.encrypted).toBe(true);
      expect(wrapper.v).toBe(1);
      expect(wrapper.ct).toBeDefined();
      expect(wrapper.iv).toBeDefined();
    });

    it('should decrypt encrypted payload wrapper', async () => {
      const payload = { message: 'test', number: 42 };
      
      const wrapper = await createEncryptedPayload(sharedKey, payload);
      const decrypted = await decryptEncryptedPayload(sharedKey, wrapper);
      
      expect(decrypted).toEqual(payload);
    });

    it('should pass through non-encrypted payload', async () => {
      const payload = { message: 'not encrypted' };
      
      const result = await decryptEncryptedPayload(sharedKey, payload);
      
      expect(result).toEqual(payload);
    });

    it('should detect encrypted payload', () => {
      expect(isEncryptedPayload({ encrypted: true, ct: 'abc', iv: 'def' })).toBe(true);
      expect(isEncryptedPayload({ encrypted: true, ct: 'abc' })).toBe(false);
      expect(isEncryptedPayload({ message: 'plain' })).toBe(false);
      expect(isEncryptedPayload(null)).toBe(false);
      expect(isEncryptedPayload('string')).toBe(false);
    });
  });

  describe('RelaySessionKeys', () => {
    it('should initialize and generate public key', async () => {
      const keys = new RelaySessionKeys();
      await keys.initialize();
      
      const publicKey = keys.getPublicKeyJwk();
      expect(publicKey).toBeDefined();
      expect(publicKey.kty).toBe('EC');
      expect(publicKey.crv).toBe('P-256');
    });

    it('should throw if not initialized', () => {
      const keys = new RelaySessionKeys();
      
      expect(() => keys.getPublicKeyJwk()).toThrow('not initialized');
    });

    it('should not be ready before peer key is set', async () => {
      const keys = new RelaySessionKeys();
      await keys.initialize();
      
      expect(keys.isReady()).toBe(false);
    });

    it('should be ready after peer key is set', async () => {
      const aliceKeys = new RelaySessionKeys();
      const bobKeys = new RelaySessionKeys();
      
      await aliceKeys.initialize();
      await bobKeys.initialize();
      
      await aliceKeys.setPeerPublicKey(bobKeys.getPublicKeyJwk());
      
      expect(aliceKeys.isReady()).toBe(true);
    });

    it('should encrypt and decrypt between two sessions', async () => {
      const aliceKeys = new RelaySessionKeys();
      const bobKeys = new RelaySessionKeys();
      
      await aliceKeys.initialize();
      await bobKeys.initialize();
      
      // Exchange public keys
      await aliceKeys.setPeerPublicKey(bobKeys.getPublicKeyJwk());
      await bobKeys.setPeerPublicKey(aliceKeys.getPublicKeyJwk());
      
      // Alice encrypts, Bob decrypts
      const payload = { from: 'alice', message: 'Hello Bob!' };
      const encrypted = await aliceKeys.encrypt(payload);
      const decrypted = await bobKeys.decrypt(encrypted);
      
      expect(decrypted).toEqual(payload);
    });

    it('should work bidirectionally', async () => {
      const aliceKeys = new RelaySessionKeys();
      const bobKeys = new RelaySessionKeys();
      
      await aliceKeys.initialize();
      await bobKeys.initialize();
      
      await aliceKeys.setPeerPublicKey(bobKeys.getPublicKeyJwk());
      await bobKeys.setPeerPublicKey(aliceKeys.getPublicKeyJwk());
      
      // Alice to Bob
      const msg1 = { direction: 'alice->bob' };
      const enc1 = await aliceKeys.encrypt(msg1);
      const dec1 = await bobKeys.decrypt(enc1);
      expect(dec1).toEqual(msg1);
      
      // Bob to Alice
      const msg2 = { direction: 'bob->alice' };
      const enc2 = await bobKeys.encrypt(msg2);
      const dec2 = await aliceKeys.decrypt(enc2);
      expect(dec2).toEqual(msg2);
    });

    it('should throw if encrypting before ready', async () => {
      const keys = new RelaySessionKeys();
      await keys.initialize();
      
      await expect(keys.encrypt({ test: 'data' })).rejects.toThrow('Shared key not established');
    });

    it('should clean up on destroy', async () => {
      const keys = new RelaySessionKeys();
      await keys.initialize();
      
      const peerKeys = new RelaySessionKeys();
      await peerKeys.initialize();
      await keys.setPeerPublicKey(peerKeys.getPublicKeyJwk());
      
      expect(keys.isReady()).toBe(true);
      
      keys.destroy();
      
      expect(keys.isReady()).toBe(false);
      expect(() => keys.getPublicKeyJwk()).toThrow('not initialized');
    });
  });
});
