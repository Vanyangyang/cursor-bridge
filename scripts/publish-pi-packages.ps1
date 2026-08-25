$ErrorActionPreference = 'Stop'

$repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $repositoryRoot

$npmUser = (& npm whoami).Trim()
if ($LASTEXITCODE -ne 0 -or $npmUser -ne 'flyingmoonc') {
    throw "Expected npm account flyingmoonc, received '$npmUser'."
}

& npm run build:pi-packages
if ($LASTEXITCODE -ne 0) {
    throw 'Pi package staging build failed.'
}

$packages = @(
    '.pi-package-stage\pi-cursor-bridge',
    '.pi-package-stage\pi-grok-build-supervisor'
)

foreach ($package in $packages) {
    $manifest = Get-Content -Raw -LiteralPath (Join-Path $package 'package.json') | ConvertFrom-Json
    $packageSpec = "$($manifest.name)@$($manifest.version)"
    $publishedVersion = (& npm view $packageSpec version 2>$null).Trim()
    if ($LASTEXITCODE -eq 0 -and $publishedVersion -eq $manifest.version) {
        Write-Host "`nSkipping $packageSpec because it is already published." -ForegroundColor DarkGray
        continue
    }

    Write-Host "`nPublishing $package ..." -ForegroundColor Cyan
    & npm publish $package
    if ($LASTEXITCODE -ne 0) {
        throw "npm publish failed for $package."
    }
}

Write-Host "`nBoth Pi packages were published successfully." -ForegroundColor Green
