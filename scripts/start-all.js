#!/usr/bin/env node

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

/**
 * Start both bootstrap and development servers
 */
class ServerStarter {
  constructor() {
    this.processes = [];
    this.isShuttingDown = false;
  }

  /**
   * Start a process and track it
   */
  startProcess(command, args, name, color) {
    console.log(`\n🚀 Starting ${name}...`);
    
    const process = spawn(command, args, {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
      detached: false
    });

    // Forward output with prefixes
    process.stdout?.on('data', (data) => {
      const lines = data.toString().split('\n').filter(line => line.trim());
      lines.forEach(line => {
        console.log(`[${name}] ${line}`);
      });
    });

    process.stderr?.on('data', (data) => {
      const lines = data.toString().split('\n').filter(line => line.trim());
      lines.forEach(line => {
        console.error(`[${name}] ${line}`);
      });
    });

    process.on('error', (error) => {
      console.error(`❌ ${name} error:`, error.message);
    });

    process.on('exit', (code) => {
      if (!this.isShuttingDown) {
        console.log(`⚠️  ${name} exited with code ${code}`);
      }
    });

    this.processes.push({ process, name });
    return process;
  }

  /**
   * Start all servers
   */
  async start() {
    console.log('🎯 Starting YZSocialC Servers');
    console.log('===============================');

    try {
      // Start bootstrap server
      const bootstrapProcess = this.startProcess('node', ['src/bootstrap/server.js'], 'Bootstrap Server (port 8080)', 'blue');
      
      // Wait a moment for bootstrap server to start
      console.log('⏳ Waiting for bootstrap server to initialize...');
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      // Start webpack dev server
      const devProcess = this.startProcess('npx', ['webpack', 'serve', '--config', 'webpack.config.cjs', '--mode', 'development', '--open'], 'Dev Server (port 3000)', 'green');

      console.log('\n✅ Both servers starting...');
      console.log('📱 Access the app at: http://localhost:3000');
      console.log('🔌 Bootstrap server at: http://localhost:8080/health');
      console.log('\n💡 Open multiple browser tabs to test P2P connections!');
      console.log('⏹️  Press Ctrl+C to stop all servers');

      // Handle shutdown
      process.on('SIGINT', () => this.shutdown());
      process.on('SIGTERM', () => this.shutdown());

      // Keep the main process alive
      return new Promise(() => {
        // This will keep the process running indefinitely
      });

    } catch (error) {
      console.error('❌ Failed to start servers:', error.message);
      this.shutdown();
      throw error;
    }
  }

  /**
   * Shutdown all processes
   */
  shutdown() {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    console.log('\n🛑 Shutting down servers...');
    
    this.processes.forEach(({ process, name }) => {
      try {
        process.kill('SIGTERM');
        console.log(`✓ Stopped ${name}`);
      } catch (error) {
        console.warn(`⚠️  Failed to stop ${name}:`, error.message);
      }
    });

    setTimeout(() => {
      console.log('👋 All servers stopped. Goodbye!');
      process.exit(0);
    }, 1000);
  }
}

// Start if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const starter = new ServerStarter();
  starter.start().catch(error => {
    console.error('❌ Failed to start servers:', error.message);
    process.exit(1);
  });
}

export { ServerStarter };