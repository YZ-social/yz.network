#!/usr/bin/env node

import { exec } from 'child_process';
import { promisify } from 'util';
import { PIDRegistry } from './pid-registry.js';

const execAsync = promisify(exec);

/**
 * Shutdown script to kill YZSocialC servers
 */
class ServerShutdown {
  constructor() {
    this.ports = [3000, 8080, 8081]; // Dev server, bootstrap, fallback bootstrap
    this.isWindows = process.platform === 'win32';
    this.pidRegistry = new PIDRegistry();
  }

  /**
   * Find process ID by port
   */
  async findProcessByPort(port) {
    try {
      if (this.isWindows) {
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
        
        return Array.from(pids);
      } else {
        // Unix/Linux/macOS
        const { stdout } = await execAsync(`lsof -ti:${port}`);
        return stdout.trim().split('\n').filter(pid => pid);
      }
    } catch (error) {
      // No process found on this port
      return [];
    }
  }

  /**
   * Kill process by PID
   */
  async killProcess(pid) {
    try {
      if (this.isWindows) {
        await execAsync(`taskkill /PID ${pid} /F`);
      } else {
        await execAsync(`kill -9 ${pid}`);
      }
      return true;
    } catch (error) {
      console.warn(`Failed to kill process ${pid}: ${error.message}`);
      return false;
    }
  }

  /**
   * Kill all Node.js processes (nuclear option)
   */
  async killAllNodeProcesses() {
    try {
      if (this.isWindows) {
        await execAsync('taskkill /IM node.exe /F');
      } else {
        await execAsync('pkill -f node');
      }
      console.log('✓ Killed all Node.js processes');
    } catch (error) {
      console.log('ℹ No Node.js processes found to kill');
    }
  }

  /**
   * Main shutdown process
   */
  async shutdown() {
    console.log('🔄 Shutting down YZSocialC servers...');
    console.log(`Platform: ${process.platform}`);
    
    let killedAny = false;

    // First, kill all tracked processes from PID registry
    console.log('\n📋 Checking PID registry for tracked processes...');
    const trackedKilled = await this.pidRegistry.killAll();
    if (trackedKilled > 0) {
      console.log(`✅ Killed ${trackedKilled} tracked processes`);
      killedAny = true;
    }

    // Then kill processes by port (for any untracked processes)
    console.log('\n📡 Checking ports for untracked processes...');
    for (const port of this.ports) {
      console.log(`\n📡 Checking port ${port}...`);
      
      const pids = await this.findProcessByPort(port);
      
      if (pids.length === 0) {
        console.log(`  ✓ Port ${port} is free`);
        continue;
      }

      console.log(`  🎯 Found ${pids.length} untracked process(es) on port ${port}: ${pids.join(', ')}`);
      
      for (const pid of pids) {
        const success = await this.killProcess(pid);
        if (success) {
          console.log(`  ✓ Killed untracked process ${pid}`);
          killedAny = true;
        }
      }
    }

    // Verify ports are free
    console.log('\n🔍 Verifying ports are free...');
    let allFree = true;
    
    for (const port of this.ports) {
      const pids = await this.findProcessByPort(port);
      if (pids.length > 0) {
        console.log(`  ⚠️  Port ${port} still occupied by: ${pids.join(', ')}`);
        allFree = false;
      } else {
        console.log(`  ✓ Port ${port} is free`);
      }
    }

    if (!allFree) {
      console.log('\n💥 Some ports still occupied. Using nuclear option...');
      await this.killAllNodeProcesses();
      killedAny = true;
    }

    if (killedAny) {
      console.log('\n✅ Shutdown complete! All servers stopped.');
    } else {
      console.log('\n✅ No servers were running.');
    }

    console.log('\n🚀 Ready to restart with: npm run bootstrap && npm run dev');
  }
}

// Run shutdown if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const shutdown = new ServerShutdown();
  shutdown.shutdown().catch(error => {
    console.error('❌ Shutdown failed:', error.message);
    process.exit(1);
  });
}

export { ServerShutdown };