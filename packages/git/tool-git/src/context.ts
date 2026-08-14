/**
 * Shared tool-layer helpers for the git tool suite: resolving the calling
 * session's working directory, detecting the repository above it, and
 * converting a model-supplied path into a repo-root-relative pathspec.
 * @module @deepseek-ai/dsh-tool-git/context
 */

import { realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { GitError } from '@deepseek-ai/dsh-git'
import type { GitRepo } from '@deepseek-ai/dsh-git'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'

/**
 * The calling agent's per-session workspace, mirroring how the filesystem and
 * bash tools default their working directory to the session cwd.
 * @param exec - the tool-execution context; only its optional `agent` is read.
 * @returns the calling agent's session cwd, or undefined for a non-agent caller.
 */
export function sessionCwd(exec: ToolExecution): string | undefined {
  return exec.agent?.session.header.cwd
}

/**
 * The working directory this call runs git in: the session cwd when present,
 * else the process cwd (which is also the git-local backend's config default).
 * @param exec - the tool-execution context supplying the session cwd.
 * @returns the explicit working directory for this call.
 */
export function callCwd(exec: ToolExecution): string {
  return sessionCwd(exec) ?? process.cwd()
}

/**
 * Resolve the repository containing the call's working directory, raising
 * `GIT_NOT_REPO` when none exists.
 * @param ctx - the plugin context whose `git` seam resolves the repository.
 * @param cwd - the working directory to search from.
 * @param signal - aborts repository detection.
 * @returns the resolved repository.
 */
export async function requireRepo(ctx: Context, cwd: string, signal?: AbortSignal): Promise<GitRepo> {
  const repo = await ctx.git.root(cwd, signal)
  if (repo === undefined) {
    throw new GitError(`no git repository found at or above ${cwd}`, 'GIT_NOT_REPO')
  }
  return repo
}

/**
 * Canonicalize the call's working directory so a symlinked session cwd (for
 * example `/var` → `/private/var` on macOS) compares cleanly against the
 * repository root git resolves (which is always realpath'd).
 * @param cwd - the call's working directory.
 * @returns the realpath'd cwd, or the raw value when it no longer exists.
 */
function canonicalCwd(cwd: string): string {
  try {
    return realpathSync(cwd)
  } catch {
    /* the cwd vanished after the call started; the raw value keeps conversion working */
    return cwd
  }
}

/**
 * Convert a model-supplied path (resolved against the call's working
 * directory) into a repo-root-relative pathspec for git. `undefined` passes
 * through unchanged (the whole repository).
 * @param repo - the resolved repository.
 * @param cwd - the call's working directory the path resolves against.
 * @param path - the model-supplied path, or undefined for the whole repository.
 * @returns the repo-root-relative pathspec, or undefined for the whole repository.
 */
export function repoRelativePath(repo: GitRepo, cwd: string, path: string | undefined): string | undefined {
  if (path === undefined) return undefined
  const absolute = isAbsolute(path) ? path : resolve(canonicalCwd(cwd), path)
  const rel = relative(repo.root, absolute)
  /* v8 ignore next 2 -- relative() returns an absolute result only across Windows drives. */
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new GitError(`path "${path}" is outside the repository "${repo.displayRoot}"`, 'GIT_PATH_NOT_FOUND')
  }
  return rel === '' ? '.' : rel
}
