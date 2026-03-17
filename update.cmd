@echo off
:: Runs the contribution tracker and pushes updates to GitHub.
:: Set GITHUB_TOKEN for higher API rate limits (5000/hr vs 60/hr).

setlocal

where node >nul 2>&1
if %errorlevel% NEQ 0 (
    echo [ERROR] Node.js not found in PATH.
    pause & exit /b 1
)

echo.
node "%~dp0track-contributions.js"

if %errorlevel% NEQ 0 (
    echo.
    echo [ERROR] Tracker exited with errors.
    pause & exit /b 1
)

echo.
echo Done. View live at: https://github.com/TheRefreshCNFT/contributions
timeout /t 3 >nul
