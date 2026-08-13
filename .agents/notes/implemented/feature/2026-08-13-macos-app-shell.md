# Agent Note: macOS app shell for the web runner

Status: implemented

English | [中文](2026-08-13-macos-app-shell.zh.md)

## Problem

`dsh web` is a terminal-launched server. After installing dsh, the web runner is started by hand and keeps serving as long as the terminal stays open; there is no standard macOS presence, and the server's lifetime is tied to a terminal rather than to a user-facing app. Closing the terminal can leave the process and its port 3080 behind, and nothing cleans that up.

## Decision

`apps/macos` ships a native Swift shell around the unchanged `dsh web` runner. The app resolves the dsh and node executables (preference override, then a bundled install, then a PATH-style search), spawns `dsh web` as a child in its own process group via posix_spawn, opens the default browser once the port accepts connections, and owns the server's lifecycle: every quit path — Cmd+Q, window close, SIGTERM/SIGINT/SIGHUP — terminates the process group, SIGTERM first with a 6-second wait for the port to free, then SIGKILL, and verifies the port is released before exit. Lock files under Application Support record the server pid and port. A hard-killed app leaves an orphaned server; the next launch detects it by recorded pid plus an argument-signature check, terminates it, and starts fresh. A second app instance activates the running one and exits. `build.sh` assembles the .app — swiftc, a committed icon, codesign — with `--bundle-dsh` for a self-contained bundle (pinned by `DSH_BUNDLE_VERSION`) and `--universal` for a fat binary; `CODESIGN_IDENTITY` selects the signing identity. `.github/workflows/macos-app-release.yml` builds the universal app on every pull request and master push and attaches it to the GitHub Release of a `dsh-v*` tag, automatically on a tag push or via manual dispatch with `publish=true`; the README at [apps/macos/README.md](../../../../apps/macos/README.md) documents build, configuration, release, and the lifecycle guarantees.

## Alternatives considered

**AppleScript app bundle.** Rejected because process-group teardown, signal handling, and error surfacing are all clumsier there, and the result is less of a standard macOS app.

**Electron or Tauri shell.** Rejected because it ships a second runtime and rebuilds the UI; the essence here is a local port plus the existing browser frontend, not a new frontend.

**Embedded WKWebView.** Rejected because the essence is deliberately unchanged — a local port and the external browser — and a webview duplicates the frontend while adding token and browser-trust friction.

**Bundling node into the app.** Rejected for now because it triples the bundle size; the app resolves a system node, and `--bundle-dsh` already covers self-containment of the dsh side.

## Consequences

Quitting the app always frees the port when the server is the one holding it, and foreign listeners are never killed: termination targets only the app's own process group, and recovery re-verifies the recorded pid's arguments before any kill. The app needs node and dsh present or bundled, and it is ad-hoc signed rather than notarized, so external distribution needs a real signing setup. The web runner, profile, and `~/.dsh` data are untouched — only the process group around them is managed.
