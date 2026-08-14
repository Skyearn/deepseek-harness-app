# Git

English | [中文](git.zh.md)

The optional git capability is a read-only query seam over one repository, split across three packages: [dsh-git](../../packages/git/git) owns `ctx.git` and the normalized request/result types, [dsh-git-local](../../packages/git/git-local) implements the local backend by running the `git` CLI through `ctx.subprocess`, and [dsh-tool-git](../../packages/git/tool-git) registers the `git_status`/`git_diff`/`git_log` model tools. The seam normalizes three queries — working-tree status, per-file diffs, and commit history — so a consumer never parses git output itself. It exposes no mutation; change tracking and review are read-only by contract.

Provider source: [`packages/git/git/src/types.ts`](../../packages/git/git/src/types.ts) and [`packages/git/git/src/index.ts`](../../packages/git/git/src/index.ts). Local backend source: [`packages/git/git-local/src/index.ts`](../../packages/git/git-local/src/index.ts). Tool source: [`packages/git/tool-git/src/index.ts`](../../packages/git/tool-git/src/index.ts).

## Repository identity (provider contract)

A consumer resolves the repository once with `ctx.git.root(cwd)` — searching parent directories like git itself — and passes the returned `GitRepo` handle to every query. `root` is the directory git commands run in (the backend's execution world); `displayRoot` is the path rendered in model/UI output, and the two may differ for a remote backend. `key` is a branded opaque id; consumers must not parse it or assume it is a local path.

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

## Change tracking (provider contract)

`status` reads the working-tree status of a repository: the current branch (or the short HEAD hash when detached), the ahead/behind counts against a tracked upstream, and one entry per changed path with its staging state. Entries beyond the request's `maxEntries` are dropped with `truncated` set. The change kinds normalize git's status letter codes; status can report every kind, while diff output reports only added, modified, deleted, and renamed.

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

## Per-file diffs (provider contract)

`diff` compares one pair of trees — the index against the working tree (unstaged changes), HEAD against the index (staged changes), or two explicit revisions — and returns per-file before/after content in git's output order. Each content side is bounded by the request: a file over the per-file byte cap or containing binary data is reported without content via `omitted`, and files beyond `maxFiles` are dropped with `truncated` set.

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

## Commit history (provider contract)

`log` reads commit history newest first, at most `count` commits, optionally scoped to a pathspec. A repository with no commits yields an empty history rather than an error.

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

## The local backend (provider)

`dsh-git-local` runs every command through `ctx.subprocess` with a bounded deadline and a deterministic non-interactive environment — no color, no pager, no credential prompt, and a fixed locale — plus `core.quotepath=false` so parsed paths stay raw UTF-8. Repository discovery walks parent directories like git itself. Status parses porcelain v2 output; diff lists changed paths with `--name-status -z` and reads each content side with `git show <rev>:./<path>` (or the worktree file); log parses 0x1e/0x1f-separated records.

## Error taxonomy (provider contract)

Git failures use stable `GitErrorCode` strings carried by `GitError` (`HarnessError`). The tool registry preserves `{ name, code }` on error results, so retry, permission, and UI layers can branch without parsing text.

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

`GIT_NOT_REPO` means the working directory is outside any repository — `root()` maps it to `undefined`, the other queries raise it. `GIT_PATH_NOT_FOUND` means a requested path or pathspec does not resolve inside the repository. `GIT_BAD_REVISION` means a revision name did not resolve; `GIT_TIMEOUT` means a command exceeded the backend deadline; `GIT_ABORTED` means the caller's signal cancelled the command. `GIT_IO_ERROR` covers any other git failure, including the backend failing to start git.

## The service and the plugin

`GitService` (`ctx.git`, abstract) owns `root`, `status`, `diff`, and `log`. `dsh-git-local` provides `LocalGitService`; `dsh-tool-git` is the Consumer — it resolves the repository from the calling session's working directory, runs the three queries through `ctx.git`, and renders results, with `git_diff` presenting the diff card and `git_status`/`git_log` generic cards. The plugin also adds a system-prompt section steering the model to prefer these read-only tools over running git through the shell.

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
