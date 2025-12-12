# YZSocialC Testing Guide

This document outlines all the tests available in the YZSocialC project and how to run them.

## Test Categories

### 1. Unit Tests (Jest) - ✅ **Runs in GitHub Actions**

**Location**: `test/` directory  
**Framework**: Jest with Node.js environment  
**Purpose**: Test individual components in isolation

#### Available Tests:
- `test/basic.test.js` - Basic smoke tests and framework validation
- `test/core/DHTNodeId.test.js` - DHT Node ID generation, XOR distance, serialization
- `test/core/KBucket.test.js` - K-bucket data structure for routing table
- `test/core/DHTNode.test.js` - DHT node representation and metadata
- `test/dht/RoutingTable.test.js` - Kademlia routing table implementation

#### Run Commands:
```bash
# All unit tests
npm test

# Core component tests only
npm run test:core

# With coverage
npm run test:coverage

# Watch mode
npm run test:watch
```

### 2. Browser Tests (Playwright) - ✅ **Runs in GitHub Actions**

**Location**: `tests/browser/` directory  
**Framework**: Playwright  
**Purpose**: Test browser-specific functionality and UI

#### Available Tests:
- `smoke-test.spec.js` - Basic application loading and API availability
- `infrastructure.spec.js` - Test infrastructure setup and connectivity
- `basic-dht.spec.js` - DHT operations in browser environment
- `tab-visibility.spec.js` - Tab visibility disconnect/reconnect behavior
- `basic-functionality.spec.js` - Core functionality without network
- `debug.spec.js` - Debug utilities for troubleshooting

#### Run Commands:
```bash
# Quick browser tests (smoke + infrastructure)
npm run test:playwright:quick

# All browser tests
npm run test:playwright

# With UI for debugging
npm run test:playwright:ui

# Debug mode
npm run test:playwright:debug

# Windows batch script
./test-browser-quick.bat
```

### 3. Algorithm Tests - ✅ **Runs in GitHub Actions**

**Location**: `test/local/` directory  
**Purpose**: Test DHT algorithms without network complexity

#### Available Tests:
- `basic-dht-concept-test.js` - **✅ CI-Ready** - Pure algorithmic validation
- `simple-network-test.js` - Virtual network simulation

#### Run Commands:
```bash
# DHT algorithm concept test (CI-safe)
npm run test:concept

# Simple network simulation
npm run test:simple
```

### 4. Integration Tests - ❌ **Local Only**

**Location**: `test/local/`, `test/hybrid/`, `test/nodejs/`  
**Purpose**: Test real network interactions  
**Requirements**: Running bootstrap server

#### Available Tests:
- `test/local/dht-network-test.js` - Full DHT network with real WebRTC
- `test/hybrid/` - Browser-Node.js hybrid tests
- `test/nodejs/` - Node.js specific integration tests

#### Run Commands:
```bash
# Start infrastructure first
npm run bridge-nodes
npm run bridge-bootstrap:genesis:openNetwork

# Then run integration tests
npm run test:network
```

## GitHub Actions Test Matrix

### Workflow: `test.yml`
- **Triggers**: Push/PR to main/develop
- **Node Versions**: 18.x, 20.x
- **Tests Run**:
  - ESLint
  - Jest unit tests (all core components)
  - DHT concept algorithm test

### Workflow: `playwright.yml`
- **Triggers**: Push/PR to main/develop
- **Browser**: Chromium (Firefox disabled due to antivirus issues)
- **Tests Run**:
  - Smoke test (application loading)
  - Infrastructure test (basic connectivity)
- **Infrastructure**: Starts full DHT network (bootstrap + bridge nodes)

## Local Development Testing

### Quick Test Suite (Recommended)
```bash
# 1. Unit tests
npm test

# 2. Algorithm validation
npm run test:concept

# 3. Browser smoke test
npm run test:playwright:quick
```

### Full Test Suite
```bash
# 1. All unit tests with coverage
npm run test:coverage

# 2. Algorithm tests
npm run test:concept
npm run test:simple

# 3. Start DHT infrastructure
npm run bridge-nodes
npm run bridge-bootstrap:genesis:openNetwork

# 4. Integration tests (in new terminal)
npm run test:network

# 5. Full browser tests
npm run test:playwright
```

### Windows Quick Testing
```batch
# Run the batch file for quick browser tests
test-browser-quick.bat
```

## Test Results Interpretation

### Unit Tests (Jest)
- **Expected**: 100% pass rate
- **Coverage**: Aim for >80% on core components
- **Speed**: Should complete in <30 seconds

### Browser Tests (Playwright)
- **Expected**: 100% pass rate for smoke + infrastructure
- **Speed**: Should complete in <20 seconds
- **Note**: Bootstrap server warnings are expected in isolated tests

### Algorithm Tests
- **DHT Concept Test**: Should achieve >95% success rate
- **Speed**: Completes in <5 seconds
- **Validates**: Core DHT mathematical principles

### Integration Tests (Local Only)
- **Network Test**: Should achieve >85% success rate
- **Speed**: Takes 2-5 minutes depending on network size
- **Requirements**: Full DHT infrastructure running

## Troubleshooting

### Jest Tests Failing
```bash
# Check Node.js version
node --version  # Should be 18+ or 20+

# Clear cache
npm run test -- --clearCache

# Verbose output
JEST_VERBOSE=true npm test
```

### Playwright Tests Failing
```bash
# Install browsers
npx playwright install --with-deps

# Check if antivirus is blocking Firefox
# Disable Firefox tests in playwright.config.js if needed

# Debug mode
npm run test:playwright:debug
```

### Integration Tests Failing
```bash
# Verify bootstrap server is running
curl http://localhost:8080/health

# Check bridge nodes
curl http://localhost:8083/health
curl http://localhost:8084/health

# Kill any stuck processes
npm run kill-ports
```

## Adding New Tests

### Unit Tests
1. Create `*.test.js` file in appropriate `test/` subdirectory
2. Follow existing patterns with Jest
3. Add to `jest.config.js` testMatch if needed

### Browser Tests
1. Create `*.spec.js` file in `tests/browser/`
2. Follow Playwright patterns
3. Add to GitHub Actions workflow if CI-appropriate

### Integration Tests
1. Create in `test/local/` or `test/hybrid/`
2. Document infrastructure requirements
3. Add npm script to package.json

## CI/CD Integration

### What Runs in CI:
- ✅ All Jest unit tests
- ✅ DHT algorithm concept test
- ✅ Browser smoke tests
- ✅ ESLint

### What Doesn't Run in CI:
- ❌ Full integration tests (require complex setup)
- ❌ Network stress tests (too resource intensive)
- ❌ Manual/interactive tests

### Adding Tests to CI:
1. Ensure test is deterministic and fast
2. No external dependencies (databases, services)
3. Add to appropriate GitHub Actions workflow
4. Test locally first with same Node.js version

## Performance Benchmarks

### Target Performance:
- **Unit Tests**: <30 seconds total
- **Browser Tests**: <20 seconds for smoke tests
- **Algorithm Tests**: <5 seconds
- **Build + Test**: <2 minutes total in CI

### Current Status:
- ✅ Unit tests: ~10 seconds
- ✅ Browser tests: ~15 seconds  
- ✅ Algorithm tests: ~3 seconds
- ✅ Total CI time: ~1 minute

This comprehensive testing strategy ensures code quality while maintaining fast CI/CD pipelines.