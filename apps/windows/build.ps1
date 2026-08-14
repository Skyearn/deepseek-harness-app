# Build the "DeepSeek Harness" Windows launcher for dsh web.
#
# The launcher mirrors the macOS shell: it launches `dsh web`, embeds the
# served UI in a WebView2 control, and terminates the server's process tree on
# quit so the port is released. Compiled with the .NET Framework csc.exe that
# ships with Windows; the WebView2 SDK assemblies and loader are downloaded
# from NuGet, so no SDK is required.
#
# Usage: build.ps1 [-BundleDsh] [-DshVersion <version>]
#   -BundleDsh    npm-install @deepseek-ai/dsh beside the exe so the folder is
#                 self-contained. The version comes from -DshVersion or the
#                 DSH_BUNDLE_VERSION environment variable (default: latest).
#   WEBVIEW2_SDK_VERSION  pins the WebView2 SDK version (default: latest stable).
param(
  [switch]$BundleDsh,
  [string]$DshVersion = ''
)

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$outDir = Join-Path $scriptDir 'build'
$exe = Join-Path $outDir 'DeepSeek Harness.exe'
if (-not $DshVersion) { $DshVersion = $env:DSH_BUNDLE_VERSION; if (-not $DshVersion) { $DshVersion = 'latest' } }

Write-Host "==> Preparing $outDir"
New-Item -ItemType Directory -Force $outDir | Out-Null

# --- WebView2 SDK (managed wrappers + x64 loader) -----------------------------
$webView2Version = $env:WEBVIEW2_SDK_VERSION
if (-not $webView2Version) {
  $index = Invoke-RestMethod 'https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/index.json'
  $webView2Version = ($index.versions | Where-Object { $_ -notmatch '-' })[-1]
}
Write-Host "==> Downloading Microsoft.Web.WebView2 $webView2Version"
$nupkg = Join-Path $env:TEMP "microsoft.web.webview2.$webView2Version.nupkg"
if (-not (Test-Path $nupkg)) {
  Invoke-WebRequest "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$webView2Version/microsoft.web.webview2.$webView2Version.nupkg" -OutFile $nupkg
}
$extract = Join-Path $env:TEMP "webview2-$webView2Version"
if (Test-Path $extract) { Remove-Item -Recurse -Force $extract }
$zip = "$extract.zip"
Copy-Item $nupkg $zip -Force
Expand-Archive $zip $extract
Copy-Item (Join-Path $extract 'lib\net462\Microsoft.Web.WebView2.Core.dll') $outDir
Copy-Item (Join-Path $extract 'lib\net462\Microsoft.Web.WebView2.WinForms.dll') $outDir
Copy-Item (Join-Path $extract 'runtimes\win-x64\native\WebView2Loader.dll') $outDir

# --- Compile ------------------------------------------------------------------
Write-Host "==> Compiling $exe"
$csc = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) { $csc = "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe" }
if (-not (Test-Path $csc)) { throw "csc.exe not found; .NET Framework 4.x is required" }

& $csc /nologo /target:winexe "/out:$exe" "/win32manifest:$(Join-Path $scriptDir 'app.manifest')" `
  "/win32icon:$(Join-Path $scriptDir 'Resources\app.ico')" `
  /r:System.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll /r:System.Management.dll `
  "/r:$(Join-Path $outDir 'Microsoft.Web.WebView2.Core.dll')" `
  "/r:$(Join-Path $outDir 'Microsoft.Web.WebView2.WinForms.dll')" `
  (Join-Path $scriptDir 'Sources\Program.cs')
if ($LASTEXITCODE -ne 0) { throw "csc failed with exit code $LASTEXITCODE" }

if ($BundleDsh) {
  $dshDir = Join-Path $outDir 'dsh'
  Write-Host "==> Bundling @deepseek-ai/dsh@$DshVersion into $dshDir"
  npm install --prefix $dshDir "@deepseek-ai/dsh@$DshVersion"
  if ($LASTEXITCODE -ne 0) { throw "npm install failed" }

  # Bundle a node runtime beside the exe so the app is self-contained and
  # needs no system install. The version is pinned by NODE_BUNDLE_VERSION
  # (default: a v24 LTS-line build).
  $nodeDir = Join-Path $outDir 'node'
  if (-not (Test-Path (Join-Path $nodeDir 'node.exe'))) {
    $nodeVersion = if ($env:NODE_BUNDLE_VERSION) { $env:NODE_BUNDLE_VERSION } else { 'v24.12.0' }
    Write-Host "==> Bundling node $nodeVersion"
    $nodeZip = Join-Path $outDir 'node.zip'
    Invoke-WebRequest "https://nodejs.org/dist/$nodeVersion/node-$nodeVersion-win-x64.zip" -OutFile $nodeZip
    $extract = Join-Path $outDir 'node-extract'
    Expand-Archive $nodeZip $extract
    New-Item -ItemType Directory -Force $nodeDir | Out-Null
    Copy-Item -Recurse -Force (Join-Path $extract "node-$nodeVersion-win-x64\*") $nodeDir
    Remove-Item $nodeZip, $extract -Recurse -Force
    if (-not (Test-Path (Join-Path $nodeDir 'node.exe'))) { throw "bundled node missing" }
    # Prune what `dsh web` never runs: the npm/corepack CLIs and the docs.
    foreach ($name in @('npm', 'npm.cmd', 'npx', 'npx.cmd', 'corepack', 'corepack.cmd')) {
      Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $nodeDir $name)
    }
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $nodeDir 'node_modules')
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $nodeDir 'share')
  }
}

Write-Host "==> Done: $exe"
