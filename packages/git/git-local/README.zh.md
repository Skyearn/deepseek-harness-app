# @deepseek-ai/dsh-git-local

[English](README.md) | 中文

git 查询 seam 的**本地 git 后端**（[`@deepseek-ai/dsh-git`](../git)）：它在宿主执行世界中通过 `ctx.subprocess` 运行 `git` CLI，并把输出解析为规范化的 seam 词汇。它是 `ctx.git` 的随附提供方。

每条命令都在确定性的非交互环境中运行——`NO_COLOR`、`GIT_PAGER=cat`/`PAGER=cat`、`GIT_TERMINAL_PROMPT=0`（绝不出现凭证提示）和 `LC_ALL=C`——外加 `-c core.quotepath=false`，使解析出的路径保持原始 UTF-8。每条命令都有有界的 deadline（`timeoutMs`）和按流的输出上限；调用方的 `AbortSignal` 映射为 `GIT_ABORTED`，deadline 映射为 `GIT_TIMEOUT`。


## 配置

所有键都可选；默认值即随附值。

| 配置键 | 默认值 | 含义 |
|---|---|---|
| `gitPath` | `'git'` | git 可执行文件；裸名称通过 PATH 解析。 |
| `cwd` | `process.cwd()` | 调用未提供工作目录时，仓库发现的默认工作目录。 |
| `timeoutMs` | `30000` | 每条命令的默认 deadline（毫秒）。 |
| `maxOutputBytes` | `8388608` | 按流的内存输出上限（字节）；溢出保留尾部并设置结果的截断标志。 |

## 解析

后端读取三种 git 输出格式（每一种都在提供方测试中针对真实 git 固定）：

- `git status --porcelain=v2 --branch`：分支名/oid、领先/落后计数，以及逐路径的 XY 暂存状态；重命名条目先携带目标，然后是制表符和源。
- `git diff --name-status -z` 加上逐文件 `git show <rev>:./<path>`：变更文件列表与完整的前后内容。
- `git log -n <count> --format=…`：记录以 0x1e 分隔，字段以 0x1f 分隔（git 禁止出现在提交消息中的控制字符）。

## 模型体验

通过 `dsh-tool-git` 间接产生影响；该消费方把仓库查询渲染为有界且保留的工具结果。

#### KV Cache 影响

不会直接使缓存失效；具名消费方负责请求前缀的任何变化。

## 已知限制与延期工作

- **需要 `git` 可执行文件**：CLI 就是后端；缺少可执行文件会以 `GIT_IO_ERROR` 呈现。库支持的提供方（`isomorphic-git` 风格）将是单独的包。
- **不支持裸仓库**：`rev-parse --show-toplevel` 需要 worktree；后端把裸仓库报告为 `GIT_IO_ERROR`。
- **Worktree diff 排除未跟踪文件**：这是 git 自身的语义：`git diff` 从不列出未跟踪路径，因此新未暂存文件在暂存前对 diff 工具不可见（`git_status` 会报告它）。
- **文件名中的制表符**：源或目标路径包含制表符字节的重命名会破坏 porcelain v2 的制表符分隔重命名记录；这是病态情形，已有文档记录。
- **尊重环境中的 `GIT_DIR`**：后端把确定性环境合并到子进程服务已净化的父进程基础上，因此环境中的 `GIT_DIR` 仍然生效；必须忽略它的部署应在组合边界清除它。
