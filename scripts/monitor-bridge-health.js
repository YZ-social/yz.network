#!/usr/bin/env node

/**
 * Bridge Health Monitor
 * 
 * Monitors bootstrap server bridge connections and automatically restarts
 * bridge nodes when connection issues are detected.
 * 
 * Usage:
 *   node scripts/monitor-bridge-health.js
 *   
 * Environment Variables:
 *   BOOTSTRAP_URL - Bootstrap server URL (default: http://localhost:8080)
 *   CHECK_INTERVAL - Check interval in seconds (default: 60)
 *   RESTART_THRESHOLD - Unhealthy bridges to trigger restart (default: 1)
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const config = {
  bootstrapUrl: process.env.BOOTSTRAP_URL || 'http://localhost:8080',
  checkInterval: parseInt(process.env.CHECK_INTERVAL) || 60, // seconds
  restartThreshold: parseInt(process.env.RESTART_THRESHOLD) || 1, // unhealthy bridges
  maxRestarts: 3, // max restarts per hour
  restartCooldown: 20 * 60 * 1000 // 20 minutes between restarts
};

let restartHistory = [];

/**
 * Check bootstrap server bridge availability
 */
async function checkBridgeAvailability() {
  try {
    const response = await fetch(`${config.bootstrapUrl}/bridge-health`, {
      signal: AbortSignal.timeout(10000)
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    return await response.json();
  } catch (error) {
    console.error(`❌ Failed to check bridge availability: ${error.message}`);
    return null;
  }
}

/**
 * Check if we should restart bridge nodes
 */
function shouldRestart(availabilityData) {
  if (!availabilityData || availabilityData.healthy) {
    return false;
  }
  
  const unavailableCount = availabilityData.bridgeAvailability?.unavailable || 0;
  
  // Check restart threshold
  if (unavailableCount < config.restartThreshold) {
    return false;
  }
  
  // Check restart rate limiting
  const now = Date.now();
  const recentRestarts = restartHistory.filter(time => now - time < 60 * 60 * 1000); // Last hour
  
  if (recentRestarts.length >= config.maxRestarts) {
    console.warn(`⚠️ Restart rate limit reached (${recentRestarts.length}/${config.maxRestarts} in last hour)`);
    return false;
  }
  
  // Check cooldown period
  const lastRestart = restartHistory[restartHistory.length - 1];
  if (lastRestart && (now - lastRestart) < config.restartCooldown) {
    const timeLeft = Math.round((config.restartCooldown - (now - lastRestart)) / 1000 / 60);
    console.log(`⏳ Restart cooldown active (${timeLeft} minutes remaining)`);
    return false;
  }
  
  return true;
}

/**
 * Restart bridge nodes
 */
async function restartBridgeNodes() {
  console.log('🔄 Restarting bridge nodes...');
  
  try {
    // Find bridge node containers
    const { stdout } = await execAsync('docker ps --filter "name=bridge-node" --format "{{.Names}}"');
    const bridgeNodes = stdout.trim().split('\n').filter(Boolean);
    
    if (bridgeNodes.length === 0) {
      console.warn('⚠️ No bridge node containers found');
      return false;
    }
    
    console.log(`🔄 Restarting ${bridgeNodes.length} bridge nodes: ${bridgeNodes.join(', ')}`);
    
    // Restart bridge nodes
    await execAsync(`docker restart ${bridgeNodes.join(' ')}`);
    
    // Wait a moment for them to start
    await new Promise(resolve => setTimeout(resolve, 10000));
    
    // Restart bootstrap server to re-establish connections
    console.log('🔄 Restarting bootstrap server...');
    await execAsync('docker restart yz-bootstrap-server');
    
    // Record restart time
    restartHistory.push(Date.now());
    
    console.log('✅ Bridge nodes and bootstrap server restarted successfully');
    return true;
    
  } catch (error) {
    console.error('❌ Failed to restart bridge nodes:', error.message);
    return false;
  }
}

/**
 * Main monitoring loop
 */
async function monitor() {
  console.log('🏥 Checking bridge availability...');
  
  const availabilityData = await checkBridgeAvailability();
  
  if (!availabilityData) {
    console.log('⚠️ Could not check bridge availability - bootstrap server may be down');
    return;
  }
  
  const { healthy, bridgeAvailability } = availabilityData;
  
  if (healthy) {
    console.log(`✅ Bridge nodes available (${bridgeAvailability.available}/${bridgeAvailability.total})`);
  } else {
    console.warn(`⚠️ Bridge nodes unavailable: ${bridgeAvailability.unavailable}/${bridgeAvailability.total}`);
    console.warn('   Details:', bridgeAvailability.results.filter(r => !r.available));
    
    if (shouldRestart(availabilityData)) {
      console.log('🚨 Triggering bridge node restart...');
      const success = await restartBridgeNodes();
      
      if (success) {
        // Wait for restart to complete and verify
        console.log('⏳ Waiting for services to stabilize...');
        await new Promise(resolve => setTimeout(resolve, 30000));
        
        const newAvailabilityData = await checkBridgeAvailability();
        if (newAvailabilityData?.healthy) {
          console.log('✅ Bridge availability restored after restart');
        } else {
          console.error('❌ Bridge availability still poor after restart');
        }
      }
    }
  }
}

/**
 * Start monitoring
 */
async function start() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🏥 Bridge Health Monitor');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`🔗 Bootstrap URL: ${config.bootstrapUrl}`);
  console.log(`⏰ Check interval: ${config.checkInterval}s`);
  console.log(`🚨 Restart threshold: ${config.restartThreshold} unhealthy bridges`);
  console.log(`🔄 Max restarts: ${config.maxRestarts}/hour`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  
  // Initial check
  await monitor();
  
  // Schedule periodic checks
  setInterval(monitor, config.checkInterval * 1000);
}

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('\n🛑 Shutting down bridge health monitor...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down bridge health monitor...');
  process.exit(0);
});

// Start monitoring
start().catch(error => {
  console.error('❌ Monitor startup failed:', error);
  process.exit(1);
});