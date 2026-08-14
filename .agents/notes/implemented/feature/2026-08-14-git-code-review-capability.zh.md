# Agent Note: Git 代码评审能力——只读仓库查询

Status: implemented

[English](2026-08-14-git-code-review-capability.md) | 中文

## 问题

harness 没有一流的仓库检视能力。想要评审变更的模型会通过 bash 工具运行 `git`，这既无界（原始终端输出、任意命令、没有上限）也无结构（模型自行解析 porcelain 文本，没有规范化结果，也没有 diff 视图）。代码评审需要三种结构化、有界的查询——改了什么、怎么改的、以及什么导致了这些改动——外加一个能渲染逐文件 diff 的 UI。

## 决策

`packages/git/` 下新增的 git 能力族遵循[能力 seam 模式](../../../../docs/capability-seams.md)：一个 Service Definition、一个本地提供方和一个面向模型的消费方，拆分为三个包，因为各角色独立演进。

| 包 | 角色 | ctx 键 |
|---|---|---|
| `@deepseek-ai/dsh-git` | 只读 `GitService` seam：仓库检测、规范化的 status/diff/log 词汇、类型化的 `GitError` 分类体系 | `ctx.git` |
| `@deepseek-ai/dsh-git-local` | 本地后端：通过 `ctx.subprocess` 运行 `git` CLI，解析 porcelain v2 / `--name-status -z` / 0x1e 分隔的 log 记录 | （注册 `ctx.git`） |
| `@deepseek-ai/dsh-tool-git` | 模型工具 `git_status` / `git_diff` / `git_log`，带 unified-diff 渲染和 diff 卡片 | （注册到 `ctx.tools`） |

该 seam 按约定只读：它不拥有任何变更操作，因此提供方只实现四个查询（`root`、`status`、`diff`、`log`）。这使变更跟踪和评审保持诚实（评审者无法通过评审工具意外暂存或提交），并把变更推迟到拥有自身事件的未来 seam。规范化词汇刻意保持精简：`GitChangeKind` 折叠 git 的字母代码，`GitStatusEntry` 携带暂存状态，`GitDiffFile` 携带完整的前后文本和 `omitted: 'binary' | 'too_large'` 标记而非内容。结果在 seam 上有界（每个请求都有条目/文件/字节上限，提供方丢弃条目时设置 `truncated` 标志），在工具上也有界（配置以同样方式设上限），遵循完整结果规则。

本地后端在确定性非交互环境（`NO_COLOR`、`GIT_PAGER=cat`、`GIT_TERMINAL_PROMPT=0`、`LC_ALL=C`）中运行每条命令，并加 `-c core.quotepath=false`；每条命令的 deadline 映射为 `GIT_TIMEOUT`，调用方取消映射为 `GIT_ABORTED`。它解析 porcelain v2（重命名条目是目标在前、制表符分隔——与 `--short` 的 `src -> dst` 相反）、`git diff --name-status -z`，以及以 0x1e 分隔的 `git log --format` 记录（git 禁止出现在提交消息中的控制字符）。

工具从调用方会话的工作目录解析仓库（`exec.agent.session.header.cwd`，与文件系统和 bash 工具相同），在包含关系检查前规范化符号链接的会话 cwd（git 的 `rev-parse --show-toplevel` 总是返回 realpath），并把模型路径转换为仓库根相对的 pathspec，以 `GIT_PATH_NOT_FOUND` 拒绝仓库之外的路径。`git_diff` 返回每个文件的完整前后内容，为模型渲染 unified diff（`-U<unified>`，新增/删除文件对照 `/dev/null`），并从可回放的结果元数据呈现 diff 卡片；`git_status` 和 `git_log` 呈现 generic 卡片。

## 测试

解析器测试用从真实 git 捕获的 fixture（测试前置数据）固定 porcelain 格式，提供方和工具测试用 `git` CLI 构建真实临时仓库（`slow-git` 和 `failing-git` shim 覆盖超时、中止和空 stderr 分类路径）。工具套件覆盖注册表路径（带会话 cwd 的 `ctx.tools.execute`）、展示、HMR（热模块替换）安全的 dispose（资源释放），以及一个通过真实 Loader 启动仅测试用 `cordis.yml` 的 Loader 组合测试。各包满足逐文件 100% 覆盖率门禁。

## 曾考虑的替代方案

- **一个不带 seam 的 `tool-git` 包**：否决。第二个后端（远程 API、库支持、沙箱化）届时会分叉工具层的解析，而能力 seam 规则要求角色独立演进时拆分。
- **通过 `dsh-tool-bash` 运行 git**：否决。无界输出、没有规范化结果、没有 diff 卡片、也没有可供替换的提供方 seam；该能力的全部意义就在于结构和边界。
- **同一 seam 中的完整变更面（stage/commit/push）**：否决。变更需要自己的事件词汇、审批策略和错误分类体系；只读使首次交付聚焦于评审并保持诚实。
- **规范值中使用原始 git 输出**：否决。面向模型的约定应当是规范化词汇；工具层从规范的前后内容渲染 unified diff。
- **`git diff --no-index` 风格的 hunk 输出，而非完整文件文本**：否决。diff 卡片渲染完整的旧/新两侧，完整文本是诚实的编程 API；模型的 unified diff 由工具用 `dsh-tool-fs` 所用的同一个 `diff` 库重建。

## 后果

收益：结构化、有界、提供方无关的仓库查询；GUI 的 diff 卡片；没有新的会话事件（工具结果搭载在现有的 `tool/call` / `tool/result` 事件上）；这是 harness 的首个能力——其本地提供方是干净 seam 背后的外部 CLI，镜像 `dsh-lsp` 抽象语言服务器的方式。

代价：该 seam 只读，因此评审无法通过它变更状态；worktree diff 排除未跟踪文件（git 自身语义——`git_status` 会报告它们）；重命名路径中的制表符会破坏 porcelain v2 的制表符分隔重命名记录；本地后端不支持裸仓库；执行世界中必须存在 `git` CLI。
