# DeepSeek Harness Windows launcher

English | [中文](README.zh.md)

A thin native Windows wrapper around `dsh web` for `apps/windows`, mirroring the [macOS shell](../macos/README.md). The web runner itself is unchanged: the app starts the same server on the same port and opens your default browser, exactly like launching `dsh web` in a terminal. What the launcher adds is a standard Windows presence and process ownership — a window, a taskbar icon, and guaranteed cleanup: quitting (closing the window or the Quit button) terminates the server's process tree and verifies the port is released before the app exits.

The launcher is a single C# file compiled with the .NET Framework `csc.exe` that ships with Windows, so building it needs no SDK or toolchain beyond Node.js (for the optional bundled `dsh`).

## Requirements

- Windows 10 or newer (the .NET Framework 4.x runtime ships with the OS)
- `node` (22.19+ or 24+), reachable on `PATH` or at `%ProgramFiles%\nodejs`, `%LOCALAPPDATA%\Programs\nodejs`, nvm-windows, Volta, or bun installs
- an installed `dsh` (npm/pnpm global, or an npx cache), or `-BundleDsh` to embed one beside the exe

## Build

```powershell
apps/windows/build.ps1                      # -> apps/windows/build/DeepSeek Harness.exe
apps/windows/build.ps1 -BundleDsh           # self-contained: also installs @deepseek-ai/dsh
apps/windows/build.ps1 -BundleDsh -DshVersion 0.1.0-rc.6
```

`-BundleDsh` installs `@deepseek-ai/dsh@<version>` into `build\dsh` (version from `-DshVersion` or the `DSH_BUNDLE_VERSION` environment variable, default `latest`). The result is a folder with `DeepSeek Harness.exe` and (when bundled) `dsh\` — zip that folder to distribute.

## How it works

1. On launch the app resolves the `dsh` (its `lib/bin.js`) and `node` executables — the `dshPath`/`nodePath` registry values, then a bundled install beside the exe, then a PATH-style search including `%APPDATA%\npm`, Program Files, nvm-windows, Volta, bun, and the npx cache.
2. It spawns `node <dsh> web` as a child process with no console window, appending the server's output to the server log.
3. Once `127.0.0.1:<port>` accepts connections, the default browser opens the served URL.
4. Quitting — closing the window, the Quit button, or the window being closed by `taskkill /PID` (WM_CLOSE) — kills the server's process tree (`taskkill /PID <pid> /T /F`), waits for the port to free (up to 6s), and only ever touches the process tree the app itself spawned. Windows has no SIGTERM, so this is a hard terminate rather than the macOS graceful drain; the port is still released.
5. If the app is killed hard (Task Manager, crash), the orphaned server keeps serving; the next launch detects the recorded pid, verifies its command line matches the resolved `dsh`, terminates it, and starts fresh.
6. A second instance refuses to start (named mutex).

## Configuration

Registry values under `HKCU\Software\DeepSeek Harness` (mirror of the macOS `defaults` domain), overridden by command-line arguments:

| Setting | Registry value / argument | Default | Meaning |
|---|---|---|---|
| `port` | `port` / `-port` | `3080` | Port passed to `dsh web` as `--port` |
| `dshPath` | `dshPath` / `-dshPath` | auto | Explicit path to the dsh `lib/bin.js` |
| `nodePath` | `nodePath` / `-nodePath` | auto | Explicit path to `node.exe` |
| `openBrowserOnLaunch` | `openBrowserOnLaunch` / `-openBrowserOnLaunch` | `1` | Open the default browser when the server is ready |
| `stateDir` | `stateDir` / `-stateDir` | `%LOCALAPPDATA%\DeepSeek Harness` | Where the launcher keeps its `server.pid`/`app.pid` locks and the server log |

Example — serve on a different port:

```powershell
reg add HKCU\Software\DeepSeek Harness /v port /t REG_DWORD /d 8080
```

## Logs and state

- `%LOCALAPPDATA%\DeepSeek Harness\server.log` — the server's stdout/stderr
- `%LOCALAPPDATA%\DeepSeek Harness\server.pid` / `app.pid` — lock files
- `%USERPROFILE%\.dsh` — the server's own profile, sessions, and settings, untouched by the launcher

Uninstall: quit the app, delete the folder, and remove the registry key `HKCU\Software\DeepSeek Harness` plus `%LOCALAPPDATA%\DeepSeek Harness`.

## Testing

`apps/windows/scripts/test-lifecycle.ps1` launches the exe on a test port with a scratch `DSH_HOME` and verifies both phases end to end: graceful quit frees the port and kills the server's process tree; a hard kill leaves an orphaned server that the next launch reclaims.

## Release

Both platforms are built and attached to the same GitHub Release by `.github/workflows/app-release.yml`; the asset is `DeepSeek-Harness-<version>-windows-x64.zip` (the exe plus the bundled `dsh\` folder when released). See [the macOS README](../macos/README.md#release) for the release flow and the automatic upstream sync.
