#!/usr/bin/env node

/**
 * Bridge Connection Recovery Script
 * 
 * Fixes bridge node connectivity issues after genesis restart by:
 * 1. Checking bridge node health
 * 2. Verifying genesis connection
 * 3. Triggering bridge invitations if needed
 * 4. Restarting services in correct order if necessary
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

console.log('🔧 Bridge Connection Recovery Tool');
console.log('==================================\n');

async function checkServiceHealth(serviceName, port) {
  try {
    const { stdout } = await execAsync(`curl -s http://localhost:${port}/health`);
    const health = JSON.parse(stdout);
    return { healthy: true, data: health };
  } catch (error) {
    return { healthy: false, error: error.message };
  }
}

async function checkDockerHealth(containerName) {
  try {
    const { stdout } = await execAsync(`docker inspect ${containerName} --format='{{.State.Health.Status}}'`);
    return stdout.trim();
  } catch (error) {
    return 'unknown';
  }
}

async function restartContainer(containerName) {
  try {
    console.log(`🔄 Restarting ${containerName}...`);
    await execAsync(`docker restart ${containerName}`);
    return true;
  } catch (error) {
    console.error(`❌ Failed to restart ${containerName}: ${error.message}`);
    return false;
  }
}

async function waitForService(serviceName, port, maxWait = 30) {
  console.log(`⏳ Waiting for ${serviceName} to be ready...`);
  
  for (let i = 0; i < maxWait; i++) {
    const health = await checkServiceHealth(serviceName, port);
    if (health.healthy) {
      console.log(`✅ ${serviceName} is ready`);
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  console.warn(`⚠️ ${serviceName} not ready after ${maxWait} seconds`);
  return false;
}

async function checkBridgeAvailability() {
  try {
    const { stdout } = await execAsync(`curl -s http://localhost:8080/bridge-health`);
    const bridgeHealth = JSON.parse(stdout);
    return bridgeHealth;
  } catch (error) {
    return { healthy: false, error: error.message };
  }
}

async function checkGenesisInvitations() {
  try {
    const { stdout } = await execAsync(`docker logs yz-bootstrap-server --tail 100 2>&1 | grep -E "(Bridge invitation|Successfully invited|bridge.*accepted)" || echo "No invitations found"`);
    return stdout.trim();
  } catch (error) {
    return 'Error checking logs';
  }
}

async function triggerBridgeInvitations() {
  console.log('🎫 Attempting to trigger bridge invitations...');
  
  try {
    // Restart genesis node to trigger reconnection and invitation process
    await restartContainer('yz-genesis-node');
    await new Promise(resolve => setTimeout(resolve, 10000));
    
    // Check if invitations were triggered
    const invitationLogs = await checkGenesisInvitations();
    if (invitationLogs.includes('Bridge invitation') || invitationLogs.includes('Successfully invited')) {
      console.log('✅ Bridge invitations appear to have been triggered');
      return true;
    } else {
      console.warn('⚠️ Bridge invitations may not have been triggered');
      return false;
    }
  } catch (error) {
    console.error(`❌ Failed to trigger bridge invitations: ${error.message}`);
    return false;
  }
}

async function main() {
  console.log('📋 Step 1: Checking service health...');
  
  // Check bootstrap server
  const bootstrapHealth = await checkServiceHealth('bootstrap', 8080);
  console.log(`Bootstrap Server: ${bootstrapHealth.healthy ? '✅ Healthy' : '❌ Unhealthy'}`);
  
  // Check bridge nodes
  const bridge1Health = await checkServiceHealth('bridge-node-1', 9083);
  const bridge2Health = await checkServiceHealth('bridge-node-2', 9084);
  console.log(`Bridge Node 1: ${bridge1Health.healthy ? '✅ Healthy' : '❌ Unhealthy'}`);
  console.log(`Bridge Node 2: ${bridge2Health.healthy ? '✅ Healthy' : '❌ Unhealthy'}`);
  
  // Check genesis node
  const genesisHealth = await checkServiceHealth('genesis', 9095);
  console.log(`Genesis Node: ${genesisHealth.healthy ? '✅ Healthy' : '❌ Unhealthy'}`);
  
  console.log('\n📋 Step 2: Checking bridge availability...');
  
  const bridgeAvailability = await checkBridgeAvailability();
  console.log(`Bridge Availability: ${bridgeAvailability.healthy ? '✅ Available' : '❌ Unavailable'}`);
  
  if (bridgeAvailability.bridgeAvailability) {
    console.log(`   Available: ${bridgeAvailability.bridgeAvailability.available || 0}`);
    console.log(`   Total: ${bridgeAvailability.bridgeAvailability.total || 0}`);
  }
  
  console.log('\n📋 Step 3: Checking invitation history...');
  
  const invitationLogs = await checkGenesisInvitations();
  console.log('Recent invitation activity:');
  console.log(invitationLogs || 'No recent invitation activity found');
  
  console.log('\n🔧 Step 4: Determining recovery actions...');
  
  let needsRecovery = false;
  const recoveryActions = [];
  
  // Check if bootstrap is unhealthy
  if (!bootstrapHealth.healthy) {
    needsRecovery = true;
    recoveryActions.push('restart-bootstrap');
  }
  
  // Check if bridge nodes are unhealthy
  if (!bridge1Health.healthy || !bridge2Health.healthy) {
    needsRecovery = true;
    recoveryActions.push('restart-bridges');
  }
  
  // Check if genesis is unhealthy
  if (!genesisHealth.healthy) {
    needsRecovery = true;
    recoveryActions.push('restart-genesis');
  }
  
  // Check if bridge availability is poor
  if (!bridgeAvailability.healthy) {
    needsRecovery = true;
    recoveryActions.push('fix-bridge-availability');
  }
  
  // Check if no recent invitations
  if (!invitationLogs.includes('Bridge invitation') && !invitationLogs.includes('Successfully invited')) {
    needsRecovery = true;
    recoveryActions.push('trigger-invitations');
  }
  
  if (!needsRecovery) {
    console.log('✅ All services appear healthy - no recovery needed');
    return;
  }
  
  console.log(`⚠️ Recovery needed. Actions: ${recoveryActions.join(', ')}`);
  console.log('\n🚀 Step 5: Executing recovery actions...');
  
  // Execute recovery actions in order
  for (const action of recoveryActions) {
    switch (action) {
      case 'restart-bootstrap':
        await restartContainer('yz-bootstrap-server');
        await waitForService('bootstrap', 8080);
        break;
        
      case 'restart-bridges':
        await restartContainer('yz-bridge-node-1');
        await restartContainer('yz-bridge-node-2');
        await waitForService('bridge-node-1', 9083);
        await waitForService('bridge-node-2', 9084);
        break;
        
      case 'restart-genesis':
        await restartContainer('yz-genesis-node');
        await waitForService('genesis', 9095);
        break;
        
      case 'fix-bridge-availability':
        // Restart bridges and bootstrap in sequence
        await restartContainer('yz-bridge-node-1');
        await restartContainer('yz-bridge-node-2');
        await new Promise(resolve => setTimeout(resolve, 10000));
        await restartContainer('yz-bootstrap-server');
        await waitForService('bootstrap', 8080);
        break;
        
      case 'trigger-invitations':
        await triggerBridgeInvitations();
        break;
    }
  }
  
  console.log('\n🎯 Step 6: Final verification...');
  
  // Wait a bit for everything to stabilize
  await new Promise(resolve => setTimeout(resolve, 15000));
  
  // Re-check bridge availability
  const finalBridgeCheck = await checkBridgeAvailability();
  console.log(`Final Bridge Availability: ${finalBridgeCheck.healthy ? '✅ Available' : '❌ Still unavailable'}`);
  
  // Check for unhealthy DHT nodes
  try {
    const { stdout } = await execAsync(`docker ps --filter "health=unhealthy" --format "{{.Names}}" | grep -E "(dht-node|bridge|bootstrap|genesis)" || echo ""`);
    const unhealthyNodes = stdout.trim();
    
    if (unhealthyNodes) {
      console.log(`⚠️ Found unhealthy nodes: ${unhealthyNodes}`);
      console.log('💡 Consider restarting these nodes manually');
    } else {
      console.log('✅ No unhealthy nodes detected');
    }
  } catch (error) {
    console.warn('⚠️ Could not check for unhealthy nodes');
  }
  
  console.log('\n🎉 Bridge connection recovery completed!');
  console.log('\n💡 If issues persist:');
  console.log('   1. Check logs: docker logs yz-bootstrap-server');
  console.log('   2. Check bridge logs: docker logs yz-bridge-node-1');
  console.log('   3. Check genesis logs: docker logs yz-genesis-node');
  console.log('   4. Run full restart: ./RestartServerImproved.sh');
}

main().catch(error => {
  console.error('❌ Recovery script failed:', error);
  process.exit(1);
});