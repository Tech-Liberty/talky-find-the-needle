# Builds the release archive: dist\TalkyNeedle-<version>.zip and dist\SHA256SUMS.txt.
# Never includes bridge\config.json (it holds the token): the bridge creates it on first start.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$version = (Get-Content -LiteralPath (Join-Path $root 'bridge\package.json') -Raw | ConvertFrom-Json).version
$modText = Get-Content -LiteralPath (Join-Path $root 'mods\talky_needle\talky_needle.gd') -Raw
if ($modText -notmatch 'const VERSION := "([^"]+)"') { throw 'VERSION not found in talky_needle.gd' }
if ($Matches[1] -ne $version) { throw "package.json says $version but talky_needle.gd says $($Matches[1])" }

$files = @(
    'README.md', 'LICENSE', 'start-bridge.cmd', 'tools\install.ps1',
    'bridge\bridge.js', 'bridge\package.json', 'bridge\config.example.json',
    'bridge\lib\engine.js', 'bridge\lib\hosts.js',
    'mods\talky_needle\talky_needle.gd', 'mods\talky_needle\tn_actions.gd', 'mods\talky_needle\tn_menu.gd'
)

$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Force -Path $dist | Out-Null
$zipPath = Join-Path $dist "TalkyNeedle-$version.zip"
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath }

$zip = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($file in $files) {
        $source = Join-Path $root $file
        if (-not (Test-Path -LiteralPath $source)) { throw "missing file: $file" }
        $entry = 'TalkyNeedle/' + ($file -replace '\\', '/')
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $source, $entry) | Out-Null
    }
} finally {
    $zip.Dispose()
}

$hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLower()
[System.IO.File]::WriteAllText((Join-Path $dist 'SHA256SUMS.txt'), "$hash  TalkyNeedle-$version.zip`n")
Write-Output "TalkyNeedle-$version.zip: $hash"
