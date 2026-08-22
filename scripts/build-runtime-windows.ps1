param(
  [Parameter(Mandatory=$true)][string]$DshVersion,
  [string]$NodeVersion = 'v24.12.0',
  [string]$Out = ''
)
$ErrorActionPreference = 'Stop'
if (-not $Out) { $Out = "dist\dsh-runtime-$DshVersion-windows-x64.zip" }

$Work = Join-Path $env:TEMP ("dsh-runtime-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $Work | Out-Null
try {
  New-Item -ItemType Directory -Force (Join-Path $Work 'runtime') | Out-Null
  Write-Host "==> Installing @deepseek-ai/dsh@$DshVersion"
  npm install --prefix (Join-Path $Work 'runtime') --no-audit --no-fund "@deepseek-ai/dsh@$DshVersion"

  $versionDir = Join-Path $Work "runtime\versions\$DshVersion"
  New-Item -ItemType Directory -Force $versionDir | Out-Null
  Move-Item (Join-Path $Work 'runtime\node_modules') (Join-Path $versionDir 'node_modules')
  Set-Content (Join-Path $Work 'runtime\current') $DshVersion
  New-Item -ItemType File -Force (Join-Path $versionDir '.complete') | Out-Null

  Write-Host "==> Downloading Node $NodeVersion"
  $nodeZip = Join-Path $Work "node-$NodeVersion.zip"
  Invoke-WebRequest "https://nodejs.org/dist/$NodeVersion/node-$NodeVersion-win-x64.zip" -OutFile $nodeZip
  $nodeExtract = Join-Path $Work 'node-extract'
  Expand-Archive $nodeZip $nodeExtract
  $nodeDir = Join-Path $Work 'runtime\node'
  New-Item -ItemType Directory -Force $nodeDir | Out-Null
  Copy-Item -Recurse -Force (Join-Path $nodeExtract "node-$NodeVersion-win-x64\*") $nodeDir

  $outDir = Split-Path -Parent $Out
  if ($outDir) { New-Item -ItemType Directory -Force $outDir | Out-Null }
  Compress-Archive -Path (Join-Path $Work 'runtime\*') -DestinationPath $Out -Force
  Write-Host "==> Runtime bundle: $Out"
}
finally {
  Remove-Item -Recurse -Force $Work -ErrorAction SilentlyContinue
}
