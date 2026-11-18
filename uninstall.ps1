# Removes the Keyturn program, its shortcuts and its "keyturn" command.
# Keeps your vault (Documents\Keyturn) and this PC's key (%LOCALAPPDATA%\Keyturn):
# install Keyturn again and everything is back as it was.

$ErrorActionPreference = 'Stop'
$Dir = $PSScriptRoot
$Port = 7457
$Local = if ($env:KEYTURN_LOCAL) { $env:KEYTURN_LOCAL } else { Join-Path $env:LOCALAPPDATA 'Keyturn' }
$System = -not $env:KEYTURN_NO_SYSTEM

# Only ever remove an installed copy (never a source folder or anything else).
if ((Test-Path -LiteralPath (Join-Path $Dir '.git')) -or -not (Test-Path -LiteralPath (Join-Path $Dir 'app\server.js')) -or
    -not (Test-Path -LiteralPath (Join-Path $Dir 'node\node.exe'))) {
  Write-Host "This is not an installed copy of Keyturn ($Dir). Nothing was removed." -ForegroundColor Yellow; exit 1
}

$running = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like "*$Dir\app\server.js*" })
if ($running.Count) {
  $locked = $true
  try {
    $token = (Get-Content -Raw -LiteralPath (Join-Path $Local 'cli.token')).Trim()
    $locked = [bool](Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/cli/status" -Headers @{ 'x-keyturn-cli' = $token } -TimeoutSec 5).locked
  } catch { }
  if (-not $locked) { Write-Host 'Keyturn is open right now. Click "Lock now" in its window, then run this again.' -ForegroundColor Yellow; exit 1 }
  $running | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

if ($System) {
  foreach ($folder in [Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs')) {
    $lnk = Join-Path $folder 'Keyturn.lnk'
    if (Test-Path -LiteralPath $lnk) { Remove-Item -Force -LiteralPath $lnk }
  }
  $bin = Join-Path $Dir 'bin'
  $path = (Get-Item -Path 'HKCU:\Environment').GetValue('Path', '', 'DoNotExpandEnvironmentNames')
  $parts = $path -split ';'
  if ($parts -contains $bin) {
    Set-ItemProperty -Path 'HKCU:\Environment' -Name Path -Value (($parts | Where-Object { $_ -and $_ -ne $bin }) -join ';') -Type ExpandString
    [Environment]::SetEnvironmentVariable('KEYTURN_HOME_REFRESH', $null, 'User')
  }
  Remove-Item -Recurse -Force -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Keyturn' -ErrorAction SilentlyContinue
}

# The program folder goes a moment after this script ends (it is running from there).
Start-Process -WindowStyle Hidden -FilePath "$env:WINDIR\System32\cmd.exe" -ArgumentList "/c timeout /t 2 /nobreak >nul & rmdir /s /q `"$Dir`""

Write-Host 'Keyturn is removed.' -ForegroundColor Green
Write-Host "Your vault is kept in $(Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'Keyturn'), and this PC's key in $Local."
Write-Host 'Install Keyturn again any time and it opens as before.'
