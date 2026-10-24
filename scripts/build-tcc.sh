#!/bin/sh
# Builds native/tcc as one universal (arm64 + x86_64) addon, so the same file
# ships in the Apple Silicon and the Intel Oats.app. node-gyp can't produce fat
# binaries and wipes build/ on every rebuild, so each slice is kept in arch/.
set -e
cd "$(dirname "$0")/../native/tcc"
mkdir -p arch
for arch in arm64 x64; do
  npx -y node-gyp@11.2.0 rebuild --arch="$arch" >/dev/null 2>&1
  cp build/Release/oats_tcc.node "arch/oats_tcc-$arch.node"
done
lipo -create arch/oats_tcc-arm64.node arch/oats_tcc-x64.node -output build/Release/oats_tcc.node
lipo -info build/Release/oats_tcc.node
