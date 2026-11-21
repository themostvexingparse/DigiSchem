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
# A GNU-toolchain build imports WebView2Loader.dll, which must sit next to the exe. An MSVC build
# links the loader statically and needs nothing else.
if (Test-Path "$rel\WebView2Loader.dll") { Copy-Item "$rel\WebView2Loader.dll" $out }
if ($Installers) {
  Get-ChildItem "$rel\bundle" -Recurse -Include *.msi, *-setup.exe | Copy-Item -Destination $out
}
$latest = Join-Path $root "builds\latest"
# builds\latest is in use while DigiSchem runs from it: then leave it alone (never half-delete it).
$locked = $false
if (Test-Path $latest) {
  foreach ($f in Get-ChildItem $latest -File) {
    try { $s = [System.IO.File]::Open($f.FullName, 'Open', 'ReadWrite', 'None'); $s.Close() } catch { $locked = $true }
  }
}
if ($locked) {
  Write-Warning "builds\latest is in use (DigiSchem is running from it) - not updated. Close it and re-run, or use $out"
} else {
  if (Test-Path $latest) { Remove-Item -Recurse -Force $latest }
  Copy-Item -Recurse $out $latest
}
Write-Output "BUILD OK -> $out"
