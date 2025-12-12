@echo off
REM Run browser tests locally with proper setup (Windows Batch)

echo 🚀 Starting local browser test run...

REM Create logs directory
if not exist logs mkdir logs

echo 📦 Installing dependencies...
call npm ci
if %errorlevel% neq 0 (
    echo ❌ Failed to install dependencies
    exit /b 1
)

echo 🏗️ Building project...
call npm run build
if %errorlevel% neq 0 (
    echo ❌ Failed to build project
    exit /b 1
)

echo 📡 Starting bridge nodes...
start /B npm run bridge-nodes > logs\bridge-nodes.log 2>&1

echo ⏳ Waiting for bridge nodes to start...
timeout /t 15 /nobreak > nul

echo 🌟 Starting bootstrap server (genesis + open network)...
start /B npm run bridge-bootstrap:genesis:openNetwork > logs\bootstrap.log 2>&1

echo ⏳ Waiting for bootstrap server to start...
timeout /t 20 /nobreak > nul

echo 🔍 Verifying bootstrap server...
for /l %%i in (1,1,10) do (
    curl -f http://localhost:8080/health > nul 2>&1
    if %errorlevel% equ 0 (
        echo ✅ Bootstrap server is ready
        goto bootstrap_ready
    )
    echo ⏳ Attempt %%i/10: Bootstrap server not ready yet...
    timeout /t 5 /nobreak > nul
)

echo ❌ Bootstrap server failed to start
echo === Bridge Nodes Log ===
if exist logs\bridge-nodes.log type logs\bridge-nodes.log
echo === Bootstrap Log ===
if exist logs\bootstrap.log type logs\bootstrap.log
goto cleanup

:bootstrap_ready

echo 🌐 Starting test server...
start /B npm run test:server > logs\test-server.log 2>&1

echo ⏳ Waiting for test server...
for /l %%i in (1,1,10) do (
    curl -f http://localhost:3000/health > nul 2>&1
    if %errorlevel% equ 0 (
        echo ✅ Test server is ready
        goto test_server_ready
    )
    echo ⏳ Attempt %%i/10: Test server not ready yet...
    timeout /t 2 /nobreak > nul
)

echo ❌ Test server failed to start
if exist logs\test-server.log type logs\test-server.log
goto cleanup

:test_server_ready

echo 🎭 Installing Playwright browsers...
call npx playwright install --with-deps
if %errorlevel% neq 0 (
    echo ❌ Failed to install Playwright browsers
    goto cleanup
)

echo 🧪 Running Playwright tests...
call npx playwright test
set test_result=%errorlevel%

if %test_result% equ 0 (
    echo ✅ All tests passed!
) else (
    echo ❌ Some tests failed
)

echo 📊 Test run complete!
echo 📁 Reports available in:
echo   - playwright-report/ (HTML report)
echo   - test-results/ (JSON results)
echo   - logs/ (Service logs)

:cleanup
echo 🛑 Cleaning up...
taskkill /f /im node.exe > nul 2>&1
call npm run kill-ports > nul 2>&1
echo ✅ Cleanup complete

exit /b %test_result%