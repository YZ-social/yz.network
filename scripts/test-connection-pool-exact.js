#!/usr/bin/env node

/**
 * Test the exact same connection flow as BridgeConnectionPool
 */

import WebSocket from 'ws';

async function testConnectionPoolFlow() {
  console.log('🧪 Testing exact connection pool flow...');
  
  const bridgeAddr = 'wss://imeyouwe.com/bridge1';
  const authToken = '91840b332e1212f0563d60df866642536fb82f6d71df472bea6a6c36fdb03502';
  
  try {
    console.log(`🔗 Connecting to ${bridgeAddr}...`);
    
    // Use exact same options as BridgeConnectionPool
    const wsOptions = {
      rejectUnauthorized: false,
      handshakeTimeout: 10000,
      headers: {
        'User-Agent': 'YZ-Bootstrap-ConnectionPool/1.0'
      }
    };
    
    const ws = new WebSocket(bridgeAddr, wsOptions);
    
    // Set up handlers exactly like BridgeConnectionPool
    ws.on('open', () => {
      console.log('✅ WebSocket opened, sending auth...');
      
      // Send authentication exactly like BridgeConnectionPool
      ws.send(JSON.stringify({
        type: 'bootstrap_auth',
        auth_token: authToken,
        bootstrapServer: 'connection-pool'
      }));
    });
    
    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        console.log('📥 Received message:', message);
        
        if (message.type === 'auth_success') {
          console.log('✅ Authentication successful!');
          ws.close();
        } else if (message.type === 'auth_failed' || message.type === 'error') {
          console.log('❌ Authentication failed:', message.message);
          ws.close();
        }
      } catch (error) {
        console.log('❌ Failed to parse message:', error.message);
      }
    });
    
    ws.on('error', (error) => {
      console.log('❌ WebSocket error:', error.message);
    });
    
    ws.on('close', (code, reason) => {
      console.log(`🔌 WebSocket closed: ${code} ${reason}`);
    });
    
    // Wait for connection
    await new Promise((resolve) => {
      setTimeout(resolve, 10000);
    });
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
  }
}

testConnectionPoolFlow().then(() => {
  console.log('🏁 Test complete');
  process.exit(0);
});