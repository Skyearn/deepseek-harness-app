#!/usr/bin/env bash
set -euo pipefail

DSH_VERSION="${1:?dsh version required}"
SHELL_VERSION="${2:-current}"
NODE_VERSION="${NODE_BUNDLE_VERSION:-v24.12.0}"
OUT="${3:-dist/dsh-runtime-${SHELL_VERSION}-${DSH_VERSION}-macos-universal.tar.gz}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$WORK/runtime"
echo "==> Installing @deepseek-ai/dsh@${DSH_VERSION}"
npm install --prefix "$WORK/runtime" --no-audit --no-fund "@deepseek-ai/dsh@${DSH_VERSION}"

mkdir -p "$WORK/runtime/versions/${DSH_VERSION}"
mv "$WORK/runtime/node_modules" "$WORK/runtime/versions/${DSH_VERSION}/node_modules"
echo "$DSH_VERSION" > "$WORK/runtime/current"
touch "$WORK/runtime/versions/${DSH_VERSION}/.complete"

echo "==> Downloading Node ${NODE_VERSION}"
mkdir -p "$WORK/runtime/node"
for arch in arm64 x64; do
  curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-darwin-${arch}.tar.gz" -o "$WORK/node-${arch}.tar.gz"
  tar -xzf "$WORK/node-${arch}.tar.gz" -C "$WORK"
done
lipo -create \
  "$WORK/node-${NODE_VERSION}-darwin-arm64/bin/node" \
  "$WORK/node-${NODE_VERSION}-darwin-x64/bin/node" \
  -output "$WORK/runtime/node/bin/node"
chmod +x "$WORK/runtime/node/bin/node"

mkdir -p "$(dirname "$OUT")"
tar -czf "$OUT" -C "$WORK/runtime" .
echo "==> Runtime bundle: $OUT"
