export default {
  // Use Node.js environment for testing
  testEnvironment: 'node',
  
  // Enable ES modules
  extensionsToTreatAsEsm: ['.js'],
  transform: {},
  
  // Test file patterns
  testMatch: [
    '**/test/**/*.test.js',
    '**/test/**/*.spec.js'
  ],
  
  // Coverage configuration
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/index.js', // Exclude main entry point
    '!src/ui/**/*.js', // Exclude UI components (browser-specific)
    '!src/wasm/**/*.js' // Exclude WebAssembly components
  ],
  
  // Coverage thresholds
  coverageThreshold: {
    global: {
      branches: 70,
      functions: 70,
      lines: 70,
      statements: 70
    }
  },
  
  // Setup files
  setupFilesAfterEnv: ['<rootDir>/test/setup.js'],
  
  // Module name mapping for ES modules
  moduleNameMapping: {
    '^(\\.{1,2}/.*)\\.js$': '$1'
  },
  
  // Timeout for tests
  testTimeout: 10000
};