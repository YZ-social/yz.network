# Browser Testing Setup for Windows

## Quick Start

### Option 1: PowerShell (Recommended)
```powershell
npm run test:browser
```

### Option 2: Command Prompt
```cmd
npm run test:browser:cmd
```

### Option 3: Manual Setup (for debugging)

1. **Build the project:**
   ```cmd
   npm run build
   ```

2. **Start bridge nodes (Terminal 1):**
   ```cmd
   npm run bridge-nodes
   ```

3. **Start bootstrap server (Terminal 2):**
   ```cmd
   npm run bridge-bootstrap:genesis:openNetwork
   ```

4. **Wait 30 seconds for services to start**

5. **Verify services are running:**
   ```cmd
   curl http://localhost:8080/health
   ```

6. **Start test server (Terminal 3):**
   ```cmd
   npm run test:server
   ```

7. **Verify test server:**
   ```cmd
   curl http://localhost:3000/health
   ```

8. **Run Playwright tests (Terminal 4):**
   ```cmd
   npx playwright test
   ```

## Troubleshooting

### Services not starting
- Check if ports 3000, 8080, 8083, 8084 are available
- Run `npm run kill-ports` to clean up

### Playwright browser installation
```cmd
npx playwright install --with-deps
```

### View test results
- HTML report: `playwright-report/index.html`
- Open in browser after tests complete

### Debug individual tests
```cmd
npx playwright test --debug
npx playwright test tests/browser/infrastructure.spec.js
```

## Available Test Files

1. **infrastructure.spec.js** - Basic infrastructure tests
2. **basic-dht.spec.js** - DHT functionality tests  
3. **tab-visibility.spec.js** - Tab visibility disconnect/reconnect tests

## GitHub Actions

The GitHub Actions workflow will automatically:
1. Set up Ubuntu environment
2. Install dependencies and Playwright browsers
3. Start DHT network infrastructure
4. Run all browser tests
5. Upload test reports as artifacts

## Local Development

For faster iteration during development:

1. **Keep services running in background:**
   ```cmd
   npm run bridge-nodes
   npm run bridge-bootstrap:genesis:openNetwork
   ```

2. **Run specific tests:**
   ```cmd
   npx playwright test tests/browser/infrastructure.spec.js
   ```

3. **Use UI mode for debugging:**
   ```cmd
   npx playwright test --ui
   ```