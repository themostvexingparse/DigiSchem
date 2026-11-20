# Builds the DigiSchem desktop app and drops a portable copy into builds\<timestamp>-<commit>\
# plus builds\latest\. Usage:  powershell -ExecutionPolicy Bypass -File scripts\build-desktop.ps1 [-Installers]
param([switch]$Installers)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$commit = (git rev-parse --short HEAD).Trim()
$stamp = Get-Date -Format "yyyyMMdd-HHmm"
if ($Installers) { npx tauri build } else { npx tauri build --no-bundle }
if ($LASTEXITCODE -ne 0) { throw "tauri build failed" }

$rel = Join-Path $root "src-tauri\target\release"
$out = Join-Path $root "builds\$stamp-$commit"
New-Item -ItemType Directory -Force $out | Out-Null
Copy-Item "$rel\digischem.exe" "$out\DigiSchem.exe"
Copy-Item "$rel\WebView2Loader.dll" $out   # required next to the exe (GNU toolchain build)
if ($Installers) {
  Get-ChildItem "$rel\bundle" -Recurse -Include *.msi, *-setup.exe | Copy-Item -Destination $out
}
$latest = Join-Path $root "builds\latest"
if (Test-Path $latest) { Remove-Item -Recurse -Force $latest }
Copy-Item -Recurse $out $latest
Write-Output "BUILD OK -> $out"
