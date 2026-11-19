# Keyturn installer for Windows 10 and 11.
#   irm https://keys.aiforge.uk/install.ps1 | iex
# Installs for this Windows account only (no admin rights). Running it again updates Keyturn.
# Your vault (Documents\Keyturn) and this PC's key (%LOCALAPPDATA%\Keyturn) are never touched.

& {
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$Version = '1.1.0'
$ZipSha256 = '1d5282bec27cf08b111ec0a4af2b10a4f6d14895ed7495a0bb0a2fded7b168c9'
$ZipUrl = "https://github.com/VincentPorquet777/keyturn/releases/download/v$Version/keyturn-$Version-windows.zip"
$NodeVersion = 'v24.22.3'
$Port = 7457

$Dir = if ($env:KEYTURN_HOME) { $env:KEYTURN_HOME } else { Join-Path $env:LOCALAPPDATA 'Programs\Keyturn' }
$Local = if ($env:KEYTURN_LOCAL) { $env:KEYTURN_LOCAL } else { Join-Path $env:LOCALAPPDATA 'Keyturn' }
$System = -not $env:KEYTURN_NO_SYSTEM   # shortcuts, PATH, Apps list (tests turn this off)

function Say($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }
function Get-Sha256($file) { (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash.ToLowerInvariant() }

Say ''
Say "Keyturn $Version" 'Cyan'

if ([Environment]::OSVersion.Version.Major -lt 10) { throw 'Keyturn needs Windows 10 or 11.' }
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'arm64' }
        elseif ([Environment]::Is64BitOperatingSystem) { 'x64' } else { throw 'Keyturn needs 64-bit Windows.' }

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("keyturn-install-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  # 1. Is a copy from this folder already running? Update it only while it is locked.
  $running = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*$Dir\app\server.js*" })
  if ($running.Count) {
    $locked = $true
    try {
      $token = (Get-Content -Raw -LiteralPath (Join-Path $Local 'cli.token')).Trim()
      $s = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/cli/status" -Headers @{ 'x-keyturn-cli' = $token } -TimeoutSec 5
      $locked = [bool]$s.locked
    } catch { }
    if (-not $locked) { Say 'Keyturn is open right now. Click "Lock now" in its window, then run this again.' 'Yellow'; return }
    $running | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 500
  }

  # 2. Keyturn itself, checked against the fingerprint in this script.
  Say 'Downloading Keyturn...'
  $zip = Join-Path $tmp 'keyturn.zip'
  Invoke-WebRequest -UseBasicParsing -Uri $ZipUrl -OutFile $zip
  if ((Get-Sha256 $zip) -ne $ZipSha256) { throw 'The Keyturn download does not match its fingerprint. Nothing was installed.' }
  $stage = Join-Path $tmp 'keyturn'
  Expand-Archive -LiteralPath $zip -DestinationPath $stage

  # 3. Its own copy of Node.js (from nodejs.org, checked against nodejs.org's list), so nothing else is needed.
  $nodeExe = Join-Path $Dir 'node\node.exe'
  $haveNode = (Test-Path -LiteralPath $nodeExe) -and ((& $nodeExe --version) -eq $NodeVersion)
  if (-not $haveNode) {
    Say "Downloading Node.js $NodeVersion ($arch)..."
    $nodeName = "node-$NodeVersion-win-$arch"
    $nodeZip = Join-Path $tmp "$nodeName.zip"
    Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/$NodeVersion/$nodeName.zip" -OutFile $nodeZip
    $sums = (Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/$NodeVersion/SHASUMS256.txt").Content
    if ($sums -is [byte[]]) { $sums = [Text.Encoding]::ASCII.GetString($sums) }
    $want = ($sums -split "`n" | Where-Object { $_ -match "\s$([regex]::Escape("$nodeName.zip"))\s*$" } | Select-Object -First 1) -replace '\s.*$', ''
    if (-not $want -or (Get-Sha256 $nodeZip) -ne $want.Trim().ToLowerInvariant()) { throw 'The Node.js download does not match nodejs.org. Nothing was installed.' }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $z = [IO.Compression.ZipFile]::OpenRead($nodeZip)
    try {
      $entry = $z.Entries | Where-Object { $_.FullName -eq "$nodeName/node.exe" } | Select-Object -First 1
      New-Item -ItemType Directory -Force -Path (Join-Path $stage 'node') | Out-Null
      [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $stage 'node\node.exe'), $true)
    } finally { $z.Dispose() }
  }

  # 4. Put it in place. Only program files are replaced; your vault lives elsewhere.
  New-Item -ItemType Directory -Force -Path $Dir | Out-Null
  foreach ($old in 'app', 'bin', 'Keyturn.vbs', 'README.md', 'LICENSE', 'uninstall.ps1') {
    $p = Join-Path $Dir $old
    if (Test-Path -LiteralPath $p) { Remove-Item -Recurse -Force -LiteralPath $p }
  }
  if (-not $haveNode -and (Test-Path -LiteralPath (Join-Path $Dir 'node'))) { Remove-Item -Recurse -Force -LiteralPath (Join-Path $Dir 'node') }
  Get-ChildItem -LiteralPath $stage | ForEach-Object { Move-Item -LiteralPath $_.FullName -Destination $Dir -Force }

  $bin = Join-Path $Dir 'bin'
  New-Item -ItemType Directory -Force -Path $bin | Out-Null
  Set-Content -Encoding ASCII -LiteralPath (Join-Path $bin 'keyturn.cmd') -Value "@`"%~dp0..\node\node.exe`" `"%~dp0..\app\keyturn.js`" %*"
  Set-Content -Encoding ASCII -LiteralPath (Join-Path $bin 'keyturn-uninstall.cmd') -Value "@(goto) 2>nul & powershell -NoProfile -ExecutionPolicy Bypass -File `"%~dp0..\uninstall.ps1`""

  if ($System) {
    # 5. Desktop and Start menu shortcuts.
    $sh = New-Object -ComObject WScript.Shell
    foreach ($folder in [Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs')) {
      $lnk = $sh.CreateShortcut((Join-Path $folder 'Keyturn.lnk'))
      $lnk.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
      $lnk.Arguments = "`"$(Join-Path $Dir 'Keyturn.vbs')`""
      $lnk.WorkingDirectory = $Dir
      $lnk.IconLocation = (Join-Path $Dir 'app\ui\keyturn.ico') + ',0'
      $lnk.Description = 'Keyturn: your keys, opened by your phone'
      $lnk.Save()
    }

    # 6. The keyturn command for your assistant (user PATH, keeping its existing entries as they are).
    $envKey = Get-Item -Path 'HKCU:\Environment'
    $path = $envKey.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
    if (($path -split ';') -notcontains $bin) {
      $new = (@($path.TrimEnd(';')) + $bin | Where-Object { $_ }) -join ';'
      Set-ItemProperty -Path 'HKCU:\Environment' -Name Path -Value $new -Type ExpandString
      [Environment]::SetEnvironmentVariable('KEYTURN_HOME_REFRESH', $null, 'User')   # tells Windows the setting changed
    }
    if (($env:Path -split ';') -notcontains $bin) { $env:Path = "$env:Path;$bin" }

    # 7. Listed in Settings > Apps, with an Uninstall button.
    $u = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Keyturn'
    New-Item -Force -Path $u | Out-Null
    $vals = @{
      DisplayName = 'Keyturn'; DisplayVersion = $Version; Publisher = 'Ai Forge'; InstallLocation = $Dir
      DisplayIcon = Join-Path $Dir 'app\ui\keyturn.ico'; URLInfoAbout = 'https://github.com/VincentPorquet777/keyturn'
      UninstallString = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $Dir 'uninstall.ps1')`""
    }
    foreach ($k in $vals.Keys) { Set-ItemProperty -Path $u -Name $k -Value $vals[$k] }
    Set-ItemProperty -Path $u -Name NoModify -Value 1 -Type DWord
    Set-ItemProperty -Path $u -Name NoRepair -Value 1 -Type DWord
  }

  Say ''
  Say "Keyturn $Version is installed." 'Green'
  if (-not $env:KEYTURN_NO_START) {
    Start-Process -FilePath (Join-Path $env:WINDIR 'System32\wscript.exe') -ArgumentList "`"$(Join-Path $Dir 'Keyturn.vbs')`""
    Say 'The Keyturn window is opening. Scan its code with your phone to set it up or unlock it.'
  }
  Say 'Your assistant can now use the "keyturn" command (in a new terminal window). Type "keyturn" for the list.'
  Say 'To remove Keyturn later: Settings > Apps, or "keyturn-uninstall". Your vault is always kept.'
} finally {
  Remove-Item -Recurse -Force -LiteralPath $tmp -ErrorAction SilentlyContinue
}
}
