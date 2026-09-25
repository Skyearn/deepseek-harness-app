> ## ⚠️ 项目已归档，不再更新
>
> **官方已发布 DeepSeek Harness 桌面版**，本仓库（第三方原生桌面壳）停止开发与维护，不再发布新版本。
>
> 请改用官方渠道：
>
> - 官网 / 桌面版下载：https://www.deepseek.com/harness/
> - 官方仓库：https://github.com/deepseek-ai/deepseek-harness
> - 官方文档：https://deepseek-harness.github.io/deepseek-harness/
>
> 最后发布的版本为 `app-v0.1.7`。已有的 Release 与 asset 保留，但不再提供更新与支持，issue / PR 也不再处理。
>
> 如果你仍在使用本壳：
>
> - 内核更新走 npm `@deepseek-ai/dsh`，不受本仓库归档影响；
> - 本仓库停止发布 prebuilt runtime 后，壳会自动回退到「下载 Node + npm 安装」路径，仍然可用；
> - 建议迁移到官方桌面版，以避免与新内核的兼容性风险。

# DeepSeek Harness Desktop

DeepSeek Harness 桌面壳仓库。

这个仓库不再包含上游 `deepseek-ai/deepseek-harness` 的完整源码，只保留：

- 原生桌面壳（macOS / Windows）
- 壳/内核更新器
- prebuilt dsh runtime 自动发布逻辑

---

## 核心设计：壳与内核解耦

```text
┌─────────────────────────────────────────────┐
│ DeepSeek Harness Shell (这个仓库)             │
│                                             │
│  - 原生窗口 / WKWebView / WebView2            │
│  - 进程生命周期 / 端口管理                    │
│  - 菜单 / 状态栏 / 语言                       │
│  - Core Updater                               │
│      - 下载 prebuilt runtime                  │
│      - 校验 / 解压 / 原子切换                  │
│      - 回退到 Node + npm 安装                  │
└─────────────────────────────────────────────┘
                      │
                      │ 启动
                      v
┌─────────────────────────────────────────────┐
│ DSH Core (Runtime)                          │
│                                             │
│  @deepseek-ai/dsh 本体                       │
│  Node runtime                               │
│  存放在：                                    │
│  macOS:  ~/Library/Application Support/     │
│          DeepSeek Harness/runtime/          │
│  Windows:%LOCALAPPDATA%\\DeepSeek Harness\\  │
│          runtime\\                          │
└─────────────────────────────────────────────┘
```

### 解耦后的更新方式

- **壳（Shell）更新**
  - 需要重新发布 App
  - 由本仓库 `app-v*` Release 提供

- **内核（Core）更新**
  - 不需要重新发布 App
  - 每 6 小时自动检测上游 npm `@deepseek-ai/dsh`
  - 自动构建并发布：
    ```text
    dsh-runtime-<dsh-version>
    ├── dsh-runtime-<dsh-version>-macos-universal.tar.gz
    └── dsh-runtime-<dsh-version>-windows-x64.zip
    ```
  - Shell 下次启动自动下载最新 prebuilt runtime

---

## 仓库结构

```text
deepseek-harness-app/
├── .github/
│   └── workflows/
│       └── app-release.yml          # 构建并发布 shell App
│
├── apps/
│   ├── macos/
│   │   ├── Sources/main.swift       # macOS 壳
│   │   ├── build.sh                 # macOS 构建脚本
│   │   ├── Resources/               # 图标 / Info.plist
│   │   └── scripts/test-lifecycle.sh
│   │
│   ├── windows/
│   │   ├── Sources/Program.cs       # Windows 壳
│   │   ├── build.ps1                # Windows 构建脚本
│   │   ├── Resources/               # 图标 / manifest
│   │   └── scripts/test-lifecycle.ps1
│   │
│   ├── updater/
│   │   └── updater.mjs              # 壳/内核 bootstrap 与更新
│   │
│   ├── version                      # 当前壳版本
│   └── dsh-version                  # 上次 shell release 绑定的 dsh 版本
│
└── README.md
```

Prebuilt runtime 发布在独立仓库：

```text
https://github.com/Skyearn/deepseek-harness-runtime
```

---

## 首次启动流程

```text
启动 Shell
  ↓
本地 runtime 是否完整？
  ├── 是 → 直接启动
  └── 否 → bootstrap
        ↓
查询 dsh-runtime-* Release
  ├── 找到 → 下载 prebuilt runtime
  │        → 下载阶段显示真实百分比
  │        → 解压/安装阶段显示不确定进度
  │        → 启动
  └── 没找到 → 回退
             → 从 nodejs.org 下载 Node
             → 从 npm 安装 @deepseek-ai/dsh
             → 启动
```

---

## Build

macOS：

```sh
apps/macos/build.sh --universal
```

Windows：

```powershell
powershell -ExecutionPolicy Bypass -File apps/windows/build.ps1
```

runtime bundle 构建与发布不在这里，改在独立仓库：

```text
https://github.com/Skyearn/deepseek-harness-runtime
```

---

## Runtime 目录

```text
runtime/
├── node/               # 下载的 Node runtime
├── versions/
│   └── <dsh-version>/
│       ├── node_modules/
│       ├── .complete
├── current             # 当前使用的 dsh 版本
└── npm-install.log     # npm 回退安装日志
```

---

## 防止 prebuilt 错位

- 独立 runtime release 使用 dsh 版本命名
- Shell 启动时优先使用最新 `dsh-runtime-*`
- 如果找不到匹配 prebuilt，自动回退 npm 安装
- 不强制 Shell 与 runtime 版本绑定

