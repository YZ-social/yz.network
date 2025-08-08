/**
 * Basic smoke tests to verify the test framework works
 * These tests verify core functionality without making assumptions about API details
 */

describe('Test Framework', () => {
  test('Jest is working correctly', () => {
    expect(1 + 1).toBe(2);
  });

  test('ES modules can be imported', async () => {
    // Test that we can import ES modules in the test environment
    const { DHTNodeId } = await import('../src/core/DHTNodeId.js');
    expect(DHTNodeId).toBeDefined();
    expect(typeof DHTNodeId).toBe('function');
  });

  test('WebRTC mocks are available', () => {
    expect(global.RTCPeerConnection).toBeDefined();
    expect(global.RTCDataChannel).toBeDefined();
    expect(global.crypto).toBeDefined();
  });
});

describe('Basic DHTNodeId functionality', () => {
  test('can create DHTNodeId instance', async () => {
    const { DHTNodeId } = await import('../src/core/DHTNodeId.js');
    const nodeId = new DHTNodeId();
    
    expect(nodeId).toBeDefined();
    expect(nodeId.bytes).toBeDefined();
    expect(nodeId.bytes.length).toBe(20);
  });

  test('can create DHTNodeId from string', async () => {
    const { DHTNodeId } = await import('../src/core/DHTNodeId.js');
    const nodeId = DHTNodeId.fromString('test-string');
    
    expect(nodeId).toBeDefined();
    expect(nodeId.bytes).toBeDefined();
    expect(nodeId.bytes.length).toBe(20);
  });
});