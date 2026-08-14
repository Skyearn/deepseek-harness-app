/**
 * The git seam contract: `ctx.git` binds the abstract service, requests carry
 * the resolved repo, and the typed error taxonomy routes by code.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import GitService, { GitError, GitRepoKey } from '@deepseek-ai/dsh-git'
import type {
  GitDiff,
  GitDiffRequest,
  GitLog,
  GitLogRequest,
  GitRepo,
  GitStatus,
  GitStatusRequest,
} from '@deepseek-ai/dsh-git'

/** A minimal backend stub proving the seam contract, not a real provider. */
class StubGit extends GitService {
  override async root(cwd: string | undefined): Promise<GitRepo | undefined> {
    return cwd === undefined
      ? undefined
      : { key: GitRepoKey(cwd), root: cwd, displayRoot: cwd }
  }

  override async status(_request: GitStatusRequest): Promise<GitStatus> {
    throw new Error('status not stubbed')
  }

  override async diff(_request: GitDiffRequest): Promise<GitDiff> {
    throw new Error('diff not stubbed')
  }

  override async log(_request: GitLogRequest): Promise<GitLog> {
    throw new Error('log not stubbed')
  }
}

describe('git seam', () => {
  it('binds ctx.git to the mounted service', async () => {
    const ctx = new Context()
    await ctx.plugin(StubGit)
    expect(ctx.git).toBeInstanceOf(GitService)
    await ctx.fiber.dispose()
  })

  it('resolves a repo handle whose key is opaque and branded', async () => {
    const ctx = new Context()
    await ctx.plugin(StubGit)
    const repo = await ctx.git.root('/tmp/example')
    expect(repo).not.toBeUndefined()
    expect(repo?.root).toBe('/tmp/example')
    expect(repo?.displayRoot).toBe('/tmp/example')
    // The key is not a plain string at the type level.
    const key: string = 'anything'
    // @ts-expect-error -- a raw string is not a GitRepoKey
    const _rejected: GitRepoKey = key
    expect(GitRepoKey('/tmp/example')).toBe(repo?.key)
    await ctx.fiber.dispose()
  })

  it('returns undefined for a cwd outside any repository', async () => {
    const ctx = new Context()
    await ctx.plugin(StubGit)
    expect(await ctx.git.root(undefined)).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('GitError carries its stable code and message', () => {
    const error = new GitError('no repository', 'GIT_NOT_REPO', { cause: new Error('root cause') })
    expect(error.code).toBe('GIT_NOT_REPO')
    expect(error.message).toBe('no repository')
    expect(error.cause).toBeInstanceOf(Error)
    expect(error.name).toBe('GitError')
  })
})
