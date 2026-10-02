#!/usr/bin/env bash
# Builds the site into dist/: the landing page plus a browser demo of the real
# app UI (app/src) running on mock data (demo-shim/mock.js).
set -euo pipefail
cd "$(dirname "$0")"
rm -rf dist
mkdir -p dist/demo
cp -R src/. dist/
cp ../app/src-tauri/icons/128x128.png dist/icon.png
cp ../app/src/*.html ../app/src/*.css ../app/src/*.js dist/demo/
cp demo-shim/mock.js dist/demo/
for page in dist/demo/index.html dist/demo/settings.html; do
  sed -i.bak 's#<script src="theme.js"></script>#<script src="mock.js"></script>\n  <script src="theme.js"></script>#' "$page"
  rm "$page.bak"
done
echo "built $(find dist -type f | wc -l | tr -d ' ') files into website/dist"
