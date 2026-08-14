# @deepseek-ai/dsh-git-local

English | [中文](README.zh.md)

The **local-git backend** for the git query seam ([`@deepseek-ai/dsh-git`](../git)): it runs the `git` CLI through `ctx.subprocess` in the host execution world and parses the output into the normalized seam vocabulary. It is the shipped provider for `ctx.git`.

Every command runs with a deterministic, non-interactive environment — `NO_COLOR`, `GIT_PAGER=cat`/`PAGER=cat`, `GIT_TERMINAL_PROMPT=0` (never a credential prompt), and `LC_ALL=C` — plus `-c core.quotepath=false` so parsed paths stay raw UTF-8. Each command has a bounded deadline (`timeoutMs`) and per-stream output caps; a caller `AbortSignal` maps to `GIT_ABORTED`, the deadline to `GIT_TIMEOUT`.


## Config

All keys are optional; the defaults are the shipped values.

| Key | Default | Meaning |
|---|---|---|
| `gitPath` | `'git'` | The git executable; a bare name resolves through PATH. |
| `cwd` | `process.cwd()` | Default working directory for repository discovery when a call supplies none. |
| `timeoutMs` | `30000` | Default per-command deadline in milliseconds. |
| `maxOutputBytes` | `8388608` | Per-stream in-memory output cap in bytes; overflow keeps the tail and sets the result's truncation flag. |

## Parsing

The backend reads three git output formats (each pinned against real git in the provider tests):

- `git status --porcelain=v2 --branch` — branch name/oid, ahead/behind counts, and per-path XY staging state; rename entries carry the destination first, then a tab and the source.
- `git diff --name-status -z` plus per-file `git show <rev>:./<path>` — the changed file list and full before/after content.
- `git log -n <count> --format=…` — records separated by 0x1e, fields by 0x1f (control characters git forbids in commit messages).

## Model Experience

Indirectly, through `dsh-tool-git`, which renders repository queries as bounded, retained tool results.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **Requires a `git` executable** — the CLI is the backend; a missing executable surfaces as `GIT_IO_ERROR`. A library-backed provider (`isomorphic-git`-style) would be a separate package.
- **Bare repositories unsupported** — `rev-parse --show-toplevel` requires a work tree; the backend reports a bare repo as `GIT_IO_ERROR`.
- **Worktree diffs exclude untracked files** — git's own semantics: `git diff` never lists untracked paths, so a new un-staged file is invisible to the diff tools until staged (`git_status` reports it).
- **Tab inside a filename** — a rename whose source or destination path contains a tab byte breaks porcelain v2's tab-separated rename record; pathological and documented.
- **`GIT_DIR` ambient env respected** — the backend merges the deterministic env onto the subprocess service's scrubbed parent base, so an ambient `GIT_DIR` still applies; deployments that must ignore it should clear it at the composition boundary.
