/**
 * Model-facing diff tool: per-file before/after content for the worktree,
 * the index, or a revision range, rendered as a unified diff for the model
 * and as the diff card for the UI.
 * @module @deepseek-ai/dsh-tool-git/diff
 */

import { structuredPatch } from 'diff'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { DiffResultView, ToolResult } from '@deepseek-ai/dsh-tools'
import { GitError } from '@deepseek-ai/dsh-git'
import type { GitDiffFile, GitDiffMode } from '@deepseek-ai/dsh-git'
import { callCwd, repoRelativePath, requireRepo } from './context.ts'
import { CHANGE_KIND_ENUM } from './change-kind.ts'

/** The canonical `git_diff` value: per-file before/after content. */
export interface GitDiffValue {
  /** The repository display root the diff was read from. */
  repo: string
  /** Changed files with content, in git's output order. */
  files: GitDiffFile[]
  /** Whether files were dropped after reaching the configured cap. */
  truncated: boolean
}

/** Tool config knobs the diff render needs. */
export interface DiffRenderConfig {
  /** Unified context lines rendered around each hunk. */
  context: number
  /** Per-call `unified` values are clamped to this maximum. */
  maxDiffContext: number
}

/** Tool config knobs the diff fetch needs. */
export interface DiffFetchConfig {
  /** Inclusive cap on files returned with content. */
  maxFiles: number
  /** Per-file byte cap on each content side. */
  maxBytesPerFile: number
  /** Inclusive byte cap on the total returned content. */
  maxTotalBytes: number
}

/**
 * Clamp a per-call unified-context request to the configured maximum.
 * @param unified - the requested context lines, or undefined for the default.
 * @param config - the render config carrying the default and the cap.
 * @returns the effective context lines.
 */
export function clampUnified(unified: number | undefined, config: DiffRenderConfig): number {
  if (unified === undefined) return config.context
  return Math.max(0, Math.min(unified, config.maxDiffContext))
}

/**
 * Render one file's change as a unified diff block (headers plus hunks).
 * Added and deleted files use `/dev/null` on the empty side; binary and
 * oversized files render an omission note instead of content.
 * @param file - the changed file with its content sides.
 * @param context - unified context lines per hunk.
 * @returns the rendered block lines.
 */
export function renderDiffFile(file: GitDiffFile, context: number): string[] {
  const oldHeader = file.oldText === null ? '/dev/null' : `a/${file.oldPath ?? file.path}`
  const newHeader = file.newText === null ? '/dev/null' : `b/${file.path}`
  const lines: string[] = [`diff --git a/${file.oldPath ?? file.path} b/${file.path}`, `--- ${oldHeader}`, `+++ ${newHeader}`]
  if (file.omitted !== undefined) {
    const reason = file.omitted === 'binary' ? 'binary file' : 'file exceeds the size cap'
    lines.push(`<content omitted: ${reason}>`)
    return lines
  }
  const patch = structuredPatch(oldHeader, newHeader, file.oldText ?? '', file.newText ?? '', undefined, undefined, { context })
  for (const hunk of patch.hunks) {
    lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`)
    for (const line of hunk.lines) lines.push(line)
  }
  return lines
}

/**
 * Render the canonical diff value as one model-facing unified-diff text block.
 * @param value - the canonical tool value.
 * @param context - unified context lines per hunk.
 * @returns the model-facing diff text.
 */
export function renderGitDiff(value: GitDiffValue, context: number): string {
  const lines: string[] = [`<repo>${value.repo}</repo>`]
  if (value.files.length === 0 && !value.truncated) {
    lines.push('<diff>no changes</diff>')
    return lines.join('\n')
  }
  lines.push(`<diff>${value.files.length} file(s) changed${value.truncated ? ' (truncated)' : ''}</diff>`)
  for (const file of value.files) {
    lines.push(...renderDiffFile(file, context))
  }
  return lines.join('\n')
}

/** Narrow opaque result metadata to non-empty file diffs for the diff card. */
function diffsFromMeta(meta: unknown): { path: string; oldText: string | null; newText: string }[] | undefined {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  const diffs = (meta as Record<string, unknown>).diffs
  if (!Array.isArray(diffs) || diffs.length === 0) return undefined
  const out: { path: string; oldText: string | null; newText: string }[] = []
  for (const diff of diffs) {
    if (diff === null) return undefined
    if (typeof diff !== 'object') return undefined
    const { path, oldText, newText } = diff as Record<string, unknown>
    if (typeof path !== 'string' || (oldText !== null && typeof oldText !== 'string') || typeof newText !== 'string') {
      return undefined
    }
    out.push({ path, oldText, newText })
  }
  return out
}

/**
 * Map a diff request's arguments onto the seam's diff mode, validating the
 * cross-field rule the schema DSL cannot express: `staged` and a revision
 * range are mutually exclusive, and `base`/`head` must come together.
 * @param args - the schema-validated tool arguments.
 * @returns the normalized diff mode.
 */
export function diffModeOf(args: { staged?: boolean; base?: string; head?: string }): GitDiffMode {
  const hasBase = args.base !== undefined
  const hasHead = args.head !== undefined
  if (hasBase !== hasHead) {
    throw new GitError('git_diff: base and head must be provided together', 'GIT_BAD_REVISION')
  }
  if (args.staged && hasBase) {
    throw new GitError('git_diff: staged and a base/head range are mutually exclusive', 'GIT_BAD_REVISION')
  }
  if (args.staged) return { kind: 'staged' }
  if (args.base !== undefined && args.head !== undefined) return { kind: 'range', base: args.base, head: args.head }
  return { kind: 'worktree' }
}

/** Register the `git_diff` tool. */
/** Register the `git_diff` tool.
 * @param ctx - the plugin context; registrations are effects scoped to it, and execution uses its `git` service.
 * @param config - the render and fetch caps the tool enforces on results.
 */
export function applyGitDiffTool(ctx: Context, config: DiffRenderConfig & DiffFetchConfig): void {
  ctx.tools.register(defineTool({
    name: 'git_diff',
    description: 'Show the per-file diff of the git repository containing the working directory: the unstaged worktree diff by default, the staged diff with staged=true, or a revision range with base and head. Each file carries its full before/after content.',
    parameters: {
      path: {
        type: 'string',
        description: 'Optional repo path (file or directory) to restrict the diff to.',
      },
      staged: {
        type: 'boolean',
        description: 'Diff the staged changes (HEAD vs index) instead of the unstaged worktree changes.',
      },
      base: {
        type: 'string',
        description: 'Start revision of the range to diff; requires head.',
      },
      head: {
        type: 'string',
        description: 'End revision of the range to diff; requires base.',
      },
      unified: {
        type: 'number',
        description: 'Unified context lines rendered around each hunk; defaults to the configured context and is capped by it.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          repo: { type: 'string', required: true },
          /* jscpd:ignore-start -- parallel declarative schema boilerplate with the git_status files array. */
          files: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                kind: { type: 'string', required: true, enum: [...CHANGE_KIND_ENUM] },
                oldPath: { type: 'string' },
                oldText: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
                newText: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
                omitted: { type: 'string', enum: ['binary', 'too_large'] },
              },
            },
          },
          /* jscpd:ignore-end */
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (args, value) => {
        const context = clampUnified(args.unified, config)
        return [{ type: 'text', text: renderGitDiff(value, context) }]
      },
      presentationMeta: (_args, value) => ({
        diffs: value.files
          .filter(file => file.omitted === undefined)
          .map(file => ({
            path: file.path,
            oldText: file.oldText,
            // A deleted file has no new side; the card renders an empty addition.
            newText: file.newText ?? '',
          })),
      }),
    },
    async execute(args: { path?: string; staged?: boolean; base?: string; head?: string }, exec) {
      const cwd = callCwd(exec)
      const repo = await requireRepo(ctx, cwd, exec.signal)
      const path = repoRelativePath(repo, cwd, args.path)
      const diff = await ctx.git.diff({
        repo,
        mode: diffModeOf(args),
        ...path !== undefined ? { path } : {},
        maxFiles: config.maxFiles,
        maxBytesPerFile: config.maxBytesPerFile,
        maxTotalBytes: config.maxTotalBytes,
      }, exec.signal)
      return {
        repo: repo.displayRoot,
        files: diff.files,
        truncated: diff.truncated,
      }
    },
    presentCall(): { card: 'generic'; title: string } {
      // The diff exists only after execution; the pending state stays generic.
      return { card: 'generic', title: 'Git diff' }
    },
    presentResult(_args, result: ToolResult): DiffResultView | undefined {
      if (result.isError) return undefined
      const diffs = diffsFromMeta(result.meta)
      if (diffs === undefined) return undefined
      const count = new Set(diffs.map(diff => diff.path)).size
      return { card: 'diff', title: `Git diff · ${count} file(s)`, diffs }
    },
  }))
}
