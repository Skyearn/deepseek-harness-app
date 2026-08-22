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
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, renameSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

const REPO = 'Skyearn/deepseek-harness-app'
const NPM_PACKAGE = '@deepseek-ai/dsh'
const COMPLETE_MARKER = '.complete'

const isWindows = process.platform === 'win32'
const home = process.env.HOME || process.env.USERPROFILE || tmpdir()

const appSupport = isWindows
  ? join(process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'DeepSeek Harness')
  : join(home, 'Library', 'Application Support', 'DeepSeek Harness')

const runtimeDir = join(appSupport, 'runtime')
const versionsDir = join(runtimeDir, 'versions')
const downloadsDir = join(runtimeDir, 'downloads')
const currentFile = join(runtimeDir, 'current')

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
      const file = createWriteStream(dest)
      res.pipe(file)
      file.on('finish', () => file.close(() => resolve()))
      file.on('error', reject)
    })
    req.on('error', reject)
  })
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout}`)
  return result.stdout
}

function findNpm() {
  const candidates = isWindows
    ? ['npm.cmd', 'npm', 'C:\\Program Files\\nodejs\\npm.cmd', `${process.env.APPDATA}\\npm\\npm.cmd`]
    : ['npm', '/opt/homebrew/bin/npm', '/usr/local/bin/npm', '/usr/bin/npm']
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

  const npm = findNpm()
  const temp = join(versionsDir, `.tmp-${version}`)
  rmSync(temp, { recursive: true, force: true })
  mkdirSync(temp, { recursive: true })

  // npm install creates the full dependency tree. The published @deepseek-ai/dsh
  // tarball is only the CLI entry package; its workspace dependencies are not
  // included in the tarball, so extracting it alone is not runnable.
  run(npm, ['install', '--prefix', temp, '--no-audit', '--no-fund', `${NPM_PACKAGE}@${version}`])

  if (!existsSync(join(temp, 'node_modules', NPM_PACKAGE, 'lib', 'bin.js'))) {
    throw new Error('npm install did not produce the expected dsh CLI entry')
  }

  rmSync(dest, { recursive: true, force: true })
  renameSync(temp, dest)
  writeFileSync(join(dest, COMPLETE_MARKER), version)
  writeFileSync(currentFile, version)
  output([['CORE_VERSION', version], ['CORE_UPDATED', '1']])
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
  else if (command === 'download-shell') await downloadShell()
  else throw new Error(`unknown command: ${command}`)
} catch (error) {
  process.stderr.write(`ERROR: ${error.message}\n`)
  process.exit(1)
}
