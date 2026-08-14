/**
 * Pure parsers for the git CLI output formats this backend reads: porcelain v2
 * status with branch header, `--name-status -z` diff file lists, and the
 * 0x1e/0x1f-separated log records. Each parser is a total function over its
 * input string and never performs I/O, so the formats are unit-tested with
 * fixtures and pinned against real git in the provider tests.
 * @module @deepseek-ai/dsh-git-local/parse
 */

import type { GitChangeKind, GitCommit } from '@deepseek-ai/dsh-git'

/** Branch facts parsed from the `# branch.*` header lines of porcelain v2. */
export interface ParsedBranch {
  /** Branch name, or the short HEAD commit hash when detached. */
  name: string
  /** Whether HEAD is detached from a branch. */
  detached: boolean
  /** Commits ahead of the upstream, when one is tracked. */
  ahead: number
  /** Commits behind the upstream, when one is tracked. */
  behind: number
}

/** One parsed porcelain v2 entry, normalized to the seam vocabulary. */
export interface ParsedStatusEntry {
  /** Repo-root-relative path of the changed file (the destination for renames). */
  path: string
  /** Normalized change kind. */
  kind: GitChangeKind
  /** Whether the change is staged in the index. */
  staged: boolean
  /** Whether the change exists in the worktree but is not staged. */
  unstaged: boolean
  /** Original path for renamed/copied entries. */
  oldPath?: string
}

/** The parsed porcelain v2 `--branch` status output. */
export interface ParsedStatus {
  /** Branch facts from the header. */
  branch: ParsedBranch
  /** Changed paths in git's output order. */
  entries: ParsedStatusEntry[]
}

/** One parsed `--name-status -z` record. */
export interface ParsedNameStatus {
  /** The raw status letter(s), including the rename/copy score (e.g. `R100`). */
  status: string
  /** Destination (or only) path. */
  path: string
  /** Source path for renamed/copied entries. */
  oldPath?: string
}

const STATUS_HEADER_PREFIX = '# branch.'
const BRANCH_HEAD_PREFIX = '# branch.head '
const BRANCH_OID_PREFIX = '# branch.oid '
const BRANCH_AB_PATTERN = /^# branch\.ab \+(\d+) -(\d+)$/

/**
 * Map one git index/worktree status letter to a normalized kind. Rename and
 * copy letters collapse onto their kind; the score is dropped.
 * @param letter - a single porcelain status letter (`A`, `M`, `D`, `R`, `C`, `T`, `U`, `X`, `B`, `?`).
 * @returns the normalized change kind.
 */
export function kindOfLetter(letter: string): GitChangeKind {
  switch (letter) {
    case 'A': return 'added'
    case 'M': return 'modified'
    case 'D': return 'deleted'
    case 'R': return 'renamed'
    case 'C': return 'copied'
    case 'T': return 'typechanged'
    case 'U':
    case 'X':
    case 'B': return 'unmerged'
    default: return 'untracked'
  }
}

/**
 * Parse porcelain v2 `--branch` status output into branch facts and normalized
 * entries. Header lines starting `# branch.` carry the branch name/oid and the
 * ahead/behind counts; `1`/`2` lines are regular and renamed entries, `u` lines
 * are unmerged entries, and `?` lines are untracked files. Paths arrive
 * unquoted because the backend runs with `-c core.quotepath=false`.
 * @param output - the raw `git status --porcelain=v2 --branch` stdout.
 * @returns the parsed branch facts and entries.
 */
export function parseStatusV2(output: string): ParsedStatus {
  let branchName = ''
  let detached = false
  let oid = ''
  let ahead = 0
  let behind = 0
  const entries: ParsedStatusEntry[] = []
  for (const rawLine of output.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line.length === 0) continue
    if (line.startsWith(STATUS_HEADER_PREFIX)) {
      if (line.startsWith(BRANCH_HEAD_PREFIX)) {
        branchName = line.slice(BRANCH_HEAD_PREFIX.length)
        detached = branchName === '(detached)'
      } else if (line.startsWith(BRANCH_OID_PREFIX)) {
        oid = line.slice(BRANCH_OID_PREFIX.length)
      } else {
        const ab = BRANCH_AB_PATTERN.exec(line)
        if (ab) {
          ahead = Number(ab[1])
          behind = Number(ab[2])
        }
      }
      continue
    }
    const entry = parseStatusEntry(line)
    if (entry) entries.push(entry)
  }
  return {
    branch: {
      name: detached ? oid.slice(0, 7) : branchName,
      detached,
      ahead,
      behind,
    },
    entries,
  }
}

/**
 * The first non-`.` XY letter of a porcelain status field: the index letter
 * when the change is staged, else the worktree letter. `.` means unmodified.
 * @param xy - the `XY` field of a status entry.
 * @returns the normalized change kind.
 */
function kindOfXY(xy: string): GitChangeKind {
  const x = xy[0] ?? ''
  const y = xy[1] ?? ''
  return x !== '.' ? kindOfLetter(x) : y !== '.' ? kindOfLetter(y) : 'untracked'
}

/**
 * Parse one non-header porcelain v2 line into a normalized entry. Unrecognized
 * lines (for example a future format extension) yield `undefined` and are
 * skipped rather than failing the whole read.
 * @param line - one entry line from `git status --porcelain=v2`.
 * @returns the normalized entry, or undefined for an unrecognized line.
 */
export function parseStatusEntry(line: string): ParsedStatusEntry | undefined {
  if (line.startsWith('?')) {
    return { path: line.slice(2), kind: 'untracked', staged: false, unstaged: true }
  }
  if (line.startsWith('1 ')) {
    const parts = line.split(' ')
    /* v8 ignore next -- porcelain v2 always emits the XY field; the fallback is defensive. */
    const xy = parts[1] ?? ''
    return {
      path: parts.slice(8).join(' '),
      kind: kindOfXY(xy),
      staged: (xy[0] ?? '') !== '.',
      unstaged: (xy[1] ?? '') !== '.',
    }
  }
  if (line.startsWith('2 ')) {
    // A rename entry is `2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <dest>\t<source>`
    // — the destination path comes FIRST, then a tab, then the source (the
    // reverse of `--short`'s `src -> dst` display).
    const tab = line.indexOf('\t')
    if (tab === -1) return undefined
    const head = line.slice(2, tab).split(' ')
    /* v8 ignore next -- split never yields an empty array; the fallback is defensive. */
    const xy = head[0] ?? ''
    const source = line.slice(tab + 1)
    return {
      path: head.slice(8).join(' '),
      kind: 'renamed',
      staged: (xy[0] ?? '') !== '.',
      unstaged: (xy[1] ?? '') !== '.',
      oldPath: source,
    }
  }
  if (line.startsWith('u ')) {
    const parts = line.split(' ')
    /* v8 ignore next -- porcelain v2 always emits the XY field; the fallback is defensive. */
    const xy = parts[1] ?? ''
    return {
      path: parts.slice(10).join(' '),
      kind: 'unmerged',
      staged: (xy[0] ?? '') !== '.',
      unstaged: (xy[1] ?? '') !== '.',
    }
  }
  return undefined
}

/**
 * Parse `git diff --name-status -z` output. With `-z` the status token and
 * each path are NUL-terminated, and rename/copy records carry two paths.
 * @param output - the raw NUL-separated stdout.
 * @returns the parsed records in git's output order.
 */
export function parseNameStatus(output: string): ParsedNameStatus[] {
  const tokens = output.split('\0')
  const records: ParsedNameStatus[] = []
  let i = 0
  while (i < tokens.length) {
    const status = tokens[i]
    /* v8 ignore next 2 -- the loop bound guarantees an in-range token; the guard is defensive. */
    if (status === undefined || status.length === 0) {
      i += 1
      continue
    }
    /* v8 ignore next -- name-status always pairs a status with a path; the fallback is defensive. */
    const first = tokens[i + 1] ?? ''
    switch (status[0]) {
      case 'R':
      case 'C': {
        const second = tokens[i + 2] ?? ''
        records.push({ status, path: second, oldPath: first })
        i += 3
        break
      }
      default: {
        records.push({ status, path: first })
        i += 2
        break
      }
    }
  }
  return records
}

/**
 * Parse the 0x1e/0x1f-separated `git log --format=...` records. Git refuses
 * control characters (other than tab and newline) in commit messages, so the
 * field separator 0x1f and record separator 0x1e cannot occur inside a field.
 * @param output - the raw log stdout.
 * @returns the parsed commits, newest first; empty output yields an empty list.
 */
export function parseLog(output: string): GitCommit[] {
  const commits: GitCommit[] = []
  for (const record of output.split('\u001e')) {
    // git appends a newline after each expanded format record; a trimmed-empty
    // record is that trailing separator, never a commit (a real record always
    // starts with the 40-char hash).
    const trimmed = record.trim()
    if (trimmed.length === 0) continue
    const [hash = '', shortHash = '', authorName = '', authorEmail = '', authorDate = '', subject = '', body = ''] = trimmed.split('\u001f')
    commits.push({ hash, shortHash, authorName, authorEmail, authorDate, subject, body })
  }
  return commits
}

/**
 * Map a `--name-status` status token to a diff change kind. Only added,
 * modified, deleted, and renamed occur for the default diff modes this backend
 * serves.
 * @param status - the raw status token (e.g. `M`, `A`, `D`, `R100`).
 * @returns the normalized kind.
 */
export function kindOfNameStatus(status: string): GitChangeKind {
  /* v8 ignore next -- name-status tokens are never empty; the fallback is defensive. */
  const letter = status[0] ?? ''
  switch (letter) {
    case 'A': return 'added'
    case 'D': return 'deleted'
    case 'R': return 'renamed'
    case 'M': return 'modified'
    case 'C': return 'copied'
    case 'T': return 'typechanged'
    default: return 'modified'
  }
}
