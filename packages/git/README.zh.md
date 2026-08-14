# git/：git 查询能力族

[English](README.md) | 中文

git 栈包括：一个只读的提供方无关查询 seam（仓库检测、worktree 状态、逐文件 diff、提交历史）、一个通过 `ctx.subprocess` 的本地 `git` CLI 实现，以及带 diff 卡片视图的面向模型的变更跟踪工具。全部都是**产品**包。

| 包 | 角色 | ctx 键 |
|---|---|---|
| [`git/`](git/README.md) | Service Definition：规范化的 status/diff/log 词汇、`GitService` 只读查询约定，以及类型化的 `GitError` 分类体系 | `ctx.git` |
| `git-local/` | 本地 `git` CLI 实现：porcelain v2 / name-status / log 解析，带确定性非交互环境和有界 deadline | （注册 `ctx.git`） |
| `tool-git/` | 面向模型的 `git_status`/`git_diff`/`git_log` 工具：会话 cwd 解析、unified-diff 渲染、diff 卡片和输出上限 | （注册到 `ctx.tools`） |

Service Definition 位于 `git/git/`。沙箱化、远程或库支持的 git 后端可以替换 `git-local`，而无需改动 Service Definition 或工具 schema：该 seam 有意只读（变更跟踪与评审），因此提供方只实现四种规范化查询。工具从调用方会话的工作目录解析仓库，绝不通过 `bash` 传递 shell 命令；`git` CLI 是后端的事，隔离在 seam 之后。

子系统参考——目标、状态条目、diff 内容两侧、错误分类体系和只读约定——见 [docs/subsystems/git.md](../../docs/subsystems/git.md)。
