# Git

[English](git.md) | 中文

可选的 git 能力是对单一仓库的只读查询 seam，由三个包组成：[dsh-git](../../packages/git/git) 拥有 `ctx.git` 与规范化的请求/结果类型；[dsh-git-local](../../packages/git/git-local) 通过 `ctx.subprocess` 运行 `git` CLI 实现本地后端；[dsh-tool-git](../../packages/git/tool-git) 注册 `git_status`/`git_diff`/`git_log` 面向模型的工具。seam 将三种查询规范化——worktree 状态、逐文件 diff 与提交历史——因此消费方无需自行解析 git 输出。它不暴露任何变更操作；变更追踪与审阅按约定只读。

提供方源码：[`packages/git/git/src/types.ts`](../../packages/git/git/src/types.ts) 与 [`packages/git/git/src/index.ts`](../../packages/git/git/src/index.ts)。本地后端源码：[`packages/git/git-local/src/index.ts`](../../packages/git/git-local/src/index.ts)。工具源码：[`packages/git/tool-git/src/index.ts`](../../packages/git/tool-git/src/index.ts)。

## 仓库标识（提供方约定）

消费方先用 `ctx.git.root(cwd)` 解析仓库一次——与 git 自身一样向上搜索父目录——再把返回的 `GitRepo` 句柄传给每个查询。`root` 是 git 命令执行所在目录（后端的执行世界）；`displayRoot` 是渲染给模型/UI 输出的路径，两者在远程后端下可能不同。`key` 是品牌化的不透明 id；消费方禁止解析它，也不得假设它是本地路径。

```ts type-equiv
/**
 * Opaque key for one repository identity. The local backend uses the absolute
 * repository root path; a remote backend might use a repo id or URI. Consumers
 * MUST NOT parse it or assume it is a local path.
 */
type GitRepoKey = Branded<'GitRepoKey'>
```

```ts type-equiv
/**
 * A repository resolved by a backend. `root()` produces this; every other
 * operation takes it. `root` is the directory git commands run in (the
 * backend's execution world), `displayRoot` the path rendered in model/UI
 * output — the two may differ for a remote backend.
 */
interface GitRepo {
  /** Opaque key for repository identity and lookup. */
  key: GitRepoKey
  /** Working directory of git commands in the backend's execution world. */
  root: string
  /** Path for model/UI-facing output (the local backend passes `root`). */
  displayRoot: string
}
```

## 变更追踪（提供方约定）

`status` 读取仓库的 worktree 状态：当前分支（分离时为短 HEAD 哈希）、相对受追踪上游的领先/落后提交数，以及每个变更路径及其暂存状态。超过请求 `maxEntries` 的条目被丢弃并置位 `truncated`。变更种类规范化 git 的状态字母码；status 可以报告所有种类，而 diff 输出只报告 added、modified、deleted 与 renamed。

```ts type-equiv
/**
 * Normalized change kind for one path, derived from the git status/diff letter
 * codes. Status can report every kind; diff output reports only added,
 * modified, deleted, and renamed.
 */
type GitChangeKind =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'typechanged'
  | 'unmerged'
  | 'untracked'
```

```ts type-equiv
/** One changed path in the working tree or index, with its staging state. */
interface GitStatusEntry {
  /** Repo-root-relative path of the changed file. */
  path: string
  /** Normalized change kind. */
  kind: GitChangeKind
  /** Whether the change is staged in the index. */
  staged: boolean
  /** Whether the change exists in the worktree but is not staged. */
  unstaged: boolean
  /** Original path for renamed/copied entries; absent for other kinds. */
  oldPath?: string
}
```

```ts type-equiv
/** Working-tree status for one repository. */
interface GitStatus {
  /** The repository the status was read from. */
  repo: GitRepo
  /** Current branch name, or the short HEAD commit hash when detached. */
  branch: string
  /** Whether HEAD is detached from a branch. */
  detached: boolean
  /** Commits the branch is ahead of its upstream, when one is tracked. */
  ahead: number
  /** Commits the branch is behind its upstream, when one is tracked. */
  behind: number
  /** Changed paths, in git's output order. */
  entries: GitStatusEntry[]
  /** Whether entries were dropped after reaching the request's `maxEntries`. */
  truncated: boolean
}
```

## 逐文件 diff（提供方约定）

`diff` 比较两棵树——索引对 worktree（未暂存变更）、HEAD 对索引（已暂存变更），或两个显式修订（`base` 对 `head`）——并按 git 的输出顺序返回逐文件的变更前后内容。每个内容侧都受请求上限约束：超过逐文件字节上限或含二进制数据的文件通过 `omitted` 上报且不带内容，超过 `maxFiles` 的文件被丢弃并置位 `truncated`。

```ts type-equiv
/**
 * What two trees a diff compares. `worktree` compares the index against the
 * working tree (unstaged changes), `staged` compares HEAD against the index,
 * and `range` compares two explicit revisions (`base` against `head`).
 */
type GitDiffMode =
  | { kind: 'worktree' }
  | { kind: 'staged' }
  | { kind: 'range'; base: string; head: string }
```

```ts type-equiv
/** One changed file in a diff, with the full before/after content. */
interface GitDiffFile {
  /** Repo-root-relative path of the changed file (the destination for renames). */
  path: string
  /** Normalized change kind; only added, modified, deleted, or renamed occur. */
  kind: GitChangeKind
  /** Source path for renamed entries; absent for other kinds. */
  oldPath?: string
  /**
   * Full old-side content, or `null` for an added file, a binary file, or a
   * file omitted as too large (see {@link GitDiffFile.omitted}).
   */
  oldText: string | null
  /**
   * Full new-side content, or `null` for a deleted file, a binary file, or a
   * file omitted as too large (see {@link GitDiffFile.omitted}).
   */
  newText: string | null
  /**
   * Why both content sides are absent despite the reported change: a binary
   * file (content is not text) or a file over the request's per-file byte cap.
   */
  omitted?: 'binary' | 'too_large'
}
```

## 提交历史（提供方约定）

`log` 按从新到旧的顺序读取提交历史，最多 `count` 条，可选按 pathspec 限定范围。没有提交的仓库返回空历史而非错误。

```ts type-equiv
/** One commit in a log result. */
interface GitCommit {
  /** Full 40/64-character commit hash. */
  hash: string
  /** Short (7+ character) commit hash. */
  shortHash: string
  /** Author display name. */
  authorName: string
  /** Author email. */
  authorEmail: string
  /** Author date in ISO 8601 (strict) form. */
  authorDate: string
  /** First line of the commit message. */
  subject: string
  /** Remainder of the commit message after the subject, `''` when absent. */
  body: string
}
```

## 本地后端（提供方）

`dsh-git-local` 通过 `ctx.subprocess` 运行每条命令，带有限时截止时间与确定性的非交互环境——无颜色、无分页器、无凭据提示、固定 locale——外加 `core.quotepath=false`，使解析出的路径保持原始 UTF-8。仓库发现与 git 自身一样向上搜索父目录。status 解析 porcelain v2 输出；diff 以 `--name-status -z` 列出变更路径，再用 `git show <rev>:./<path>`（或 worktree 文件）读取每个内容侧；log 解析以 0x1e/0x1f 分隔的记录。

## 错误分类体系（提供方约定）

git 故障使用稳定的 `GitErrorCode` 字符串，由 `GitError`（`HarnessError`）携带。工具注册表在错误结果上保留 `{ name, code }`，使重试、权限与 UI 层可以按 code 分支而无需解析文本。

```ts type-equiv
/**
 * Stable, machine-routable codes for git failures. Carried on {@link GitError};
 * the tool registry exposes `{ name, code }` on `isError` results so
 * retry/permission/UI layers can branch without parsing messages.
 */
type GitErrorCode =
  | 'GIT_NOT_REPO'
  | 'GIT_PATH_NOT_FOUND'
  | 'GIT_BAD_REVISION'
  | 'GIT_TIMEOUT'
  | 'GIT_ABORTED'
  | 'GIT_IO_ERROR'
```

```ts type-equiv
/**
 * Typed git error. Extends {@link HarnessError} so it carries a stable
 * {@link GitErrorCode} and chains `cause`. `dsh-git` owns this vocabulary so
 * backends and the tool layer raise the same codes instead of each inventing
 * message strings.
 */
class GitError extends HarnessError {
  override readonly code: GitErrorCode

  constructor(message: string, code: GitErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.code = code
  }
}
```

`GIT_NOT_REPO` 表示工作目录在任何仓库之外——`root()` 将其转换为 `undefined`，其余查询则抛出它。`GIT_PATH_NOT_FOUND` 表示请求的路径或 pathspec 无法在仓库内解析。`GIT_BAD_REVISION` 表示修订名无法解析；`GIT_TIMEOUT` 表示命令超出后端截止时间；`GIT_ABORTED` 表示调用方的 signal 取消了命令。`GIT_IO_ERROR` 覆盖其余任何 git 故障，包括后端无法启动 git。

## 服务与插件

`GitService`（`ctx.git`，abstract）拥有 `root`、`status`、`diff` 与 `log`。`dsh-git-local` 提供 `LocalGitService`；`dsh-tool-git` 是 Consumer——它从调用会话的工作目录解析仓库，通过 `ctx.git` 执行三种查询并渲染结果，`git_diff` 呈现 diff 卡片，`git_status`/`git_log` 呈现 generic 卡片。该插件还注册一段系统提示词小节，引导模型优先使用这些只读工具而不是通过 shell 运行 git。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxgit--gitservice-abstract-seam"></a>

### `ctx.git` — `GitService` (abstract seam)

Abstract read-only git provider. Consumers resolve the repository once with GitService.root, then run the three normalized queries against the returned GitRepo handle. A backend may be local (the `git` CLI in the same execution world), remote (an API client), or sandboxed; the normalized result vocabulary must not change between them.

```ts cordis-catalog
/**
 * Detect the repository containing `cwd` (searching parent directories, like
 * git itself), or `undefined` when none exists.
 * @param cwd - the directory to search from; `undefined` lets the backend apply its own default.
 * @param signal - aborts the detection round-trip.
 * @returns the resolved repository, or undefined when `cwd` is outside any repository.
 */
abstract root(cwd: string | undefined, signal?: AbortSignal): Promise<GitRepo | undefined>

/**
 * Read the working-tree status of a repository.
 * @param request - the resolved repository, optional pathspec, and the entry cap.
 * @param signal - aborts the read.
 * @returns the branch facts and changed paths, with truncation reported.
 */
abstract status(request: GitStatusRequest, signal?: AbortSignal): Promise<GitStatus>

/**
 * Read a per-file diff between two trees. Content sides are bounded by the
 * request; files over the per-file byte cap or binary are reported without
 * content via {@link GitDiffFile.omitted}, and the file count is capped by
 * `maxFiles` with `truncated` set when more changed files exist.
 * @param request - the resolved repository, the compared trees, the optional pathspec, and the content caps.
 * @param signal - aborts the read.
 * @returns per-file before/after content in git's output order.
 */
abstract diff(request: GitDiffRequest, signal?: AbortSignal): Promise<GitDiff>

/**
 * Read commit history, newest first.
 * @param request - the resolved repository, the commit cap, and the optional pathspec.
 * @param signal - aborts the read.
 * @returns at most `count` commits; empty when the repository has no commits.
 */
abstract log(request: GitLogRequest, signal?: AbortSignal): Promise<GitLog>
```

Source: [`packages/git/git/src/index.ts:56`](../../packages/git/git/src/index.ts)
<!-- END GENERATED cordis-surface -->
