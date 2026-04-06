#!/usr/bin/env node

/**
 * Diagnose memory leak in DHT nodes
 * Connects to a running node and inspects internal data structure sizes
 */

import WebSocket from 'ws';

const BOOTSTRAP_URL = process.env.BOOTSTRAP_URL || 'wss://imeyouwe.com/ws';

async function diagnose() {
  console.log('🔍 Connecting to bootstrap server to diagnose memory usage...');
  console.log(`   URL: ${BOOTSTRAP_URL}`);
  
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(BOOTSTRAP_URL);
    
    ws.on('open', () => {
      console.log('✅ Connected to bootstrap server');
      
      // Request diagnostic info
      ws.send(JSON.stringify({
        type: 'diagnostic_request',
        requestId: 'diag-' + Date.now()
      }));
      
      // Also request stats
      ws.send(JSON.stringify({
        type: 'get_stats',
        requestId: 'stats-' + Date.now()
      }));
    });
    
    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        console.log('\n📊 Received:', message.type);
        console.log(JSON.stringify(message, null, 2));
      } catch (e) {
        console.log('Raw message:', data.toString().substring(0, 200));
      }
    });
    
    ws.on('error', (error) => {
      console.error('❌ WebSocket error:', error.message);
      reject(error);
    });
    
    ws.on('close', () => {
      console.log('Connection closed');
      resolve();
    });
    
    // Close after 5 seconds
    setTimeout(() => {
      ws.close();
      resolve();
    }, 5000);
  });
}

// Check metrics endpoint for more detailed info
async function checkMetrics() {
  const ports = [9096, 9097, 9098, 9099, 9100, 9101, 9102, 9103, 9104, 9105, 9106, 9107, 9108, 9109, 9110];
  
  console.log('\n📈 Checking metrics endpoints...\n');
  
  for (const port of ports) {
    try {
      const response = await fetch(`http://localhost:${port}/metrics`);
      if (response.ok) {
        const metrics = await response.json();
        const uptimeHours = (metrics.node_uptime_seconds / 3600).toFixed(2);
        const memoryMB = (metrics.memory_heap_used_bytes / 1024 / 1024).toFixed(2);
        const memoryPercent = metrics.memory_percent?.toFixed(1) || 'N/A';
        
        console.log(`Node ${port}: uptime=${uptimeHours}h, heap=${memoryMB}MB, mem%=${memoryPercent}%`);
      }
    } catch (e) {
      // Skip unreachable nodes
    }
  }
}

async function main() {
  try {
    await checkMetrics();
    // await diagnose();
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

main();
