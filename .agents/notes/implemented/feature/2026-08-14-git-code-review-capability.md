# Agent Note: Git code-review capability — read-only repository queries

Status: implemented

English | [中文](2026-08-14-git-code-review-capability.zh.md)

## Problem

The harness has no first-class repository inspection. A model that wants to review changes runs `git` through the bash tool, which is unbounded (raw terminal output, arbitrary commands, no caps) and unstructured (the model parses porcelain text itself, with no normalized result and no diff view). Code review needs three structured, bounded queries — what changed, how it changed, and what led to it — plus a UI that can render a per-file diff.

## Decision

A new git capability family under `packages/git/` follows the [capability-seam pattern](../../../../docs/capability-seams.md): a Service Definition, a local provider, and a model-facing Consumer, split into three packages because the roles evolve independently.

| Package | Role | ctx key |
|---|---|---|
| `@deepseek-ai/dsh-git` | Read-only `GitService` seam: repo detection, normalized status/diff/log vocabulary, typed `GitError` taxonomy | `ctx.git` |
| `@deepseek-ai/dsh-git-local` | Local backend: runs the `git` CLI through `ctx.subprocess`, parses porcelain v2 / `--name-status -z` / 0x1e-separated log records | (registers `ctx.git`) |
| `@deepseek-ai/dsh-tool-git` | Model tools `git_status` / `git_diff` / `git_log` with unified-diff rendering and the diff card | (registers on `ctx.tools`) |

The seam is read-only by contract: it owns no mutation, so providers implement only the four queries (`root`, `status`, `diff`, `log`). This keeps change tracking and review honest (a reviewer cannot accidentally stage or commit through the review tools) and defers mutation to a future seam with its own events. The normalized vocabulary is deliberately small: `GitChangeKind` collapses git's letter codes, `GitStatusEntry` carries staging state, and `GitDiffFile` carries full before/after text with an `omitted: 'binary' | 'too_large'` marker instead of content. Results are bounded at the seam (entry/file/byte caps in every request, `truncated` flags when the provider drops items) and at the tool (config caps the same way), per the complete-result rule.

The local backend runs every command with a deterministic non-interactive environment (`NO_COLOR`, `GIT_PAGER=cat`, `GIT_TERMINAL_PROMPT=0`, `LC_ALL=C`) and `-c core.quotepath=false`, with a per-command deadline mapping to `GIT_TIMEOUT` and caller cancellation to `GIT_ABORTED`. It parses porcelain v2 (rename entries are destination-first, tab-separated — the reverse of `--short`'s `src -> dst`), `git diff --name-status -z`, and `git log --format` records separated by 0x1e (control characters git forbids in commit messages).

The tools resolve the repository from the calling session's working directory (`exec.agent.session.header.cwd`, like the filesystem and bash tools), canonicalize a symlinked session cwd before the containment check (git's `rev-parse --show-toplevel` always returns a realpath), and convert model paths to repo-root-relative pathspecs, rejecting paths outside the repository with `GIT_PATH_NOT_FOUND`. `git_diff` returns full before/after content per file, renders a unified diff for the model (`-U<unified>`, added/deleted files against `/dev/null`), and presents the diff card from replayable result metadata; `git_status` and `git_log` present generic cards.

## Testing

The parser tests pin the porcelain formats with fixtures captured from real git, and the provider and tool tests build real temp repositories with the `git` CLI (a `slow-git` and a `failing-git` shim cover the timeout, abort, and empty-stderr classification paths). The tool suite covers the registry path (`ctx.tools.execute` with a session cwd), presentation, HMR-safe disposal, and a Loader composition test that boots a test-only `cordis.yml` through the real Loader. Packages meet the per-file 100% coverage gate.

## Alternatives considered

- **One `tool-git` package without a seam** — rejected: a second backend (remote API, library-backed, sandboxed) would then fork the tool layer's parsing, and the capability-seam rule requires the split when roles evolve independently.
- **Run git through `dsh-tool-bash`** — rejected: unbounded output, no normalized result, no diff card, and no provider seam to swap; the whole point of the capability is structure and bounds.
- **Full mutation surface (stage/commit/push) in the same seam** — rejected: mutation needs its own event vocabulary, approval policy, and error taxonomy; read-only keeps the first delivery review-focused and honest.
- **Raw git output in the canonical value** — rejected: the model-facing contract should be the normalized vocabulary; the tool layer renders the unified diff from the canonical before/after content.
- **`git diff --no-index`-style hunk output instead of full file text** — rejected: the diff card renders full old/new sides, and full text is the honest programmatic API; the model's unified diff is reconstructed by the tool with the same `diff` library `dsh-tool-fs` uses.

## Consequences

Buying: structured, bounded, provider-neutral repository queries; a diff card for the GUI; no new session events (the tools' results ride the existing `tool/call` / `tool/result` events); the harness's first capability whose local provider is an external CLI behind a clean seam, mirroring how `dsh-lsp` abstracts a language server.

Costing: the seam is read-only, so review cannot mutate state through it; worktree diffs exclude untracked files (git's own semantics — `git_status` reports them); a tab inside a rename path breaks porcelain v2's tab-separated rename record; bare repositories are unsupported by the local backend; the `git` CLI must be present in the execution world.
