/**
 * Pure unit tests for the shared tool-layer context helpers: session-cwd
 * resolution and repo-root-relative pathspec conversion.
 */

import { describe, expect, it } from 'vitest'
import { GitRepoKey } from '@deepseek-ai/dsh-git'
import { callCwd, repoRelativePath, sessionCwd } from '../src/context.ts'

const REPO = { key: GitRepoKey('/repo'), root: '/repo', displayRoot: '/repo' }

describe('sessionCwd', () => {
  it('returns the agent session cwd and undefined without an agent', () => {
    expect(sessionCwd({ agent: { session: { header: { cwd: '/workspace' } } } } as never)).toBe('/workspace')
    expect(sessionCwd({} as never)).toBeUndefined()
  })
})

describe('callCwd', () => {
  it('prefers the session cwd and falls back to the process cwd', () => {
    expect(callCwd({ agent: { session: { header: { cwd: '/workspace' } } } } as never)).toBe('/workspace')
    expect(callCwd({} as never)).toBe(process.cwd())
  })
})

describe('repoRelativePath', () => {
  it('converts absolute and session-relative paths into repo-relative pathspecs', () => {
    expect(repoRelativePath(REPO, '/workspace', '/repo/src/a.ts')).toBe('src/a.ts')
    expect(repoRelativePath(REPO, '/repo', 'src/a.ts')).toBe('src/a.ts')
    expect(repoRelativePath(REPO, '/repo/src', 'a.ts')).toBe('src/a.ts')
    expect(repoRelativePath(REPO, '/repo', '.')).toBe('.')
    expect(repoRelativePath(REPO, '/repo', undefined)).toBeUndefined()
  })

  it('rejects paths outside the repository', () => {
    expect(() => repoRelativePath(REPO, '/repo', '..')).toThrow(/outside the repository/)
    expect(() => repoRelativePath(REPO, '/repo', '../elsewhere')).toThrow(/outside the repository/)
    expect(() => repoRelativePath(REPO, '/repo', '/tmp/unrelated')).toThrow(/outside the repository/)
  })
})
