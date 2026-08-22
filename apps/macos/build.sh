#!/usr/bin/env bash
# Build the "DeepSeek Harness" macOS app shell for dsh web.
#
# The shell is a thin native wrapper: it launches `dsh web` (the unchanged web
# runner), opens the default browser at the served URL, and terminates the
# server process group on quit so the port is released.
#
# Usage: build.sh [--bundle-dsh] [--universal] [--install] [--output-dir <dir>]
#
#   --bundle-dsh   npm-install @deepseek-ai/dsh into the app's Resources so the
#                  .app is self-contained (needs network + node at build time).
#                  The version comes from DSH_BUNDLE_VERSION (default: latest).
#   --universal    build an arm64 + x86_64 universal binary.
#   --install      copy the finished .app into /Applications.
#   --output-dir   where to place the .app (default: <repo>/apps/macos/build).
#
# Environment:
#   DSH_BUNDLE_VERSION   Version of @deepseek-ai/dsh to bundle with --bundle-dsh
#                        (default: latest).
#   CODESIGN_IDENTITY    codesign identity; ad-hoc (`-`) when unset.
#
# Requirements: swiftc (Xcode Command Line Tools), iconutil; iconutil only for
# regenerating the icon — Resources/AppIcon.icns is committed, so rsvg-convert
# is no longer needed. The default mode resolves an installed dsh + node at run
# time.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
APP_NAME="DeepSeek Harness"
MIN_MACOS="13.0"
OUT_DIR="${SCRIPT_DIR}/build"
BUNDLE_DSH=0
UNIVERSAL=0
INSTALL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bundle-dsh) BUNDLE_DSH=1; shift ;;
    --universal) UNIVERSAL=1; shift ;;
    --install) INSTALL=1; shift ;;
    --output-dir) OUT_DIR="${2:?--output-dir needs a value}"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

APP_DIR="${OUT_DIR}/${APP_NAME}.app"
BIN_DIR="${APP_DIR}/Contents/MacOS"
RES_DIR="${APP_DIR}/Contents/Resources"
WORK="${OUT_DIR}/.build-work"

echo "==> Assembling ${APP_DIR}"
rm -rf "${APP_DIR}" "${WORK}"
mkdir -p "${BIN_DIR}" "${RES_DIR}"

# --- Compile the Swift shell -------------------------------------------------
ARCH="${ARCH:-$(uname -m)}"
MODULE_CACHE="${OUT_DIR}/.swift-module-cache"
swiftc_args=(-O -swift-version 5 "-module-cache-path" "${MODULE_CACHE}" \
  "-target" "${ARCH}-apple-macosx${MIN_MACOS}")
if [[ "${UNIVERSAL}" -eq 1 ]]; then
  echo "==> Compiling universal binary (arm64 + x86_64)"
  mkdir -p "${WORK}"
  swiftc "${swiftc_args[@]}" "-target" "arm64-apple-macosx${MIN_MACOS}" \
    -o "${WORK}/shell-arm64" "${SCRIPT_DIR}/Sources/main.swift"
  swiftc "${swiftc_args[@]}" "-target" "x86_64-apple-macosx${MIN_MACOS}" \
    -o "${WORK}/shell-x86_64" "${SCRIPT_DIR}/Sources/main.swift"
  lipo -create -output "${BIN_DIR}/${APP_NAME}" "${WORK}/shell-arm64" "${WORK}/shell-x86_64"
else
  echo "==> Compiling for ${ARCH}"
  swiftc "${swiftc_args[@]}" -o "${BIN_DIR}/${APP_NAME}" "${SCRIPT_DIR}/Sources/main.swift"
fi

# --- Info.plist ---------------------------------------------------------------
cp "${SCRIPT_DIR}/Resources/Info.plist" "${APP_DIR}/Contents/Info.plist"

# --- Update helper --------------------------------------------------------------
cp "${REPO_ROOT}/apps/updater/updater.mjs" "${RES_DIR}/updater.mjs"
cp "${REPO_ROOT}/apps/version" "${RES_DIR}/version.txt"
cp "${REPO_ROOT}/apps/dsh-version" "${RES_DIR}/dsh-version.txt"

# --- App icon -------------------------------------------------------------------
# Resources/AppIcon.icns is committed; regenerate it (rsvg-convert + iconutil)
# only when it is missing. The committed icon centers the white mark at 70%
# inside the #0d1526 rounded square (mirrors the DeepSeek app icon layout);
# keep the fallback template in sync.
if [[ -f "${SCRIPT_DIR}/Resources/AppIcon.icns" ]]; then
  echo "==> Using committed AppIcon.icns"
  cp "${SCRIPT_DIR}/Resources/AppIcon.icns" "${RES_DIR}/AppIcon.icns"
    if [[ -f "${SCRIPT_DIR}/Resources/AppIcon-Light.icns" ]]; then
      cp "${SCRIPT_DIR}/Resources/AppIcon-Light.icns" "${RES_DIR}/AppIcon-Light.icns"
    fi
elif command -v rsvg-convert >/dev/null 2>&1 && command -v iconutil >/dev/null 2>&1; then
  echo "==> Generating AppIcon.icns"
  mkdir -p "${WORK}/AppIcon.iconset"
  path_data="$(sed -n 's/.* d="\([^"]*\)".*/\1/p' "${REPO_ROOT}/apps/web/public/favicon.svg")"
  # The mark's source bbox is x[0.53,49.37] y[6.94,43.58] (center 24.95,25.26);
  # inset the rounded square by 10% and scale the mark to 0.62 so the Dock
  # icon has the same visual margin as standard macOS app icons.
  cat > "${WORK}/app-icon.svg" <<EOF
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 50 50">
  <rect x="5" y="5" width="40" height="40" rx="9" fill="#0d1526"/>
  <g transform="translate(25 25) scale(0.62) translate(-24.95 -25.26)">
    <path fill="#ffffff" d="${path_data}"/>
  </g>
</svg>
EOF
  rsvg-convert -w 1024 -h 1024 -o "${WORK}/icon-1024.png" "${WORK}/app-icon.svg"
  for size in 16 32 128 256 512; do
    sips -z "${size}" "${size}" "${WORK}/icon-1024.png" \
      --out "${WORK}/AppIcon.iconset/icon_${size}x${size}.png" >/dev/null
    sips -z "$((size * 2))" "$((size * 2))" "${WORK}/icon-1024.png" \
      --out "${WORK}/AppIcon.iconset/icon_${size}x${size}@2x.png" >/dev/null
  done
  iconutil -c icns "${WORK}/AppIcon.iconset" -o "${RES_DIR}/AppIcon.icns"
else
  echo "==> AppIcon.icns missing and cannot be regenerated; skipping the app icon"
  /usr/libexec/PlistBuddy -c "Delete :CFBundleIconFile" "${APP_DIR}/Contents/Info.plist" >/dev/null 2>&1 || true
fi

# --- Optional self-contained dsh bundle ----------------------------------------
if [[ "${BUNDLE_DSH}" -eq 1 ]]; then
  echo "==> Bundling @deepseek-ai/dsh into Resources/dsh"
  NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=4096}" \
    npm install --prefix "${RES_DIR}/dsh" "@deepseek-ai/dsh@${DSH_BUNDLE_VERSION:-latest}"

  # Bundle a node runtime (arm64 + x64, lipo-merged) so the app needs no
  # system node. Only the node binary is kept — npm, corepack, and docs are
  # never run by `dsh web`. Pinned by NODE_BUNDLE_VERSION (default v24 LTS-line).
  NODE_BUNDLE_VERSION="${NODE_BUNDLE_VERSION:-v24.12.0}"
  echo "==> Bundling node ${NODE_BUNDLE_VERSION}"
  mkdir -p "${RES_DIR}/dsh/bin" "${WORK}/node"
  for arch in darwin-arm64 darwin-x64; do
    curl -fsSL "https://nodejs.org/dist/${NODE_BUNDLE_VERSION}/node-${NODE_BUNDLE_VERSION}-${arch}.tar.gz" \
      -o "${WORK}/node-${arch}.tar.gz"
    tar -xzf "${WORK}/node-${arch}.tar.gz" -C "${WORK}/node"
    mv "${WORK}/node/node-${NODE_BUNDLE_VERSION}-${arch}/bin/node" "${WORK}/node-${arch}"
  done
  lipo -create "${WORK}/node-darwin-arm64" "${WORK}/node-darwin-x64" -output "${RES_DIR}/dsh/bin/node"
  chmod +x "${RES_DIR}/dsh/bin/node"
fi

# --- Codesign (ad-hoc by default; CODESIGN_IDENTITY for release signing) ---------
CODESIGN_IDENTITY="${CODESIGN_IDENTITY:--}"
echo "==> Codesigning with identity: ${CODESIGN_IDENTITY}"
codesign --force --deep --sign "${CODESIGN_IDENTITY}" "${APP_DIR}"

rm -rf "${WORK}"

echo "==> Done: ${APP_DIR}"

if [[ "${INSTALL}" -eq 1 ]]; then
  echo "==> Installing into /Applications"
  rm -rf "/Applications/${APP_NAME}.app"
  cp -R "${APP_DIR}" "/Applications/"
  echo "==> Installed: /Applications/${APP_NAME}.app"
fi
