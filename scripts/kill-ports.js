#!/usr/bin/env node

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Quick script to kill specific ports
 * Usage: node scripts/kill-ports.js [port1] [port2] ...
 */

const defaultPorts = [3000, 8080, 8081, 8083, 8084];
const isWindows = process.platform === 'win32';

async function killPort(port) {
  console.log(`🎯 Targeting port ${port}...`);
  
  try {
    if (isWindows) {
      // Windows approach
      const { stdout } = await execAsync(`netstat -ano | findstr :${port}`);
      const lines = stdout.trim().split('\n');
      const pids = new Set();
      
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (pid && pid !== '0') {
          pids.add(pid);
        }
      }
      
      if (pids.size === 0) {
        console.log(`  ✓ Port ${port} is already free`);
        return;
      }
      
      console.log(`  📍 Found PIDs: ${Array.from(pids).join(', ')}`);
      
      for (const pid of pids) {
        await execAsync(`taskkill /PID ${pid} /F`);
        console.log(`  ✓ Killed PID ${pid}`);
      }
    } else {
      // Unix/Linux/macOS approach
      const { stdout } = await execAsync(`lsof -ti:${port}`);
      const pids = stdout.trim().split('\n').filter(pid => pid);
      
      if (pids.length === 0) {
        console.log(`  ✓ Port ${port} is already free`);
        return;
      }
      
      console.log(`  📍 Found PIDs: ${pids.join(', ')}`);
      
      for (const pid of pids) {
        await execAsync(`kill -9 ${pid}`);
        console.log(`  ✓ Killed PID ${pid}`);
      }
    }
    
    console.log(`  ✅ Port ${port} is now free`);
    
  } catch (error) {
    if (error.message.includes('No such process') || error.message.includes('not found')) {
      console.log(`  ✓ Port ${port} is already free`);
    } else {
      console.error(`  ❌ Failed to kill port ${port}: ${error.message}`);
    }
  }
}

async function main() {
  const ports = process.argv.slice(2).length > 0 
    ? process.argv.slice(2).map(p => parseInt(p))
    : defaultPorts;
  
  console.log('🔫 Kill Ports Script');
  console.log(`Platform: ${process.platform}`);
  console.log(`Targeting ports: ${ports.join(', ')}`);
  console.log('');
  
  for (const port of ports) {
    if (isNaN(port)) {
      console.error(`❌ Invalid port: ${port}`);
      continue;
    }
    
    await killPort(port);
  }
  
  console.log('\n🎉 Kill ports complete!');
}

main().catch(error => {
  console.error('❌ Script failed:', error.message);
  process.exit(1);
});