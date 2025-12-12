#!/usr/bin/env node

/**
 * Verify that the browser testing setup is working correctly
 */

import http from 'http';
import fs from 'fs';
import path from 'path';

console.log('🔍 Verifying browser testing setup...\n');

// Check if required files exist
const requiredFiles = [
  'playwright.config.js',
  'tests/browser/infrastructure.spec.js',
  'tests/browser/basic-dht.spec.js',
  'scripts/test-server.js',
  'package.json'
];

console.log('📁 Checking required files...');
let missingFiles = [];

for (const file of requiredFiles) {
  if (fs.existsSync(file)) {
    console.log(`✅ ${file}`);
  } else {
    console.log(`❌ ${file} - MISSING`);
    missingFiles.push(file);
  }
}

if (missingFiles.length > 0) {
  console.log(`\n❌ Missing ${missingFiles.length} required files. Setup incomplete.`);
  process.exit(1);
}

// Check if Playwright is installed
console.log('\n🎭 Checking Playwright installation...');
try {
  const { execSync } = await import('child_process');
  execSync('npx playwright --version', { stdio: 'pipe' });
  console.log('✅ Playwright is installed');
} catch (error) {
  console.log('❌ Playwright not installed. Run: npm install');
  process.exit(1);
}

// Check if dist directory exists (build artifacts)
console.log('\n🏗️ Checking build artifacts...');
if (fs.existsSync('dist')) {
  const distFiles = fs.readdirSync('dist');
  if (distFiles.length > 0) {
    console.log(`✅ Build artifacts found (${distFiles.length} files)`);
  } else {
    console.log('⚠️ Build directory is empty. Run: npm run build');
  }
} else {
  console.log('⚠️ Build directory not found. Run: npm run build');
}

// Check package.json scripts
console.log('\n📦 Checking npm scripts...');
const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const requiredScripts = [
  'test:browser',
  'test:server',
  'bridge-nodes',
  'bridge-bootstrap:genesis:openNetwork'
];

for (const script of requiredScripts) {
  if (packageJson.scripts[script]) {
    console.log(`✅ npm run ${script}`);
  } else {
    console.log(`❌ npm run ${script} - MISSING`);
  }
}

console.log('\n🎯 Setup verification complete!');
console.log('\n📋 Next steps:');
console.log('1. Build project: npm run build');
console.log('2. Install Playwright browsers: npx playwright install');
console.log('3. Run tests: npm run test:browser');
console.log('4. Or run manually following test-setup.md');

console.log('\n✅ Browser testing setup is ready!');