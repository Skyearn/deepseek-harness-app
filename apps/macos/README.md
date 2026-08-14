# DeepSeek Harness macOS app shell

English | [中文](README.zh.md)

A thin native macOS wrapper around `dsh web` for `apps/macos`. The web runner itself is unchanged: the app starts the same server on the same port and shows the UI in an embedded WKWebView window, exactly like the page a browser would load at the served URL. What the shell adds is a standard macOS presence and process ownership — a dock icon, a window with the embedded UI, and guaranteed cleanup: quitting the app (Cmd+Q, closing the window, or a termination signal) terminates the server's process group and verifies the port is released before the app exits. The system browser is never opened automatically; "Open in Browser" in the menu (Cmd+B) is the explicit opt-in.

## Requirements

- macOS 13 or newer
- `node` (22.19+ or 24+), reachable at `/opt/homebrew/bin/node`, `/usr/local/bin/node`, a `PATH` directory, or an nvm/asdf/volta/bun install
- an installed `dsh` (npm/pnpm global, or an npx cache), or `--bundle-dsh` to embed one in the app

## Build

```sh
apps/macos/build.sh                    # -> apps/macos/build/DeepSeek Harness.app
apps/macos/build.sh --universal        # arm64 + x86_64 universal binary
apps/macos/build.sh --bundle-dsh       # self-contained: embeds @deepseek-ai/dsh
apps/macos/build.sh --install          # copy the finished app into /Applications
apps/macos/build.sh --output-dir /tmp  # place the .app elsewhere
```

Building needs `swiftc` (Xcode Command Line Tools). The app icon is committed at `Resources/AppIcon.icns`, so no image tooling is required. `--bundle-dsh` installs `@deepseek-ai/dsh@${DSH_BUNDLE_VERSION:-latest}` into the app; `CODESIGN_IDENTITY` selects the codesign identity (ad-hoc `-` by default). The app is code-signed but not notarized for distribution.

## Release

`.github/workflows/app-release.yml` builds the platform apps and attaches them to a GitHub Release. The build jobs run on every pull request and master push as a packaging check; publishing attaches the assets from a `dsh-v*` tag — automatically on a tag push, or via `workflow_dispatch` with `publish=true`. A published app embeds `@deepseek-ai/dsh` at the exact tagged version, so that version must already be published to npm; a rehearsal build dispatches with `bundle_dsh=false`. The assets are `DeepSeek-Harness-<version>-macos-universal.zip` (arm64 + x86_64, ad-hoc signed) and `DeepSeek-Harness-<version>-windows-x64.zip` (see [apps/windows/README.md](../../windows/README.md)). Notarized macOS distribution needs a Developer ID certificate plus `notarytool`/`stapler` after the build; that signing chain is not wired into the workflow yet.

`.github/workflows/upstream-sync.yml` automates the whole loop: on a schedule (every 6 hours — edit the cron to change it) or manual dispatch it merges upstream `deepseek-ai/deepseek-harness` master into the fork's master and pushes it, then asks npm for the current `@deepseek-ai/dsh` version and, when the fork has no release for it yet, tags the merged tree `dsh-v<version>` and pushes it — which triggers the build-and-attach workflow above. Upstream publishes to npm rather than pushing tags, so npm is the release signal; a tag left without a release by a failed build is recreated at HEAD on the next run to retry. The `sync_only` dispatch input merges without touching releases.

## How it works

1. On launch the app resolves the `dsh` and `node` executables — the `dshPath`/`nodePath` preferences, then a bundled install under `Contents/Resources/dsh` (`--bundle-dsh`), then a PATH-style search including Homebrew, npm globals, nvm, asdf, volta, bun, and `~/.npm/_npx` caches.
2. It spawns `dsh web` as a child process in its own process group, with the server's output appended to `~/Library/Logs/DeepSeek Harness/server.log`.
3. Once `127.0.0.1:<port>` accepts connections, the embedded WKWebView loads the served URL. The system browser opens only through the "Open in Browser" menu item or the opt-in `openBrowserOnLaunch` preference.
4. Quitting — Cmd+Q, the Quit menu item, closing the window, or SIGTERM/SIGINT/SIGHUP — sends SIGTERM to the server's process group, waits for the port to free (up to 6s), escalates to SIGKILL if needed, and only ever touches processes the app itself spawned. A foreign process that happens to hold the port is left alone.
5. If the app is killed hard (SIGKILL, crash), the orphaned server keeps serving; the next launch detects the recorded pid, verifies its arguments match the resolved `dsh`, terminates it, and starts fresh.
6. A second app instance activates the running one and exits; `LSMultipleInstancesProhibited` backs this up at the Finder level.

## Configuration

Preferences live in the `ai.deepseek.harness` domain (`defaults write ai.deepseek.harness <key> <value>`):

| Key | Default | Meaning |
|---|---|---|
| `port` | `3080` | Port passed to `dsh web` as `--port` |
| `dshPath` | auto | Explicit path to the dsh executable (or its `lib/bin.js`) |
| `nodePath` | auto | Explicit path to the node executable |
| `openBrowserOnLaunch` | `NO` | Additionally open the system browser when the server is ready (the embedded view always shows) |
| `showStatusBar` | `YES` | Show the 30px status bar (server state + URL) under the web view; the app menu's status-bar item (显示/隐藏状态栏) toggles it |
| `stateDir` | `~/Library/Application Support/DeepSeek Harness` | Where the shell keeps its `server.pid`/`app.pid` lock files |

Example — serve on a different port:

```sh
defaults write ai.deepseek.harness port -int 8080
```

Development override pointing at a repo build (`pnpm run build` first):

```sh
defaults write ai.deepseek.harness dshPath -string "$PWD/apps/cli/lib/bin.js"
defaults write ai.deepseek.harness nodePath -string "$(which node)"
```

## Logs and state

- `~/Library/Logs/DeepSeek Harness/server.log` — the server's stdout/stderr (best-effort)
- `~/Library/Application Support/DeepSeek Harness/` — the `server.pid` and `app.pid` lock files
- `~/.dsh` — the server's own profile, sessions, and settings, untouched by the shell

Uninstall: quit the app, delete it from /Applications, and remove the two directories above plus `~/Library/Preferences/ai.deepseek.harness.plist`.

## Testing

`apps/macos/scripts/test-lifecycle.sh` launches the app on a test port with a scratch `DSH_HOME` and verifies both phases end to end: graceful quit frees the port and kills the server's process group; a SIGKILL crash leaves an orphaned server that the next launch reclaims.
