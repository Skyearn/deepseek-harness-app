/**
 * Local-git implementation of `ctx.git`. Every command runs the `git` CLI
 * through `ctx.subprocess` with a bounded deadline, a deterministic
 * non-interactive environment, and `core.quotepath=false` so parsed paths stay
 * raw UTF-8. Repository discovery walks parent directories exactly like git
 * itself; the three normalized queries parse porcelain v2 status, `--name-status -z`
 * file lists plus per-file content reads, and 0x1e/0x1f-separated log records.
 * @module @deepseek-ai/dsh-git-local
 */

import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { GitError, GitRepoKey, GitService } from '@deepseek-ai/dsh-git'
import type {
  GitChangeKind,
  GitCommit,
  GitDiff,
  GitDiffFile,
  GitDiffRequest,
  GitLog,
  GitLogRequest,
  GitRepo,
  GitStatus,
  GitStatusRequest,
} from '@deepseek-ai/dsh-git'
import type { SubprocessCollect, SubprocessHandle, SubprocessOutputReader, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { deadline, MAX_TIMER_DELAY_MS, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { kindOfNameStatus, parseLog, parseNameStatus, parseStatusV2 } from './parse.ts'
import type { ParsedNameStatus } from './parse.ts'

/** Default per-command SIGTERM→SIGKILL grace period, matching `dsh-bash-local`. */
const DEFAULT_GRACE_MS = 3_000

/** Default per-command deadline in milliseconds. */
const DEFAULT_TIMEOUT_MS = 30_000

/** Default per-stream in-memory output cap in bytes. */
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024

/**
 * Deterministic non-interactive environment for every git command: no color,
 * no pager, no credential prompt, and a fixed locale so messages and paths
 * parse stably. The subprocess service merges these onto its scrubbed parent
 * base.
 */
const GIT_ENV = {
  NO_COLOR: '1',
  GIT_PAGER: 'cat',
  PAGER: 'cat',
  GIT_TERMINAL_PROMPT: '0',
  LC_ALL: 'C',
} as const

/** Plugin config (all optional — `static Config` supplies the defaults). */
export interface Config {
  /** The git executable; a bare name resolves through PATH. */
  gitPath?: string
  /** Default working directory for repository discovery when a call supplies none. */
  cwd?: string
  /** Default per-command deadline in milliseconds. */
  timeoutMs?: number
  /** Per-stream in-memory output cap in bytes. */
  maxOutputBytes?: number
}

/** The shape after schemastery applied the defaults. */
type ResolvedConfig = Required<Config>

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`git-local: ${name} must be a positive integer`)
  }
}

/** Project a settled collect-mode reader into plain text plus the lossy flag. */
function finalOutput(reader: SubprocessOutputReader): { text: string; lossy: boolean } {
  const read = reader.readFrom(0)
  return { text: read.text, lossy: read.lossy }
}

/**
 * The local git backend. Runs read-only git queries in the host execution
 * world; the seam contract forbids mutations, so every invocation is a query.
 */
export class LocalGitService extends GitService {
  static Config: z<Config> = z.object({
    gitPath: z.string().default('git'),
    cwd: z.string().default(process.cwd()),
    timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS),
    maxOutputBytes: z.number().default(DEFAULT_MAX_OUTPUT_BYTES),
  })

  static inject = ['subprocess']

  /** Validated config (schemastery applied the defaults before construction). */
  readonly config: ResolvedConfig

  constructor(ctx: Context, config: Config) {
    super(ctx)
    const resolved = config as ResolvedConfig
    if (resolved.gitPath.trim().length === 0) {
      throw new Error('git-local: gitPath must be a non-empty string')
    }
    assertPositiveInteger('timeoutMs', resolved.timeoutMs)
    if (resolved.timeoutMs > MAX_TIMER_DELAY_MS) {
      throw new Error(`git-local: timeoutMs must not exceed ${MAX_TIMER_DELAY_MS}`)
    }
    assertPositiveInteger('maxOutputBytes', resolved.maxOutputBytes)
    this.config = resolved
  }

  /** Map a caller cwd onto an absolute working directory. */
  private baseDir(cwd: string | undefined): string {
    const dir = cwd ?? this.config.cwd
    return isAbsolute(dir) ? dir : resolve(dir)
  }

  /**
   * Run one git command and return its collected output, classifying failures
   * into typed git errors. The deadline combines the configured timeout and the
   * caller's cancellation signal; a timeout raises `GIT_TIMEOUT`, cancellation
   * `GIT_ABORTED`, and a non-zero exit the code its stderr classifies to.
   * @param args - git arguments after the executable.
   * @param opts - working directory, output caps, and cancellation.
   * @returns the collected stdout/stderr text and whether either stream was truncated.
   */
  /**
   * Run one git command and return its collected output, classifying failures
   * into typed git errors. The deadline combines the configured timeout and the
   * caller's cancellation signal; a timeout raises `GIT_TIMEOUT`, cancellation
   * `GIT_ABORTED`, and a non-zero exit the code its stderr classifies to.
   * @param subcommand - the git subcommand name, used in error messages.
   * @param args - the full git arguments after the executable.
   * @param opts - working directory, output caps, and cancellation.
   * @returns the collected stdout/stderr text and whether either stream was truncated.
   */
  private async run(
    subcommand: string,
    args: readonly string[],
    opts: { cwd: string; stdoutMaxBytes: number; signal: AbortSignal | undefined },
  ): Promise<{ stdout: string; stderr: string; lossy: boolean }> {
    using d = deadline(opts.signal, this.config.timeoutMs, 'GIT_TIMEOUT')
    // Fail fast on an already-settled cancellation before spawning: a
    // pre-aborted signal would otherwise surface as a spawn rejection.
    if (opts.signal?.aborted === true) {
      throw new GitError(`git ${subcommand} aborted`, 'GIT_ABORTED')
    }
    const collect = (maxBytes: number): SubprocessCollect => ({ maxBytes })
    const spec: SubprocessSpawnSpec = {
      argv: [this.config.gitPath, ...args],
      cwd: opts.cwd,
      stdio: {
        stdin: 'ignore',
        stdout: collect(opts.stdoutMaxBytes),
        stderr: collect(this.config.maxOutputBytes),
      },
      graceMs: DEFAULT_GRACE_MS,
      signal: d.signal,
      env: GIT_ENV,
    }
    let handle: SubprocessHandle
    try {
      handle = this.ctx.subprocess.spawn(spec)
    } catch (error: unknown) {
      /* v8 ignore start -- spawn failures surface through handle.done, not a synchronous throw. */
      if (d.signal.aborted) throw new GitError(`git ${subcommand} aborted`, 'GIT_ABORTED', { cause: error })
      throw new GitError(`cannot start git: ${String(error)}`, 'GIT_IO_ERROR', { cause: error })
      /* v8 ignore stop */
    }
    const outcome = await handle.done.catch((error: unknown) => {
      /* v8 ignore next 2 -- an abort between the pre-check and a spawn-level
       * failure; the pre-check already handles a pre-aborted signal. */
      if (d.signal.aborted) throw new GitError(`git ${subcommand} aborted`, 'GIT_ABORTED', { cause: error })
      throw new GitError(`cannot start git: ${String(error)}`, 'GIT_IO_ERROR', { cause: error })
    })
    if (timeoutOf(d.signal, 'GIT_TIMEOUT') !== undefined) {
      throw new GitError(`git ${subcommand} timed out after ${this.config.timeoutMs} ms`, 'GIT_TIMEOUT')
    }
    if (d.signal.aborted) {
      throw new GitError(`git ${subcommand} aborted`, 'GIT_ABORTED')
    }
    const stdoutReader = handle.collected.stdout
    const stderrReader = handle.collected.stderr
    /* v8 ignore start -- collect dispositions expose both readers by the seam contract; defensive. */
    if (stdoutReader === undefined || stderrReader === undefined) {
      throw new Error('git-local: subprocess implementation dropped a requested collect stream')
    }
    /* v8 ignore stop */
    const stdout = finalOutput(stdoutReader)
    const stderr = finalOutput(stderrReader)
    if (outcome.exitCode !== 0) throw this.classifyError(subcommand, stderr.text)
    return { stdout: stdout.text, stderr: stderr.text, lossy: stdout.lossy || stderr.lossy }
  }

  /** Classify a non-zero git exit by its stderr text into a typed error. */
  private classifyError(subcommand: string, stderr: string): GitError {
    const message = stderr.trim().length > 0 ? stderr.trim() : `git ${subcommand} failed`
    const text = stderr.toLowerCase()
    if (text.includes('not a git repository')) return new GitError(message, 'GIT_NOT_REPO')
    /* v8 ignore next 2 -- no current command fails a pathspec (git diff/log
     * return an empty result instead); kept for future commands that do. */
    if (text.includes('pathspec') && text.includes('did not match')) return new GitError(message, 'GIT_PATH_NOT_FOUND')
    if (text.includes('unknown revision') || text.includes('bad revision') || text.includes('ambiguous argument')) {
      return new GitError(message, 'GIT_BAD_REVISION')
    }
    return new GitError(message, 'GIT_IO_ERROR')
  }

  override async root(cwd: string | undefined, signal?: AbortSignal): Promise<GitRepo | undefined> {
    const dir = this.baseDir(cwd)
    let stdout: string
    try {
      const result = await this.run('rev-parse', ['-c', 'core.quotepath=false', 'rev-parse', '--show-toplevel'], {
        cwd: dir,
        stdoutMaxBytes: this.config.maxOutputBytes,
        signal,
      })
      stdout = result.stdout
    } catch (error: unknown) {
      if (error instanceof GitError && error.code === 'GIT_NOT_REPO') return undefined
      throw error
    }
    const root = stdout.trim()
    /* v8 ignore next 2 -- rev-parse prints the root path on success; empty output is unreachable. */
    if (root.length === 0) return undefined
    return { key: GitRepoKey(root), root, displayRoot: root }
  }

  override async status(request: GitStatusRequest, signal?: AbortSignal): Promise<GitStatus> {
    const args = ['-c', 'core.quotepath=false', 'status', '--porcelain=v2', '--branch']
    if (request.path !== undefined) args.push('--', request.path)
    const result = await this.run('status', args, {
      cwd: request.repo.root,
      stdoutMaxBytes: this.config.maxOutputBytes,
      signal,
    })
    const parsed = parseStatusV2(result.stdout)
    return {
      repo: request.repo,
      branch: parsed.branch.name,
      detached: parsed.branch.detached,
      ahead: parsed.branch.ahead,
      behind: parsed.branch.behind,
      entries: parsed.entries.slice(0, request.maxEntries),
      truncated: result.lossy || parsed.entries.length > request.maxEntries,
    }
  }

  override async diff(request: GitDiffRequest, signal?: AbortSignal): Promise<GitDiff> {
    const nameArgs = ['-c', 'core.quotepath=false', 'diff', '--name-status', '-z']
    switch (request.mode.kind) {
      case 'worktree':
        break
      case 'staged':
        nameArgs.push('--cached')
        break
      case 'range':
        nameArgs.push(request.mode.base, request.mode.head)
        break
    }
    if (request.path !== undefined) nameArgs.push('--', request.path)
    const result = await this.run('diff', nameArgs, {
      cwd: request.repo.root,
      stdoutMaxBytes: this.config.maxOutputBytes,
      signal,
    })
    const changed = parseNameStatus(result.stdout)
    const files: GitDiffFile[] = []
    let totalBytes = 0
    for (const item of changed.slice(0, request.maxFiles)) {
      const fetched = await this.fetchDiffFile(request, item, totalBytes, signal)
      totalBytes += fetched.bytes
      files.push(fetched.file)
    }
    return { repo: request.repo, files, truncated: changed.length > request.maxFiles }
  }

  /** The pre-image source for a mode and change kind. */
  private preSource(mode: GitDiffRequest['mode'], kind: GitChangeKind): { kind: 'blob'; rev: string } | { kind: 'none' } {
    if (kind === 'added') return { kind: 'none' }
    switch (mode.kind) {
      // An empty rev renders the index blob (`git show :./<path>`).
      case 'worktree': return { kind: 'blob', rev: '' }
      case 'staged': return { kind: 'blob', rev: 'HEAD' }
      case 'range': return { kind: 'blob', rev: mode.base }
    }
  }

  /** The post-image source for a mode and change kind. */
  private postSource(mode: GitDiffRequest['mode'], kind: GitChangeKind): { kind: 'blob'; rev: string } | { kind: 'worktree' } | { kind: 'none' } {
    if (kind === 'deleted') return { kind: 'none' }
    switch (mode.kind) {
      case 'worktree': return { kind: 'worktree' }
      // An empty rev renders the index blob (`git show :./<path>`).
      case 'staged': return { kind: 'blob', rev: '' }
      case 'range': return { kind: 'blob', rev: mode.head }
    }
  }

  /**
   * Resolve one changed file's pre/post content for the request's mode and
   * fetch both sides, applying the per-file and cumulative byte caps.
   * @param request - the diff request carrying mode and caps.
   * @param item - the parsed name-status record for this file.
   * @param totalBytes - cumulative content bytes already fetched.
   * @param signal - aborts content reads.
   * @returns the diff file plus the bytes its content sides consumed.
   */
  private async fetchDiffFile(
    request: GitDiffRequest,
    item: ParsedNameStatus,
    totalBytes: number,
    signal?: AbortSignal,
  ): Promise<{ file: GitDiffFile; bytes: number }> {
    const kind = kindOfNameStatus(item.status)
    const file: GitDiffFile = {
      path: item.path,
      kind,
      ...item.oldPath !== undefined ? { oldPath: item.oldPath } : {},
      oldText: null,
      newText: null,
    }
    const pre = this.preSource(request.mode, kind)
    const post = this.postSource(request.mode, kind)
    const sides = await this.fetchSides(request, item, pre, post, totalBytes, signal)
    const omitted = sides.pre.omitted ?? sides.post.omitted
    if (omitted !== undefined) {
      file.omitted = omitted
    } else {
      file.oldText = sides.pre.text
      file.newText = sides.post.text
    }
    return { file, bytes: sides.bytes }
  }

  /**
   * Fetch both content sides of one file, honoring the cumulative byte cap
   * before reading anything further. The pre side of a rename reads the source
   * path, the post side the destination path.
   * @param request - the diff request carrying the caps.
   * @param item - the parsed name-status record (paths and rename source).
   * @param pre - the pre-image source for the mode and kind.
   * @param post - the post-image source for the mode and kind.
   * @param totalBytes - cumulative content bytes already fetched.
   * @param signal - aborts content reads.
   * @returns the two content sides and the bytes consumed.
   */
  private async fetchSides(
    request: GitDiffRequest,
    item: ParsedNameStatus,
    pre: { kind: 'blob'; rev: string } | { kind: 'none' },
    post: { kind: 'blob'; rev: string } | { kind: 'worktree' } | { kind: 'none' },
    totalBytes: number,
    signal?: AbortSignal,
  ): Promise<{
    pre: { text: string | null; omitted?: 'binary' | 'too_large' }
    post: { text: string | null; omitted?: 'binary' | 'too_large' }
    bytes: number
  }> {
    const overBudget = totalBytes >= request.maxTotalBytes
    const prePath = item.oldPath ?? item.path
    const preSide = pre.kind === 'none'
      ? { text: null as string | null }
      : overBudget
        ? { text: null as string | null, omitted: 'too_large' as const }
        : await this.fetchBlob(request, pre.rev, prePath, signal)
    const postSide = post.kind === 'none'
      ? { text: null as string | null }
      : overBudget
        ? { text: null as string | null, omitted: 'too_large' as const }
        : post.kind === 'worktree'
          ? await this.fetchWorktree(request, item.path, signal)
          : await this.fetchBlob(request, post.rev, item.path, signal)
    const bytes = (preSide.text?.length ?? 0) + (postSide.text?.length ?? 0)
    return { pre: preSide, post: postSide, bytes }
  }

  /** Read the worktree file for the post side, under the per-file byte cap. */
  private async fetchWorktree(
    request: GitDiffRequest,
    path: string,
    signal?: AbortSignal,
  ): Promise<{ text: string | null; omitted?: 'binary' | 'too_large' }> {
    /* v8 ignore start -- an abort between the listing and the file read is a race; the pre-checks handle pre-aborted signals. */
    if (signal?.aborted) throw new GitError('git diff aborted', 'GIT_ABORTED')
    /* v8 ignore stop */
    const absolute = resolve(request.repo.root, path)
    /* v8 ignore start -- a file vanishing between the diff listing and the read is a race with an honest null fallback. */
    const info = await stat(absolute).catch(() => undefined)
    if (info === undefined) return { text: null }
    /* v8 ignore stop */
    if (info.size > request.maxBytesPerFile) return { text: null, omitted: 'too_large' }
    /* v8 ignore start -- the same race on the read itself. */
    const content = await readFile(absolute, 'utf8').catch(() => undefined)
    if (content === undefined) return { text: null }
    /* v8 ignore stop */
    if (content.includes('\u0000')) return { text: null, omitted: 'binary' }
    return { text: content }
  }

  /**
   * Read one blob (`git show <rev>:./<path>`) under the per-file byte cap.
   * Output overflow means the file exceeds the cap; a NUL byte means binary.
   * @param request - the diff request carrying the per-file cap.
   * @param rev - the revision whose blob to read (`HEAD`, `:` for the index, or a revision name).
   * @param path - the repo-root-relative path.
   * @param signal - aborts the read.
   * @returns the decoded text, or null with an omission reason.
   */
  private async fetchBlob(
    request: GitDiffRequest,
    rev: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<{ text: string | null; omitted?: 'binary' | 'too_large' }> {
    const result = await this.run('show', ['-c', 'core.quotepath=false', 'show', `${rev}:./${path}`], {
      cwd: request.repo.root,
      stdoutMaxBytes: request.maxBytesPerFile,
      signal,
    })
    if (result.lossy) return { text: null, omitted: 'too_large' }
    if (result.stdout.includes('\u0000')) return { text: null, omitted: 'binary' }
    return { text: result.stdout }
  }

  override async log(request: GitLogRequest, signal?: AbortSignal): Promise<GitLog> {
    const args = [
      '-c', 'core.quotepath=false',
      'log', '-n', String(request.count),
      '--format=%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b%x1e',
    ]
    if (request.path !== undefined) args.push('--', request.path)
    let stdout: string
    try {
      const result = await this.run('log', args, {
        cwd: request.repo.root,
        stdoutMaxBytes: this.config.maxOutputBytes,
        signal,
      })
      stdout = result.stdout
    } catch (error: unknown) {
      // A repository with no commits yet fails log with this stable message;
      // the honest result is an empty history, not an error.
      if (error instanceof GitError
        && error.code === 'GIT_IO_ERROR'
        && error.message.includes('does not have any commits yet')) {
        stdout = ''
      } else {
        throw error
      }
    }
    const commits: GitCommit[] = parseLog(stdout)
    return { repo: request.repo, commits }
  }
}

export default LocalGitService
