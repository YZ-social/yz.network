#!/usr/bin/env node
/**
 * Morning Health Check Script
 * Run this after overnight operation to check for:
 * - Memory leaks
 * - Node crashes/restarts
 * - Mesh formation issues
 * - Connection stability
 */

const { execSync } = require('child_process');

const REMOTE = 'oracle-yz';
const CONTAINERS = [
  'yz-bootstrap-server',
  'yz-bridge-node-1', 
  'yz-bridge-node-2',
  'yz-genesis-node',
  ...Array.from({length: 15}, (_, i) => `yz-dht-node-${i + 1}`)
];

function ssh(cmd) {
  try {
    return execSync(`ssh ${REMOTE} "${cmd}"`, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  } catch (e) {
    return e.stdout || e.message;
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function formatUptime(seconds) {
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${mins}m`;
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('  YZ NETWORK MORNING HEALTH CHECK');
console.log('  ' + new Date().toISOString());
console.log('═══════════════════════════════════════════════════════════════\n');

// 1. Check container status and restarts
console.log('📦 CONTAINER STATUS & RESTARTS');
console.log('─────────────────────────────────────────────────────────────────');
const containerStatus = ssh(`docker ps -a --format '{{.Names}}|{{.Status}}|{{.State}}'`);
const statusLines = containerStatus.trim().split('\n').filter(l => l.includes('yz-'));

let restartCount = 0;
let unhealthyCount = 0;
const containerInfo = [];

for (const line of statusLines) {
  const [name, status, state] = line.split('|');
  const isHealthy = status.includes('healthy') && !status.includes('unhealthy');
  const isRunning = state === 'running';
  
  // Check for restarts in status (e.g., "Up 2 hours (healthy)" vs "Restarting")
  const restartMatch = status.match(/Restarting/i);
  if (restartMatch) restartCount++;
  if (!isHealthy && isRunning) unhealthyCount++;
  
  containerInfo.push({ name, status, isHealthy, isRunning });
}

// Get restart counts from docker inspect
const restartCounts = ssh(`docker inspect --format '{{.Name}}|{{.RestartCount}}' $(docker ps -aq --filter name=yz-) 2>/dev/null`);
const restartData = {};
for (const line of restartCounts.trim().split('\n')) {
  const [name, count] = line.split('|');
  if (name && count) {
    restartData[name.replace('/', '')] = parseInt(count) || 0;
  }
}

let totalRestarts = 0;
for (const c of containerInfo) {
  const restarts = restartData[c.name] || 0;
  totalRestarts += restarts;
  const statusIcon = c.isHealthy ? '✅' : (c.isRunning ? '⚠️' : '❌');
  const restartWarn = restarts > 0 ? ` [${restarts} restarts!]` : '';
  console.log(`  ${statusIcon} ${c.name.padEnd(22)} ${c.status}${restartWarn}`);
}

console.log(`\n  Summary: ${containerInfo.filter(c => c.isHealthy).length}/${containerInfo.length} healthy, ${totalRestarts} total restarts\n`);

// 2. Memory usage
console.log('💾 MEMORY USAGE');
console.log('─────────────────────────────────────────────────────────────────');
const memStats = ssh(`docker stats --no-stream --format '{{.Name}}|{{.MemUsage}}|{{.MemPerc}}'`);
const memLines = memStats.trim().split('\n').filter(l => l.includes('yz-'));

const memoryData = [];
for (const line of memLines) {
  const [name, usage, perc] = line.split('|');
  const percNum = parseFloat(perc) || 0;
  memoryData.push({ name, usage, perc: percNum });
}

// Sort by memory percentage descending
memoryData.sort((a, b) => b.perc - a.perc);

console.log('  Top memory consumers:');
for (const m of memoryData.slice(0, 10)) {
  const bar = '█'.repeat(Math.min(20, Math.floor(m.perc / 5))) + '░'.repeat(Math.max(0, 20 - Math.floor(m.perc / 5)));
  const warn = m.perc > 50 ? ' ⚠️' : '';
  console.log(`  ${m.name.padEnd(22)} ${m.usage.padEnd(20)} ${bar} ${m.perc.toFixed(1)}%${warn}`);
}

const avgMem = memoryData.reduce((sum, m) => sum + m.perc, 0) / memoryData.length;
const maxMem = Math.max(...memoryData.map(m => m.perc));
console.log(`\n  Average: ${avgMem.toFixed(1)}%, Max: ${maxMem.toFixed(1)}%`);

if (maxMem > 80) {
  console.log('  ⚠️  WARNING: High memory usage detected - possible memory leak!');
}
console.log();

// 3. Check for errors in logs
console.log('🔍 ERROR ANALYSIS (last 1000 lines per container)');
console.log('─────────────────────────────────────────────────────────────────');

const errorPatterns = [
  'Error:',
  'FATAL',
  'crash',
  'OOM',
  'out of memory',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'heap out of memory'
];

const errorCounts = {};
for (const container of CONTAINERS.slice(0, 5)) { // Check first 5 for speed
  const logs = ssh(`docker logs --tail 1000 ${container} 2>&1 | grep -iE '${errorPatterns.join('|')}' | wc -l`);
  errorCounts[container] = parseInt(logs.trim()) || 0;
}

let hasErrors = false;
for (const [container, count] of Object.entries(errorCounts)) {
  if (count > 0) {
    hasErrors = true;
    console.log(`  ⚠️  ${container}: ${count} error lines`);
  }
}
if (!hasErrors) {
  console.log('  ✅ No significant errors found in sampled containers');
}
console.log();

// 4. Connection/Mesh status
console.log('🌐 MESH CONNECTIVITY');
console.log('─────────────────────────────────────────────────────────────────');

// Check bootstrap for connected nodes
const bootstrapConnections = ssh(`docker logs --tail 500 yz-bootstrap-server 2>&1 | grep -c 'authenticated\\|connected' || echo 0`);
console.log(`  Bootstrap connections logged: ${bootstrapConnections.trim()}`);

// Check a sample DHT node for peer count
const dhtPeerCheck = ssh(`docker logs --tail 100 yz-dht-node-1 2>&1 | grep -oE 'peers?: [0-9]+|connections?: [0-9]+' | tail -5`);
if (dhtPeerCheck.trim()) {
  console.log(`  DHT Node 1 recent peer info:\n    ${dhtPeerCheck.trim().split('\n').join('\n    ')}`);
}
console.log();

// 5. System resources
console.log('🖥️  HOST SYSTEM RESOURCES');
console.log('─────────────────────────────────────────────────────────────────');
const hostMem = ssh(`free -h | grep Mem`);
const hostDisk = ssh(`df -h / | tail -1`);
const loadAvg = ssh(`uptime | grep -oE 'load average:.*'`);

console.log(`  Memory: ${hostMem.trim()}`);
console.log(`  Disk:   ${hostDisk.trim()}`);
console.log(`  Load:   ${loadAvg.trim()}`);
console.log();

// 6. Uptime summary
console.log('⏱️  UPTIME SUMMARY');
console.log('─────────────────────────────────────────────────────────────────');
const uptimes = ssh(`docker inspect --format '{{.Name}}|{{.State.StartedAt}}' $(docker ps -q --filter name=yz-) 2>/dev/null`);
const now = new Date();
let minUptime = Infinity;
let maxUptime = 0;

for (const line of uptimes.trim().split('\n')) {
  const [name, startedAt] = line.split('|');
  if (startedAt) {
    const started = new Date(startedAt);
    const uptimeSec = (now - started) / 1000;
    minUptime = Math.min(minUptime, uptimeSec);
    maxUptime = Math.max(maxUptime, uptimeSec);
  }
}

console.log(`  Shortest uptime: ${formatUptime(minUptime)}`);
console.log(`  Longest uptime:  ${formatUptime(maxUptime)}`);

if (minUptime < 3600) {
  console.log('  ⚠️  WARNING: Some containers have been up less than 1 hour - possible restarts!');
}
console.log();

// Final summary
console.log('═══════════════════════════════════════════════════════════════');
console.log('  HEALTH SUMMARY');
console.log('═══════════════════════════════════════════════════════════════');

const issues = [];
if (totalRestarts > 0) issues.push(`${totalRestarts} container restarts`);
if (maxMem > 80) issues.push('High memory usage (>80%)');
if (unhealthyCount > 0) issues.push(`${unhealthyCount} unhealthy containers`);
if (minUptime < 3600) issues.push('Recent container restarts detected');
if (hasErrors) issues.push('Errors found in logs');

if (issues.length === 0) {
  console.log('  ✅ All systems healthy - no issues detected!');
} else {
  console.log('  ⚠️  Issues found:');
  for (const issue of issues) {
    console.log(`     • ${issue}`);
  }
}
console.log('\n  Run `ssh oracle-yz "docker logs <container>"` for detailed logs');
console.log('═══════════════════════════════════════════════════════════════\n');
