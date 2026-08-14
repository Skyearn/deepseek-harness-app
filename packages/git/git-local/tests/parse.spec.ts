/**
 * Pure parser tests for the git CLI output formats, with fixtures captured
 * from real git output (see provider.spec.ts for the live pinning).
 */

import { describe, expect, it } from 'vitest'
import {
  kindOfLetter,
  kindOfNameStatus,
  parseLog,
  parseNameStatus,
  parseStatusEntry,
  parseStatusV2,
} from '../src/parse.ts'

describe('kindOfLetter', () => {
  it.each([
    ['A', 'added'],
    ['M', 'modified'],
    ['D', 'deleted'],
    ['R', 'renamed'],
    ['C', 'copied'],
    ['T', 'typechanged'],
    ['U', 'unmerged'],
    ['X', 'unmerged'],
    ['B', 'unmerged'],
    ['?', 'untracked'],
    ['Z', 'untracked'],
  ] as const)('maps %s to %s', (letter, kind) => {
    expect(kindOfLetter(letter)).toBe(kind)
  })
})

describe('kindOfNameStatus', () => {
  it.each([
    ['M', 'modified'],
    ['A', 'added'],
    ['D', 'deleted'],
    ['R100', 'renamed'],
    ['C75', 'copied'],
    ['T', 'typechanged'],
    ['X', 'modified'],
    ['', 'modified'],
  ] as const)('maps %s to %s', (status, kind) => {
    expect(kindOfNameStatus(status)).toBe(kind)
  })
})

describe('parseStatusV2', () => {
  it('parses a mixed worktree with renames, staged adds, and untracked files', () => {
    const output = [
      '# branch.oid 519c2674b3d6cf36bd7640f0888b0e613cd6c40c',
      '# branch.head main',
      '1 .M N... 100644 100644 100644 78981922613b2afb6025042ff6bd878ac1994e85 78981922613b2afb6025042ff6bd878ac1994e85 a.txt',
      '2 R. N... 100644 100644 100644 61780798228d17af2d34fce4cfbdf35556832472 61780798228d17af2d34fce4cfbdf35556832472 R100 b2.txt\tb.txt',
      '1 A. N... 000000 100644 100644 0000000000000000000000000000000000000000 19d9cc8584ac2c7dcf57d2680375e80f099dc481 staged.txt',
      '? u.txt',
    ].join('\n')
    const parsed = parseStatusV2(output)
    expect(parsed.branch).toEqual({ name: 'main', detached: false, ahead: 0, behind: 0 })
    expect(parsed.entries).toEqual([
      { path: 'a.txt', kind: 'modified', staged: false, unstaged: true },
      { path: 'b2.txt', kind: 'renamed', staged: true, unstaged: false, oldPath: 'b.txt' },
      { path: 'staged.txt', kind: 'added', staged: true, unstaged: false },
      { path: 'u.txt', kind: 'untracked', staged: false, unstaged: true },
    ])
  })

  it('parses detached HEAD with ahead/behind counts from the branch header', () => {
    const oid = '519c2674b3d6cf36bd7640f0888b0e613cd6c40c'
    const output = [
      `# branch.oid ${oid}`,
      '# branch.head (detached)',
      '# branch.upstream origin/main',
      '# branch.ab +3 -1',
    ].join('\n')
    const parsed = parseStatusV2(output)
    expect(parsed.branch).toEqual({ name: oid.slice(0, 7), detached: true, ahead: 3, behind: 1 })
    expect(parsed.entries).toEqual([])
  })

  it('keeps spaces inside untracked paths', () => {
    const parsed = parseStatusV2('# branch.oid o\n# branch.head main\n? my file.txt\n')
    expect(parsed.entries).toEqual([{ path: 'my file.txt', kind: 'untracked', staged: false, unstaged: true }])
  })

  it('parses an unmerged entry', () => {
    const line = 'u UU N... 100644 100644 100644 100644 1a2b3c 4d5e6f 7a8b9c conflicted.txt'
    const parsed = parseStatusV2(`# branch.oid o\n# branch.head main\n${line}\n`)
    expect(parsed.entries).toEqual([{ path: 'conflicted.txt', kind: 'unmerged', staged: true, unstaged: true }])
  })

  it('reports a clean initial repository with no commits', () => {
    const parsed = parseStatusV2('# branch.oid (initial)\n# branch.head main\n')
    expect(parsed.branch).toEqual({ name: 'main', detached: false, ahead: 0, behind: 0 })
    expect(parsed.entries).toEqual([])
  })

  it('skips unrecognized entry lines instead of failing the read', () => {
    const parsed = parseStatusV2('# branch.oid o\n# branch.head main\n9 future-format extra\n')
    expect(parsed.entries).toEqual([])
  })

  it('tolerates CRLF line endings and truncated fields without throwing', () => {
    // Malformed porcelain (a future or buggy git): CRLF endings, entry lines
    // missing their fixed fields, and an all-`.` XY code must not crash.
    const parsed = parseStatusV2([
      '# branch.oid o\r\n',
      '# branch.head main\r\n',
      '1 \r\n',
      '2 \t\r\n',
      '1 .. N... 100644 100644 100644 a b unchanged.txt\r\n',
      'u \r\n',
      '? u.txt\r\n',
    ].join(''))
    expect(parsed.branch.name).toBe('main')
    expect(parsed.entries.length).toBeGreaterThan(0)
    expect(parsed.entries[0]?.kind).toBeDefined()
    expect(parsed.entries.some(entry => entry.path === 'unchanged.txt' && entry.kind === 'untracked')).toBe(true)
  })
})

describe('parseStatusEntry', () => {
  it('returns undefined for an unrecognized line', () => {
    expect(parseStatusEntry('garbage')).toBeUndefined()
  })

  it('returns undefined for a rename line without a tab separator', () => {
    expect(parseStatusEntry('2 R. N... 100644 100644 100644 a b R100 only-one-path')).toBeUndefined()
  })
})

describe('parseNameStatus', () => {
  it('parses plain and rename records with -z separators', () => {
    const records = parseNameStatus('M\0a.txt\0A\0new.txt\0R100\0old.txt\0renamed.txt\0C75\0orig.txt\0copied.txt\0D\0gone.txt\0')
    expect(records).toEqual([
      { status: 'M', path: 'a.txt' },
      { status: 'A', path: 'new.txt' },
      { status: 'R100', path: 'renamed.txt', oldPath: 'old.txt' },
      { status: 'C75', path: 'copied.txt', oldPath: 'orig.txt' },
      { status: 'D', path: 'gone.txt' },
    ])
  })

  it('returns an empty list for empty output', () => {
    expect(parseNameStatus('')).toEqual([])
  })

  it('tolerates a lone status token without a path (defensive)', () => {
    expect(parseNameStatus('M')).toEqual([{ status: 'M', path: '' }])
  })

  it('tolerates a rename record missing its destination path (defensive)', () => {
    expect(parseNameStatus('R100\0old.txt')).toEqual([{ status: 'R100', path: '', oldPath: 'old.txt' }])
  })

  it('skips stray empty tokens', () => {
    const records = parseNameStatus('M\0a.txt\0\0A\0b.txt\0')
    expect(records).toEqual([
      { status: 'M', path: 'a.txt' },
      { status: 'A', path: 'b.txt' },
    ])
  })
})

describe('parseLog', () => {
  it('parses one commit with its body', () => {
    const output = 'hash\x1fshort\x1fAda Lovelace\x1fada@example.com\x1f2026-08-14T08:35:45+08:00\x1fSubject line\x1fBody line one\nBody line two\x1e'
    expect(parseLog(output)).toEqual([{
      hash: 'hash',
      shortHash: 'short',
      authorName: 'Ada Lovelace',
      authorEmail: 'ada@example.com',
      authorDate: '2026-08-14T08:35:45+08:00',
      subject: 'Subject line',
      body: 'Body line one\nBody line two',
    }])
  })

  it('parses multiple commits newest first and tolerates the trailing separator', () => {
    const output = 'h1\x1fs1\x1fn\x1fe\x1fd\x1fone\x1f\x1eh2\x1fs2\x1fn\x1fe\x1fd\x1ftwo\x1fbody\x1e'
    const commits = parseLog(output)
    expect(commits).toHaveLength(2)
    expect(commits[0]?.subject).toBe('one')
    expect(commits[1]?.subject).toBe('two')
    expect(commits[1]?.body).toBe('body')
  })

  it('returns an empty list for empty output', () => {
    expect(parseLog('')).toEqual([])
  })
})
