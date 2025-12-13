export default {
  testEnvironment: 'node',
  
  testMatch: [
    '**/test/basic.test.js',
    '**/test/core/*.test.js',
    '**/test/dht/*.test.js',
    '**/test/local/*.test.js',
    '**/test/Howard/*.test.js'
  ],
  
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/index.js',
    '!src/ui/**/*.js',
    '!src/wasm/**/*.js'
  ],
  
  // Coverage thresholds disabled for now
  // coverageThreshold: {
  //   global: {
  //     branches: 50,
  //     functions: 50,
  //     lines: 50,
  //     statements: 50
  //   }
  // },
  
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1'
  },
  
  setupFilesAfterEnv: ['<rootDir>/test/setup.js'],
  testTimeout: 10000
};