$ErrorActionPreference = 'Stop'

$repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $repositoryRoot

$npmUserOutput = @(& npm whoami 2>&1)
$npmWhoamiExitCode = $LASTEXITCODE
$npmUser = ([string]($npmUserOutput | Select-Object -Last 1)).Trim()
if ($npmWhoamiExitCode -ne 0 -or $npmUser -ne 'flyingmoonc') {
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
    $localPackOutput = @(& npm pack $package --json --dry-run)
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to calculate the local package digest for $packageSpec."
    }
    $localPack = ($localPackOutput -join [Environment]::NewLine) | ConvertFrom-Json
    $localShasum = ([string]($localPack | Select-Object -First 1).shasum).Trim()
    if (-not $localShasum) {
        throw "npm pack did not return a shasum for $packageSpec."
    }

    $publishedShasumOutput = @(& npm view $packageSpec dist.shasum --json 2>$null)
    $publishedLookupExitCode = $LASTEXITCODE
    $publishedShasum = ([string]($publishedShasumOutput -join '')).Trim().Trim('"')
    if ($publishedLookupExitCode -eq 0 -and $publishedShasum) {
        if ($publishedShasum -ne $localShasum) {
            throw "$packageSpec already exists on npm, but its published tarball differs from the local package. Bump the package version instead of skipping it."
        }
        Write-Host "`nSkipping $packageSpec because the identical tarball is already published." -ForegroundColor DarkGray
        continue
    }

    Write-Host "`nPublishing $package ..." -ForegroundColor Cyan
    & npm publish $package
    if ($LASTEXITCODE -ne 0) {
        throw "npm publish failed for $package."
    }
}

Write-Host "`nBoth Pi packages were published successfully." -ForegroundColor Green
