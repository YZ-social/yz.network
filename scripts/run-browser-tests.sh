#!/bin/bash

# Run browser tests locally with proper setup
# This script mimics what GitHub Actions does

set -e

echo "🚀 Starting local browser test run..."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to cleanup on exit
cleanup() {
    echo -e "\n🛑 Cleaning up..."
    
    # Kill background processes
    if [ ! -z "$BRIDGE_PID" ]; then
        echo "Stopping bridge nodes (PID: $BRIDGE_PID)"
        kill $BRIDGE_PID 2>/dev/null || true
    fi
    
    if [ ! -z "$BOOTSTRAP_PID" ]; then
        echo "Stopping bootstrap server (PID: $BOOTSTRAP_PID)"
        kill $BOOTSTRAP_PID 2>/dev/null || true
    fi
    
    if [ ! -z "$TEST_SERVER_PID" ]; then
        echo "Stopping test server (PID: $TEST_SERVER_PID)"
        kill $TEST_SERVER_PID 2>/dev/null || true
    fi
    
    # Kill any remaining processes
    pkill -f "node.*bridge" 2>/dev/null || true
    pkill -f "node.*bootstrap" 2>/dev/null || true
    pkill -f "node.*test-server" 2>/dev/null || true
    
    # Use project cleanup
    npm run kill-ports 2>/dev/null || true
    
    echo "✅ Cleanup complete"
}

# Set trap to cleanup on exit
trap cleanup EXIT

# Create logs directory
mkdir -p logs

echo "📦 Installing dependencies..."
npm ci

echo "🏗️ Building project..."
npm run build

echo "📡 Starting bridge nodes..."
npm run bridge-nodes > logs/bridge-nodes.log 2>&1 &
BRIDGE_PID=$!
echo "Bridge nodes PID: $BRIDGE_PID"

echo "⏳ Waiting for bridge nodes to start..."
sleep 15

echo "🌟 Starting bootstrap server (genesis + open network)..."
npm run bridge-bootstrap:genesis:openNetwork > logs/bootstrap.log 2>&1 &
BOOTSTRAP_PID=$!
echo "Bootstrap server PID: $BOOTSTRAP_PID"

echo "⏳ Waiting for bootstrap server to start..."
sleep 20

echo "🔍 Verifying bootstrap server..."
for i in {1..10}; do
    if curl -f http://localhost:8080/health >/dev/null 2>&1; then
        echo -e "${GREEN}✅ Bootstrap server is ready${NC}"
        break
    else
        echo -e "${YELLOW}⏳ Attempt $i/10: Bootstrap server not ready yet...${NC}"
        sleep 5
    fi
    if [ $i -eq 10 ]; then
        echo -e "${RED}❌ Bootstrap server failed to start${NC}"
        echo "=== Bridge Nodes Log ==="
        cat logs/bridge-nodes.log || echo "No bridge nodes log"
        echo "=== Bootstrap Log ==="
        cat logs/bootstrap.log || echo "No bootstrap log"
        exit 1
    fi
done

echo "🌐 Starting test server..."
npm run test:server > logs/test-server.log 2>&1 &
TEST_SERVER_PID=$!

echo "⏳ Waiting for test server..."
for i in {1..10}; do
    if curl -f http://localhost:3000/health >/dev/null 2>&1; then
        echo -e "${GREEN}✅ Test server is ready${NC}"
        break
    else
        echo -e "${YELLOW}⏳ Attempt $i/10: Test server not ready yet...${NC}"
        sleep 2
    fi
    if [ $i -eq 10 ]; then
        echo -e "${RED}❌ Test server failed to start${NC}"
        cat logs/test-server.log || echo "No test server log"
        exit 1
    fi
done

echo "🎭 Installing Playwright browsers..."
npx playwright install --with-deps

echo "🧪 Running Playwright tests..."
if npx playwright test; then
    echo -e "${GREEN}✅ All tests passed!${NC}"
    TEST_RESULT=0
else
    echo -e "${RED}❌ Some tests failed${NC}"
    TEST_RESULT=1
fi

echo "📊 Test run complete!"
echo "📁 Reports available in:"
echo "  - playwright-report/ (HTML report)"
echo "  - test-results/ (JSON results)"
echo "  - logs/ (Service logs)"

exit $TEST_RESULT