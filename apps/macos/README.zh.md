# DeepSeek Harness macOS 应用壳

[English](README.md) | 中文

`apps/macos` 下围绕 `dsh web` 的一个轻量原生 macOS 壳。Web 运行器本身完全不变：应用启动同一个端口上的同一个服务，并打开默认浏览器，与在终端里执行 `dsh web` 完全一致。壳额外提供的是标准 macOS 形态与进程所有权——Dock 图标、窗口，以及有保障的清理：退出应用（Cmd+Q、关闭窗口或收到终止信号）会终止服务端的进程组，并在应用退出前确认端口已释放。

## 环境要求

- macOS 13 或更高
- `node`（22.19+ 或 24+），可在 `/opt/homebrew/bin/node`、`/usr/local/bin/node`、某个 `PATH` 目录或 nvm/asdf/volta/bun 安装中找到
- 已安装的 `dsh`（npm/pnpm 全局，或 npx 缓存），或使用 `--bundle-dsh` 将其内嵌到应用里

## 构建

```sh
apps/macos/build.sh                    # -> apps/macos/build/DeepSeek Harness.app
apps/macos/build.sh --universal        # arm64 + x86_64 universal binary
apps/macos/build.sh --bundle-dsh       # self-contained: embeds @deepseek-ai/dsh
apps/macos/build.sh --install          # copy the finished app into /Applications
apps/macos/build.sh --output-dir /tmp  # place the .app elsewhere
```

构建需要 `swiftc`（Xcode Command Line Tools）。应用图标已提交于 `Resources/AppIcon.icns`，无需图像工具。`--bundle-dsh` 会把 `@deepseek-ai/dsh@${DSH_BUNDLE_VERSION:-latest}` 装进应用；`CODESIGN_IDENTITY` 选择签名身份（默认 ad-hoc `-`）。应用已签名但未做分发公证。

## 发布

`.github/workflows/app-release.yml` 构建各平台应用并挂到 GitHub Release。构建任务在每个拉取请求与 master 推送时作为打包检查运行；发布从 `dsh-v*` 标签挂载产物——标签推送时自动进行，或通过 `workflow_dispatch` 勾选 `publish=true`。发布的应用内嵌精确对应标签版本的 `@deepseek-ai/dsh`，因此该版本必须已发布到 npm；排练构建可勾选 `bundle_dsh=false`。产物为 `DeepSeek-Harness-<版本>-macos-universal.zip`（arm64 + x86_64，ad-hoc 签名）与 `DeepSeek-Harness-<版本>-windows-x64.zip`（见 [apps/windows/README.md](../../windows/README.md)）。macOS 公证分发需要 Developer ID 证书并在构建后执行 `notarytool`/`stapler`；该签名链尚未接入工作流。

`.github/workflows/upstream-sync.yml` 把整条链路自动化：按计划（每 6 小时——改 cron 即可调整）或手动派发时，先把上游 `deepseek-ai/deepseek-harness` 的 master 合并进 fork 的 master 并推送，再向 npm 查询当前 `@deepseek-ai/dsh` 版本；当 fork 还没有该版本的 Release 时，给合并后的代码树打 `dsh-v<版本>` 标签并推送——从而触发上面的构建挂载工作流。上游通过 npm 发布而不是推送标签，因此 npm 是版本信号；某次构建失败导致有标签无 Release 时，下次运行会把标签重建到 HEAD 重试。派发输入 `sync_only` 只合并不动 Release。

## 工作方式

1. 启动时应用解析 `dsh` 与 `node` 可执行文件——`dshPath`/`nodePath` 偏好设置，其次是 `Contents/Resources/dsh` 下的内嵌安装（`--bundle-dsh`），最后是按 PATH 风格的搜索，包括 Homebrew、npm 全局、nvm、asdf、volta、bun 与 `~/.npm/_npx` 缓存。
2. 它以独立进程组的形式把 `dsh web` 作为子进程拉起，服务端输出追加到 `~/Library/Logs/DeepSeek Harness/server.log`。
3. 一旦 `127.0.0.1:<端口>` 接受连接，就用默认浏览器打开服务地址。
4. 退出——Cmd+Q、Quit 菜单项、关闭窗口或 SIGTERM/SIGINT/SIGHUP——会向服务端进程组发送 SIGTERM，等待端口释放（最多 6 秒），必要时升级为 SIGKILL，并且只触碰应用自己拉起的进程。恰好占用该端口的外部进程会被原样保留。
5. 如果应用被强杀（SIGKILL、崩溃），孤儿的服务端会继续服务；下次启动会读取记录的 pid，确认其参数与解析出的 `dsh` 匹配后将其终止，再全新启动。
6. 第二个应用实例会激活已运行的实例并退出；Finder 层面由 `LSMultipleInstancesProhibited` 兜底。

## 配置

偏好设置位于 `ai.deepseek.harness` 域（`defaults write ai.deepseek.harness <键> <值>`）：

| 键 | 默认值 | 含义 |
|---|---|---|
| `port` | `3080` | 以 `--port` 传给 `dsh web` 的端口 |
| `dshPath` | 自动 | dsh 可执行文件（或其 `lib/bin.js`）的显式路径 |
| `nodePath` | 自动 | node 可执行文件的显式路径 |
| `openBrowserOnLaunch` | `YES` | 服务就绪时是否打开默认浏览器 |
| `stateDir` | `~/Library/Application Support/DeepSeek Harness` | 壳存放 `server.pid`/`app.pid` 锁文件的位置 |

示例——换一个端口提供服务：

```sh
defaults write ai.deepseek.harness port -int 8080
```

指向仓库构建的开发覆盖（先 `pnpm run build`）：

```sh
defaults write ai.deepseek.harness dshPath -string "$PWD/apps/cli/lib/bin.js"
defaults write ai.deepseek.harness nodePath -string "$(which node)"
```

## 日志与状态

- `~/Library/Logs/DeepSeek Harness/server.log` —— 服务端的 stdout/stderr（尽力而为）
- `~/Library/Application Support/DeepSeek Harness/` —— `server.pid` 与 `app.pid` 锁文件
- `~/.dsh` —— 服务端自己的 profile、会话与设置，壳不触碰

卸载：退出应用，从 /Applications 删除，再删除上面两个目录以及 `~/Library/Preferences/ai.deepseek.harness.plist`。

## 测试

`apps/macos/scripts/test-lifecycle.sh` 在测试端口上以临时 `DSH_HOME` 启动应用，端到端验证两个阶段：正常退出释放端口并杀掉服务端进程组；SIGKILL 崩溃留下孤儿服务端，由下次启动回收。
