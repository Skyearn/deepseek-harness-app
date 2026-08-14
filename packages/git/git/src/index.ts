/**
 * Git Service Definition: a provider-neutral read-only query seam over one
 * repository. Backends own repository discovery, revision resolution, command
 * execution (the local backend runs the `git` CLI through `ctx.subprocess`),
 * and output parsing. The seam normalizes three queries — working-tree status,
 * per-file diffs, and commit history — so a consumer never parses git output
 * itself. The seam exposes no mutation; change tracking and review are
 * read-only by contract.
 * @module @deepseek-ai/dsh-git
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type {
  GitDiff,
  GitDiffRequest,
  GitLog,
  GitLogRequest,
  GitRepo,
  GitStatus,
  GitStatusRequest,
} from './types.ts'

export {
  GitError,
  GitRepoKey,
} from './types.ts'
export type {
  GitChangeKind,
  GitCommit,
  GitDiff,
  GitDiffFile,
  GitDiffMode,
  GitDiffRequest,
  GitErrorCode,
  GitLog,
  GitLogRequest,
  GitRepo,
  GitStatus,
  GitStatusEntry,
  GitStatusRequest,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    git: GitService
  }
}

/**
 * Abstract read-only git provider. Consumers resolve the repository once with
 * {@link GitService.root}, then run the three normalized queries against the
 * returned {@link GitRepo} handle. A backend may be local (the `git` CLI in
 * the same execution world), remote (an API client), or sandboxed; the
 * normalized result vocabulary must not change between them.
 */
export abstract class GitService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'git')
  }

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
}

export default GitService
