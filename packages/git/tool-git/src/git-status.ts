/**
 * Model-facing working-tree status tool: lists changed files with their
 * staging state, branch, and ahead/behind counts for code-review change
 * tracking.
 * @module @deepseek-ai/dsh-tool-git/status
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GitStatusEntry } from '@deepseek-ai/dsh-git'
import { callCwd, repoRelativePath, requireRepo } from './context.ts'
import { CHANGE_KIND_ENUM } from './change-kind.ts'

/** The canonical `git_status` value: branch facts plus changed files. */
export interface GitStatusValue {
  /** The repository display root the status was read from. */
  repo: string
  /** Current branch name, or the short HEAD hash when detached. */
  branch: string
  /** Whether HEAD is detached from a branch. */
  detached: boolean
  /** Commits ahead of the upstream, when one is tracked. */
  ahead: number
  /** Commits behind the upstream, when one is tracked. */
  behind: number
  /** Changed paths in git's output order. */
  files: GitStatusEntry[]
  /** Whether entries were dropped after reaching the configured cap. */
  truncated: boolean
}

/**
 * One model-facing status line: kind, path, and staging state.
 * @param entry - the normalized status entry.
 * @returns a single rendered line.
 */
export function renderStatusEntry(entry: GitStatusEntry): string {
  const state = entry.staged && entry.unstaged
    ? 'staged + unstaged'
    : entry.staged
      ? 'staged'
      : entry.unstaged
        ? 'unstaged'
        : ''
  const rename = entry.oldPath !== undefined ? ` (from ${entry.oldPath})` : ''
  return `  ${entry.kind.padEnd(12)} ${entry.path}${rename}${state.length > 0 ? `  [${state}]` : ''}`
}

/**
 * Render the canonical status value as one model-facing text block.
 * @param value - the canonical tool value.
 * @returns the model-facing listing.
 */
export function renderGitStatus(value: GitStatusValue): string {
  const lines: string[] = [`<repo>${value.repo}</repo>`]
  lines.push(`<branch>${value.branch}</branch>`)
  if (value.detached) lines.push('<state>detached HEAD</state>')
  if (value.ahead > 0 || value.behind > 0) {
    lines.push(`<upstream>ahead ${value.ahead}, behind ${value.behind}</upstream>`)
  }
  if (value.files.length === 0) {
    lines.push('<changes>working tree clean</changes>')
  } else {
    lines.push(`<changes>${value.files.length} changed file(s)${value.truncated ? ' (truncated)' : ''}</changes>`)
    for (const entry of value.files) lines.push(renderStatusEntry(entry))
  }
  return lines.join('\n')
}

/** Register the `git_status` tool. */
/** Register the `git_status` tool.
 * @param ctx - the plugin context; registrations are effects scoped to it, and execution uses its `git` service.
 * @param maxEntries - inclusive cap on returned status entries; overflow sets `truncated`.
 */
export function applyGitStatusTool(ctx: Context, maxEntries: number): void {
  ctx.tools.register(defineTool({
    name: 'git_status',
    description: 'List changed files in the git repository containing the working directory, with staging state, branch, and ahead/behind counts. Use it to track changes before reviewing a diff.',
    parameters: {
      path: {
        type: 'string',
        description: 'Optional repo path (file or directory) to restrict the status to.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          repo: { type: 'string', required: true },
          branch: { type: 'string', required: true },
          detached: { type: 'boolean', required: true },
          ahead: { type: 'number', required: true },
          behind: { type: 'number', required: true },
          /* jscpd:ignore-start -- parallel declarative schema boilerplate with the git_diff files array. */
          files: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                kind: { type: 'string', required: true, enum: [...CHANGE_KIND_ENUM] },
                staged: { type: 'boolean', required: true },
                unstaged: { type: 'boolean', required: true },
                oldPath: { type: 'string' },
              },
            },
          },
          /* jscpd:ignore-end */
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderGitStatus(value) }],
    },
    async execute(args: { path?: string }, exec) {
      const cwd = callCwd(exec)
      const repo = await requireRepo(ctx, cwd, exec.signal)
      const path = repoRelativePath(repo, cwd, args.path)
      const status = await ctx.git.status({
        repo,
        ...path !== undefined ? { path } : {},
        maxEntries,
      }, exec.signal)
      return {
        repo: repo.displayRoot,
        branch: status.branch,
        detached: status.detached,
        ahead: status.ahead,
        behind: status.behind,
        files: status.entries,
        truncated: status.truncated,
      }
    },
    presentCall(args): { card: 'generic'; title: string; kind: 'search'; rawInput?: string } {
      return {
        card: 'generic',
        title: 'Git status',
        kind: 'search',
        ...args.path !== undefined ? { rawInput: args.path } : {},
      }
    },
  }))
}
