# DeepSeek Harness Desktop

English | [中文](README.zh.md)

This repository packages [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) as native desktop applications. It is a fork of `deepseek-ai/deepseek-harness` that adds an app shell layer on top of the unchanged web runner: each platform shell launches `dsh web`, serves the same UI in an embedded web view, and owns the server process — quitting the app terminates the server and releases the port.

![DeepSeek Harness desktop app](apps/macos/app-screenshot.png)

## Applications

| Platform | Shell | Asset |
|---|---|---|
| macOS | [apps/macos](apps/macos/README.md) — Swift + WKWebView | `DeepSeek-Harness-<version>-macos-universal.zip` (arm64 + x86_64) |
| Windows | [apps/windows](apps/windows/README.md) — C# .NET Framework + WebView2 | `DeepSeek-Harness-<version>-windows-x64.zip` |

Both shells provide the same behaviors: a dock/taskbar icon, an embedded UI window, guaranteed cleanup on quit, single-instance enforcement, crash recovery of an orphaned server, and an explicit "Open in Browser" opt-in instead of auto-opening the system browser.

## Highlights

- **Self-contained distribution** — `--bundle-dsh` (macOS) / `-BundleDsh` (Windows) embeds `@deepseek-ai/dsh` into the app, and both builds bundle a Node.js runtime (`bin/node`, pinned via `NODE_BUNDLE_VERSION`, default `v24.12.0`) so no system Node install is required. The bundled runtime is pruned to what `dsh web` runs (no npm/npx/corepack, no docs).
- **Localized UI** — the macOS menu bar, context menu, and system-provided items (Undo/Redo, Dictation, Emoji & Symbols) follow the app's effective language via `CFBundleDevelopmentRegion`/`CFBundleLocalizations` (`zh-Hans`); the Windows launcher localizes its own strings and context menu.
- **Windows high-DPI** — a PerMonitorV2 manifest (`apps/windows/app.manifest`) keeps the embedded UI crisp on scaled displays.
- **Branded icons** — the macOS `AppIcon.icns` and the Windows `app.ico` share the DeepSeek mark: the white mark sits at 70% scale inside a `#0d1526` rounded square, matching the official app-icon layout.
- **Guaranteed port release** — quit paths terminate the server's process group/tree and verify the port is free before exiting.

## Run

Download the release zip for your platform and open the app directly — the shell resolves `dsh` and `node` (bundled installs first, then PATH) and starts the embedded UI. See [Build](#build) for producing the apps from a checkout.

### Run from source

Build the shells as described in [Build](#build), then run the produced artifacts: `apps/macos/build/DeepSeek Harness.app` (macOS) or `apps/windows/build/DeepSeek Harness.exe` (Windows).

## Build

Requirements: `swiftc` (Xcode Command Line Tools) for macOS; `.NET Framework 4.x` (`csc.exe`) for Windows; Node.js 24 for bundling.

```sh
# macOS — apps/macos/build/DeepSeek Harness.app
apps/macos/build.sh --universal --bundle-dsh

# Windows — apps/windows/build/DeepSeek Harness.exe
powershell -ExecutionPolicy Bypass -File apps/windows/build.ps1 -BundleDsh
```

`DSH_BUNDLE_VERSION` (or `-DshVersion` on Windows) selects the `@deepseek-ai/dsh` version to embed; `NODE_BUNDLE_VERSION` pins the bundled Node. On macOS `CODESIGN_IDENTITY` selects the codesign identity (ad-hoc `-` by default); `--install` copies the finished app into `/Applications`.

## Release

`.github/workflows/app-release.yml` builds both platform apps on every pull request and master push as a packaging check, and attaches the zips to a GitHub Release when an `app-v*` tag is pushed. The app shell version comes from the tag (`app-v<version>`, recorded in `apps/version`); the bundled `@deepseek-ai/dsh` version is recorded in `apps/dsh-version` on the tag, so the npm package at that version must be published before the release build runs.

`.github/workflows/upstream-sync.yml` automates the loop on a 6-hour schedule: it merges upstream `deepseek-ai/deepseek-harness` master into this fork's master, asks npm for the current `@deepseek-ai/dsh` version, and when it differs from `apps/dsh-version` bumps the app version (patch +1 in `apps/version`), records the new dsh version, and tags the tree `app-v<version>`, which triggers the release build. Shell-only releases (no dsh change) bump `apps/version` and tag manually. `sync_only` dispatch merges without touching releases.

## Configuration

Both shells resolve `dsh` and `node` in the same order: explicit paths, then the bundled install beside the app, then a PATH-style search. Behavior is configured per platform:

- macOS: preferences in the `ai.deepseek.harness` domain — `defaults write ai.deepseek.harness port -int 8080`
- Windows: registry values under `HKCU\Software\DeepSeek Harness` — `reg add HKCU\Software\DeepSeek Harness /v port /t REG_DWORD /d 8080`

Keys: `port` (default `3080`), `dshPath`, `nodePath`, `openBrowserOnLaunch`, `stateDir`.

## Logs and state

The shell keeps its own lock files and server log beside the app's data directory; `~/.dsh` (macOS) / `%USERPROFILE%\.dsh` (Windows) holds the server's own profile and sessions, untouched by the shell. See each shell's README for exact paths and uninstall steps.

## Testing

`apps/macos/scripts/test-lifecycle.sh` and `apps/windows/scripts/test-lifecycle.ps1` exercise the lifecycle end to end on a test port: graceful quit frees the port and kills the server's process group/tree; a hard kill leaves an orphaned server that the next launch reclaims.

## License

[MIT](LICENSE)
