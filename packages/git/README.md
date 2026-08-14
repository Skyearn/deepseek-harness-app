# git/ — git query capability family

English | [中文](README.zh.md)

The git stack: a read-only provider-neutral query seam (repository detection, working-tree status, per-file diffs, commit history), a local `git` CLI implementation through `ctx.subprocess`, and the model-facing change-tracking tools with the diff-card view. All **product** packages.

| Package | Role | ctx key |
|---|---|---|
| [`git/`](git/README.md) | Service Definition: the normalized status/diff/log vocabulary, the `GitService` read-only query contract, and the typed `GitError` taxonomy | `ctx.git` |
| `git-local/` | Local `git` CLI implementation: porcelain v2 / name-status / log parsing with deterministic non-interactive environment and bounded deadlines | (registers `ctx.git`) |
| `tool-git/` | Model-facing `git_status`/`git_diff`/`git_log` tools: session-cwd resolution, unified-diff rendering, the diff card, and the output caps | (registers on `ctx.tools`) |

The Service Definition lives at `git/git/`. A sandboxed, remote, or library-backed git backend can replace `git-local` without touching the Service Definition or the tool schemas: the seam is deliberately read-only (change tracking and review), so providers implement only the four normalized queries. The tools resolve the repository from the calling session's working directory and never pass a shell command through `bash`; the `git` CLI is the backend's concern, isolated behind the seam.

The subsystem reference — targets, status entries, diff content sides, the error taxonomy, and the read-only contract — is [docs/subsystems/git.md](../../docs/subsystems/git.md).
