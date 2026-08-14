# @deepseek-ai/dsh-git

[English](README.md) | 中文

**抽象的只读 git 查询 seam**（`ctx.git`）：用于变更跟踪和代码评审的提供方无关 `GitService` 约定。它规范化三种仓库查询——worktree 状态、逐文件 diff 和提交历史——使消费方永远无需自行解析 git 输出。该 seam 按约定只读：它不拥有任何变更操作，提供方只实现查询。

本地后端是 [`@deepseek-ai/dsh-git-local`](../git-local)（通过 `ctx.subprocess` 运行 `git` CLI）；面向模型的工具是 [`@deepseek-ai/dsh-tool-git`](../tool-git)。沙箱化、远程或库支持的提供方可以替换 `dsh-git-local`，而无需改动 Service Definition 或工具 schema。


## 服务

`GitService` 扩展 Cordis `Service` 并注册 `ctx.git`。提供方子类实现四个方法：

| 方法 | 返回 | 查询 |
|---|---|---|
| `root(cwd, signal?)` | `GitRepo \| undefined` | 检测包含 `cwd` 的仓库（像 git 一样向上搜索父目录），或返回 `undefined` 表示不在任何仓库内。 |
| `status(request, signal?)` | `GitStatus` | 分支事实（名称、分离头、领先/落后）以及带暂存状态的规范化变更条目。 |
| `diff(request, signal?)` | `GitDiff` | 针对 worktree、索引或修订范围的逐文件前后内容，受请求的上限约束。 |
| `log(request, signal?)` | `GitLog` | 提交按从新到旧排列，最多 `count` 条。 |

每个请求都携带解析后的 `GitRepo` 句柄（`key` 不透明，`root` 是后端的工作目录，`displayRoot` 是面向模型/UI 的路径）。请求还携带提供方必须对完整结果执行的上限：`maxEntries`（status）、`maxFiles`/`maxBytesPerFile`/`maxTotalBytes`（diff）和 `count`（log）。丢弃条目的提供方会设置结果的 `truncated` 标志，而不是静默缩短。

失败会抛出带稳定 `GitErrorCode` 的类型化 `GitError` 值（`GIT_NOT_REPO`、`GIT_PATH_NOT_FOUND`、`GIT_BAD_REVISION`、`GIT_TIMEOUT`、`GIT_ABORTED`、`GIT_IO_ERROR`），因此工具层和重试/UI 层按代码分支，绝不依据消息文本。

词汇位于 [`packages/git/git/src/types.ts`](../../../packages/git/git/src/types.ts)；生成的 `ctx.git` Cordis API 区块在 [git 子系统页面](../../../docs/subsystems/git.md) 上。

## 事件

该 seam 不声明任何事件。它是只读查询约定；未来的变更能力（commit、stage、push）属于拥有自身事件词汇的独立 seam。

## 扩展点

实现 `GitService` 以添加后端。后端必须遵守的约定：

- `root` 检测、`resolve` 风格的身份保持（同一仓库产生相同 `key`），以及与传输方式无关的规范化输出。
- diff 内容两侧是完整文件文本（新增文件 `oldText: null`，删除文件 `newText: null`）。内容无法以文本表示的文件以 `omitted: 'binary'` 报告；超过逐文件上限的文件以 `omitted: 'too_large'` 报告。
- 取消（`AbortSignal`）必须到达进行中的工作；本地后端把调用方的中止映射为 `GIT_ABORTED`，把其 deadline 映射为 `GIT_TIMEOUT`。

## 模型体验

通过 `dsh-tool-git` 间接产生影响；该消费方把仓库查询渲染为有界且保留的工具结果。

#### KV Cache 影响

不会直接使缓存失效；具名消费方负责请求前缀的任何变化。

## 已知限制与延期工作

- **按约定只读**：没有 stage、commit、push、branch 或 stash 操作；变更 seam 将是拥有自身事件的独立能力。
- **完整文件内容，而非 hunk**：diff 结果携带每个文件的完整前后文本；hunk/上下文渲染是工具层的职责（`dsh-tool-git` 为模型和 diff 卡片计算 unified hunk）。
- **没有逐文件陈旧性防护**：该 seam 是快照查询；`root()` 与某个查询之间的并发变更属于调用方的责任。
