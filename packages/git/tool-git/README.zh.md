# @deepseek-ai/dsh-tool-git

[English](README.md) | 中文

基于 git 查询 seam（[`@deepseek-ai/dsh-git`](../git)）的**面向模型的 git 工具**——`git_status`（变更跟踪）、`git_diff`（逐文件 diff 视图）和 `git_log`（提交历史）。这是 git 栈的消费方层：它拥有工具名、JSON schema、会话 cwd 解析、面向模型的渲染、diff 卡片展示和输出上限。它通过 `ctx.git` 提供方约定读取；随附提供方是 [`@deepseek-ai/dsh-git-local`](../git-local)。

每个工具都作用于包含调用方会话工作目录的 git 仓库（`exec.agent.session.header.cwd`，与文件系统和 bash 工具相同），回退到 `process.cwd()`。模型提供的 `path` 针对该目录解析，且必须保持在仓库内部（否则为 `GIT_PATH_NOT_FOUND`）。指向仓库内符号链接的会话 cwd 会在包含关系检查前被规范化，与 git 自身 realpath 解析出的根保持一致。


## 工具

| 工具 | 用途 | 关键参数 |
|---|---|---|
| `git_status` | 跟踪带暂存状态、分支和领先/落后计数的已变更文件。 | `path?` |
| `git_diff` | 查看逐文件 diff：默认是未暂存的 worktree diff，`staged: true` 时是暂存 diff，或使用 `base` 和 `head` 的修订范围（互斥）。 | `path?`、`staged?`、`base?`、`head?`、`unified?` |
| `git_log` | 评审提交历史，从新到旧，覆盖整个仓库或单个路径。 | `count?`（默认 20）、`path?` |

schema 是模型的真源；生成的 [工具目录](../../../docs/tool-catalog.md#deepseek-aidsh-tool-git) 携带确切的 `parameters` 和 `output` 声明。

`git_diff` 返回每个文件的完整前后内容（受下面上限约束）。对模型，它渲染 unified diff（带 `@@` 头与配置上下文的 hunk，`-U<unified>` 风格，新增/删除文件对照 `/dev/null`）；对 UI，它从可回放的结果元数据呈现 [diff 卡片](../../../docs/cookbook/adding-a-tool.md#how-your-tool-renders-in-a-ui)。二进制文件和超过逐文件上限的文件以 `omitted` 原因列出而非内容，截断的文件列表会显式报告。

## 配置

所有键都可选；默认值即随附上限。

| 配置键 | 默认值 | 含义 |
|---|---|---|
| `maxStatusEntries` | `500` | `git_status` 返回的状态条目数的包含性上限；溢出设置 `truncated`。 |
| `maxDiffFiles` | `50` | `git_diff` 返回的文件数的包含性上限；溢出设置 `truncated`。 |
| `maxDiffBytesPerFile` | `262144` | 每个 diff 内容侧的逐文件字节上限；更大的文件以 `too_large` 省略。 |
| `maxDiffTotalBytes` | `4194304` | 返回的 diff 总内容的包含性字节上限。 |
| `diffContext` | `3` | 渲染 diff 中的 unified 上下文行数。 |
| `maxDiffContext` | `20` | 每次调用的 `unified` 值被钳制到此最大值。 |
| `maxLogCount` | `100` | `git_log` 返回的提交数的包含性上限；每次调用的 `count` 被钳制到该值。 |

## 模型体验

### 系统提示词

#### 模型看到的内容

该插件注册范围内的每个请求都会收到下面独立注册的 git 工具指引。作用域化的工具限制可以隐藏 schema，但不会移除本区块。

##### Git 指引

```markdown
Use the git_status tool to list changed files with their staging state, the git_diff tool to view per-file diffs (unstaged by default, staged with staged=true, or a revision range with base and head), and the git_log tool to inspect recent commit history. Prefer these read-only tools over running git through the shell for change tracking and review.
```

#### Token 影响

插件激活期间每个请求有固定的指引成本；工具结果受上面配置上限约束，因此评审读取的是有上限的 diff，而非无界的 transcript（文本记录）。

#### KV Cache 影响

指引区块是稳定的重复前缀，不会使复用失效；工具结果内容随工具读取的仓库状态而变化，与其他工具结果完全一致。

## 已知限制与延期工作

- **按约定只读**：工具绝不暂存、提交或修改仓库；变更在 git seam 的范围之外。
- **`git_diff` 看不到未跟踪文件**：这是 git 自身的语义（见 git-local README）；`git_status` 是处理未跟踪文件的工具。
- **没有逐文件行范围参数**：评审单个 hunk 仍会获取文件的完整前后内容（受 `maxDiffBytesPerFile` 约束）；行级切片被延期。
- **规范化后，路径包含关系检查仅基于字符串**：指向仓库外部的仓库内部符号链接不会被工具跟随（git 自身解析 pathspec），因此精心构造的链接无法通过 `path` 参数逃出仓库。
