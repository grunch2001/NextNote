#!/usr/bin/env bash
# Builds the Windows installer (NSIS) and a portable exe.
# The app is packaged on Linux; the installer step runs with a portable Windows Node
# (NSIS needs to execute the generated installer once, which on Linux would require Wine).
set -euo pipefail
cd "$(dirname "$0")/.."
NODE_WIN=.tools/node-win/node.exe

if [ ! -x "$NODE_WIN" ]; then
  mkdir -p .tools && cd .tools
  V=$(curl -s https://nodejs.org/dist/index.json | python3 -c "import json,sys; print([r['version'] for r in json.load(sys.stdin) if r['version'].startswith('v24.')][0])")
  curl -sSLo node-win.zip "https://nodejs.org/dist/$V/node-$V-win-x64.zip"
  curl -sSL "https://nodejs.org/dist/$V/SHASUMS256.txt" | grep "node-$V-win-x64.zip" | sed "s/node-$V-win-x64.zip/node-win.zip/" > sums.txt
  sha256sum -c sums.txt
  python3 -c "import zipfile; zipfile.ZipFile('node-win.zip').extractall('.')"
  rm -rf node-win && mv "node-$V-win-x64" node-win && rm node-win.zip
  chmod +x node-win/node.exe
  cd ..
fi

npm run build
npm run electron:build-main
rm -rf release/win-unpacked release/NextNote-Setup-*.exe* release/NextNote-*-portable.exe
npx electron-builder --win --x64 --dir
# VS Code terminals export ELECTRON_RUN_AS_NODE, which must not reach Windows processes
env -u ELECTRON_RUN_AS_NODE WSLENV= "$NODE_WIN" node_modules/electron-builder/cli.js --win nsis portable --x64 --prepackaged release/win-unpacked
ls -la release/*.exe
