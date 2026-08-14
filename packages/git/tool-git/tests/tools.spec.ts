/**
 * Tool-suite tests over the REAL git provider: a temp repository is built with
 * git, the tools execute through the registry, and the canonical values,
 * rendered text, errors, and presentation are asserted.
 */

import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import LocalGitService from '@deepseek-ai/dsh-git-local'
import * as ToolGit from '@deepseek-ai/dsh-tool-git'

const run = promisify(execFile)
const gitAvailable = await run('git', ['--version']).then(() => true, () => false)

const testToolSignal = new AbortController().signal

let dir: string
let ctx: Context
let fiber: Awaited<ReturnType<Context['plugin']>>

afterEach(async () => {
  await fiber.dispose()
  await rm(dir, { recursive: true, force: true })
})

async function git(...args: string[]): Promise<void> {
  await run('git', args, { cwd: dir })
}

/** Build a temp repo and mount the real tool stack with the repo as session cwd. */
async function setup(): Promise<void> {
  dir = await mkdtemp(join(tmpdir(), 'dsh-tool-git-'))
  await git('init', '-q', '-b', 'main')
  await git('config', 'user.email', 'test@example.com')
  await git('config', 'user.name', 'Test User')
  await writeFile(join(dir, 'a.txt'), 'one\ntwo\nthree\n')
  await git('add', '-A')
  await git('commit', '-q', '-m', 'initial commit')

  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalGitService, { cwd: dir })
  fiber = await ctx.plugin(ToolGit)
}

let callCounter = 0
function call(name: string, args: unknown) {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: CallId(`call-${++callCounter}`),
    name,
    arguments: args,
    agent: { session: { header: { cwd: dir } } } as never,
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

describe.skipIf(!gitAvailable)('tool-git against the real provider', () => {
  it('registers git_status, git_diff, and git_log with schemas', async () => {
    await setup()
    const names = ctx.tools.schemas().map(schema => schema.name)
    expect(names).toContain('git_status')
    expect(names).toContain('git_diff')
    expect(names).toContain('git_log')
  })

  it('git_status tracks staged, unstaged, and untracked changes', async () => {
    await setup()
    await writeFile(join(dir, 'a.txt'), 'one\ntwo\nthree\nchanged\n')
    await writeFile(join(dir, 'new.txt'), 'fresh\n')
    await git('add', 'new.txt')

    const result = await call('git_status', {})
    expect(result.isError).toBe(false)
    const value = result.value as { branch: string; files: { path: string; kind: string; staged: boolean; unstaged: boolean }[] }
    expect(value.branch).toBe('main')
    expect(value.files).toEqual([
      { path: 'a.txt', kind: 'modified', staged: false, unstaged: true },
      { path: 'new.txt', kind: 'added', staged: true, unstaged: false },
    ])
    const rendered = text(result)
    expect(rendered).toContain('<branch>main</branch>')
    expect(rendered).toMatch(/modified\s+a\.txt\s+\[unstaged\]/)
    expect(rendered).toMatch(/added\s+new\.txt\s+\[staged\]/)
  })

  it('git_status reports GIT_NOT_REPO outside a repository and scopes by path', async () => {
    await setup()
    const outside = await ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId(`call-${++callCounter}`),
      name: 'git_status',
      arguments: {},
      agent: { session: { header: { cwd: '/tmp' } } } as never,
    })
    expect(outside.isError).toBe(true)
    expect(outside.error).toMatchObject({ info: { code: 'GIT_NOT_REPO' } })
    expect(text(outside)).toContain('no git repository')

    await writeFile(join(dir, 'a.txt'), 'changed\n')
    // A path inside the repo matching nothing is an empty status (git semantics).
    const scoped = await call('git_status', { path: 'missing.txt' })
    expect(scoped.isError).toBe(false)
    expect(scoped.value).toMatchObject({ files: [] })

    // A path outside the repository is rejected by the tool.
    const escaping = await call('git_status', { path: '../outside' })
    expect(escaping.isError).toBe(true)
    expect(escaping.error).toMatchObject({ info: { code: 'GIT_PATH_NOT_FOUND' } })
  })

  it('git_diff returns per-file before/after content and renders a unified diff', async () => {
    await setup()
    await writeFile(join(dir, 'a.txt'), 'one\nTWO\nthree\n')
    const result = await call('git_diff', {})
    expect(result.isError).toBe(false)
    const value = result.value as { files: { path: string; kind: string; oldText: string | null; newText: string | null }[] }
    expect(value.files).toEqual([{ path: 'a.txt', kind: 'modified', oldText: 'one\ntwo\nthree\n', newText: 'one\nTWO\nthree\n' }])
    const rendered = text(result)
    expect(rendered).toContain('diff --git a/a.txt b/a.txt')
    expect(rendered).toContain('-two')
    expect(rendered).toContain('+TWO')
  })

  it('git_diff compares the staged index with staged=true and a range with base/head', async () => {
    await setup()
    await writeFile(join(dir, 'a.txt'), 'one\ntwo\nstaged\n')
    await git('add', 'a.txt')
    const staged = await call('git_diff', { staged: true })
    expect(staged.isError).toBe(false)
    expect((staged.value as { files: { oldText: string | null }[] }).files[0]?.oldText).toBe('one\ntwo\nthree\n')

    const base = (await run('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim()
    await writeFile(join(dir, 'a.txt'), 'one\ntwo\nthree\nfour\n')
    await git('commit', '-q', '-am', 'second')
    const head = (await run('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim()
    const ranged = await call('git_diff', { base, head })
    expect(ranged.isError).toBe(false)
    expect((ranged.value as { files: { newText: string | null }[] }).files[0]?.newText).toBe('one\ntwo\nthree\nfour\n')
  })

  it('git_diff validates the mode cross-fields and unknown revisions', async () => {
    await setup()
    const loneBase = await call('git_diff', { base: 'HEAD' })
    expect(loneBase.isError).toBe(true)
    expect(loneBase.error).toMatchObject({ info: { code: 'GIT_BAD_REVISION' } })
    expect(text(loneBase)).toContain('base and head must be provided together')

    const stagedRange = await call('git_diff', { staged: true, base: 'a', head: 'b' })
    expect(stagedRange.isError).toBe(true)
    expect(stagedRange.error).toMatchObject({ info: { code: 'GIT_BAD_REVISION' } })

    const unknown = await call('git_diff', { base: 'nope', head: 'HEAD' })
    expect(unknown.isError).toBe(true)
    expect(unknown.error).toMatchObject({ info: { code: 'GIT_BAD_REVISION' } })
  })

  it('git_log lists commits newest first and clamps the count', async () => {
    await setup()
    await git('commit', '-q', '--allow-empty', '-m', 'second')
    const result = await call('git_log', { count: 1 })
    expect(result.isError).toBe(false)
    const value = result.value as { commits: { subject: string; authorName: string }[] }
    expect(value.commits).toHaveLength(1)
    expect(value.commits[0]).toMatchObject({ subject: 'second', authorName: 'Test User' })
    expect(text(result)).toContain('commit ')
    expect(text(result)).toContain('second')
  })

  it('git_status and git_log present a generic card; git_diff presents the diff card', async () => {
    await setup()
    const statusView = ctx.tools.get('git_status')?.presentCall?.({ path: 'a.txt' })
    expect(statusView).toEqual({ card: 'generic', title: 'Git status', kind: 'search', rawInput: 'a.txt' })
    expect(ctx.tools.get('git_status')?.presentCall?.({})).toEqual({ card: 'generic', title: 'Git status', kind: 'search' })

    const diffView = ctx.tools.get('git_diff')?.presentCall?.({})
    expect(diffView).toEqual({ card: 'generic', title: 'Git diff' })

    const logView = ctx.tools.get('git_log')?.presentCall?.({})
    expect(logView).toEqual({ card: 'generic', title: 'Git log', kind: 'search' })

    const diffResult = ctx.tools.get('git_diff')?.presentResult?.({}, {
      content: [],
      isError: false,
      meta: { diffs: [{ path: 'a.txt', oldText: 'old\n', newText: 'new\n' }] },
    })
    expect(diffResult).toEqual({
      card: 'diff',
      title: 'Git diff · 1 file(s)',
      diffs: [{ path: 'a.txt', oldText: 'old\n', newText: 'new\n' }],
    })

    // Errors and malformed replay metadata fall back to the generic path.
    expect(ctx.tools.get('git_diff')?.presentResult?.({}, { content: [], isError: true })).toBeUndefined()
    expect(ctx.tools.get('git_diff')?.presentResult?.({}, { content: [], isError: false, meta: 42 })).toBeUndefined()
    expect(ctx.tools.get('git_diff')?.presentResult?.({}, { content: [], isError: false, meta: { diffs: 'nope' } })).toBeUndefined()
    expect(ctx.tools.get('git_diff')?.presentResult?.({}, { content: [], isError: false, meta: { diffs: [42] } })).toBeUndefined()
    expect(ctx.tools.get('git_diff')?.presentResult?.({}, { content: [], isError: false, meta: { diffs: [null] } })).toBeUndefined()
    expect(ctx.tools.get('git_diff')?.presentResult?.({}, {
      content: [],
      isError: false,
      meta: { diffs: [{ path: 5, oldText: null, newText: 'x' }] },
    })).toBeUndefined()
  })

  it('a running git_diff through the registry produces replayable diff meta', async () => {
    await setup()
    await writeFile(join(dir, 'gone.txt'), 'bye\n')
    await git('add', 'gone.txt')
    await git('commit', '-q', '-m', 'add gone')
    await writeFile(join(dir, 'a.txt'), 'one\nTWO\n')
    await rm(join(dir, 'gone.txt')) // an unstaged deletion in the worktree diff
    const result = await call('git_diff', {})
    expect(result.isError).toBe(false)
    expect(result.meta).toEqual({
      diffs: [
        { path: 'a.txt', oldText: 'one\ntwo\nthree\n', newText: 'one\nTWO\n' },
        // A deleted file has no new side; the diff card renders an empty addition.
        { path: 'gone.txt', oldText: 'bye\n', newText: '' },
      ],
    })
  })

  it('git_diff and git_log honor a path scope', async () => {
    await setup()
    await writeFile(join(dir, 'a.txt'), 'one\nTWO\n')
    const diff = await call('git_diff', { path: 'a.txt' })
    expect(diff.isError).toBe(false)
    expect(diff.value).toMatchObject({ files: [{ path: 'a.txt' }] })

    const log = await call('git_log', { path: 'a.txt', count: 5 })
    expect(log.isError).toBe(false)
    expect(log.value).toMatchObject({ commits: [{ subject: 'initial commit' }] })
  })

  it('disposing the tool fiber unregisters the tools (HMR safety)', async () => {
    await setup()
    expect(ctx.tools.get('git_status')).toBeDefined()
    await fiber.dispose()
    expect(ctx.tools.get('git_status')).toBeUndefined()
    expect(ctx.tools.get('git_diff')).toBeUndefined()
    expect(ctx.tools.get('git_log')).toBeUndefined()
    fiber = await ctx.plugin(ToolGit)
  })

  it('rejects invalid config at load time', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-tool-git-'))
    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(LocalGitService, { cwd: dir })
    await expect(ctx.plugin(ToolGit, { maxLogCount: 0 })).rejects.toThrow(/maxLogCount must be a positive integer/)
    await expect(ctx.plugin(ToolGit, { diffContext: 9, maxDiffContext: 3 })).rejects.toThrow(/diffContext must not exceed maxDiffContext/)
    fiber = ctx.fiber
  })
})
