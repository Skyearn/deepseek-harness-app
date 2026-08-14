# @deepseek-ai/dsh-git

English | [中文](README.zh.md)

The **abstract read-only git query seam** (`ctx.git`): a provider-neutral `GitService` contract for change tracking and code review. It normalizes three repository queries — working-tree status, per-file diffs, and commit history — so a consumer never parses git output itself. The seam is read-only by contract: it owns no mutation, and a provider implements only queries.

The local backend is [`@deepseek-ai/dsh-git-local`](../git-local) (runs the `git` CLI through `ctx.subprocess`); the model-facing tools are [`@deepseek-ai/dsh-tool-git`](../tool-git). A sandboxed, remote, or library-backed provider can replace `dsh-git-local` without touching the Service Definition or the tool schemas.


## Service

`GitService` extends the Cordis `Service` and registers `ctx.git`. A provider subclass implements four methods:

| Method | Returns | Query |
|---|---|---|
| `root(cwd, signal?)` | `GitRepo \| undefined` | Detect the repository containing `cwd` (searching parent directories like git), or `undefined` outside any repository. |
| `status(request, signal?)` | `GitStatus` | Branch facts (name, detached, ahead/behind) plus normalized change entries with staging state. |
| `diff(request, signal?)` | `GitDiff` | Per-file before/after content for the worktree, the index, or a revision range, bounded by the request's caps. |
| `log(request, signal?)` | `GitLog` | Commits newest first, at most `count`. |

Every request carries the resolved `GitRepo` handle (`key` opaque, `root` the backend's working directory, `displayRoot` the model/UI-facing path). Requests also carry the caps the provider must enforce on the complete result: `maxEntries` (status), `maxFiles`/`maxBytesPerFile`/`maxTotalBytes` (diff), and `count` (log). A provider that drops items sets the result's `truncated` flag rather than silently shortening.

Failures raise typed `GitError` values with a stable `GitErrorCode` (`GIT_NOT_REPO`, `GIT_PATH_NOT_FOUND`, `GIT_BAD_REVISION`, `GIT_TIMEOUT`, `GIT_ABORTED`, `GIT_IO_ERROR`), so the tool layer and retry/UI layers branch on codes, never message text.

The vocabulary lives in [`packages/git/git/src/types.ts`](../../../packages/git/git/src/types.ts); the generated `ctx.git` Cordis API section is on [the git subsystem page](../../../docs/subsystems/git.md).

## Events

The seam declares no events. It is a read-only query contract; a future mutation capability (commit, stage, push) belongs in a separate seam that owns its own event vocabulary.

## Extension points

Implement `GitService` to add a backend. The contract a backend must honor:

- `root` detection, `resolve`-style identity preservation (the same repository yields the same `key`), and normalized output regardless of transport.
- The diff content sides are full file text (`oldText: null` for added files, `newText: null` for deleted files). A file whose content cannot be represented as text is reported with `omitted: 'binary'`; a file over the per-file cap with `omitted: 'too_large'`.
- Cancellation (`AbortSignal`) must reach in-flight work; the local backend maps a caller abort to `GIT_ABORTED` and its deadline to `GIT_TIMEOUT`.

## Model Experience

Indirectly, through `dsh-tool-git`, which renders repository queries as bounded, retained tool results.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **Read-only by contract** — no stage, commit, push, branch, or stash operations; a mutation seam would be a separate capability with its own events.
- **Full-file content, not hunks** — the diff result carries complete before/after text per file; hunk/context rendering is the tool layer's job (`dsh-tool-git` computes unified hunks for the model and the diff card).
- **No per-file staleness guards** — the seam is a snapshot query; concurrent mutations between `root()` and a query are the caller's concern.
