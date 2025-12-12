#!/usr/bin/env node

/**
 * Health check script for DHT network services
 * Verifies that bootstrap server and bridge nodes are running
 */

import http from 'http';

const services = [
  { name: 'Bootstrap Server', url: 'http://localhost:8080/health' },
  { name: 'Test Server', url: 'http://localhost:3000/health' }
];

async function checkService(service) {
  return new Promise((resolve) => {
    const req = http.get(service.url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          console.log(`✅ ${service.name}: OK`);
          resolve(true);
        } else {
          console.log(`❌ ${service.name}: HTTP ${res.statusCode}`);
          resolve(false);
        }
      });
    });
    
    req.on('error', (err) => {
      console.log(`❌ ${service.name}: ${err.message}`);
      resolve(false);
    });
    
    req.setTimeout(5000, () => {
      console.log(`❌ ${service.name}: Timeout`);
      req.destroy();
      resolve(false);
    });
  });
}

async function main() {
  console.log('🔍 Checking DHT network services...\n');
  
  const results = await Promise.all(
    services.map(service => checkService(service))
  );
  
  const allHealthy = results.every(result => result);
  
  console.log(`\n📊 Overall status: ${allHealthy ? '✅ HEALTHY' : '❌ UNHEALTHY'}`);
  
  process.exit(allHealthy ? 0 : 1);
}

main().catch(console.error);