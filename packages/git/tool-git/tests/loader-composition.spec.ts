/**
 * REAL-composition coverage: a test-only cordis.yml booted through the actual
 * Loader proves the shipped plugin composition (subprocess + git seam +
 * git-local provider + tool-git) mounts and runs git tools end to end.
 */

import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import LocalGitService from '@deepseek-ai/dsh-git-local'
import * as ToolGit from '@deepseek-ai/dsh-tool-git'

const run = promisify(execFile)
const gitAvailable = await run('git', ['--version']).then(() => true, () => false)

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/**
 * Build a temp repository and boot a cordis.yml carrying the full git tool
 * stack through the real Loader.
 * @returns the booted context and the repository root.
 */
async function boot(): Promise<{ ctx: Context; repo: string }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-tool-git-loader-'))
  const repo = join(root, 'repo')
  await run('git', ['init', '-q', '-b', 'main', repo])
  await run('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  await run('git', ['config', 'user.name', 'Test User'], { cwd: repo })
  await writeFile(join(repo, 'a.txt'), 'one\n')
  await run('git', ['add', '-A'], { cwd: repo })
  await run('git', ['commit', '-q', '-m', 'initial'], { cwd: repo })

  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-subprocess-local'",
    "- name: '@deepseek-ai/dsh-git-local'",
    "- name: '@deepseek-ai/dsh-tool-git'",
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-subprocess-local', LocalSubprocessRuntime],
    ['@deepseek-ai/dsh-git-local', LocalGitService],
    ['@deepseek-ai/dsh-tool-git', ToolGit],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return { ctx, repo }
}

describe.skipIf(!gitAvailable)('tool-git real Loader composition through cordis.yml', () => {
  it('boots the git stack and runs git_status and git_log end to end', async () => {
    const { ctx, repo } = await boot()
    await writeFile(join(repo, 'a.txt'), 'one\nchanged\n')

    const session = { header: { cwd: repo } }
    const status = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('loader-status'),
      name: 'git_status',
      arguments: {},
      agent: { session } as never,
    })
    expect(status.isError).toBe(false)
    expect(status.value).toMatchObject({ branch: 'main', files: [{ path: 'a.txt', kind: 'modified', staged: false, unstaged: true }] })

    const log = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('loader-log'),
      name: 'git_log',
      arguments: {},
      agent: { session } as never,
    })
    expect(log.isError).toBe(false)
    expect(log.value).toMatchObject({ commits: [{ subject: 'initial' }] })

    // The assembled model-facing prompt carries the git guidance section.
    const schema = ctx.tools.schemas().find(s => s.name === 'git_diff')
    expect(schema?.description).toContain('per-file diff')
  }, 30_000)
})
