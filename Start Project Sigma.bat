@echo off
setlocal
title Project Sigma
cd /d "%~dp0"

rem No labels or goto: cmd reads a batch file with LF line endings wrongly around them.

where node >nul 2>nul
if errorlevel 1 (
    echo Project Sigma needs Node.js 22.15 or newer, and Node.js was not found.
    echo Install the LTS version from https://nodejs.org, then run this file again.
    echo.
    pause
    exit /b 1
)

rem the launcher does the work, not this file, so every platform starts Project Sigma the same way
echo Starting Project Sigma. Close this window, or press Ctrl+C, to stop it.
echo.
node server/launcher.js
if errorlevel 1 (
    echo.
    echo Project Sigma stopped. If that was not you, the lines above say why.
    pause
)
endlocal
