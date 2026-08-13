# End-to-end lifecycle test for the DeepSeek Harness Windows launcher.
#
# Phase 1: launch the app on a test port with a workspace-local DSH_HOME and
# state dir; verify the server comes up (lock file, then port); close the app
# window (taskkill /PID sends WM_CLOSE) and verify the port is released, the
# server's process tree is dead, and the lock file is gone.
# Phase 2: hard-kill the app, confirm the orphaned server survives, relaunch
# and confirm recovery reclaims the orphan, then quit cleanly.
$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = (Resolve-Path (Join-Path $scriptDir '..\..\..')).Path
$exe = Join-Path $scriptDir '..\build\DeepSeek Harness.exe'
$testPort = 3199
$stateDir = Join-Path $repoRoot '.cache\shell-state'
$dshHome = Join-Path $repoRoot '.cache\shell-dsh-home'
$appProcesses = @()

function Test-PortOpen([int]$port) {
  try {
    $c = New-Object System.Net.Sockets.TcpClient
    try {
      $iar = $c.BeginConnect('127.0.0.1', $port, $null, $null)
      $ok = $iar.AsyncWaitHandle.WaitOne(300)
      if ($ok) { $c.EndConnect($iar) }
      return $ok
    } finally { $c.Close() }
  } catch { return $false }
}

function Wait-Port([int]$port, [bool]$wantOpen, [int]$timeoutSec) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  while ($sw.Elapsed.TotalSeconds -lt $timeoutSec) {
    if ((Test-PortOpen $port) -eq $wantOpen) { return $true }
    Start-Sleep -Milliseconds 100
  }
  return $false
}

function Wait-Lock([string]$path, [string]$excludePid) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  while ($sw.Elapsed.TotalSeconds -lt 120) {
    if (Test-Path $path) {
      $first = (Get-Content $path -ErrorAction SilentlyContinue).Split(' ')[0]
      if (-not $excludePid -or $first -ne $excludePid) { return $true }
    }
    Start-Sleep -Milliseconds 100
  }
  return $false
}

function Read-ServerPid {
  $content = Get-Content (Join-Path $stateDir 'server.pid') -ErrorAction SilentlyContinue
  if (-not $content) { return 0 }
  return [int]($content.Split(' ')[0])
}

function Stop-LockServers {
  if (Test-Path $stateDir) {
    Get-ChildItem $stateDir -Filter '*.pid' | ForEach-Object {
      $sp = (Get-Content $_.FullName -ErrorAction SilentlyContinue).Split(' ')[0]
      if ($sp) { & taskkill /PID $sp /T /F 2>$null | Out-Null }
    }
  }
}

function Launch-App {
  $argList = @('-port', "$testPort", '-stateDir', "`"$stateDir`"", '-openBrowserOnLaunch', '0', '-singleInstance', '0')
  $app = Start-Process -FilePath $exe -ArgumentList $argList -PassThru
  $script:appProcesses += $app
  Write-Host "app pid=$($app.Id)"
  return $app
}

function Stop-App([int]$appPid) { & taskkill /PID $appPid 2>$null | Out-Null }
function Stop-AppForce([int]$appPid) { & taskkill /F /PID $appPid 2>$null | Out-Null }

try {
  # --- Phase 1: graceful quit --------------------------------------------------
  Write-Host '==> phase 1: graceful quit'
  Remove-Item -Recurse -Force $stateDir, $dshHome -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force $stateDir | Out-Null
  $env:DSH_HOME = $dshHome

  $app = Launch-App
  if (-not (Wait-Lock (Join-Path $stateDir 'server.pid') '')) { throw 'phase 1: no server.pid lock' }
  $serverPid = Read-ServerPid
  if ($serverPid -le 0) { throw 'phase 1: server.pid has no pid' }
  if (-not (Wait-Port $testPort $true 60)) { throw 'phase 1: port did not open' }
  Write-Host "PASS: phase 1: server process $serverPid alive, lock file present, port open"

  Write-Host '==> phase 1: closing the app window (WM_CLOSE)'
  Stop-App $app.Id
  $app.WaitForExit(30000) | Out-Null

  if (-not (Wait-Port $testPort $false 30)) { throw 'phase 1: port still open after quit' }
  Write-Host 'PASS: phase 1: port released after quit'
  if (Get-Process -Id $serverPid -ErrorAction SilentlyContinue) { throw 'phase 1: server process still alive' }
  Write-Host 'PASS: phase 1: server process gone after quit'
  if (Test-Path (Join-Path $stateDir 'server.pid')) { throw 'phase 1: server.pid lock not removed' }
  Write-Host 'PASS: phase 1: server.pid lock removed after quit'

  # --- Phase 2: crash recovery --------------------------------------------------
  Write-Host ''
  Write-Host '==> phase 2: crash recovery (taskkill /F leaves an orphaned server)'
  Remove-Item -Recurse -Force $stateDir, $dshHome -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force $stateDir | Out-Null

  $app = Launch-App
  if (-not (Wait-Lock (Join-Path $stateDir 'server.pid') '')) { throw 'phase 2: no server.pid lock' }
  $orphanPid = Read-ServerPid
  if (-not (Wait-Port $testPort $true 60)) { throw 'phase 2: port did not open' }
  Write-Host "PASS: phase 2: server running (pid $orphanPid)"

  Write-Host '==> phase 2: hard-killing the app (simulated crash)'
  Stop-AppForce $app.Id
  $app.WaitForExit(10000) | Out-Null
  Start-Sleep -Seconds 1

  if (-not (Get-Process -Id $orphanPid -ErrorAction SilentlyContinue)) { throw 'phase 2: orphan server died unexpectedly' }
  Write-Host "PASS: phase 2: orphaned server $orphanPid survives the app crash"

  Write-Host '==> phase 2: relaunching the app (recovery should reclaim the orphan)'
  $app = Launch-App
  if (-not (Wait-Lock (Join-Path $stateDir 'server.pid') "$orphanPid")) { throw 'phase 2: no new server.pid lock' }
  $newPid = Read-ServerPid
  if (-not (Wait-Port $testPort $true 60)) { throw 'phase 2: port did not reopen' }
  Start-Sleep -Seconds 2

  if (Get-Process -Id $orphanPid -ErrorAction SilentlyContinue) { throw 'phase 2: orphaned server was not reclaimed' }
  Write-Host "PASS: phase 2: orphaned server $orphanPid reclaimed"
  if (-not (Get-Process -Id $newPid -ErrorAction SilentlyContinue)) { throw 'phase 2: new server not alive' }
  Write-Host "PASS: phase 2: new server running (pid $newPid), port open"

  Stop-App $app.Id
  $app.WaitForExit(30000) | Out-Null
  if (-not (Wait-Port $testPort $false 30)) { throw 'phase 2: port still open after quit' }
  Write-Host 'PASS: phase 2: port released after quit'

  Write-Host '==> all lifecycle tests passed'
}
finally {
  foreach ($app in $appProcesses) {
    if ($app -and -not $app.HasExited) { Stop-AppForce $app.Id }
  }
  Stop-LockServers
}
