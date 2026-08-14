/**
 * Model-facing git tools over `ctx.git`: `git_status` (change tracking),
 * `git_diff` (per-file diff views with the diff card), and `git_log` (commit
 * history). This package owns schemas, session-cwd resolution, rendering, and
 * output caps, never a concrete git provider.
 * @module @deepseek-ai/dsh-tool-git
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { applyGitDiffTool } from './git-diff.ts'
import type { DiffFetchConfig, DiffRenderConfig } from './git-diff.ts'
import { applyGitLogTool } from './git-log.ts'
import { applyGitStatusTool } from './git-status.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-git'

/** Services required by the git tool suite. */
export const inject = ['tools', 'git', 'systemPrompt']

/** Default maximum status entries before truncation. */
const DEFAULT_MAX_STATUS_ENTRIES = 500
/** Default maximum files returned by one diff call. */
const DEFAULT_MAX_DIFF_FILES = 50
/** Default per-file content cap in bytes. */
const DEFAULT_MAX_DIFF_BYTES_PER_FILE = 256 * 1024
/** Default total content cap in bytes. */
const DEFAULT_MAX_DIFF_TOTAL_BYTES = 4 * 1024 * 1024
/** Default unified context lines in the rendered diff. */
const DEFAULT_DIFF_CONTEXT = 3
/** Default maximum per-call unified context lines. */
const DEFAULT_MAX_DIFF_CONTEXT = 20
/** Default maximum commits returned by one log call. */
const DEFAULT_MAX_LOG_COUNT = 100

/** Plugin config (all optional — `Config` supplies the defaults). */
export interface Config {
  /** Inclusive cap on status entries returned by `git_status`. */
  maxStatusEntries?: number
  /** Inclusive cap on files returned by `git_diff`. */
  maxDiffFiles?: number
  /** Per-file byte cap on each diff content side. */
  maxDiffBytesPerFile?: number
  /** Inclusive byte cap on the total diff content returned. */
  maxDiffTotalBytes?: number
  /** Unified context lines in the rendered diff. */
  diffContext?: number
  /** Per-call `unified` values are clamped to this maximum. */
  maxDiffContext?: number
  /** Inclusive cap on commits returned by `git_log`. */
  maxLogCount?: number
}

export const Config: z<Config> = z.object({
  maxStatusEntries: z.number().default(DEFAULT_MAX_STATUS_ENTRIES),
  maxDiffFiles: z.number().default(DEFAULT_MAX_DIFF_FILES),
  maxDiffBytesPerFile: z.number().default(DEFAULT_MAX_DIFF_BYTES_PER_FILE),
  maxDiffTotalBytes: z.number().default(DEFAULT_MAX_DIFF_TOTAL_BYTES),
  diffContext: z.number().default(DEFAULT_DIFF_CONTEXT),
  maxDiffContext: z.number().default(DEFAULT_MAX_DIFF_CONTEXT),
  maxLogCount: z.number().default(DEFAULT_MAX_LOG_COUNT),
})

/** The shape after schemastery applied the defaults. */
type ResolvedConfig = Required<Config>

/** Every cap counts items or bytes — a positive integer, or the arithmetic misbehaves silently. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`tool-git: ${name} must be a positive integer`)
  }
}

/** The guidance the model sees alongside the git tools. */
const GIT_SYSTEM_PROMPT = 'Use the git_status tool to list changed files with their staging state, '
  + 'the git_diff tool to view per-file diffs (unstaged by default, staged with staged=true, or a '
  + 'revision range with base and head), and the git_log tool to inspect recent commit history. '
  + 'Prefer these read-only tools over running git through the shell for change tracking and review.'

/** Register the `git_status`/`git_diff`/`git_log` suite. */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  assertPositiveInteger('maxStatusEntries', resolved.maxStatusEntries)
  assertPositiveInteger('maxDiffFiles', resolved.maxDiffFiles)
  assertPositiveInteger('maxDiffBytesPerFile', resolved.maxDiffBytesPerFile)
  assertPositiveInteger('maxDiffTotalBytes', resolved.maxDiffTotalBytes)
  assertPositiveInteger('diffContext', resolved.diffContext)
  assertPositiveInteger('maxDiffContext', resolved.maxDiffContext)
  if (resolved.diffContext > resolved.maxDiffContext) {
    throw new Error(`tool-git: diffContext must not exceed maxDiffContext (${resolved.maxDiffContext})`)
  }
  assertPositiveInteger('maxLogCount', resolved.maxLogCount)

  ctx.systemPrompt.section({
    name: 'tool:git',
    order: 107,
    text: GIT_SYSTEM_PROMPT,
  })

  const renderConfig: DiffRenderConfig = {
    context: resolved.diffContext,
    maxDiffContext: resolved.maxDiffContext,
  }
  const fetchConfig: DiffFetchConfig = {
    maxFiles: resolved.maxDiffFiles,
    maxBytesPerFile: resolved.maxDiffBytesPerFile,
    maxTotalBytes: resolved.maxDiffTotalBytes,
  }
  applyGitStatusTool(ctx, resolved.maxStatusEntries)
  applyGitDiffTool(ctx, { ...renderConfig, ...fetchConfig })
  applyGitLogTool(ctx, resolved.maxLogCount)
}
