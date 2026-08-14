/**
 * Pure presentation tests for the git tools: unified-diff rendering, status
 * and log listings, the per-call unified clamp, and diff-mode validation.
 */

import { describe, expect, it } from 'vitest'
import type { GitDiffFile } from '@deepseek-ai/dsh-git'
import { clampUnified, diffModeOf, renderDiffFile, renderGitDiff } from '../src/git-diff.ts'
import type { DiffRenderConfig } from '../src/git-diff.ts'
import { renderGitLog } from '../src/git-log.ts'
import { renderGitStatus } from '../src/git-status.ts'

const CONFIG: DiffRenderConfig = { context: 3, maxDiffContext: 20 }

function file(over: Partial<GitDiffFile> & Pick<GitDiffFile, 'path' | 'kind'>): GitDiffFile {
  return { oldText: null, newText: null, ...over }
}

describe('renderDiffFile', () => {
  it('renders a modified file with a unified hunk and context', () => {
    const lines = renderDiffFile(file({
      path: 'src/a.ts',
      kind: 'modified',
      oldText: 'one\ntwo\nthree\n',
      newText: 'one\nTWO\nthree\n',
    }), 3)
    expect(lines[0]).toBe('diff --git a/src/a.ts b/src/a.ts')
    expect(lines[1]).toBe('--- a/src/a.ts')
    expect(lines[2]).toBe('+++ b/src/a.ts')
    expect(lines.some(line => line === '-two')).toBe(true)
    expect(lines.some(line => line === '+TWO')).toBe(true)
    expect(lines.some(line => line.startsWith('@@ -'))).toBe(true)
  })

  it('renders an added file against /dev/null with all-new lines', () => {
    const lines = renderDiffFile(file({ path: 'new.txt', kind: 'added', newText: 'a\nb\n' }), 3)
    expect(lines[1]).toBe('--- /dev/null')
    expect(lines[2]).toBe('+++ b/new.txt')
    expect(lines.some(line => line === '+a')).toBe(true)
  })

  it('renders a deleted file against /dev/null with all-removed lines', () => {
    const lines = renderDiffFile(file({ path: 'gone.txt', kind: 'deleted', oldText: 'x\n' }), 3)
    expect(lines[1]).toBe('--- a/gone.txt')
    expect(lines[2]).toBe('+++ /dev/null')
    expect(lines.some(line => line === '-x')).toBe(true)
  })

  it('renders a rename with both paths in the headers', () => {
    const lines = renderDiffFile(file({
      path: 'new.txt',
      kind: 'renamed',
      oldPath: 'old.txt',
      oldText: 'same\n',
      newText: 'same\n',
    }), 3)
    expect(lines[0]).toBe('diff --git a/old.txt b/new.txt')
  })

  it('renders an omission note for binary and oversized files', () => {
    expect(renderDiffFile(file({ path: 'bin.dat', kind: 'modified', omitted: 'binary' }), 3))
      .toContain('<content omitted: binary file>')
    expect(renderDiffFile(file({ path: 'big.txt', kind: 'modified', omitted: 'too_large' }), 3))
      .toContain('<content omitted: file exceeds the size cap>')
  })
})

describe('renderGitDiff', () => {
  it('wraps the diff with the repo and file counts', () => {
    const text = renderGitDiff({
      repo: '/repo',
      files: [file({ path: 'a.txt', kind: 'added', newText: 'x\n' })],
      truncated: false,
    }, 3)
    expect(text).toContain('<repo>/repo</repo>')
    expect(text).toContain('<diff>1 file(s) changed</diff>')
  })

  it('reports truncation and no-changes states', () => {
    const truncated = renderGitDiff({ repo: '/r', files: [], truncated: true }, 3)
    expect(truncated).toContain('<diff>0 file(s) changed (truncated)</diff>')
    const clean = renderGitDiff({ repo: '/r', files: [], truncated: false }, 3)
    expect(clean).toContain('<diff>no changes</diff>')
  })
})

describe('clampUnified', () => {
  it('defaults to the configured context and clamps per-call requests', () => {
    expect(clampUnified(undefined, CONFIG)).toBe(3)
    expect(clampUnified(7, CONFIG)).toBe(7)
    expect(clampUnified(999, CONFIG)).toBe(20)
    expect(clampUnified(-5, CONFIG)).toBe(0)
  })
})

describe('diffModeOf', () => {
  it('selects worktree, staged, and range modes', () => {
    expect(diffModeOf({})).toEqual({ kind: 'worktree' })
    expect(diffModeOf({ staged: true })).toEqual({ kind: 'staged' })
    expect(diffModeOf({ base: 'a', head: 'b' })).toEqual({ kind: 'range', base: 'a', head: 'b' })
  })

  it('rejects a base without a head and a staged range', () => {
    expect(() => diffModeOf({ base: 'a' })).toThrow(/together/)
    expect(() => diffModeOf({ head: 'b' })).toThrow(/together/)
    expect(() => diffModeOf({ staged: true, base: 'a', head: 'b' })).toThrow(/mutually exclusive/)
  })
})

describe('renderGitStatus', () => {
  it('renders the branch, counts, and per-entry state', () => {
    const text = renderGitStatus({
      repo: '/repo',
      branch: 'main',
      detached: false,
      ahead: 2,
      behind: 1,
      files: [
        { path: 'a.txt', kind: 'modified', staged: false, unstaged: true },
        { path: 'b.txt', kind: 'added', staged: true, unstaged: true },
        { path: 'c.txt', kind: 'renamed', staged: true, unstaged: false, oldPath: 'd.txt' },
      ],
      truncated: false,
    })
    expect(text).toContain('<repo>/repo</repo>')
    expect(text).toContain('<branch>main</branch>')
    expect(text).toContain('<upstream>ahead 2, behind 1</upstream>')
    expect(text).toMatch(/modified\s+a\.txt\s+\[unstaged\]/)
    expect(text).toMatch(/added\s+b\.txt\s+\[staged \+ unstaged\]/)
    expect(text).toMatch(/renamed\s+c\.txt \(from d\.txt\)\s+\[staged\]/)
  })

  it('renders a clean tree and a detached HEAD', () => {
    const text = renderGitStatus({
      repo: '/repo', branch: 'abc1234', detached: true, ahead: 0, behind: 0, files: [], truncated: true,
    })
    expect(text).toContain('<state>detached HEAD</state>')
    expect(text).toContain('working tree clean')
    expect(text).toContain('<branch>abc1234</branch>')
  })

  it('renders truncation on a non-empty listing and an entry with no staging state', () => {
    const text = renderGitStatus({
      repo: '/repo', branch: 'main', detached: false, ahead: 0, behind: 0,
      files: [{ path: 'a.txt', kind: 'modified', staged: false, unstaged: false }],
      truncated: true,
    })
    expect(text).toContain('1 changed file(s) (truncated)')
    expect(text).toMatch(/modified\s+a\.txt$/)
  })
})

describe('renderGitLog', () => {
  it('renders git-style commit blocks with bodies', () => {
    const text = renderGitLog({
      repo: '/repo',
      commits: [{
        hash: 'a'.repeat(40),
        shortHash: 'aaaaaaa',
        authorName: 'Ada',
        authorEmail: 'ada@example.com',
        authorDate: '2026-08-14T08:35:45+08:00',
        subject: 'Subject',
        body: 'Body line',
      }],
    })
    expect(text).toContain('<repo>/repo</repo>')
    expect(text).toContain('<commits>1 commit(s)</commits>')
    expect(text).toContain(`commit ${'a'.repeat(40)}`)
    expect(text).toContain('Author: Ada <ada@example.com>')
    expect(text).toContain('    Body line')
  })

  it('renders an empty history', () => {
    expect(renderGitLog({ repo: '/repo', commits: [] })).toContain('<commits>no commits</commits>')
  })
})
