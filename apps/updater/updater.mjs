#!/usr/bin/env node
// Shell/Core update helper for DeepSeek Harness desktop apps.
// Zero-dependency: uses Node builtins only.
//
// ARCHIVED: this repository stopped updating when DeepSeek shipped the official
// desktop app (https://www.deepseek.com/harness/). The code stays for anyone
// still running the archived shell builds; no further changes are planned.
//
// Commands:
//   node updater.mjs check --shell-current <version>
//   node updater.mjs update-core
//   node updater.mjs download-shell --shell-current <version>
//
// Output is line oriented so both the Swift and C# shells can parse it.

import https from 'node:https'
import { createWriteStream, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, renameSync, statSync, writeFileSync, openSync, closeSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'

const REPO = 'Skyearn/deepseek-harness-app'
const NPM_PACKAGE = '@deepseek-ai/dsh'
const COMPLETE_MARKER = '.complete'
const NODE_VERSION = 'v24.12.0'

const isWindows = process.platform === 'win32'
const home = process.env.HOME || process.env.USERPROFILE || tmpdir()

const appSupport = isWindows
  ? join(process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'DeepSeek Harness')
  : join(home, 'Library', 'Application Support', 'DeepSeek Harness')

const runtimeDir = join(appSupport, 'runtime')
const versionsDir = join(runtimeDir, 'versions')
const downloadsDir = join(runtimeDir, 'downloads')
const currentFile = join(runtimeDir, 'current')
const nodeRuntimeDir = join(runtimeDir, 'node')

const NPM_REGISTRY = 'https://registry.npmjs.org'
const NPM_SCOPE = NPM_PACKAGE.split('/')[0]

// Parses `0.1.5-rc.2` into its numeric release segments and prerelease
// identifiers.
function parseVersion(value) {
  const [release, prerelease = ''] = String(value).split('-')
  return {
    release: release.split('.').map(part => Number.parseInt(part, 10) || 0),
    prerelease: prerelease ? prerelease.split('.') : [],
  }
}

// Compares two versions the way semver does. A release outranks any of its own
// prereleases (0.1.5 > 0.1.5-rc.2), prerelease identifiers compare segment by
// segment with numeric identifiers ordered numerically (rc.2 < rc.10), and a
// shorter identifier list sorts first (alpha < alpha.1). Returns -1, 0 or 1.
function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  const releaseCount = Math.max(left.release.length, right.release.length)
  for (let i = 0; i < releaseCount; i++) {
    const x = left.release[i] || 0
    const y = right.release[i] || 0
    if (x !== y) return x < y ? -1 : 1
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) return 0
    return left.prerelease.length === 0 ? 1 : -1
  }
  const prereleaseCount = Math.max(left.prerelease.length, right.prerelease.length)
  for (let i = 0; i < prereleaseCount; i++) {
    const x = left.prerelease[i]
    const y = right.prerelease[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const xNumeric = /^\d+$/.test(x)
    const yNumeric = /^\d+$/.test(y)
    if (xNumeric && yNumeric) return Number(x) < Number(y) ? -1 : 1
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1
    return x < y ? -1 : 1
  }
  return 0
}

// The dist-tag that tracks the channel the installed core belongs to. Upstream
// publishes a prerelease under `next`/`alpha` and only moves `latest` when a
// version graduates, so reading `latest` alone never sees a new rc.
function coreChannel(version) {
  if (/-alpha(\.|$)/.test(version)) return 'alpha'
  if (/-(rc|beta)(\.|$)/.test(version)) return 'next'
  return 'latest'
}

function hasUpdate(current, latest) {
  if (!latest) return '0'
  if (!current) return '1'
  return compareVersions(latest, current) > 0 ? '1' : '0'
}

// GitHub orders releases by creation time, which is not always version order
// (backported patches, equal timestamps), so pick the highest semver tag.
function highestRelease(releases, prefix) {
  return (Array.isArray(releases) ? releases : [])
    .filter(release => typeof release?.tag_name === 'string' && release.tag_name.startsWith(prefix))
    .reduce((best, release) => {
      if (!best) return release
      const candidate = release.tag_name.slice(prefix.length)
      const incumbent = best.tag_name.slice(prefix.length)
      return compareVersions(candidate, incumbent) > 0 ? release : best
    }, null)
}

function request(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'user-agent': 'deepseek-harness-updater' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
        res.resume()
        resolve(request(new URL(res.headers.location, url), redirects + 1))
        return
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`))
        return
      }
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    })
    req.on('error', reject)
  })
}

function requestJSON(url) {
  return request(url).then(text => JSON.parse(text))
}

// The GitHub API rate-limits anonymous callers hard (60/h per IP, shared behind
// NAT). `/<repo>/releases/latest` redirects to the newest release tag without
// touching the API, which is enough to build a download URL by convention.
function resolveReleaseTag(repo) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      `https://github.com/${repo}/releases/latest`,
      { headers: { 'user-agent': 'deepseek-harness-updater' } },
      (res) => {
        res.resume()
        const match = String(res.headers.location || '').match(/\/releases\/tag\/([^/?#]+)/)
        if (match) resolve(decodeURIComponent(match[1]))
        else reject(new Error(`cannot resolve the latest release of ${repo}`))
      },
    )
    req.on('error', reject)
  })
}

function emitLine(line) {
  process.stdout.write(`${line}\n`)
}

function downloadOnce(url, dest, offset, redirects = 0) {
  return new Promise((resolve, reject) => {
    mkdirSync(dirname(dest), { recursive: true })
    const headers = { 'user-agent': 'deepseek-harness-updater' }
    if (offset > 0) headers.Range = `bytes=${offset}-`
    const req = https.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
        res.resume()
        resolve(downloadOnce(new URL(res.headers.location, url).toString(), dest, offset, redirects + 1))
        return
      }
      if (res.statusCode === 416 && offset > 0) {
        // The local file is already as long as the remote one: start over.
        res.resume()
        resolve(downloadOnce(url, dest, 0, redirects))
        return
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume()
        reject(new Error(`HTTP ${res.statusCode} for ${url}`))
        return
      }
      const resuming = offset > 0 && res.statusCode === 206
      const total = Number(res.headers['content-length'] || 0) + (resuming ? offset : 0)

      if (total > 0) emitLine("TARGET_SIZE=" + total)
      let downloaded = resuming ? offset : 0
      let lastReport = downloaded
      let settled = false
      const file = createWriteStream(dest, { flags: resuming ? 'a' : 'w' })
      const fail = (error) => {
        if (settled) return
        settled = true
        res.destroy()
        file.destroy()
        reject(error)
      }
      res.on('data', chunk => {
        downloaded += chunk.length
        file.write(chunk)
        if (total > 0 && (downloaded - lastReport >= 1024 * 1024 || downloaded === total)) {
          lastReport = downloaded
          emitLine(`PROGRESS=${downloaded}/${total}`)
        }
      })
      res.on('end', () => file.end())
      res.on('error', fail)
      res.on('aborted', () => fail(new Error(`download aborted for ${url}`)))
      file.on('finish', () => {
        if (settled) return
        settled = true
        file.close(() => resolve())
      })
      file.on('error', fail)
    })
    req.on('error', reject)
    req.setTimeout(60_000, () => req.destroy(new Error(`download stalled for ${url}`)))
  })
}

// A prebuilt bundle is ~120 MB, so one flaky moment must not lose the whole
// update: keep the partial file, resume from its length and retry.
async function download(url, dest, attempts = 3) {
  let lastError = null
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const offset = existsSync(dest) ? statSync(dest).size : 0
      await downloadOnce(url, dest, offset)
      return
    } catch (error) {
      lastError = error
      if (attempt < attempts) {
        emitLine(`STATUS=下载中断，正在重试（${attempt + 1}/${attempts}）…`)
        await new Promise(resolve => setTimeout(resolve, 1500 * attempt))
      }
    }
  }
  rmSync(dest, { force: true })
  throw lastError
}

function run(command, args, env) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: env ? { ...process.env, ...env } : process.env,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout}`)
  return result.stdout
}

function runWithLog(command, args, env, logPath, flags = 'w') {
  mkdirSync(dirname(logPath), { recursive: true })
  const fd = openSync(logPath, flags)
  try {
    const result = spawnSync(command, args, {
      encoding: 'utf8',
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ['ignore', fd, fd],
    })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`${command} failed: see ${logPath}`)
    return result.stdout
  } finally {
    closeSync(fd)
  }
}

function nodeExecutablePath() {
  return isWindows ? join(nodeRuntimeDir, 'node.exe') : join(nodeRuntimeDir, 'bin', 'node')
}

function nodeNpmPath() {
  return isWindows ? join(nodeRuntimeDir, 'npm.cmd') : join(nodeRuntimeDir, 'bin', 'npm')
}

function nodeBinDir() {
  return isWindows ? nodeRuntimeDir : join(nodeRuntimeDir, 'bin')
}

// npm's shebang is `#!/usr/bin/env node`, and an app launched from Finder gets a
// minimal PATH, so probing/launching npm needs a PATH carrying a runnable node:
// the runtime we manage first, then the node the updater itself runs under.
function pathWithNode() {
  const separator = isWindows ? ';' : ':'
  const dirs = [nodeBinDir(), dirname(process.execPath)]
  if (process.env.PATH) dirs.push(process.env.PATH)
  return dirs.join(separator)
}

async function installNodeRuntime() {
  const platform = isWindows ? 'win-x64' : `darwin-${process.arch}`
  const archiveName = `node-${NODE_VERSION}-${platform}.${isWindows ? 'zip' : 'tar.gz'}`
  const url = `https://nodejs.org/dist/${NODE_VERSION}/${archiveName}`
  const archive = join(downloadsDir, archiveName)
  emitLine('STATUS=正在下载 Node 运行环境…')
  await download(url, archive)

  emitLine('STATUS=正在解压 Node 运行环境…')
  const extractDir = join(downloadsDir, `.node-${NODE_VERSION}-${platform}`)
  rmSync(extractDir, { recursive: true, force: true })
  mkdirSync(extractDir, { recursive: true })
  const tar = isWindows ? 'tar.exe' : 'tar'
  run(tar, ['-xf', archive, '-C', extractDir])

  const extracted = join(extractDir, `node-${NODE_VERSION}-${platform}`)
  if (!existsSync(extracted)) throw new Error('node archive extraction produced an unexpected layout')

  emitLine('STATUS=正在准备 Node 运行环境…')
  rmSync(nodeRuntimeDir, { recursive: true, force: true })
  mkdirSync(nodeRuntimeDir, { recursive: true })
  cpSync(extracted, nodeRuntimeDir, { recursive: true })
  if (!existsSync(nodeExecutablePath())) throw new Error('downloaded node runtime is missing the node executable')
}

function findNpm() {
  if (existsSync(nodeNpmPath())) return nodeNpmPath()
  const nodeDir = dirname(process.execPath)
  const candidates = isWindows
    ? ['npm.cmd', 'npm', join(nodeDir, 'npm.cmd'), join(nodeDir, 'npm'),
       'C:\\Program Files\\nodejs\\npm.cmd', `${process.env.APPDATA}\\npm\\npm.cmd`]
    : ['npm', join(nodeDir, 'npm'), '/opt/homebrew/bin/npm', '/usr/local/bin/npm', '/usr/bin/npm',
       `${home}/.npm-global/bin/npm`, `${home}/.local/bin/npm`]
  // Include nvm/asdf/volta installs, the same locations the native shell scans.
  try {
    const nvmRoot = join(home, '.nvm', 'versions', 'node')
    for (const version of readdirSync(nvmRoot)) {
      candidates.push(join(nvmRoot, version, 'bin', 'npm'))
    }
  } catch {}
  try {
    const asdfRoot = join(home, '.asdf', 'installs', 'nodejs')
    for (const version of readdirSync(asdfRoot)) {
      candidates.push(join(asdfRoot, version, 'bin', 'npm'))
    }
  } catch {}
  candidates.push(join(home, '.volta', 'bin', 'npm'), join(home, '.bun', 'bin', 'npm'))
  const env = { PATH: pathWithNode() }
  for (const candidate of candidates) {
    try {
      run(candidate, ['--version'], env)
      return candidate
    } catch {
      // try the next location
    }
  }
  throw new Error('npm not found; cannot install core dependencies')
}

// Prebuilt runtime bundles ship only the node binary, so when no system npm
// exists fall back to the full Node distribution, which bundles npm.
async function ensureNpm() {
  try {
    return findNpm()
  } catch {
    await installNodeRuntime()
    return findNpm()
  }
}

function extractTgz(tgz, dest) {
  mkdirSync(dest, { recursive: true })
  const tar = isWindows ? 'tar.exe' : 'tar'
  run(tar, ['-xzf', tgz, '-C', dest])
}

function readCurrentCoreVersion() {
  try {
    const raw = readFileSync(currentFile, 'utf8').trim()
    return raw || null
  } catch {
    return null
  }
}

function currentCoreDir(version) {
  return join(versionsDir, version)
}

function coreEntryPath() {
  const version = readCurrentCoreVersion()
  if (!version) return null
  const root = currentCoreDir(version)
  if (!existsSync(join(root, COMPLETE_MARKER))) return null
  const npmLib = join(root, 'node_modules', NPM_PACKAGE, 'lib', 'bin.js')
  return existsSync(npmLib) ? npmLib : null
}

async function coreLatest() {
  // Prereleases are published under their channel's dist-tag, so resolve the
  // tag matching the installed core instead of always trusting `latest`.
  const channel = coreChannel(readCurrentCoreVersion() || '')
  const tags = await requestJSON(`${NPM_REGISTRY}/-/package/${NPM_PACKAGE}/dist-tags`)
  const candidates = [...new Set([channel, 'latest'])]
    .filter(tag => typeof tags[tag] === 'string' && tags[tag])
  if (candidates.length === 0) throw new Error(`no dist-tags published for ${NPM_PACKAGE}`)
  // Take the highest across the channel tag and `latest` so a graduated stable
  // release still wins over a newer prerelease.
  const version = candidates.reduce(
    (best, tag) => (best === '' || compareVersions(tags[tag], best) > 0 ? tags[tag] : best),
    '',
  )
  const manifest = await requestJSON(`${NPM_REGISTRY}/${NPM_PACKAGE}/${version}`)
  return {
    version,
    tarball: manifest.dist?.tarball,
    integrity: manifest.dist?.integrity || '',
  }
}

async function shellLatest() {
  try {
    const viaAPI = await shellLatestViaAPI()
    if (viaAPI.version) return viaAPI
  } catch {
    // Rate-limited or offline: fall back to the redirect below.
  }
  return await shellLatestFallback()
}

// The anonymous GitHub API allows only 60 requests per hour per IP and is
// often rate-limited behind NAT, so resolve the newest app release through
// the /releases/latest redirect, which needs no API call.
async function shellLatestFallback() {
  const tag = await resolveReleaseTag(REPO)
  if (tag.startsWith("app-v") == false) return { version: "", url: "", assetUrl: "" }
  const version = tag.slice(5)
  const suffix = isWindows ? "windows-x64.zip" : "macos-universal.zip"
  return {
    version,
    url: "https://github.com/" + REPO + "/releases/tag/" + tag,
    assetUrl: "https://github.com/" + REPO + "/releases/download/" + tag + "/DeepSeek-Harness-" + version + "-" + suffix,
  }
}
async function shellLatestViaAPI() {
  const releases = await requestJSON(`https://api.github.com/repos/${REPO}/releases?per_page=20`)
  const release = highestRelease(releases, 'app-v')
  if (!release) {
    return { version: '', url: '', assetUrl: '' }
  }
  const tag = release.tag_name || ''
  const version = tag.startsWith('app-v') ? tag.slice(5) : tag
  let assetUrl = ''
  if (Array.isArray(release.assets)) {
    const wanted = isWindows ? 'windows-x64.zip' : 'macos-universal.zip'
    const asset = release.assets.find(item => item.name?.includes(wanted))
    if (asset) assetUrl = asset.browser_download_url || ''
  }
  return {
    version,
    url: release.html_url || '',
    assetUrl,
  }
}

const RUNTIME_REPO = 'Skyearn/deepseek-harness-runtime'

async function runtimeBundleUrl() {
  try {
    const releases = await requestJSON(`https://api.github.com/repos/${RUNTIME_REPO}/releases?per_page=20`)
    const release = highestRelease(releases, 'dsh-runtime-')
    if (release && Array.isArray(release.assets)) {
      const wanted = isWindows ? 'windows-x64' : 'macos-universal'
      const asset = release.assets.find(item =>
        item.name?.startsWith('dsh-runtime-') &&
        item.name.includes(wanted) &&
        (item.name.endsWith('.tar.gz') || item.name.endsWith('.zip'))
      )
      if (asset?.browser_download_url) return asset.browser_download_url
    }
  } catch {
    // Rate-limited or unavailable; the redirect below needs no API token.
  }
  // Fall back to the newest release by convention:
  // dsh-runtime-<version>-<platform>.{tar.gz,zip}
  const tag = await resolveReleaseTag(RUNTIME_REPO)
  const version = tag.startsWith('dsh-runtime-') ? tag.slice('dsh-runtime-'.length) : ''
  if (!version) return ''
  const suffix = isWindows ? 'windows-x64.zip' : 'macos-universal.tar.gz'
  return `https://github.com/${RUNTIME_REPO}/releases/download/${tag}/dsh-runtime-${version}-${suffix}`
}

function output(entries) {
  for (const [key, value] of entries) {
    process.stdout.write(`${key}=${value}\n`)
  }
}

function argValue(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : null
}

async function check() {
  const shellCurrent = argValue('--shell-current') || ''
  // The shell lives on the GitHub API and the core on the npm registry; a
  // failure of one (rate limit, outage) must not hide the other, so report the
  // side that answered and leave the other blank for the shells to surface.
  const [shellResult, coreResult] = await Promise.allSettled([shellLatest(), coreLatest()])
  if (shellResult.status === 'rejected' && coreResult.status === 'rejected') {
    throw shellResult.reason
  }
  const shell = shellResult.status === 'fulfilled'
    ? shellResult.value
    : { version: '', url: '', assetUrl: '' }
  const core = coreResult.status === 'fulfilled'
    ? coreResult.value
    : { version: '', tarball: '', integrity: '' }
  const coreCurrent = readCurrentCoreVersion() || ''
  output([
    ['SHELL_CURRENT', shellCurrent],
    ['SHELL_LATEST', shell.version],
    ['SHELL_HAS_UPDATE', hasUpdate(shellCurrent, shell.version)],
    ['SHELL_URL', shell.url],
    ['SHELL_ASSET_URL', shell.assetUrl],
    ['CORE_CURRENT', coreCurrent],
    ['CORE_LATEST', core.version],
    ['CORE_HAS_UPDATE', hasUpdate(coreCurrent, core.version)],
    ['CORE_TARBALL', core.tarball || ''],
    ['CORE_INTEGRITY', core.integrity || ''],
  ])
}

async function updateCore() {
  const current = readCurrentCoreVersion() || ''

  // Two sources: the prebuilt bundle published by the runtime repository (no
  // npm involved) and the npm registry (channel-aware). Ask both, then install
  // whichever offers the newer version; the bundle wins ties.
  let bundleUrl = ''
  try {
    bundleUrl = await runtimeBundleUrl()
  } catch {
    // GitHub unreachable: npm below may still work.
  }
  const bundleVersion = bundleUrl ? runtimeBundleVersion(bundleUrl) : ''

  let latest = null
  try {
    latest = await coreLatest()
  } catch (error) {
    if (!bundleVersion) throw error
  }
  const latestVersion = latest ? latest.version : ''

  const preferBundle = bundleVersion
    && (!latestVersion || compareVersions(bundleVersion, latestVersion) >= 0)
  const target = preferBundle ? bundleVersion : latestVersion
  if (!target) throw new Error('no dsh version available to install')

  // Already on the newest version: leave the installation, the `current` file
  // and the running server untouched instead of re-selecting the same version.
  if (current && compareVersions(target, current) <= 0) {
    output([['CORE_VERSION', current], ['CORE_UPDATED', '0'], ['CORE_ALREADY_LATEST', '1']])
    return
  }

  emitLine("TARGET_VERSION=" + target)
  if (preferBundle) {
    await installRuntimeBundle(bundleUrl)
    output([['CORE_VERSION', readCurrentCoreVersion() || bundleVersion], ['CORE_UPDATED', '1']])
    return
  }

  const version = target
  const dest = currentCoreDir(version)
  const installedEntry = join(dest, 'node_modules', NPM_PACKAGE, 'lib', 'bin.js')
  if (existsSync(installedEntry) && existsSync(join(dest, COMPLETE_MARKER))) {
    writeFileSync(currentFile, version)
    output([['CORE_VERSION', version], ['CORE_UPDATED', '1']])
    return
  }

  const npm = await ensureNpm()
  const npmEnv = { PATH: pathWithNode() }
  const temp = join(versionsDir, `.tmp-${version}`)
  rmSync(temp, { recursive: true, force: true })
  mkdirSync(temp, { recursive: true })

  // npm install creates the full dependency tree. The published @deepseek-ai/dsh
  // tarball is only the CLI entry package; its workspace dependencies are not
  // included in the tarball, so extracting it alone is not runnable.
  //
  // A configured mirror (npmjs.com/.npmrc proxy) serves metadata and can lag
  // behind a freshly published version for ANY scope in the tree, so try the
  // configured registry first, then fall back to the registry the version was
  // resolved from.
  emitLine('STATUS=正在安装 DSH 内核…')
  const npmLogPath = join(runtimeDir, 'npm-install.log')
  const installArgs = (registryArgs) => [
    'install', '--prefix', temp, '--no-audit', '--no-fund', '--prefer-offline',
    ...registryArgs,
    `${NPM_PACKAGE}@${version}`,
  ]
  try {
    runWithLog(npm, installArgs([`--${NPM_SCOPE}:registry=${NPM_REGISTRY}`]), npmEnv, npmLogPath)
  } catch (error) {
    rmSync(temp, { recursive: true, force: true })
    mkdirSync(temp, { recursive: true })
    emitLine('STATUS=镜像缺少依赖，正在改用官方源重试…')
    runWithLog(npm, installArgs([`--registry=${NPM_REGISTRY}`]), npmEnv, npmLogPath, 'a')
  }

  if (!existsSync(join(temp, 'node_modules', NPM_PACKAGE, 'lib', 'bin.js'))) {
    throw new Error('npm install did not produce the expected dsh CLI entry')
  }

  rmSync(dest, { recursive: true, force: true })
  renameSync(temp, dest)
  writeFileSync(join(dest, COMPLETE_MARKER), version)
  writeFileSync(currentFile, version)
  output([['CORE_VERSION', version], ['CORE_UPDATED', '1']])
}

async function bootstrap() {
  let url = ''
  try {
    url = await runtimeBundleUrl()
  } catch {
    // GitHub unreachable; fall back to npm below.
  }
  if (url) {
    await installRuntimeBundle(url)
    output([['CORE_VERSION', readCurrentCoreVersion() || ''], ['CORE_UPDATED', '1']])
  } else {
    await updateCore()
  }
}

/// Downloads, verifies and atomically switches to a prebuilt runtime bundle
/// published by the runtime repository. No npm, no registry, no mirror.
async function installRuntimeBundle(url) {
  const archiveName = basename(url)
  const archive = join(downloadsDir, archiveName)
  emitLine('STATUS=正在下载预构建运行环境…')
  await download(url, archive)

  emitLine('STATUS=正在解压预构建运行环境…')
  const temp = join(runtimeDir, '.prebuilt-tmp')
  rmSync(temp, { recursive: true, force: true })
  mkdirSync(temp, { recursive: true })
  const tar = isWindows ? 'tar.exe' : 'tar'
  run(tar, ['-xf', archive, '-C', temp])

  const sourceRoot = existsSync(join(temp, 'runtime', 'current')) ? join(temp, 'runtime') : temp
  if (!existsSync(join(sourceRoot, 'current')) || !existsSync(join(sourceRoot, 'node'))) {
    throw new Error('prebuilt runtime archive has an unexpected layout')
  }

  rmSync(join(runtimeDir, 'node'), { recursive: true, force: true })
  rmSync(join(runtimeDir, 'versions'), { recursive: true, force: true })
  rmSync(join(runtimeDir, 'current'), { recursive: true, force: true })
  for (const name of ['node', 'versions', 'current']) {
    if (existsSync(join(sourceRoot, name))) {
      renameSync(join(sourceRoot, name), join(runtimeDir, name))
    }
  }
  if (!existsSync(nodeExecutablePath()) || !existsSync(currentFile)) {
    throw new Error('prebuilt runtime is incomplete')
  }
  const version = readCurrentCoreVersion()
  if (version && !existsSync(join(currentCoreDir(version), COMPLETE_MARKER))) {
    throw new Error('prebuilt runtime missing .complete marker')
  }
  // The bundle carries npm's leftover package.json/package-lock.json at its
  // root; drop the extraction scratch dir once node/versions/current moved.
  rmSync(temp, { recursive: true, force: true })
  return version || ''
}

/// `dsh-runtime-0.1.5-rc.2-macos-universal.tar.gz` -> `0.1.5-rc.2`
function runtimeBundleVersion(url) {
  const match = basename(url).match(/^dsh-runtime-(.+?)-(?:macos-universal|windows-x64)\.(?:tar\.gz|zip)$/)
  return match ? match[1] : ''
}

async function downloadShell() {
  const shell = await shellLatest()
  if (!shell.assetUrl) throw new Error('no shell asset found in the latest release')
  emitLine("TARGET_VERSION=" + shell.version)
  const destination = join(appSupport, 'downloads', `DeepSeek-Harness-${shell.version}${isWindows ? '-windows-x64.zip' : '-macos-universal.zip'}`)
  await download(shell.assetUrl, destination)
  output([
    ['SHELL_VERSION', shell.version],
    ['SHELL_DOWNLOAD', destination],
    ['SHELL_DOWNLOADED', '1'],
  ])
}

// An unhandled async error would otherwise kill the process without printing
// anything the shells can show, leaving them with a wall of PROGRESS lines.
process.on('uncaughtException', (error) => {
  process.stdout.write(`ERROR: ${error && error.message ? error.message : String(error)}\n`)
  process.exit(1)
})

const command = process.argv[2] || 'check'
try {
  if (command === 'check') await check()
  else if (command === 'update-core') await updateCore()
  else if (command === 'bootstrap') {
    await bootstrap()
    output([['BOOTSTRAP_OK', '1']])
  }
  else if (command === 'download-shell') await downloadShell()
  else throw new Error(`unknown command: ${command}`)
} catch (error) {
  process.stdout.write(`ERROR: ${error.message}\n`)
  process.exit(1)
}
