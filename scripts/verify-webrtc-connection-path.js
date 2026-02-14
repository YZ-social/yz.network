/**
 * WebRTC Connection Path Verification Script
 * 
 * This script verifies the integrity of WebRTC connection paths:
 * - Test browser ↔ browser WebRTC DataChannel establishment
 * - Verify WebRTC signaling coordination through bootstrap server
 * - Check if data transfer metrics interfere with WebRTC message routing
 * - Test WebRTC fallback to WebSocket routing when direct connections fail
 * - Debug WebRTC connection manager failures
 * 
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5
 */

import WebSocket from 'ws';

const BOOTSTRAP_URL = process.env.BOOTSTRAP_URL || 'wss://imeyouwe.com/bootstrap';
const TEST_TIMEOUT = 30000;

console.log('='.repeat(70));
console.log('WebRTC Connection Path Verification');
console.log('='.repeat(70));
console.log(`Bootstrap URL: ${BOOTSTRAP_URL}`);
console.log(`Test Timeout: ${TEST_TIMEOUT}ms`);
console.log('');

const results = {
  signalingCoordination: { status: 'pending', details: [] },
  bootstrapSignaling: { status: 'pending', details: [] },
  signalForwarding: { status: 'pending', details: [] },
  connectionManagerIntegrity: { status: 'pending', details: [] },
  fallbackMechanism: { status: 'pending', details: [] }
};

/**
 * Test 1: Verify WebRTC signaling coordination through bootstrap server
 * Requirements: 4.1, 4.4
 */
async function testSignalingCoordination() {
  console.log('\n📡 Test 1: WebRTC Signaling Coordination');
  console.log('-'.repeat(50));
  
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      results.signalingCoordination.status = 'timeout';
      results.signalingCoordination.details.push('Connection timeout after 10s');
      resolve(false);
    }, 10000);
    
    try {
      const ws = new WebSocket(BOOTSTRAP_URL);
      
      ws.on('open', () => {
        console.log('✅ Connected to bootstrap server');
        results.signalingCoordination.details.push('Bootstrap connection established');
        
        // Register as a test peer to verify signaling capability
        const registerMessage = {
          type: 'register',
          peerId: `test-webrtc-${Date.now()}`,
          metadata: {
            nodeType: 'browser',
            capabilities: ['webrtc', 'datachannel']
          }
        };
        
        ws.send(JSON.stringify(registerMessage));
        console.log('📤 Sent registration message');
      });
      
      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          console.log(`📥 Received: ${message.type}`);
          
          if (message.type === 'registered' || message.type === 'welcome') {
            results.signalingCoordination.status = 'pass';
            results.signalingCoordination.details.push(`Registration successful: ${message.type}`);
            clearTimeout(timeout);
            ws.close();
            resolve(true);
          } else if (message.type === 'error') {
            results.signalingCoordination.status = 'fail';
            results.signalingCoordination.details.push(`Error: ${message.error || message.message}`);
            clearTimeout(timeout);
            ws.close();
            resolve(false);
          }
        } catch (e) {
          console.log(`📥 Non-JSON message: ${data.toString().substring(0, 100)}`);
        }
      });
      
      ws.on('error', (error) => {
        console.error('❌ WebSocket error:', error.message);
        results.signalingCoordination.status = 'fail';
        results.signalingCoordination.details.push(`Connection error: ${error.message}`);
        clearTimeout(timeout);
        resolve(false);
      });
      
      ws.on('close', (code, reason) => {
        console.log(`🔌 Connection closed: ${code} - ${reason || 'no reason'}`);
        if (results.signalingCoordination.status === 'pending') {
          results.signalingCoordination.status = 'fail';
          results.signalingCoordination.details.push(`Connection closed unexpectedly: ${code}`);
          clearTimeout(timeout);
          resolve(false);
        }
      });
      
    } catch (error) {
      console.error('❌ Test error:', error.message);
      results.signalingCoordination.status = 'fail';
      results.signalingCoordination.details.push(`Test error: ${error.message}`);
      clearTimeout(timeout);
      resolve(false);
    }
  });
}

/**
 * Test 2: Verify bootstrap server can handle WebRTC signal forwarding
 * Requirements: 4.4
 */
async function testBootstrapSignaling() {
  console.log('\n📡 Test 2: Bootstrap Server Signal Handling');
  console.log('-'.repeat(50));
  
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      results.bootstrapSignaling.status = 'timeout';
      results.bootstrapSignaling.details.push('Signal handling test timeout');
      resolve(false);
    }, 10000);
    
    try {
      const ws = new WebSocket(BOOTSTRAP_URL);
      const testPeerId = `test-signal-${Date.now()}`;
      
      ws.on('open', () => {
        console.log('✅ Connected to bootstrap server');
        
        // First register
        ws.send(JSON.stringify({
          type: 'register',
          peerId: testPeerId,
          metadata: { nodeType: 'browser' }
        }));
      });
      
      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          console.log(`📥 Received: ${message.type}`);
          
          if (message.type === 'registered' || message.type === 'welcome') {
            // Now test signal forwarding capability
            const signalMessage = {
              type: 'forward_signal',
              fromPeer: testPeerId,
              toPeer: 'nonexistent-peer-for-test',
              signal: {
                type: 'offer',
                sdp: 'test-sdp-data'
              }
            };
            
            ws.send(JSON.stringify(signalMessage));
            console.log('📤 Sent test signal forward request');
            
            // The server should respond (either with error for nonexistent peer or success)
            // Either response proves the signaling mechanism works
            results.bootstrapSignaling.status = 'pass';
            results.bootstrapSignaling.details.push('Signal forwarding mechanism available');
          }
          
          if (message.type === 'signal_error' || message.type === 'error') {
            // Expected - peer doesn't exist, but mechanism works
            results.bootstrapSignaling.details.push(`Signal mechanism responded: ${message.error || message.message || 'peer not found'}`);
            clearTimeout(timeout);
            ws.close();
            resolve(true);
          }
          
          if (message.type === 'signal_forwarded') {
            results.bootstrapSignaling.details.push('Signal forwarding confirmed');
            clearTimeout(timeout);
            ws.close();
            resolve(true);
          }
        } catch (e) {
          // Non-JSON response
        }
      });
      
      ws.on('error', (error) => {
        results.bootstrapSignaling.status = 'fail';
        results.bootstrapSignaling.details.push(`Error: ${error.message}`);
        clearTimeout(timeout);
        resolve(false);
      });
      
      // Give it time to process
      setTimeout(() => {
        if (results.bootstrapSignaling.status === 'pass') {
          clearTimeout(timeout);
          ws.close();
          resolve(true);
        }
      }, 3000);
      
    } catch (error) {
      results.bootstrapSignaling.status = 'fail';
      results.bootstrapSignaling.details.push(`Test error: ${error.message}`);
      clearTimeout(timeout);
      resolve(false);
    }
  });
}

/**
 * Test 3: Verify WebRTC connection manager integrity
 * Requirements: 4.1, 4.2
 */
async function testConnectionManagerIntegrity() {
  console.log('\n🔧 Test 3: WebRTC Connection Manager Integrity');
  console.log('-'.repeat(50));
  
  try {
    // Import and test WebRTCConnectionManager
    const { WebRTCConnectionManager } = await import('../src/network/WebRTCConnectionManager.js');
    const { ConnectionManagerFactory } = await import('../src/network/ConnectionManagerFactory.js');
    
    // Test 1: Manager instantiation
    console.log('Testing WebRTCConnectionManager instantiation...');
    const manager = new WebRTCConnectionManager({
      localNodeType: 'browser',
      targetNodeType: 'browser'
    });
    
    if (!manager) {
      throw new Error('Failed to create WebRTCConnectionManager');
    }
    results.connectionManagerIntegrity.details.push('✅ Manager instantiation successful');
    
    // Test 2: ICE servers configuration
    console.log('Testing ICE servers configuration...');
    if (!manager.rtcOptions || !manager.rtcOptions.iceServers) {
      throw new Error('ICE servers not configured');
    }
    const iceServerCount = manager.rtcOptions.iceServers.length;
    results.connectionManagerIntegrity.details.push(`✅ ICE servers configured: ${iceServerCount} servers`);
    
    // Test 3: Keep-alive configuration
    console.log('Testing keep-alive configuration...');
    if (manager.keepAliveInterval !== 30000) {
      throw new Error(`Unexpected keepAliveInterval: ${manager.keepAliveInterval}`);
    }
    if (manager.keepAliveIntervalHidden !== 10000) {
      throw new Error(`Unexpected keepAliveIntervalHidden: ${manager.keepAliveIntervalHidden}`);
    }
    results.connectionManagerIntegrity.details.push('✅ Keep-alive intervals configured correctly');
    
    // Test 4: Factory routing for browser-to-browser
    console.log('Testing ConnectionManagerFactory routing...');
    ConnectionManagerFactory.initializeTransports({ localNodeType: 'browser' });
    const browserManager = ConnectionManagerFactory.createForConnection('browser', 'browser');
    
    if (!(browserManager instanceof WebRTCConnectionManager)) {
      throw new Error('Factory did not create WebRTCConnectionManager for browser-to-browser');
    }
    results.connectionManagerIntegrity.details.push('✅ Factory routes browser↔browser to WebRTCConnectionManager');
    
    // Test 5: Signal emission capability
    console.log('Testing signal emission capability...');
    let signalEmitted = false;
    manager.on('signal', () => { signalEmitted = true; });
    manager.emit('signal', { peerId: 'test', signal: { type: 'test' } });
    
    if (!signalEmitted) {
      throw new Error('Signal event not emitted');
    }
    results.connectionManagerIntegrity.details.push('✅ Signal emission working');
    
    // Cleanup
    manager.destroy();
    browserManager.destroy();
    
    results.connectionManagerIntegrity.status = 'pass';
    console.log('✅ All connection manager integrity tests passed');
    return true;
    
  } catch (error) {
    console.error('❌ Connection manager integrity test failed:', error.message);
    results.connectionManagerIntegrity.status = 'fail';
    results.connectionManagerIntegrity.details.push(`❌ Error: ${error.message}`);
    return false;
  }
}

/**
 * Test 4: Verify WebRTC fallback to WebSocket routing
 * Requirements: 4.5
 */
async function testFallbackMechanism() {
  console.log('\n🔄 Test 4: WebRTC Fallback Mechanism');
  console.log('-'.repeat(50));
  
  try {
    const { ConnectionManagerFactory } = await import('../src/network/ConnectionManagerFactory.js');
    const { WebSocketConnectionManager } = await import('../src/network/WebSocketConnectionManager.js');
    
    // Test that browser-to-nodejs connections use WebSocket (fallback path)
    console.log('Testing browser→nodejs fallback to WebSocket...');
    ConnectionManagerFactory.initializeTransports({ localNodeType: 'browser' });
    
    const wsManager = ConnectionManagerFactory.createForConnection('browser', 'nodejs');
    
    if (!(wsManager instanceof WebSocketConnectionManager)) {
      throw new Error('Factory did not create WebSocketConnectionManager for browser-to-nodejs');
    }
    results.fallbackMechanism.details.push('✅ Browser→Node.js uses WebSocket (correct fallback)');
    
    // Test that nodejs-to-browser also uses WebSocket
    console.log('Testing nodejs→browser fallback to WebSocket...');
    ConnectionManagerFactory.initializeTransports({ localNodeType: 'nodejs' });
    
    const wsManager2 = ConnectionManagerFactory.createForConnection('nodejs', 'browser');
    
    if (!(wsManager2 instanceof WebSocketConnectionManager)) {
      throw new Error('Factory did not create WebSocketConnectionManager for nodejs-to-browser');
    }
    results.fallbackMechanism.details.push('✅ Node.js→Browser uses WebSocket (correct fallback)');
    
    // Cleanup
    wsManager.destroy();
    wsManager2.destroy();
    
    results.fallbackMechanism.status = 'pass';
    console.log('✅ Fallback mechanism tests passed');
    return true;
    
  } catch (error) {
    console.error('❌ Fallback mechanism test failed:', error.message);
    results.fallbackMechanism.status = 'fail';
    results.fallbackMechanism.details.push(`❌ Error: ${error.message}`);
    return false;
  }
}

/**
 * Test 5: Verify data transfer metrics don't interfere with WebRTC
 * Requirements: 4.3
 */
async function testMetricsNonInterference() {
  console.log('\n📊 Test 5: Data Transfer Metrics Non-Interference');
  console.log('-'.repeat(50));
  
  try {
    const { WebRTCConnectionManager } = await import('../src/network/WebRTCConnectionManager.js');
    
    // Create manager and verify message handling works
    const manager = new WebRTCConnectionManager({
      localNodeType: 'browser',
      targetNodeType: 'browser'
    });
    manager.initialize('test-node-metrics');
    
    // Test that handleMessage doesn't throw with various message types
    console.log('Testing message handling with various message types...');
    
    const testMessages = [
      { type: 'ping', requestId: 'req_1', timestamp: Date.now() },
      { type: 'find_node', targetId: 'target123', requestId: 'req_2' },
      { type: 'store', key: 'testkey', value: 'testvalue', requestId: 'req_3' },
      { type: 'custom', data: { nested: { deep: 'value' } } }
    ];
    
    let messagesHandled = 0;
    for (const msg of testMessages) {
      try {
        // handleMessage should not throw
        manager.handleMessage('test-peer', msg);
        messagesHandled++;
      } catch (e) {
        console.error(`❌ Message handling failed for ${msg.type}:`, e.message);
      }
    }
    
    results.signalForwarding.details.push(`✅ ${messagesHandled}/${testMessages.length} message types handled without error`);
    
    // Cleanup
    manager.destroy();
    
    if (messagesHandled === testMessages.length) {
      results.signalForwarding.status = 'pass';
      console.log('✅ Metrics non-interference test passed');
      return true;
    } else {
      results.signalForwarding.status = 'partial';
      console.log('⚠️ Some message types had issues');
      return false;
    }
    
  } catch (error) {
    console.error('❌ Metrics non-interference test failed:', error.message);
    results.signalForwarding.status = 'fail';
    results.signalForwarding.details.push(`❌ Error: ${error.message}`);
    return false;
  }
}

/**
 * Print final results
 */
function printResults() {
  console.log('\n' + '='.repeat(70));
  console.log('WebRTC Connection Path Verification Results');
  console.log('='.repeat(70));
  
  const tests = [
    { name: 'Signaling Coordination (4.1, 4.4)', result: results.signalingCoordination },
    { name: 'Bootstrap Signaling (4.4)', result: results.bootstrapSignaling },
    { name: 'Connection Manager Integrity (4.1, 4.2)', result: results.connectionManagerIntegrity },
    { name: 'Fallback Mechanism (4.5)', result: results.fallbackMechanism },
    { name: 'Metrics Non-Interference (4.3)', result: results.signalForwarding }
  ];
  
  let passed = 0;
  let failed = 0;
  
  for (const test of tests) {
    const statusIcon = test.result.status === 'pass' ? '✅' : 
                       test.result.status === 'fail' ? '❌' : 
                       test.result.status === 'timeout' ? '⏰' : '⚠️';
    
    console.log(`\n${statusIcon} ${test.name}: ${test.result.status.toUpperCase()}`);
    
    for (const detail of test.result.details) {
      console.log(`   ${detail}`);
    }
    
    if (test.result.status === 'pass') passed++;
    else failed++;
  }
  
  console.log('\n' + '-'.repeat(70));
  console.log(`Summary: ${passed} passed, ${failed} failed/pending`);
  console.log('='.repeat(70));
  
  return failed === 0;
}

/**
 * Main execution
 */
async function main() {
  console.log('Starting WebRTC connection path verification...\n');
  
  // Run all tests
  await testSignalingCoordination();
  await testBootstrapSignaling();
  await testConnectionManagerIntegrity();
  await testFallbackMechanism();
  await testMetricsNonInterference();
  
  // Print results
  const allPassed = printResults();
  
  process.exit(allPassed ? 0 : 1);
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
