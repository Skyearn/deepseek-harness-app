# Agent Note: Web 运行器的 macOS 应用壳

Status: implemented

[English](2026-08-13-macos-app-shell.md) | 中文

## 问题

`dsh web` 是一个在终端里启动的服务器。安装 dsh 之后，Web 运行器需要手动启动，并且只要终端不关就一直服务；它没有标准的 macOS 形态，服务端的生命周期系于终端而不是面向用户的应用。关掉终端可能把进程连同 3080 端口一起留在原地，而且没有任何清理机制。

## 决策

`apps/macos` 提供一个围绕不变的 `dsh web` 运行器的原生 Swift 壳。应用解析 dsh 与 node 可执行文件（偏好设置覆盖，其次内嵌安装，最后按 PATH 风格搜索），通过 posix_spawn 把 `dsh web` 作为独立进程组的子进程拉起，端口接受连接后打开默认浏览器，并拥有服务端的生命周期：每一条退出路径——Cmd+Q、关闭窗口、SIGTERM/SIGINT/SIGHUP——都会终止进程组，先 SIGTERM，等待最多 6 秒让端口释放，再 SIGKILL，并在退出前确认端口已释放。Application Support 下的锁文件记录服务端 pid 与端口。应用被强杀后会留下孤儿服务端；下次启动按记录的 pid 加参数签名检测它、将其终止，再全新启动。第二个应用实例会激活已运行的实例并退出。`build.sh` 负责组装 .app——swiftc 编译、提交的图标、签名——提供 `--bundle-dsh` 生成自包含包（版本由 `DSH_BUNDLE_VERSION` 固定），`--universal` 生成通用二进制；`CODESIGN_IDENTITY` 选择签名身份。`.github/workflows/macos-app-release.yml` 在每个拉取请求与 master 推送时构建通用应用，并把它挂到 `dsh-v*` 标签的 GitHub Release——标签推送时自动进行，或通过 `workflow_dispatch` 勾选 `publish=true`；[apps/macos/README.md](../../../../apps/macos/README.md) 记录了构建、配置、发布与生命周期保证。

## 备选方案

**AppleScript 应用包。** 否决，因为进程组拆除、信号处理与错误呈现在那里都更笨拙，结果也更不像标准的 macOS 应用。

**Electron 或 Tauri 壳。** 否决，因为会附带第二个运行时并重做 UI；这里的本质是本地端口加上既有的浏览器前端，而不是新前端。

**内嵌 WKWebView。** 否决，因为本质被刻意保持不变——本地端口加外部浏览器——而 WebView 会重复前端，还引入 token 与浏览器信任围栏的摩擦。

**把 node 打进应用。** 暂缓，因为体积会翻三倍；应用解析系统 node，`--bundle-dsh` 已经覆盖 dsh 一侧的自包含。

## 后果

只要端口确实由服务端持有，退出应用就一定释放端口；外部监听者绝不会被杀：终止只针对应用自己的进程组，回收时在下任何杀手之前都会重新核对记录 pid 的参数。应用需要 node 与 dsh 在场或内嵌，且目前是 ad-hoc 签名而非公证，对外分发需要正式的签名设置。Web 运行器、profile 与 `~/.dsh` 数据都不受影响——被管理的只有围绕它们的进程组。
