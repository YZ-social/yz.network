# Run browser tests locally with proper setup (Windows PowerShell)
# This script mimics what GitHub Actions does

param(
    [switch]$SkipBuild = $false,
    [switch]$SkipInstall = $false
)

Write-Host "🚀 Starting local browser test run..." -ForegroundColor Green

# Function to cleanup on exit
function Cleanup {
    Write-Host "`n🛑 Cleaning up..." -ForegroundColor Yellow
    
    # Kill background processes
    if ($global:BridgeProcess) {
        Write-Host "Stopping bridge nodes (PID: $($global:BridgeProcess.Id))"
        Stop-Process -Id $global:BridgeProcess.Id -Force -ErrorAction SilentlyContinue
    }
    
    if ($global:BootstrapProcess) {
        Write-Host "Stopping bootstrap server (PID: $($global:BootstrapProcess.Id))"
        Stop-Process -Id $global:BootstrapProcess.Id -Force -ErrorAction SilentlyContinue
    }
    
    if ($global:TestServerProcess) {
        Write-Host "Stopping test server (PID: $($global:TestServerProcess.Id))"
        Stop-Process -Id $global:TestServerProcess.Id -Force -ErrorAction SilentlyContinue
    }
    
    # Kill any remaining processes
    Get-Process | Where-Object { $_.ProcessName -eq "node" -and $_.CommandLine -like "*bridge*" } | Stop-Process -Force -ErrorAction SilentlyContinue
    Get-Process | Where-Object { $_.ProcessName -eq "node" -and $_.CommandLine -like "*bootstrap*" } | Stop-Process -Force -ErrorAction SilentlyContinue
    Get-Process | Where-Object { $_.ProcessName -eq "node" -and $_.CommandLine -like "*test-server*" } | Stop-Process -Force -ErrorAction SilentlyContinue
    
    # Use project cleanup
    try {
        npm run kill-ports
    } catch {
        Write-Host "Kill-ports script not available or failed" -ForegroundColor Yellow
    }
    
    Write-Host "✅ Cleanup complete" -ForegroundColor Green
}

# Set trap to cleanup on exit
trap { Cleanup; exit 1 }

# Create logs directory
if (!(Test-Path "logs")) {
    New-Item -ItemType Directory -Path "logs" | Out-Null
}

if (!$SkipInstall) {
    Write-Host "📦 Installing dependencies..." -ForegroundColor Cyan
    npm ci
    if ($LASTEXITCODE -ne 0) {
        Write-Host "❌ Failed to install dependencies" -ForegroundColor Red
        exit 1
    }
}

if (!$SkipBuild) {
    Write-Host "🏗️ Building project..." -ForegroundColor Cyan
    npm run build
    if ($LASTEXITCODE -ne 0) {
        Write-Host "❌ Failed to build project" -ForegroundColor Red
        exit 1
    }
}

Write-Host "📡 Starting bridge nodes..." -ForegroundColor Cyan
$global:BridgeProcess = Start-Process -FilePath "npm" -ArgumentList "run", "bridge-nodes" -RedirectStandardOutput "logs/bridge-nodes.log" -RedirectStandardError "logs/bridge-nodes-error.log" -PassThru -NoNewWindow
Write-Host "Bridge nodes PID: $($global:BridgeProcess.Id)"

Write-Host "⏳ Waiting for bridge nodes to start..." -ForegroundColor Yellow
Start-Sleep -Seconds 15

Write-Host "🌟 Starting bootstrap server (genesis + open network)..." -ForegroundColor Cyan
$global:BootstrapProcess = Start-Process -FilePath "npm" -ArgumentList "run", "bridge-bootstrap:genesis:openNetwork" -RedirectStandardOutput "logs/bootstrap.log" -RedirectStandardError "logs/bootstrap-error.log" -PassThru -NoNewWindow
Write-Host "Bootstrap server PID: $($global:BootstrapProcess.Id)"

Write-Host "⏳ Waiting for bootstrap server to start..." -ForegroundColor Yellow
Start-Sleep -Seconds 20

Write-Host "🔍 Verifying bootstrap server..." -ForegroundColor Cyan
$bootstrapReady = $false
for ($i = 1; $i -le 10; $i++) {
    try {
        $response = Invoke-WebRequest -Uri "http://localhost:8080/health" -TimeoutSec 5 -ErrorAction Stop
        if ($response.StatusCode -eq 200) {
            Write-Host "✅ Bootstrap server is ready" -ForegroundColor Green
            $bootstrapReady = $true
            break
        }
    } catch {
        Write-Host "⏳ Attempt $i/10: Bootstrap server not ready yet..." -ForegroundColor Yellow
        Start-Sleep -Seconds 5
    }
}

if (!$bootstrapReady) {
    Write-Host "❌ Bootstrap server failed to start" -ForegroundColor Red
    Write-Host "=== Bridge Nodes Log ===" -ForegroundColor Yellow
    if (Test-Path "logs/bridge-nodes.log") {
        Get-Content "logs/bridge-nodes.log"
    } else {
        Write-Host "No bridge nodes log found"
    }
    Write-Host "=== Bootstrap Log ===" -ForegroundColor Yellow
    if (Test-Path "logs/bootstrap.log") {
        Get-Content "logs/bootstrap.log"
    } else {
        Write-Host "No bootstrap log found"
    }
    Cleanup
    exit 1
}

Write-Host "🌐 Starting test server..." -ForegroundColor Cyan
$global:TestServerProcess = Start-Process -FilePath "npm" -ArgumentList "run", "test:server" -RedirectStandardOutput "logs/test-server.log" -RedirectStandardError "logs/test-server-error.log" -PassThru -NoNewWindow

Write-Host "⏳ Waiting for test server..." -ForegroundColor Yellow
$testServerReady = $false
for ($i = 1; $i -le 10; $i++) {
    try {
        $response = Invoke-WebRequest -Uri "http://localhost:3000/health" -TimeoutSec 5 -ErrorAction Stop
        if ($response.StatusCode -eq 200) {
            Write-Host "✅ Test server is ready" -ForegroundColor Green
            $testServerReady = $true
            break
        }
    } catch {
        Write-Host "⏳ Attempt $i/10: Test server not ready yet..." -ForegroundColor Yellow
        Start-Sleep -Seconds 2
    }
}

if (!$testServerReady) {
    Write-Host "❌ Test server failed to start" -ForegroundColor Red
    if (Test-Path "logs/test-server.log") {
        Get-Content "logs/test-server.log"
    } else {
        Write-Host "No test server log found"
    }
    Cleanup
    exit 1
}

Write-Host "🎭 Installing Playwright browsers..." -ForegroundColor Cyan
npx playwright install --with-deps
if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Failed to install Playwright browsers" -ForegroundColor Red
    Cleanup
    exit 1
}

Write-Host "🧪 Running Playwright tests..." -ForegroundColor Cyan
npx playwright test
$testResult = $LASTEXITCODE

if ($testResult -eq 0) {
    Write-Host "✅ All tests passed!" -ForegroundColor Green
} else {
    Write-Host "❌ Some tests failed" -ForegroundColor Red
}

Write-Host "📊 Test run complete!" -ForegroundColor Cyan
Write-Host "📁 Reports available in:" -ForegroundColor Cyan
Write-Host "  - playwright-report/ (HTML report)"
Write-Host "  - test-results/ (JSON results)"
Write-Host "  - logs/ (Service logs)"

Cleanup
exit $testResult