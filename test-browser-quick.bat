@echo off
echo 🧪 Running Quick Browser Tests...

echo 📦 Building project...
call npm run build
if %errorlevel% neq 0 (
    echo ❌ Build failed
    pause
    exit /b 1
)

echo 🎭 Running smoke test...
call npx playwright test tests/browser/smoke-test.spec.js --project=chromium --reporter=list
if %errorlevel% neq 0 (
    echo ❌ Smoke test failed
    pause
    exit /b 1
)

echo 🏗️ Running infrastructure test...
call npx playwright test tests/browser/infrastructure.spec.js --project=chromium --reporter=list
if %errorlevel% neq 0 (
    echo ❌ Infrastructure test failed
    pause
    exit /b 1
)

echo ✅ All tests passed!
echo 📁 View detailed report: playwright-report/index.html
pause