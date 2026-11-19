# Builds dist\keyturn-<version>-windows.zip and stamps its version and SHA-256 into install.ps1
# (and the copy the relay serves at keys.aiforge.uk/install.ps1).
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$version = (Get-Content -Raw (Join-Path $root 'app\package.json') | ConvertFrom-Json).version
$dist = Join-Path $root 'dist'
$stage = Join-Path $dist 'stage'
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force -Path (Join-Path $stage 'app') | Out-Null

foreach ($f in 'keyturn.js', 'server.js', 'package.json', 'package-lock.json') { Copy-Item (Join-Path $root "app\$f") (Join-Path $stage 'app') }
foreach ($d in 'lib', 'ui') { Copy-Item -Recurse (Join-Path $root "app\$d") (Join-Path $stage 'app') }
foreach ($f in 'Keyturn.vbs', 'README.md', 'LICENSE', 'uninstall.ps1') { Copy-Item (Join-Path $root $f) $stage }

Push-Location (Join-Path $stage 'app')
try { & npm ci --omit=dev --no-audit --no-fund --loglevel=error; if ($LASTEXITCODE) { throw 'npm ci failed' } } finally { Pop-Location }

$zip = Join-Path $dist "keyturn-$version-windows.zip"
if (Test-Path $zip) { Remove-Item -Force $zip }
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::Open($zip, 'Create')
try {
  Get-ChildItem -Recurse -File $stage | ForEach-Object {
    $name = $_.FullName.Substring($stage.Length + 1).Replace([char]92, [char]47)   # forward slashes: a portable zip
    [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $_.FullName, $name, 'Optimal')
  }
} finally { $archive.Dispose() }
$sha = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLowerInvariant()

$installer = Join-Path $root 'install.ps1'
$text = [IO.File]::ReadAllText($installer)
$text = $text -replace "(?m)^\`$Version = '[^']*'", "`$Version = '$version'"
$text = $text -replace "(?m)^\`$ZipSha256 = '[^']*'", "`$ZipSha256 = '$sha'"
[IO.File]::WriteAllText($installer, $text)
Copy-Item $installer (Join-Path $root 'relay\public\install.ps1') -Force

"{0}  {1}  ({2:N1} MB)" -f $sha, (Split-Path -Leaf $zip), ((Get-Item $zip).Length / 1MB)

# Server (Linux) package: the same app, without the Windows window launcher. Stamped into install.sh.
$tgz = Join-Path $dist "keyturn-$version-server.tar.gz"
if (Test-Path $tgz) { Remove-Item -Force $tgz }
$srv = Join-Path $dist 'stage-server'
if (Test-Path $srv) { Remove-Item -Recurse -Force $srv }
New-Item -ItemType Directory -Force -Path $srv | Out-Null
Copy-Item -Recurse (Join-Path $stage 'app') $srv
foreach ($f in 'README.md', 'LICENSE') { Copy-Item (Join-Path $root $f) $srv }
& tar.exe -czf $tgz -C $srv app README.md LICENSE
if ($LASTEXITCODE) { throw 'tar failed' }
$tsha = (Get-FileHash -Algorithm SHA256 $tgz).Hash.ToLowerInvariant()
$sh = Join-Path $root 'install.sh'
$stext = [IO.File]::ReadAllText($sh)
$stext = $stext -replace "(?m)^VERSION='[^']*'", "VERSION='$version'"
$stext = $stext -replace "(?m)^TAR_SHA256='[^']*'", "TAR_SHA256='$tsha'"
[IO.File]::WriteAllText($sh, $stext.Replace("`r`n", "`n"))
Copy-Item $sh (Join-Path $root 'relay\public\install.sh') -Force
"{0}  {1}  ({2:N1} MB)" -f $tsha, (Split-Path -Leaf $tgz), ((Get-Item $tgz).Length / 1MB)
