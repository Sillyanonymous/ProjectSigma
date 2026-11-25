#!/bin/sh
# the launcher does the work, not this script, so every platform starts Project Sigma the same way
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
    echo "Project Sigma needs Node.js 22.15 or newer, and Node.js was not found."
    echo "Install the LTS version from https://nodejs.org or your package manager, then run this again."
    exit 1
fi

echo "Starting Project Sigma. Press Ctrl+C to stop it."
echo
exec node server/launcher.js
