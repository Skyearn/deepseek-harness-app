#!/usr/bin/env node
// Shell/Core update helper for DeepSeek Harness desktop apps.
// Zero-dependency: uses Node builtins only.
//
// Commands:
//   node updater.mjs check --shell-current <version>
//   node updater.mjs update-core
//   node updater.mjs download-shell --shell-current <version>
//
// Output is line oriented so both the Swift and C# shells can parse it.

import https from 'node:https'
import { createWriteStream, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, renameSync, writeFileSync, openSync, closeSync } from 'node:fs'
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

function emitLine(line) {
  process.stdout.write(`${line}\n`)
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    mkdirSync(dirname(dest), { recursive: true })
    const req = https.get(url, { headers: { 'user-agent': 'deepseek-harness-updater' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        return download(new URL(res.headers.location, url), dest).then(resolve, reject)
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`))
        return
      }
      const total = Number(res.headers['content-length'] || 0)
      let downloaded = 0
      let lastReport = 0
      const file = createWriteStream(dest)
      res.on('data', chunk => {
        downloaded += chunk.length
        file.write(chunk)
        if (total > 0 && (downloaded - lastReport >= 1024 * 1024 || downloaded === total)) {
          lastReport = downloaded
          emitLine(`PROGRESS=${downloaded}/${total}`)
        }
      })
      res.on('end', () => {
        file.end()
      })
      file.on('finish', () => file.close(() => resolve()))
      file.on('error', reject)
    })
    req.on('error', reject)
  })
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

function runWithLog(command, args, env, logPath) {
  mkdirSync(dirname(logPath), { recursive: true })
  const fd = openSync(logPath, 'w')
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

async function ensureNodeRuntime() {
  if (existsSync(nodeExecutablePath())) return
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
  const candidates = isWindows
    ? ['npm.cmd', 'npm', 'C:\\Program Files\\nodejs\\npm.cmd', `${process.env.APPDATA}\\npm\\npm.cmd`]
    : ['npm', '/opt/homebrew/bin/npm', '/usr/local/bin/npm', '/usr/bin/npm',
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
  for (const candidate of candidates) {
    try {
      run(candidate, ['--version'])
      return candidate
    } catch {
      // try the next location
    }
  }
  throw new Error('npm not found; cannot install core dependencies')
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
  const pkg = await requestJSON(`https://registry.npmjs.org/${NPM_PACKAGE}/latest`)
  return {
    version: pkg.version,
    tarball: pkg.dist?.tarball,
    integrity: pkg.dist?.integrity || '',
  }
}

async function shellLatest() {
  const release = await requestJSON(`https://api.github.com/repos/${REPO}/releases/latest`)
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

async function runtimeBundleUrl() {
  const releases = await requestJSON(`https://api.github.com/repos/${REPO}/releases?per_page=20`)
  if (!Array.isArray(releases)) return ''
  const release = releases.find(item => item.tag_name?.startsWith('dsh-runtime-'))
  if (!release || !Array.isArray(release.assets)) return ''
  const wanted = isWindows ? 'windows-x64' : 'macos-universal'
  const asset = release.assets.find(item =>
    item.name?.startsWith('dsh-runtime-') &&
    item.name.includes(wanted) &&
    (item.name.endsWith('.tar.gz') || item.name.endsWith('.zip'))
  )
  return asset?.browser_download_url || ''
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
  const [shell, core] = await Promise.all([shellLatest(), coreLatest()])
  output([
    ['SHELL_CURRENT', shellCurrent],
    ['SHELL_LATEST', shell.version],
    ['SHELL_URL', shell.url],
    ['SHELL_ASSET_URL', shell.assetUrl],
    ['CORE_CURRENT', readCurrentCoreVersion() || ''],
    ['CORE_LATEST', core.version],
    ['CORE_TARBALL', core.tarball || ''],
    ['CORE_INTEGRITY', core.integrity || ''],
  ])
}

async function updateCore() {
  const latest = await coreLatest()
  const version = latest.version
  const dest = currentCoreDir(version)

  const installedEntry = join(dest, 'node_modules', NPM_PACKAGE, 'lib', 'bin.js')
  if (existsSync(installedEntry) && existsSync(join(dest, COMPLETE_MARKER))) {
    writeFileSync(currentFile, version)
    output([['CORE_VERSION', version], ['CORE_UPDATED', '1']])
    return
  }

  await ensureNodeRuntime()
  const npm = findNpm()
    const nodeBinDir = isWindows ? nodeRuntimeDir : join(nodeRuntimeDir, 'bin')
    const npmEnv = { PATH: nodeBinDir + (isWindows ? ';' : ':') + (process.env.PATH || '') }
  const temp = join(versionsDir, `.tmp-${version}`)
  rmSync(temp, { recursive: true, force: true })
  mkdirSync(temp, { recursive: true })

  // npm install creates the full dependency tree. The published @deepseek-ai/dsh
  // tarball is only the CLI entry package; its workspace dependencies are not
  // included in the tarball, so extracting it alone is not runnable.
  emitLine('STATUS=正在安装 DSH 内核…')
    const npmLogPath = join(runtimeDir, 'npm-install.log')
    runWithLog(npm, ['install', '--prefix', temp, '--no-audit', '--no-fund', '--prefer-offline', `${NPM_PACKAGE}@${version}`], npmEnv, npmLogPath)

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
  const url = await runtimeBundleUrl()
  if (url) {
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
    output([['CORE_VERSION', version || ''], ['CORE_UPDATED', '1']])
  } else {
    await updateCore()
  }
}

async function downloadShell() {
  const shell = await shellLatest()
  if (!shell.assetUrl) throw new Error('no shell asset found in the latest release')
  const destination = join(appSupport, 'downloads', `DeepSeek-Harness-${shell.version}${isWindows ? '-windows-x64.zip' : '-macos-universal.zip'}`)
  await download(shell.assetUrl, destination)
  output([
    ['SHELL_VERSION', shell.version],
    ['SHELL_DOWNLOAD', destination],
    ['SHELL_DOWNLOADED', '1'],
  ])
}

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
