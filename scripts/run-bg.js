#!/usr/bin/env node

import { spawn } from 'child_process';
import { platform } from 'os';
import { basename } from 'path';
import { PIDRegistry } from './pid-registry.js';

// Get command and arguments from process.argv
const [,, scriptPath, ...args] = process.argv;

if (!scriptPath) {
    console.error('Usage: node scripts/run-bg.js <script> [args...]');
    process.exit(1);
}

const isWindows = platform() === 'win32';
const pidRegistry = new PIDRegistry();

let child;

if (isWindows) {
    // Windows: Use start /B to run in background
    child = spawn('cmd', ['/c', 'start', '/B', 'node', scriptPath, ...args], {
        detached: true,
        stdio: 'ignore'
    });
} else {
    // Unix/Linux/Mac: Use nohup and & for background
    child = spawn('nohup', ['node', scriptPath, ...args], {
        detached: true,
        stdio: 'ignore'
    });
}

child.unref();

// Determine process type and port from script path and args
const scriptName = basename(scriptPath);
let processType = 'unknown';
let port = null;

if (scriptName === 'background-node.js') {
    processType = 'nodejs-client';
    // Port is first argument or default 9500
    port = args.length > 0 ? parseInt(args[0]) || 9500 : 9500;
} else if (scriptPath.includes('server.js')) {
    processType = 'bootstrap';
    port = 8080; // Default bootstrap port
}

const command = `node ${scriptPath} ${args.join(' ')}`.trim();

console.log(`Started ${scriptPath} in background (OS: ${platform()})`);
console.log(`PID: ${child.pid}`);

// Register the PID in our tracking system
if (child.pid) {
    pidRegistry.register(child.pid, processType, command, port)
        .then(() => {
            console.log(`📝 Process registered in PID registry`);
        })
        .catch(error => {
            console.warn(`Failed to register PID: ${error.message}`);
        });
}