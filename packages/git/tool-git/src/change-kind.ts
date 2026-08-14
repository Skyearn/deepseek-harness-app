/**
 * Shared JSON-schema enum values for the normalized git change kinds, used by
 * the `git_status` and `git_diff` output schemas so the two tool contracts
 * cannot drift.
 * @module @deepseek-ai/dsh-tool-git/change-kind
 */

/** The model-facing change-kind vocabulary (mirrors `GitChangeKind`). */
export const CHANGE_KIND_ENUM = [
  'added',
  'modified',
  'deleted',
  'renamed',
  'copied',
  'typechanged',
  'unmerged',
  'untracked',
] as const
