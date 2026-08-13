# Agent Note: macOS app shell for the web runner

Status: implemented

English | [中文](2026-08-13-macos-app-shell.zh.md)

## Problem

`dsh web` is a terminal-launched server. After installing dsh, the web runner is started by hand and keeps serving as long as the terminal stays open; there is no standard macOS presence, and the server's lifetime is tied to a terminal rather than to a user-facing app. Closing the terminal can leave the process and its port 3080 behind, and nothing cleans that up.

## Decision

`apps/macos` ships a native Swift shell around the unchanged `dsh web` runner. The app resolves the dsh and node executables (preference override, then a bundled install, then a PATH-style search), spawns `dsh web` as a child in its own process group via posix_spawn, and owns the server's lifecycle: every quit path — Cmd+Q, window close, SIGTERM/SIGINT/SIGHUP — terminates the process group, SIGTERM first with a 6-second wait for the port to free, then SIGKILL, and verifies the port is released before exit. Lock files under Application Support record the server pid and port. A hard-killed app leaves an orphaned server; the next launch detects it by recorded pid plus an argument-signature check, terminates it, and starts fresh. A second app instance activates the running one and exits (with a liveness check, so a stale LaunchServices entry cannot masquerade as an instance; tests pass `-singleInstance 0` to run alongside an open app on an isolated port and state dir). The UI is embedded, Electron-style: once the port accepts connections, the window's WKWebView (macOS) or WebView2 control (Windows) loads the served page — the `/api` browser-trust fence accepts it because it is the same loopback origin — and the system browser is never opened automatically, only via the explicit "Open in Browser" menu/button or the opt-in `openBrowserOnLaunch` preference (default off). `build.sh` assembles the .app — swiftc, a committed icon, codesign — with `--bundle-dsh` for a self-contained bundle (pinned by `DSH_BUNDLE_VERSION`) and `--universal` for a fat binary; `CODESIGN_IDENTITY` selects the signing identity. `apps/windows` ships the same shell as a single C# file compiled with the .NET Framework csc.exe (no SDK needed; build.ps1 downloads the WebView2 SDK from NuGet); Windows has no SIGTERM, so its quit path is a hard process-tree kill via taskkill, and configuration lives in the registry rather than preferences. `.github/workflows/app-release.yml` builds both platform apps on every pull request and master push and attaches them to the GitHub Release of a `dsh-v*` tag, automatically on a tag push or via manual dispatch with `publish=true`; `.github/workflows/upstream-sync.yml` keeps the fork current with upstream `deepseek-ai/deepseek-harness` on a schedule (merging its master into the fork's) and publishes a release whenever npm has a newer `@deepseek-ai/dsh` version, by tagging the merged tree and pushing the tag; the READMEs at [apps/macos/README.md](../../../../apps/macos/README.md) and [apps/windows/README.md](../../../../apps/windows/README.md) document build, configuration, release, and the lifecycle guarantees.

## Alternatives considered

**AppleScript app bundle.** Rejected because process-group teardown, signal handling, and error surfacing are all clumsier there, and the result is less of a standard macOS app.

**Electron or Tauri shell.** Rejected because it ships a second runtime and rebuilds the UI; the essence here is a local port plus the existing browser frontend, not a new frontend.

**Embedded WKWebView.** Rejected because the essence is deliberately unchanged — a local port and the external browser — and a webview duplicates the frontend while adding token and browser-trust friction.

**Bundling node into the app.** Rejected for now because it triples the bundle size; the app resolves a system node, and `--bundle-dsh` already covers self-containment of the dsh side.

## Consequences

Quitting the app always frees the port when the server is the one holding it, and foreign listeners are never killed: termination targets only the app's own process group, and recovery re-verifies the recorded pid's arguments before any kill. The app needs node and dsh present or bundled, and it is ad-hoc signed rather than notarized, so external distribution needs a real signing setup. The web runner, profile, and `~/.dsh` data are untouched — only the process group around them is managed.
