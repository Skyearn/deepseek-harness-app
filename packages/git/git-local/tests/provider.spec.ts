/**
 * Provider tests against the REAL git CLI: a temp repository is built with git
 * itself, and the seam's normalized status/diff/log results are asserted
 * against the on-disk world. These tests pin the porcelain parsing to the
 * installed git's actual output format.
 */

import { execFile } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import LocalGitService from '@deepseek-ai/dsh-git-local'
import { GitRepoKey, GitService } from '@deepseek-ai/dsh-git'
import type { GitRepo } from '@deepseek-ai/dsh-git'

const run = promisify(execFile)
const gitAvailable = await run('git', ['--version']).then(() => true, () => false)

async function git(dir: string, ...args: string[]): Promise<string> {
  const result = await run('git', args, { cwd: dir })
  return result.stdout
}

let ctx: Context | undefined
let repoDir: string | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (repoDir !== undefined) await rm(repoDir, { recursive: true, force: true })
  repoDir = undefined
})

/** Create a temp repository with one committed file and return its realpath root. */
async function makeRepo(seed: Record<string, string> = { 'a.txt': 'one\n' }): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'dsh-git-local-')))
  await git(dir, 'init', '-q', '-b', 'main')
  await git(dir, 'config', 'user.email', 'test@example.com')
  await git(dir, 'config', 'user.name', 'Test User')
  for (const [name, content] of Object.entries(seed)) {
    await writeFile(join(dir, name), content)
  }
  await git(dir, 'add', '-A')
  await git(dir, 'commit', '-q', '-m', 'initial commit')
  return dir
}

async function mount(dir: string): Promise<Context> {
  const context = new Context()
  await context.plugin(LocalSubprocessRuntime)
  await context.plugin(LocalGitService, { cwd: dir })
  ctx = context
  return context
}

describe.skipIf(!gitAvailable)('git-local provider against real git', () => {
  it('resolves the repository root from a subdirectory and undefined outside any repo', async () => {
    const dir = await makeRepo()
    repoDir = dir
    const context = await mount(dir)
    const repo = await context.git.root(dir)
    expect(repo?.root).toBe(dir)
    expect(repo?.displayRoot).toBe(dir)
    expect(repo?.key).toBe(GitRepoKey(dir))

    // The backend default cwd (config.cwd = dir) is the repo itself.
    expect((await context.git.root(undefined))?.root).toBe(dir)
    // A directory outside any repository resolves to undefined.
    const empty = await realpath(await mkdtemp(join(tmpdir(), 'dsh-git-empty-')))
    try {
      expect(await context.git.root(empty)).toBeUndefined()
    } finally {
      await rm(empty, { recursive: true, force: true })
    }
  })

  it('status reports staged, unstaged, renamed, and untracked changes with branch facts', async () => {
    const dir = await makeRepo({ 'a.txt': 'one\n', 'b.txt': 'two\n' })
    repoDir = dir
    await writeFile(join(dir, 'a.txt'), 'one\nchanged\n')
    await git(dir, 'mv', 'b.txt', 'b2.txt')
    await writeFile(join(dir, 'new.txt'), 'fresh\n')
    await git(dir, 'add', 'new.txt')

    const context = await mount(dir)
    const repo = await context.git.root(dir)
    const status = await context.git.status({ repo: repo as GitRepo, maxEntries: 100 })
    expect(status.branch).toBe('main')
    expect(status.detached).toBe(false)
    expect(status.truncated).toBe(false)
    expect(status.entries).toEqual([
      { path: 'a.txt', kind: 'modified', staged: false, unstaged: true },
      { path: 'b2.txt', kind: 'renamed', staged: true, unstaged: false, oldPath: 'b.txt' },
      { path: 'new.txt', kind: 'added', staged: true, unstaged: false },
    ])
  })

  it('status scopes to a path and truncates to maxEntries', async () => {
    const dir = await makeRepo({ 'a.txt': 'one\n', 'b.txt': 'two\n' })
    repoDir = dir
    await writeFile(join(dir, 'a.txt'), 'changed\n')
    await writeFile(join(dir, 'b.txt'), 'changed\n')

    const context = await mount(dir)
    const repo = await context.git.root(dir)
    const scoped = await context.git.status({ repo: repo as GitRepo, path: 'a.txt', maxEntries: 100 })
    expect(scoped.entries.map(entry => entry.path)).toEqual(['a.txt'])

    const truncated = await context.git.status({ repo: repo as GitRepo, maxEntries: 1 })
    expect(truncated.truncated).toBe(true)
    expect(truncated.entries).toHaveLength(1)
  })

  it('status reports ahead/behind against a tracked upstream', async () => {
    const dir = await makeRepo()
    repoDir = dir
    const remote = await mkdtemp(join(tmpdir(), 'dsh-git-remote-'))
    await git(dir, 'remote', 'add', 'origin', remote)
    await run('git', ['init', '-q', '--bare', remote])
    await git(dir, 'push', '-q', '-u', 'origin', 'main')
    await git(dir, 'commit', '-q', '--allow-empty', '-m', 'second')
    try {
      const context = await mount(dir)
      const repo = await context.git.root(dir)
      const status = await context.git.status({ repo: repo as GitRepo, maxEntries: 100 })
      expect(status.ahead).toBe(1)
      expect(status.behind).toBe(0)
    } finally {
      await rm(remote, { recursive: true, force: true })
    }
  })

  it('diff (worktree) returns before/after content for modified and deleted files', async () => {
    const dir = await makeRepo({ 'a.txt': 'one\ntwo\nthree\n', 'gone.txt': 'bye\n' })
    repoDir = dir
    await writeFile(join(dir, 'a.txt'), 'one\nTWO\nthree\n')
    // A plain removal (not `git rm`): the index keeps the file, so the
    // index-vs-worktree diff reports the deletion.
    await rm(join(dir, 'gone.txt'))

    const context = await mount(dir)
    const repo = await context.git.root(dir)
    const diff = await context.git.diff({
      repo: repo as GitRepo,
      mode: { kind: 'worktree' },
      maxFiles: 10,
      maxBytesPerFile: 1024,
      maxTotalBytes: 10 * 1024,
    })
    expect(diff.truncated).toBe(false)
    const byPath = new Map(diff.files.map(file => [file.path, file]))
    const modified = byPath.get('a.txt')
    expect(modified?.kind).toBe('modified')
    expect(modified?.oldText).toBe('one\ntwo\nthree\n')
    expect(modified?.newText).toBe('one\nTWO\nthree\n')
    const deleted = byPath.get('gone.txt')
    expect(deleted?.kind).toBe('deleted')
    expect(deleted?.oldText).toBe('bye\n')
    expect(deleted?.newText).toBeNull()
  })

  it('diff (staged) compares HEAD against the index, including added files', async () => {
    const dir = await makeRepo({ 'a.txt': 'one\n' })
    repoDir = dir
    await writeFile(join(dir, 'a.txt'), 'one\nstaged\n')
    await writeFile(join(dir, 'fresh.txt'), 'hello\n')
    await git(dir, 'add', '-A')

    const context = await mount(dir)
    const repo = await context.git.root(dir)
    const diff = await context.git.diff({
      repo: repo as GitRepo,
      mode: { kind: 'staged' },
      maxFiles: 10,
      maxBytesPerFile: 1024,
      maxTotalBytes: 10 * 1024,
    })
    const byPath = new Map(diff.files.map(file => [file.path, file]))
    expect(byPath.get('a.txt')).toMatchObject({ kind: 'modified', oldText: 'one\n', newText: 'one\nstaged\n' })
    expect(byPath.get('fresh.txt')).toMatchObject({ kind: 'added', oldText: null, newText: 'hello\n' })
  })

  it('diff reports a binary blob committed in the index as binary (blob-side detection)', async () => {
    const dir = await makeRepo({ 'a.txt': 'one\n' })
    repoDir = dir
    await writeFile(join(dir, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02]))
    await git(dir, 'add', 'bin.dat')

    const context = await mount(dir)
    const repo = await context.git.root(dir)
    const diff = await context.git.diff({
      repo: repo as GitRepo,
      mode: { kind: 'staged' },
      maxFiles: 10,
      maxBytesPerFile: 1024,
      maxTotalBytes: 10 * 1024,
    })
    const bin = diff.files.find(file => file.path === 'bin.dat')
    expect(bin?.kind).toBe('added')
    expect(bin?.omitted).toBe('binary')
  })

  it('diff (range) compares two explicit revisions and reports renames', async () => {
    const dir = await makeRepo({ 'old.txt': 'content\n' })
    repoDir = dir
    const base = (await git(dir, 'rev-parse', 'HEAD')).trim()
    await git(dir, 'mv', 'old.txt', 'new.txt')
    await git(dir, 'commit', '-q', '-am', 'rename')
    const head = (await git(dir, 'rev-parse', 'HEAD')).trim()

    const context = await mount(dir)
    const repo = await context.git.root(dir)
    const diff = await context.git.diff({
      repo: repo as GitRepo,
      mode: { kind: 'range', base, head },
      maxFiles: 10,
      maxBytesPerFile: 1024,
      maxTotalBytes: 10 * 1024,
    })
    expect(diff.files).toHaveLength(1)
    expect(diff.files[0]?.kind).toBe('renamed')
    expect(diff.files[0]?.path).toBe('new.txt')
    expect(diff.files[0]?.oldPath).toBe('old.txt')
    expect(diff.files[0]?.oldText).toBe('content\n')
    expect(diff.files[0]?.newText).toBe('content\n')
  })

  it('diff omits binary files and files over the per-file cap, and truncates the file list', async () => {
    const dir = await makeRepo({ 'bin.dat': 'text\n', 'big.txt': 'x'.repeat(200) + '\n', 'other.txt': 'z\n' })
    repoDir = dir
    await writeFile(join(dir, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02, 0x03]))
    await writeFile(join(dir, 'big.txt'), 'y'.repeat(500) + '\n')
    await writeFile(join(dir, 'other.txt'), 'zz\n')

    const context = await mount(dir)
    const repo = await context.git.root(dir)
    const diff = await context.git.diff({
      repo: repo as GitRepo,
      mode: { kind: 'worktree' },
      maxFiles: 2,
      maxBytesPerFile: 100,
      maxTotalBytes: 10 * 1024,
    })
    expect(diff.truncated).toBe(true)
    const byPath = new Map(diff.files.map(file => [file.path, file]))
    expect(byPath.get('bin.dat')?.omitted).toBe('binary')
    expect(byPath.get('big.txt')?.omitted).toBe('too_large')
  })

  it('diff honors the cumulative total byte cap across files', async () => {
    const dir = await makeRepo({ 'a.txt': 'aaaa\n', 'b.txt': 'bbbb\n' })
    repoDir = dir
    await writeFile(join(dir, 'a.txt'), 'AAAA\n')
    await writeFile(join(dir, 'b.txt'), 'BBBB\n')

    const context = await mount(dir)
    const repo = await context.git.root(dir)
    const diff = await context.git.diff({
      repo: repo as GitRepo,
      mode: { kind: 'worktree' },
      maxFiles: 10,
      maxBytesPerFile: 1024,
      maxTotalBytes: 6,
    })
    // The first file consumes 10 bytes (5 + 5), already over the 6-byte budget,
    // so the second file is omitted without content.
    expect(diff.files[0]?.omitted).toBeUndefined()
    expect(diff.files[1]?.omitted).toBe('too_large')
  })

  it('diff returns an empty result for a pathspec matching nothing (git semantics)', async () => {
    const dir = await makeRepo()
    repoDir = dir
    const context = await mount(dir)
    const repo = await context.git.root(dir)
    const diff = await context.git.diff({
      repo: repo as GitRepo,
      mode: { kind: 'worktree' },
      path: 'missing.txt',
      maxFiles: 10,
      maxBytesPerFile: 1024,
      maxTotalBytes: 10 * 1024,
    })
    expect(diff.files).toEqual([])
    expect(diff.truncated).toBe(false)
  })

  it('diff raises GIT_BAD_REVISION for an unknown revision', async () => {
    const dir = await makeRepo()
    repoDir = dir
    const context = await mount(dir)
    const repo = await context.git.root(dir)
    await expect(context.git.diff({
      repo: repo as GitRepo,
      mode: { kind: 'range', base: 'does-not-exist', head: 'HEAD' },
      maxFiles: 10,
      maxBytesPerFile: 1024,
      maxTotalBytes: 10 * 1024,
    })).rejects.toMatchObject({ code: 'GIT_BAD_REVISION' })
  })

  it('log returns commits newest first with authors and bodies, scoped by path', async () => {
    const dir = await makeRepo({ 'a.txt': 'one\n' })
    repoDir = dir
    await writeFile(join(dir, 'a.txt'), 'one\ntwo\n')
    await git(dir, 'commit', '-q', '-am', 'second change')
    await writeFile(join(dir, 'a.txt'), 'one\ntwo\nthree\n')
    await git(dir, 'commit', '-q', '-am', 'third change\n\nwith a body')

    const context = await mount(dir)
    const repo = await context.git.root(dir)
    const log = await context.git.log({ repo: repo as GitRepo, count: 10 })
    expect(log.commits.map(commit => commit.subject)).toEqual(['third change', 'second change', 'initial commit'])
    const latest = log.commits[0]
    expect(latest?.hash).toMatch(/^[0-9a-f]{40}$/)
    expect(latest?.shortHash).toHaveLength(7)
    expect(latest?.authorName).toBe('Test User')
    expect(latest?.authorEmail).toBe('test@example.com')
    expect(latest?.body).toBe('with a body')
    expect(latest?.authorDate).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    const scoped = await context.git.log({ repo: repo as GitRepo, count: 10, path: 'a.txt' })
    expect(scoped.commits).toHaveLength(3)
  })

  it('log caps the commit count', async () => {
    const dir = await makeRepo()
    repoDir = dir
    await git(dir, 'commit', '-q', '--allow-empty', '-m', 'second')
    await git(dir, 'commit', '-q', '--allow-empty', '-m', 'third')
    const context = await mount(dir)
    const repo = await context.git.root(dir)
    const log = await context.git.log({ repo: repo as GitRepo, count: 2 })
    expect(log.commits).toHaveLength(2)
  })

  it('log returns an empty history for a repository with no commits', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-git-local-'))
    repoDir = dir
    await git(dir, 'init', '-q', '-b', 'main')
    await git(dir, 'config', 'user.email', 'test@example.com')
    await git(dir, 'config', 'user.name', 'Test User')
    const context = await mount(dir)
    const repo = await context.git.root(dir)
    const log = await context.git.log({ repo: repo as GitRepo, count: 10 })
    expect(log.commits).toEqual([])
  })

  it('reports GIT_IO_ERROR when the git executable cannot start', async () => {
    const dir = await makeRepo()
    repoDir = dir
    const context = new Context()
    await context.plugin(LocalSubprocessRuntime)
    await context.plugin(LocalGitService, { cwd: dir, gitPath: '/nonexistent/git-binary' })
    ctx = context
    await expect(context.git.root(dir)).rejects.toMatchObject({ code: 'GIT_IO_ERROR' })
  })

  it('reports GIT_TIMEOUT when a command exceeds the configured deadline', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-git-local-'))
    repoDir = dir
    await writeFile(join(dir, 'slow-git'), '#!/bin/sh\nsleep 5\n')
    await run('chmod', ['+x', join(dir, 'slow-git')])
    const context = new Context()
    await context.plugin(LocalSubprocessRuntime)
    await context.plugin(LocalGitService, { cwd: dir, gitPath: join(dir, 'slow-git'), timeoutMs: 200 })
    ctx = context
    await expect(context.git.root(dir)).rejects.toMatchObject({ code: 'GIT_TIMEOUT' })
  })

  it('reports GIT_ABORTED when the caller signal is already aborted', async () => {
    const dir = await makeRepo()
    repoDir = dir
    const context = await mount(dir)
    const repo = await context.git.root(dir)
    await expect(context.git.status({ repo: repo as GitRepo, maxEntries: 10 }, AbortSignal.abort()))
      .rejects.toMatchObject({ code: 'GIT_ABORTED' })
  })

  it('reports GIT_ABORTED when the caller signal aborts mid-run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-git-local-'))
    repoDir = dir
    await writeFile(join(dir, 'slow-git'), '#!/bin/sh\nsleep 5\n')
    await run('chmod', ['+x', join(dir, 'slow-git')])
    const context = new Context()
    await context.plugin(LocalSubprocessRuntime)
    await context.plugin(LocalGitService, { cwd: dir, gitPath: join(dir, 'slow-git'), timeoutMs: 30_000 })
    ctx = context
    const controller = new AbortController()
    setTimeout(() => { controller.abort() }, 150)
    await expect(context.git.root(dir, controller.signal)).rejects.toMatchObject({ code: 'GIT_ABORTED' })
  })

  it('classifies a non-zero exit with empty stderr as GIT_IO_ERROR', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-git-local-'))
    repoDir = dir
    await writeFile(join(dir, 'failing-git'), '#!/bin/sh\nexit 3\n')
    await run('chmod', ['+x', join(dir, 'failing-git')])
    const context = new Context()
    await context.plugin(LocalSubprocessRuntime)
    await context.plugin(LocalGitService, { cwd: dir, gitPath: join(dir, 'failing-git') })
    ctx = context
    await expect(context.git.root(dir)).rejects.toMatchObject({
      code: 'GIT_IO_ERROR',
      message: 'git rev-parse failed',
    })
  })

  it('propagates a non-empty-commit log failure that is not an empty history', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-git-local-'))
    repoDir = dir
    await writeFile(join(dir, 'failing-git'), '#!/bin/sh\nexit 3\n')
    await run('chmod', ['+x', join(dir, 'failing-git')])
    const context = new Context()
    await context.plugin(LocalSubprocessRuntime)
    await context.plugin(LocalGitService, { cwd: dir, gitPath: join(dir, 'failing-git') })
    ctx = context
    // The failure text does not match the "no commits yet" marker, so the
    // error propagates instead of degrading to an empty history.
    await expect(context.git.log({ repo: { key: GitRepoKey(dir), root: dir, displayRoot: dir }, count: 5 }))
      .rejects.toMatchObject({ code: 'GIT_IO_ERROR' })
  })

  it('resolves a relative backend cwd against the process directory', async () => {
    const dir = await makeRepo()
    repoDir = dir
    const context = new Context()
    await context.plugin(LocalSubprocessRuntime)
    await context.plugin(LocalGitService, { cwd: relative(process.cwd(), dir) })
    ctx = context
    expect((await context.git.root(undefined))?.root).toBe(dir)
  })

  it('rejects an empty gitPath at load time', () => {
    // Each validation case needs its own Context: the Service constructor
    // registers `ctx.git` before config validation runs, and direct
    // construction receives a fully-resolved config.
    const full = { gitPath: 'git', cwd: '/tmp', timeoutMs: 30_000, maxOutputBytes: 1 }
    expect(() => new LocalGitService(new Context(), { ...full, gitPath: '  ' })).toThrow(/gitPath/)
    expect(() => new LocalGitService(new Context(), { ...full, timeoutMs: 0 })).toThrow(/timeoutMs/)
    expect(() => new LocalGitService(new Context(), { ...full, timeoutMs: Number.MAX_SAFE_INTEGER })).toThrow(/timeoutMs/)
    expect(() => new LocalGitService(new Context(), { ...full, maxOutputBytes: 0 })).toThrow(/maxOutputBytes/)
  })

  it('binds the mounted service as ctx.git', async () => {
    const dir = await makeRepo()
    repoDir = dir
    const context = await mount(dir)
    expect(context.git).toBeInstanceOf(GitService)
    const repo = await context.git.root(dir)
    expect(repo).toBeDefined()
    // Seam contract: status on an explicit repo handle.
    const status = await context.git.status({ repo: repo as GitRepo, maxEntries: 100 })
    expect(status.repo).toBe(repo)
  })
})
