# Installs Talky Needle next to the full game, or removes it (-Uninstall).
# Touches only: mods\talky_needle, and the TalkyNeedle line of override.cfg (backed up first).
param(
    [string]$GameDir = "${env:ProgramFiles(x86)}\Steam\steamapps\common\Needle in a Haystack",
    [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'

$exe = Join-Path $GameDir 'FindTheNeedle.exe'
if (-not (Test-Path -LiteralPath $exe)) { throw "FindTheNeedle.exe introuvable dans : $GameDir" }
if (Get-Process -Name FindTheNeedle -ErrorAction SilentlyContinue) { throw 'Fermez le jeu avant de continuer.' }

$modTarget = Join-Path $GameDir 'mods\talky_needle'
$cfgPath = Join-Path $GameDir 'override.cfg'
$line = 'TalkyNeedle="*mods/talky_needle/talky_needle.gd"'

$lines = @()
if (Test-Path -LiteralPath $cfgPath) {
    $lines = @(Get-Content -LiteralPath $cfgPath)
    Copy-Item -LiteralPath $cfgPath -Destination "$cfgPath.talky-needle.bak" -Force
}
$lines = @($lines | Where-Object { $_ -notmatch '^TalkyNeedle=' })

if ($Uninstall) {
    # Removes [autoload] only when no other mod's line remains under it.
    $out = New-Object System.Collections.Generic.List[string]
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i].Trim() -eq '[autoload]') {
            $j = $i + 1
            while ($j -lt $lines.Count -and $lines[$j].Trim() -eq '') { $j++ }
            if ($j -ge $lines.Count -or $lines[$j].StartsWith('[')) { $i = $j - 1; continue }
        }
        $out.Add($lines[$i])
    }
    if (@($out | Where-Object { $_.Trim() -ne '' }).Count -gt 0) {
        Set-Content -LiteralPath $cfgPath -Value $out -Encoding ascii
    } elseif (Test-Path -LiteralPath $cfgPath) {
        Remove-Item -LiteralPath $cfgPath  # the full game ships without this file
    }
    if (Test-Path -LiteralPath $modTarget) { Remove-Item -LiteralPath $modTarget -Recurse -Force }
    Write-Output 'Talky Needle retire.'
    return
}

$modSource = Join-Path $PSScriptRoot '..\mods\talky_needle'
New-Item -ItemType Directory -Force -Path $modTarget | Out-Null
Copy-Item -Path (Join-Path $modSource '*.gd') -Destination $modTarget -Force

$out = New-Object System.Collections.Generic.List[string]
$added = $false
foreach ($l in $lines) {
    $out.Add($l)
    if (-not $added -and $l.Trim() -eq '[autoload]') { $out.Add($line); $added = $true }
}
if (-not $added) {
    if ($out.Count -gt 0) { $out.Add('') }
    $out.Add('[autoload]')
    $out.Add($line)
}
Set-Content -LiteralPath $cfgPath -Value $out -Encoding ascii
Write-Output "Talky Needle installe dans : $GameDir"
