# DeepSeek Harness Windows 启动器

[English](README.md) | 中文

`apps/windows` 下围绕 `dsh web` 的一个轻量原生 Windows 包装，与 [macOS 壳](../macos/README.md) 对应。Web 运行器本身完全不变：应用启动同一个端口上的同一个服务，并打开默认浏览器，与在终端里执行 `dsh web` 完全一致。启动器额外提供的是标准 Windows 形态与进程所有权——窗口、任务栏图标，以及有保障的清理：退出（关闭窗口或 Quit 按钮）会终止服务端的进程树，并在应用退出前确认端口已释放。

启动器是单个 C# 文件，用 Windows 自带的 .NET Framework `csc.exe` 编译，因此构建除了可选的 `dsh` 内嵌所需的 Node.js 外，不需要任何 SDK 或工具链。

## 环境要求

- Windows 10 或更高（.NET Framework 4.x 运行时随系统自带）
- `node`（22.19+ 或 24+），可在 `PATH`、`%ProgramFiles%\nodejs`、`%LOCALAPPDATA%\Programs\nodejs`、nvm-windows、Volta 或 bun 安装中找到
- 已安装的 `dsh`（npm/pnpm 全局，或 npx 缓存），或使用 `-BundleDsh` 将其内嵌到 exe 旁

## 构建

```powershell
apps/windows/build.ps1                      # -> apps/windows/build/DeepSeek Harness.exe
apps/windows/build.ps1 -BundleDsh           # self-contained: also installs @deepseek-ai/dsh
apps/windows/build.ps1 -BundleDsh -DshVersion 0.1.0-rc.6
```

`-BundleDsh` 会把 `@deepseek-ai/dsh@<版本>` 装进 `build\dsh`（版本来自 `-DshVersion` 或 `DSH_BUNDLE_VERSION` 环境变量，默认 `latest`）。产物是一个包含 `DeepSeek Harness.exe` 与（内嵌时）`dsh\` 的文件夹——打包该文件夹即可分发。

## 工作方式

1. 启动时应用解析 `dsh`（其 `lib/bin.js`）与 `node` 可执行文件——`dshPath`/`nodePath` 注册表值，其次是 exe 旁的内嵌安装，最后是按 PATH 风格的搜索，包括 `%APPDATA%\npm`、Program Files、nvm-windows、Volta、bun 与 npx 缓存。
2. 它以无控制台窗口的子进程形式拉起 `node <dsh> web`，服务端输出追加到 server.log。
3. 一旦 `127.0.0.1:<端口>` 接受连接，就用默认浏览器打开服务地址。
4. 退出——关闭窗口、Quit 按钮，或被 `taskkill /PID`（WM_CLOSE）关闭窗口——会杀掉服务端的进程树（`taskkill /PID <pid> /T /F`），等待端口释放（最多 6 秒），并且只触碰应用自己拉起的进程树。Windows 没有 SIGTERM，因此这是硬终止而不是 macOS 的优雅收尾；端口仍然会释放。
5. 如果应用被强杀（任务管理器、崩溃），孤儿的服务端会继续服务；下次启动会读取记录的 pid，确认其命令行与解析出的 `dsh` 匹配后将其终止，再全新启动。
6. 第二个实例拒绝启动（命名互斥体）。

## 配置

`HKCU\Software\DeepSeek Harness` 下的注册表值（对应 macOS 的 `defaults` 域），可用命令行参数覆盖：

| 设置 | 注册表值 / 参数 | 默认值 | 含义 |
|---|---|---|---|
| `port` | `port` / `-port` | `3080` | 以 `--port` 传给 `dsh web` 的端口 |
| `dshPath` | `dshPath` / `-dshPath` | 自动 | dsh `lib/bin.js` 的显式路径 |
| `nodePath` | `nodePath` / `-nodePath` | 自动 | `node.exe` 的显式路径 |
| `openBrowserOnLaunch` | `openBrowserOnLaunch` / `-openBrowserOnLaunch` | `1` | 服务就绪时是否打开默认浏览器 |
| `stateDir` | `stateDir` / `-stateDir` | `%LOCALAPPDATA%\DeepSeek Harness` | 启动器存放 `server.pid`/`app.pid` 锁与 server.log 的位置 |

示例——换一个端口提供服务：

```powershell
reg add HKCU\Software\DeepSeek Harness /v port /t REG_DWORD /d 8080
```

## 日志与状态

- `%LOCALAPPDATA%\DeepSeek Harness\server.log` —— 服务端的 stdout/stderr
- `%LOCALAPPDATA%\DeepSeek Harness\server.pid` / `app.pid` —— 锁文件
- `%USERPROFILE%\.dsh` —— 服务端自己的 profile、会话与设置，启动器不触碰

卸载：退出应用，删除文件夹，并移除注册表键 `HKCU\Software\DeepSeek Harness` 与 `%LOCALAPPDATA%\DeepSeek Harness`。

## 测试

`apps/windows/scripts/test-lifecycle.ps1` 在测试端口上以临时 `DSH_HOME` 启动 exe，端到端验证两个阶段：正常退出释放端口并杀掉服务端进程树；强杀崩溃留下孤儿服务端，由下次启动回收。

## 发布

两个平台由 `.github/workflows/app-release.yml` 构建并挂到同一个 GitHub Release；产物为 `DeepSeek-Harness-<版本>-windows-x64.zip`（发布时包含 exe 与内嵌的 `dsh\` 文件夹）。发布流程与上游自动同步见 [macOS README](../macos/README.md#release)。
