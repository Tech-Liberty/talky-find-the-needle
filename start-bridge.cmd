@echo off
setlocal
where node >nul 2>nul
if errorlevel 1 (
    echo Node.js 18 ou plus est requis : winget install OpenJS.NodeJS.LTS
    pause
    exit /b 1
)
cd /d "%~dp0bridge"
node bridge.js
pause
