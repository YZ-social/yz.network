// Jest test for RelayProtocol module
import {
  RelayMessageType,
  RelaySessionState,
  RelayRejectionReason,
  RelayCloseReason,
  createRelayRequest,
  createRelayForward,
  createRelayAck,
  createRelayClose,
  createRelayPing,
  createRelayPong,
  isRelayMessage,
  validateRelayMessage,
  validateRelayRequest,
  validateRelayForward,
  validateRelayAck,
  validateRelayClose,
  validateRelayPing,
  validateRelayPong,
  generateSessionId,
  generatePingId,
  getSessionId,
  describeRelayMessage
} from '../../src/network/RelayProtocol.js';

describe('RelayProtocol', () => {
  describe('Message Type Constants', () => {
    it('should define all relay message types', () => {
      expect(RelayMessageType.REQUEST).toBe('relay_request');
      expect(RelayMessageType.FORWARD).toBe('relay_forward');
      expect(RelayMessageType.ACK).toBe('relay_ack');
      expect(RelayMessageType.CLOSE).toBe('relay_close');
      expect(RelayMessageType.PING).toBe('relay_ping');
      expect(RelayMessageType.PONG).toBe('relay_pong');
    });

    it('should define all session states', () => {
      expect(RelaySessionState.PENDING).toBe('pending');
      expect(RelaySessionState.ACTIVE).toBe('active');
      expect(RelaySessionState.FAILED).toBe('failed');
      expect(RelaySessionState.CLOSING).toBe('closing');
      expect(RelaySessionState.CLOSED).toBe('closed');
    });

    it('should define all rejection reasons', () => {
      expect(RelayRejectionReason.NOT_RELAY_CAPABLE).toBe('not_relay_capable');
      expect(RelayRejectionReason.CAPACITY_REACHED).toBe('capacity_reached');
      expect(RelayRejectionReason.TARGET_NOT_FOUND).toBe('target_not_found');
    });

    it('should define all close reasons', () => {
      expect(RelayCloseReason.MANUAL).toBe('manual');
      expect(RelayCloseReason.TIMEOUT).toBe('timeout');
      expect(RelayCloseReason.PATH_UPGRADE).toBe('path_upgrade');
    });
  });

  describe('Message Factory Functions', () => {
    describe('createRelayRequest', () => {
      it('should create a valid relay request message', () => {
        const msg = createRelayRequest('target123', 'session456');
        
        expect(msg.type).toBe(RelayMessageType.REQUEST);
        expect(msg.targetPeerId).toBe('target123');
        expect(msg.sessionId).toBe('session456');
        expect(msg.timestamp).toBeDefined();
      });

      it('should include additional options', () => {
        const msg = createRelayRequest('target123', 'session456', { priority: 'high' });
        
        expect(msg.priority).toBe('high');
      });
    });

    describe('createRelayForward', () => {
      it('should create a valid relay forward message', () => {
        const payload = { data: 'encrypted' };
        const msg = createRelayForward('session123', 'target456', payload);
        
        expect(msg.type).toBe(RelayMessageType.FORWARD);
        expect(msg.sessionId).toBe('session123');
        expect(msg.to).toBe('target456');
        expect(msg.payload).toEqual(payload);
        expect(msg.from).toBeUndefined();
      });

      it('should include from field when provided', () => {
        const msg = createRelayForward('session123', 'target456', {}, 'sender789');
        
        expect(msg.from).toBe('sender789');
      });
    });

    describe('createRelayAck', () => {
      it('should create a success ack message', () => {
        const msg = createRelayAck('session123', true);
        
        expect(msg.type).toBe(RelayMessageType.ACK);
        expect(msg.sessionId).toBe('session123');
        expect(msg.success).toBe(true);
        expect(msg.error).toBeUndefined();
      });

      it('should create a failure ack message with error', () => {
        const msg = createRelayAck('session123', false, 'capacity_reached');
        
        expect(msg.success).toBe(false);
        expect(msg.error).toBe('capacity_reached');
      });

      it('should include metadata when provided', () => {
        const msg = createRelayAck('session123', true, null, { relayNodeId: 'relay1' });
        
        expect(msg.metadata).toEqual({ relayNodeId: 'relay1' });
      });
    });

    describe('createRelayClose', () => {
      it('should create a close message with default reason', () => {
        const msg = createRelayClose('session123');
        
        expect(msg.type).toBe(RelayMessageType.CLOSE);
        expect(msg.sessionId).toBe('session123');
        expect(msg.reason).toBe(RelayCloseReason.MANUAL);
      });

      it('should create a close message with custom reason', () => {
        const msg = createRelayClose('session123', RelayCloseReason.PATH_UPGRADE);
        
        expect(msg.reason).toBe('path_upgrade');
      });
    });

    describe('createRelayPing', () => {
      it('should create a ping message', () => {
        const msg = createRelayPing('session123', 'ping456');
        
        expect(msg.type).toBe(RelayMessageType.PING);
        expect(msg.sessionId).toBe('session123');
        expect(msg.pingId).toBe('ping456');
        expect(msg.timestamp).toBeDefined();
      });
    });

    describe('createRelayPong', () => {
      it('should create a pong message', () => {
        const originalTimestamp = Date.now() - 100;
        const msg = createRelayPong('session123', 'ping456', originalTimestamp);
        
        expect(msg.type).toBe(RelayMessageType.PONG);
        expect(msg.sessionId).toBe('session123');
        expect(msg.pingId).toBe('ping456');
        expect(msg.timestamp).toBe(originalTimestamp);
        expect(msg.respondedAt).toBeDefined();
      });
    });
  });

  describe('Validation Functions', () => {
    describe('isRelayMessage', () => {
      it('should return true for valid relay messages', () => {
        expect(isRelayMessage({ type: 'relay_request' })).toBe(true);
        expect(isRelayMessage({ type: 'relay_forward' })).toBe(true);
        expect(isRelayMessage({ type: 'relay_ack' })).toBe(true);
        expect(isRelayMessage({ type: 'relay_close' })).toBe(true);
        expect(isRelayMessage({ type: 'relay_ping' })).toBe(true);
        expect(isRelayMessage({ type: 'relay_pong' })).toBe(true);
      });

      it('should return false for non-relay messages', () => {
        expect(isRelayMessage({ type: 'dht_message' })).toBe(false);
        expect(isRelayMessage({ type: 'ping' })).toBe(false);
        expect(isRelayMessage(null)).toBe(false);
        expect(isRelayMessage(undefined)).toBe(false);
        expect(isRelayMessage('string')).toBe(false);
      });
    });

    describe('validateRelayRequest', () => {
      it('should validate a correct request', () => {
        const msg = createRelayRequest('target123', 'session456');
        const result = validateRelayRequest(msg);
        
        expect(result.valid).toBe(true);
      });

      it('should reject missing targetPeerId', () => {
        const result = validateRelayRequest({ type: 'relay_request', sessionId: 'abc' });
        
        expect(result.valid).toBe(false);
        expect(result.error).toContain('targetPeerId');
      });

      it('should reject missing sessionId', () => {
        const result = validateRelayRequest({ type: 'relay_request', targetPeerId: 'abc' });
        
        expect(result.valid).toBe(false);
        expect(result.error).toContain('sessionId');
      });
    });

    describe('validateRelayForward', () => {
      it('should validate a correct forward message', () => {
        const msg = createRelayForward('session123', 'target456', { data: 'test' });
        const result = validateRelayForward(msg);
        
        expect(result.valid).toBe(true);
      });

      it('should reject missing payload', () => {
        const result = validateRelayForward({ type: 'relay_forward', sessionId: 'abc' });
        
        expect(result.valid).toBe(false);
        expect(result.error).toContain('payload');
      });
    });

    describe('validateRelayAck', () => {
      it('should validate a correct ack message', () => {
        const msg = createRelayAck('session123', true);
        const result = validateRelayAck(msg);
        
        expect(result.valid).toBe(true);
      });

      it('should reject missing success field', () => {
        const result = validateRelayAck({ type: 'relay_ack', sessionId: 'abc' });
        
        expect(result.valid).toBe(false);
        expect(result.error).toContain('success');
      });
    });

    describe('validateRelayMessage', () => {
      it('should validate any relay message type', () => {
        expect(validateRelayMessage(createRelayRequest('a', 'b')).valid).toBe(true);
        expect(validateRelayMessage(createRelayForward('a', 'b', {})).valid).toBe(true);
        expect(validateRelayMessage(createRelayAck('a', true)).valid).toBe(true);
        expect(validateRelayMessage(createRelayClose('a')).valid).toBe(true);
        expect(validateRelayMessage(createRelayPing('a', 'b')).valid).toBe(true);
        expect(validateRelayMessage(createRelayPong('a', 'b', 123)).valid).toBe(true);
      });

      it('should reject unknown message types', () => {
        const result = validateRelayMessage({ type: 'unknown' });
        
        expect(result.valid).toBe(false);
        expect(result.error).toContain('Unknown');
      });

      it('should reject non-object messages', () => {
        expect(validateRelayMessage(null).valid).toBe(false);
        expect(validateRelayMessage('string').valid).toBe(false);
      });
    });
  });

  describe('Utility Functions', () => {
    describe('generateSessionId', () => {
      it('should generate unique session IDs', () => {
        const id1 = generateSessionId();
        const id2 = generateSessionId();
        
        expect(id1).not.toBe(id2);
        expect(id1).toMatch(/^relay_/);
      });
    });

    describe('generatePingId', () => {
      it('should generate unique ping IDs', () => {
        const id1 = generatePingId();
        const id2 = generatePingId();
        
        expect(id1).not.toBe(id2);
        expect(id1).toMatch(/^ping_/);
      });
    });

    describe('getSessionId', () => {
      it('should extract session ID from relay messages', () => {
        const msg = createRelayRequest('target', 'session123');
        
        expect(getSessionId(msg)).toBe('session123');
      });

      it('should return null for invalid messages', () => {
        expect(getSessionId(null)).toBeNull();
        expect(getSessionId({})).toBeNull();
      });
    });

    describe('describeRelayMessage', () => {
      it('should describe relay request', () => {
        const msg = createRelayRequest('target123456789', 'session123456789');
        const desc = describeRelayMessage(msg);
        
        expect(desc).toContain('RELAY_REQUEST');
        expect(desc).toContain('target12');
      });

      it('should describe relay forward', () => {
        const msg = createRelayForward('session123456789', 'target123456789', {});
        const desc = describeRelayMessage(msg);
        
        expect(desc).toContain('RELAY_FORWARD');
      });

      it('should describe relay ack success', () => {
        const msg = createRelayAck('session123456789', true);
        const desc = describeRelayMessage(msg);
        
        expect(desc).toContain('RELAY_ACK');
        expect(desc).toContain('SUCCESS');
      });

      it('should describe relay ack failure', () => {
        const msg = createRelayAck('session123456789', false);
        const desc = describeRelayMessage(msg);
        
        expect(desc).toContain('FAILED');
      });

      it('should return message for non-relay messages', () => {
        const desc = describeRelayMessage({ type: 'other' });
        
        expect(desc).toContain('Not a relay message');
      });
    });
  });
});
