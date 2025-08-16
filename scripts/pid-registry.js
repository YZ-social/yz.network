#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const execAsync = promisify(exec);
const __dirname = dirname(fileURLToPath(import.meta.url));
const PID_FILE = join(__dirname, '.yzsocialc-pids.json');

/**
 * PID Registry for tracking YZSocialC background processes
 */
export class PIDRegistry {
  constructor() {
    this.isWindows = process.platform === 'win32';
  }

  /**
   * Load existing PID registry
   */
  load() {
    try {
      if (existsSync(PID_FILE)) {
        const data = readFileSync(PID_FILE, 'utf8');
        return JSON.parse(data);
      }
    } catch (error) {
      console.warn('Failed to load PID registry:', error.message);
    }
    return { processes: [], lastUpdated: Date.now() };
  }

  /**
   * Save PID registry
   */
  save(registry) {
    try {
      registry.lastUpdated = Date.now();
      writeFileSync(PID_FILE, JSON.stringify(registry, null, 2));
    } catch (error) {
      console.error('Failed to save PID registry:', error.message);
    }
  }

  /**
   * Check if a PID is still running
   */
  async isProcessRunning(pid) {
    try {
      if (this.isWindows) {
        const { stdout } = await execAsync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`);
        return stdout.includes(`"${pid}"`);
      } else {
        // On Unix, kill -0 checks if process exists without actually killing it
        await execAsync(`kill -0 ${pid}`);
        return true;
      }
    } catch (error) {
      return false;
    }
  }

  /**
   * Register a new background process
   */
  async register(pid, processType, command, port = null) {
    const registry = this.load();
    
    // Clean up stale entries first
    await this.cleanup();
    
    const processInfo = {
      pid: parseInt(pid),
      type: processType, // 'bootstrap', 'nodejs-client', 'dev-server', etc.
      command: command,
      port: port,
      startTime: Date.now()
    };
    
    // Remove any existing entry with the same PID
    registry.processes = registry.processes.filter(p => p.pid !== processInfo.pid);
    
    // Add new entry
    registry.processes.push(processInfo);
    
    this.save(registry);
    console.log(`📝 Registered PID ${pid} (${processType}) in registry`);
    
    return processInfo;
  }

  /**
   * Unregister a process (when it exits normally)
   */
  async unregister(pid) {
    const registry = this.load();
    const originalCount = registry.processes.length;
    
    registry.processes = registry.processes.filter(p => p.pid !== parseInt(pid));
    
    if (registry.processes.length < originalCount) {
      this.save(registry);
      console.log(`📝 Unregistered PID ${pid} from registry`);
      return true;
    }
    
    return false;
  }

  /**
   * Clean up stale PID entries (processes that are no longer running)
   */
  async cleanup() {
    const registry = this.load();
    const stillRunning = [];
    
    for (const process of registry.processes) {
      if (await this.isProcessRunning(process.pid)) {
        stillRunning.push(process);
      } else {
        console.log(`🧹 Cleaning up stale PID ${process.pid} (${process.type})`);
      }
    }
    
    if (stillRunning.length !== registry.processes.length) {
      registry.processes = stillRunning;
      this.save(registry);
    }
    
    return registry.processes;
  }

  /**
   * Get all currently tracked processes
   */
  async getRunningProcesses() {
    await this.cleanup();
    const registry = this.load();
    return registry.processes;
  }

  /**
   * Kill a specific process by PID
   */
  async killProcess(pid) {
    try {
      if (this.isWindows) {
        await execAsync(`taskkill /PID ${pid} /F`);
      } else {
        await execAsync(`kill -TERM ${pid}`);
        // Give it a moment to exit gracefully, then force kill if needed
        setTimeout(async () => {
          if (await this.isProcessRunning(pid)) {
            await execAsync(`kill -9 ${pid}`);
          }
        }, 2000);
      }
      
      await this.unregister(pid);
      return true;
    } catch (error) {
      console.warn(`Failed to kill process ${pid}: ${error.message}`);
      return false;
    }
  }

  /**
   * Kill all tracked processes
   */
  async killAll() {
    const processes = await this.getRunningProcesses();
    let killedCount = 0;
    
    console.log(`🎯 Found ${processes.length} tracked processes to kill`);
    
    for (const process of processes) {
      console.log(`  Killing PID ${process.pid} (${process.type})`);
      if (await this.killProcess(process.pid)) {
        killedCount++;
      }
    }
    
    return killedCount;
  }

  /**
   * Display all tracked processes
   */
  async list() {
    const processes = await this.getRunningProcesses();
    
    if (processes.length === 0) {
      console.log('📋 No tracked processes running');
      return;
    }
    
    console.log(`📋 Tracked YZSocialC processes (${processes.length}):`);
    console.log('PID\tType\t\tPort\tCommand');
    console.log('-'.repeat(60));
    
    for (const process of processes) {
      const port = process.port ? process.port : 'N/A';
      const age = Math.round((Date.now() - process.startTime) / 1000);
      console.log(`${process.pid}\t${process.type.padEnd(12)}\t${port}\t${process.command} (${age}s)`);
    }
  }
}

// CLI interface
if (import.meta.url === `file://${process.argv[1]}`) {
  const registry = new PIDRegistry();
  const command = process.argv[2];
  
  switch (command) {
    case 'list':
      await registry.list();
      break;
    case 'cleanup':
      await registry.cleanup();
      console.log('✅ PID registry cleaned up');
      break;
    case 'kill-all':
      const killed = await registry.killAll();
      console.log(`✅ Killed ${killed} processes`);
      break;
    default:
      console.log('Usage: node pid-registry.js [list|cleanup|kill-all]');
  }
}