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

node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=15)?0:1)"
if errorlevel 1 (
    for /f %%v in ('node -v') do echo Project Sigma needs Node.js 22.15 or newer; this computer has %%v.
    echo Install the LTS version from https://nodejs.org, then run this file again.
    echo.
    pause
    exit /b 1
)

rem Install on the first run and again whenever package-lock.json changes, as it does with an update.
node -e "const fs=require('fs');const h=require('crypto').createHash('sha256').update(fs.readFileSync('package-lock.json')).digest('hex');let s='';try{s=fs.readFileSync('node_modules/.sigma-installed','utf8')}catch{}process.exit(s===h?0:1)"
if errorlevel 1 (
    echo Installing what Project Sigma needs. The first time takes a minute or two.
    call npm ci --no-audit --no-fund
    if errorlevel 1 (
        echo.
        echo The install failed; the lines above say why.
        pause
        exit /b 1
    )
    node -e "new (require('better-sqlite3'))(':memory:').close()" >nul 2>nul
    if errorlevel 1 (
        echo.
        echo The install finished, but the database driver did not build.
        echo Run "npm rebuild better-sqlite3" in this folder and read what it says.
        pause
        exit /b 1
    )
    node -e "const fs=require('fs');fs.writeFileSync('node_modules/.sigma-installed',require('crypto').createHash('sha256').update(fs.readFileSync('package-lock.json')).digest('hex'))"
)

rem Open the browser once the server answers, on the port it reads from data/server.yaml or CL_PORT.
start "" /b node --input-type=module -e "try{const {config}=await import('./server/config.js');const url='http://localhost:'+config.port+'/';for(let i=0;i<240;i++){try{if((await fetch(url+'api/health')).ok){(await import('node:child_process')).exec('rundll32 url.dll,FileProtocolHandler '+url);break}}catch{}await new Promise(r=>setTimeout(r,500))}}catch{}"

echo Starting Project Sigma. Close this window, or press Ctrl+C, to stop it.
echo.
node server/index.js
if errorlevel 1 (
    echo.
    echo Project Sigma stopped. If that was not you, the lines above say why.
    pause
)
endlocal
