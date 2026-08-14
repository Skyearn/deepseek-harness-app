# @deepseek-ai/dsh-tool-git

English | [中文](README.zh.md)

The **model-facing git tools** — `git_status` (change tracking), `git_diff` (per-file diff views), and `git_log` (commit history) — over the git query seam ([`@deepseek-ai/dsh-git`](../git)). This is the consumer layer of the git stack: it owns tool names, JSON schemas, session-cwd resolution, model-facing rendering, the diff-card presentation, and the output caps. It reads through the `ctx.git` provider contract; the shipped provider is [`@deepseek-ai/dsh-git-local`](../git-local).

Each tool operates on the git repository containing the calling session's working directory (`exec.agent.session.header.cwd`, like the filesystem and bash tools), falling back to `process.cwd()`. A model-supplied `path` resolves against that directory and must stay inside the repository (`GIT_PATH_NOT_FOUND` otherwise). A session cwd that is a symlink into the repo is canonicalized before the containment check, matching git's own realpath'd root.


## Tools

| Tool | Purpose | Key arguments |
|---|---|---|
| `git_status` | Track changed files with staging state, branch, and ahead/behind counts. | `path?` |
| `git_diff` | View per-file diffs: the unstaged worktree diff by default, the staged diff with `staged: true`, or a revision range with `base` and `head` (mutually exclusive). | `path?`, `staged?`, `base?`, `head?`, `unified?` |
| `git_log` | Review commit history, newest first, for the whole repo or one path. | `count?` (default 20), `path?` |

Schemas are the source of truth for the model; the generated [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-git) carries the exact `parameters` and `output` declarations.

`git_diff` returns full before/after content per file (bounded by the caps below). For the model it renders a unified diff (hunks with `@@` headers and configured context, `-U<unified>` style, added/deleted files against `/dev/null`); for the UI it presents the [diff card](../../../docs/cookbook/adding-a-tool.md#how-your-tool-renders-in-a-ui) from replayable result metadata. Binary files and files over the per-file cap are listed with an `omitted` reason instead of content, and a truncated file list is reported explicitly.

## Config

All keys are optional; the defaults are the shipped caps.

| Key | Default | Meaning |
|---|---|---|
| `maxStatusEntries` | `500` | Inclusive cap on status entries returned by `git_status`; overflow sets `truncated`. |
| `maxDiffFiles` | `50` | Inclusive cap on files returned by `git_diff`; overflow sets `truncated`. |
| `maxDiffBytesPerFile` | `262144` | Per-file byte cap on each diff content side; larger files are omitted as `too_large`. |
| `maxDiffTotalBytes` | `4194304` | Inclusive byte cap on the total diff content returned. |
| `diffContext` | `3` | Unified context lines in the rendered diff. |
| `maxDiffContext` | `20` | Per-call `unified` values are clamped to this maximum. |
| `maxLogCount` | `100` | Inclusive cap on commits returned by `git_log`; per-call `count` is clamped to it. |

## Model Experience

### System prompt

#### What the model sees

Every request in this plugin's registration scope receives the independently registered git-tool guidance below. Scoped tool restrictions can hide schemas without removing this section.

##### Git guidance

```markdown
Use the git_status tool to list changed files with their staging state, the git_diff tool to view per-file diffs (unstaged by default, staged with staged=true, or a revision range with base and head), and the git_log tool to inspect recent commit history. Prefer these read-only tools over running git through the shell for change tracking and review.
```

#### Token effect

Fixed guidance cost per request while the plugin is active; tool results are bounded by the config caps above, so a review reads a capped diff rather than an unbounded transcript.

#### KV Cache effect

The guidance section is a stable repeated prefix that does not invalidate reuse; tool-result content varies with the repository state the tools read, exactly like other tool results.

## Known Limitations and Deferred Work

- **Read-only by contract** — the tools never stage, commit, or modify the repository; mutation is out of scope for the git seam.
- **Untracked files invisible to `git_diff`** — git's own semantics (see the git-local README); `git_status` is the tool for untracked files.
- **No per-file line-range arguments** — a review of one hunk still fetches the file's full before/after content (bounded by `maxDiffBytesPerFile`); line-level slicing is deferred.
- **Path containment is string-based after canonicalization** — a symlink INSIDE the repo pointing outside is not followed by the tool (git itself resolves the pathspec), so a crafted link cannot escape the repo through a `path` argument.
