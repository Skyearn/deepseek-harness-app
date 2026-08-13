# Build the "DeepSeek Harness" Windows launcher for dsh web.
#
# The launcher mirrors the macOS shell: it launches `dsh web`, opens the
# default browser, and terminates the server's process tree on quit so the
# port is released. Compiled with the .NET Framework csc.exe that ships with
# Windows, so no SDK is required.
#
# Usage: build.ps1 [-BundleDsh] [-DshVersion <version>]
#   -BundleDsh    npm-install @deepseek-ai/dsh beside the exe so the folder is
#                 self-contained. The version comes from -DshVersion or the
#                 DSH_BUNDLE_VERSION environment variable (default: latest).
param(
  [switch]$BundleDsh,
  [string]$DshVersion = ''
)

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$outDir = Join-Path $scriptDir 'build'
$exe = Join-Path $outDir 'DeepSeek Harness.exe'
if (-not $DshVersion) { $DshVersion = $env:DSH_BUNDLE_VERSION; if (-not $DshVersion) { $DshVersion = 'latest' } }

Write-Host "==> Compiling $exe"
New-Item -ItemType Directory -Force $outDir | Out-Null
$csc = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) { $csc = "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe" }
if (-not (Test-Path $csc)) { throw "csc.exe not found; .NET Framework 4.x is required" }

& $csc /nologo /target:winexe "/out:$exe" `
  /r:System.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll /r:System.Management.dll `
  (Join-Path $scriptDir 'Sources\Program.cs')
if ($LASTEXITCODE -ne 0) { throw "csc failed with exit code $LASTEXITCODE" }

if ($BundleDsh) {
  $dshDir = Join-Path $outDir 'dsh'
  Write-Host "==> Bundling @deepseek-ai/dsh@$DshVersion into $dshDir"
  npm install --prefix $dshDir "@deepseek-ai/dsh@$DshVersion"
  if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
}

Write-Host "==> Done: $exe"
