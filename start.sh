#!/bin/sh
# Starts Project Sigma: checks Node.js, installs what it needs on the first run and after an update,
# opens the browser once the server answers, then runs the server in this terminal.
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
    echo "Project Sigma needs Node.js 22.15 or newer, and Node.js was not found."
    echo "Install the LTS version from https://nodejs.org or your package manager, then run this again."
    exit 1
fi

if ! node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=15)?0:1)"; then
    echo "Project Sigma needs Node.js 22.15 or newer; this computer has $(node -v)."
    echo "Install the LTS version from https://nodejs.org or your package manager, then run this again."
    exit 1
fi

# install on the first run and again whenever package-lock.json changes, as it does with an update
if ! node -e "const fs=require('fs');const h=require('crypto').createHash('sha256').update(fs.readFileSync('package-lock.json')).digest('hex');let s='';try{s=fs.readFileSync('node_modules/.sigma-installed','utf8')}catch{}process.exit(s===h?0:1)"; then
    echo "Installing what Project Sigma needs. The first time takes a minute or two."
    # sharp has no native build for Android, so there npm takes its WebAssembly build from the lockfile
    NPM_CPU=""
    if [ "$(node -p process.platform)" = "android" ]; then NPM_CPU="--cpu=wasm32"; fi
    if ! npm ci --no-audit --no-fund $NPM_CPU; then
        echo
        echo "The install failed; the lines above say why."
        exit 1
    fi
    if ! node -e "new (require('better-sqlite3'))(':memory:').close()" >/dev/null 2>&1; then
        echo
        echo "The install finished, but the database driver did not build."
        echo "Run \"npm rebuild better-sqlite3\" in this folder and read what it says."
        exit 1
    fi
    if ! node -e "require('sharp')" >/dev/null 2>&1; then
        echo
        echo "The install finished, but the image library (sharp) did not load."
        echo "Run node -e \"require('sharp')\" in this folder and read what it says."
        exit 1
    fi
    node -e "const fs=require('fs');fs.writeFileSync('node_modules/.sigma-installed',require('crypto').createHash('sha256').update(fs.readFileSync('package-lock.json')).digest('hex'))"
fi

# open the browser once the server answers, where there is a desktop to open it on, unless openBrowser in
# data/server.yaml or CL_OPEN_BROWSER is false
OPENER=""
if [ "$(uname)" = "Darwin" ]; then
    OPENER=open
elif [ -n "${DISPLAY}${WAYLAND_DISPLAY}" ] && command -v xdg-open >/dev/null 2>&1; then
    OPENER=xdg-open
fi
if [ -n "$OPENER" ]; then
    SIGMA_OPENER="$OPENER" node --input-type=module -e "try{const {config}=await import('./server/config.js');if(config.openBrowser){const url='http://localhost:'+config.port+'/';for(let i=0;i<240;i++){try{if((await fetch(url+'api/health')).ok){(await import('node:child_process')).execFile(process.env.SIGMA_OPENER,[url]);break}}catch{}await new Promise(r=>setTimeout(r,500))}}}catch{}" &
fi

echo "Starting Project Sigma. Press Ctrl+C to stop it."
echo
exec node server/index.js
