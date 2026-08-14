/**
 * Model-facing commit-history tool: reads recent commits (newest first) for
 * the whole repository or one path, with full hashes, authors, dates, and
 * subjects — the review context for tracking what changed over time.
 * @module @deepseek-ai/dsh-tool-git/log
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GitCommit } from '@deepseek-ai/dsh-git'
import { callCwd, repoRelativePath, requireRepo } from './context.ts'

/** The canonical `git_log` value: commits newest first. */
export interface GitLogValue {
  /** The repository display root the log was read from. */
  repo: string
  /** Commits, newest first. */
  commits: GitCommit[]
}

/**
 * Render one commit in a compact git-style block.
 * @param commit - the commit to render.
 * @returns the rendered lines.
 */
export function renderCommit(commit: GitCommit): string[] {
  const lines = [
    `commit ${commit.hash}`,
    `Author: ${commit.authorName} <${commit.authorEmail}>`,
    `Date:   ${commit.authorDate}`,
    '',
    `    ${commit.subject}`,
  ]
  if (commit.body.length > 0) {
    for (const bodyLine of commit.body.split('\n')) lines.push(`    ${bodyLine}`)
  }
  return lines
}

/**
 * Render the canonical log value as one model-facing text block.
 * @param value - the canonical tool value.
 * @returns the model-facing commit listing.
 */
export function renderGitLog(value: GitLogValue): string {
  const lines: string[] = [`<repo>${value.repo}</repo>`]
  if (value.commits.length === 0) {
    lines.push('<commits>no commits</commits>')
    return lines.join('\n')
  }
  lines.push(`<commits>${value.commits.length} commit(s)</commits>`)
  for (const commit of value.commits) lines.push(...renderCommit(commit), '')
  return lines.join('\n').replace(/\n+$/, '')
}

/** Register the `git_log` tool. */
/** Register the `git_log` tool.
 * @param ctx - the plugin context; registrations are effects scoped to it, and execution uses its `git` service.
 * @param maxCount - inclusive cap on returned commits; per-call `count` is clamped to it.
 */
export function applyGitLogTool(ctx: Context, maxCount: number): void {
  ctx.tools.register(defineTool({
    name: 'git_log',
    description: 'List recent commits of the git repository containing the working directory, newest first. Use it to review what changed over time and to find the revisions a diff range should compare.',
    parameters: {
      count: {
        type: 'number',
        description: 'Maximum number of commits to return; defaults to 20 and is capped by the configured maximum.',
      },
      path: {
        type: 'string',
        description: 'Optional repo path (file or directory) to restrict the history to.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          repo: { type: 'string', required: true },
          commits: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                hash: { type: 'string', required: true },
                shortHash: { type: 'string', required: true },
                authorName: { type: 'string', required: true },
                authorEmail: { type: 'string', required: true },
                authorDate: { type: 'string', required: true },
                subject: { type: 'string', required: true },
                body: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderGitLog(value) }],
    },
    async execute(args: { count?: number; path?: string }, exec) {
      const cwd = callCwd(exec)
      const repo = await requireRepo(ctx, cwd, exec.signal)
      const count = args.count === undefined ? 20 : Math.max(1, Math.min(args.count, maxCount))
      const path = repoRelativePath(repo, cwd, args.path)
      const log = await ctx.git.log({
        repo,
        count,
        ...path !== undefined ? { path } : {},
      }, exec.signal)
      return { repo: repo.displayRoot, commits: log.commits }
    },
    presentCall(): { card: 'generic'; title: string; kind: 'search' } {
      return { card: 'generic', title: 'Git log', kind: 'search' }
    },
  }))
}
