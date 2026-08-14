/**
 * Vocabulary for the git Service Definition (`ctx.git`): the opaque repository
 * identity, the normalized change kinds and status entries, the diff
 * request/result shapes (per-file before/after content), the commit record,
 * and the typed error taxonomy.
 * @module @deepseek-ai/dsh-git/types
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { Branded } from '@deepseek-ai/dsh-brand'

/**
 * Opaque key for one repository identity. The local backend uses the absolute
 * repository root path; a remote backend might use a repo id or URI. Consumers
 * MUST NOT parse it or assume it is a local path.
 */
export type GitRepoKey = Branded<'GitRepoKey'>

/**
 * Brand a string as a {@link GitRepoKey}. For backend use only — a consumer
 * never manufactures a key, it receives one from `root()`.
 * @param key - the backend's raw key string (the local backend passes the repository root).
 * @returns the same string, branded; no validation is performed.
 */
export function GitRepoKey(key: string): GitRepoKey {
  return key as GitRepoKey
}

/**
 * A repository resolved by a backend. `root()` produces this; every other
 * operation takes it. `root` is the directory git commands run in (the
 * backend's execution world), `displayRoot` the path rendered in model/UI
 * output — the two may differ for a remote backend.
 */
export interface GitRepo {
  /** Opaque key for repository identity and lookup. */
  key: GitRepoKey
  /** Working directory of git commands in the backend's execution world. */
  root: string
  /** Path for model/UI-facing output (the local backend passes `root`). */
  displayRoot: string
}

/**
 * Normalized change kind for one path, derived from the git status/diff letter
 * codes. Status can report every kind; diff output reports only added,
 * modified, deleted, and renamed.
 */
export type GitChangeKind =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'typechanged'
  | 'unmerged'
  | 'untracked'

/** One changed path in the working tree or index, with its staging state. */
export interface GitStatusEntry {
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

/** Working-tree status for one repository. */
export interface GitStatus {
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

/**
 * What two trees a diff compares. `worktree` compares the index against the
 * working tree (unstaged changes), `staged` compares HEAD against the index,
 * and `range` compares two explicit revisions (`base` against `head`).
 */
export type GitDiffMode =
  | { kind: 'worktree' }
  | { kind: 'staged' }
  | { kind: 'range'; base: string; head: string }

/** One changed file in a diff, with the full before/after content. */
export interface GitDiffFile {
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

/** The result of one diff: per-file before/after content, bounded. */
export interface GitDiff {
  /** The repository the diff was read from. */
  repo: GitRepo
  /** Changed files with content, in git's output order. */
  files: GitDiffFile[]
  /** Whether files were dropped after reaching the request's `maxFiles`. */
  truncated: boolean
}

/** One commit in a log result. */
export interface GitCommit {
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

/** One commit-history read: newest first. */
export interface GitLog {
  /** The repository the log was read from. */
  repo: GitRepo
  /** Commits, newest first, at most the request's `count`. */
  commits: GitCommit[]
}

/** The query one {@link GitService.status} call answers. */
export interface GitStatusRequest {
  /** The repository to inspect. */
  repo: GitRepo
  /** Repo-root-relative pathspec scoping the read; omit for the whole tree. */
  path?: string
  /** Inclusive cap on returned entries; overflow sets `truncated`. */
  maxEntries: number
}

/** The query one {@link GitService.diff} call answers. */
export interface GitDiffRequest {
  /** The repository to inspect. */
  repo: GitRepo
  /** Which pair of trees to compare. */
  mode: GitDiffMode
  /** Repo-root-relative pathspec scoping the read; omit for the whole tree. */
  path?: string
  /** Inclusive cap on files returned with content; overflow sets `truncated`. */
  maxFiles: number
  /** Per-file byte cap on each content side; larger files are omitted as `too_large`. */
  maxBytesPerFile: number
  /** Inclusive byte cap on the total returned content; larger results are omitted per file. */
  maxTotalBytes: number
}

/** The query one {@link GitService.log} call answers. */
export interface GitLogRequest {
  /** The repository to inspect. */
  repo: GitRepo
  /** Inclusive cap on returned commits. */
  count: number
  /** Repo-root-relative pathspec scoping the read; omit for the whole history. */
  path?: string
}

/**
 * Stable, machine-routable codes for git failures. Carried on {@link GitError};
 * the tool registry exposes `{ name, code }` on `isError` results so
 * retry/permission/UI layers can branch without parsing messages.
 */
export type GitErrorCode =
  | 'GIT_NOT_REPO'
  | 'GIT_PATH_NOT_FOUND'
  | 'GIT_BAD_REVISION'
  | 'GIT_TIMEOUT'
  | 'GIT_ABORTED'
  | 'GIT_IO_ERROR'

/**
 * Typed git error. Extends {@link HarnessError} so it carries a stable
 * {@link GitErrorCode} and chains `cause`. `dsh-git` owns this vocabulary so
 * backends and the tool layer raise the same codes instead of each inventing
 * message strings.
 */
export class GitError extends HarnessError {
  override readonly code: GitErrorCode

  constructor(message: string, code: GitErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.code = code
  }
}
