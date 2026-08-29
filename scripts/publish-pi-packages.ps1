param(
    [ValidateSet('pi-cursor-bridge', 'pi-grok-build-supervisor')]
    [string[]]$PackageName = @('pi-cursor-bridge', 'pi-grok-build-supervisor'),
    [string]$RepositoryRoot,
    [string]$NpmCommand = 'npm'
)

$ErrorActionPreference = 'Stop'

$repositoryRoot = if ([string]::IsNullOrWhiteSpace($RepositoryRoot)) {
    (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
} else {
    (Resolve-Path -LiteralPath $RepositoryRoot).Path
}
Set-Location -LiteralPath $repositoryRoot

$runningInGitHubActions = $env:GITHUB_ACTIONS -eq 'true'
if ($runningInGitHubActions) {
    if ([string]::IsNullOrWhiteSpace($env:ACTIONS_ID_TOKEN_REQUEST_URL)) {
        throw 'GitHub Actions publishing requires permissions.id-token: write so npm Trusted Publishing can obtain an OIDC credential.'
    }
    if (-not [string]::IsNullOrWhiteSpace($env:NODE_AUTH_TOKEN) -or -not [string]::IsNullOrWhiteSpace($env:NPM_TOKEN)) {
        throw 'GitHub Actions publishing must use npm Trusted Publishing without NODE_AUTH_TOKEN or NPM_TOKEN.'
    }
    Write-Host 'Using npm Trusted Publishing (OIDC); npm whoami is intentionally skipped because OIDC is exchanged only during npm publish.' -ForegroundColor DarkGray
} else {
    $npmUserOutput = @(& $NpmCommand whoami 2>&1)
    $npmWhoamiExitCode = $LASTEXITCODE
    $npmUser = ([string]($npmUserOutput | Select-Object -Last 1)).Trim()
    if ($npmWhoamiExitCode -ne 0 -or $npmUser -ne 'flyingmoonc') {
        throw "Expected npm account flyingmoonc, received '$npmUser'."
    }
}

& $NpmCommand run build:pi-packages
if ($LASTEXITCODE -ne 0) {
    throw 'Pi package staging build failed.'
}

$packages = @($PackageName | ForEach-Object { Join-Path '.pi-package-stage' $_ })
$publishPlan = @()

foreach ($package in $packages) {
    $manifest = Get-Content -Raw -LiteralPath (Join-Path $package 'package.json') | ConvertFrom-Json
    $packageSpec = "$($manifest.name)@$($manifest.version)"
    $localPackOutput = @(& $NpmCommand pack $package --json --dry-run)
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to calculate the local package digest for $packageSpec."
    }
    $localPack = ($localPackOutput -join [Environment]::NewLine) | ConvertFrom-Json
    $localShasum = ([string]($localPack | Select-Object -First 1).shasum).Trim()
    if (-not $localShasum) {
        throw "npm pack did not return a shasum for $packageSpec."
    }

    $publishedShasumOutput = @(& $NpmCommand view $packageSpec dist.shasum --json 2>&1)
    $publishedLookupExitCode = $LASTEXITCODE
    $publishedShasum = ([string]($publishedShasumOutput -join '')).Trim().Trim('"')
    if ($publishedLookupExitCode -eq 0) {
        if (-not $publishedShasum) {
            throw "npm view returned success without a tarball shasum for $packageSpec."
        }
        if ($publishedShasum -ne $localShasum) {
            throw "$packageSpec already exists on npm, but its published tarball differs from the local package. Bump the package version instead of skipping it."
        }
        Write-Host "`nSkipping $packageSpec because the identical tarball is already published." -ForegroundColor DarkGray
        continue
    }

    $publishedLookupError = ([string]($publishedShasumOutput -join [Environment]::NewLine)).Trim()
    if ($publishedLookupError -notmatch '(?i)(?:\bE404\b|No match found for version|is not in this registry)') {
        throw "Unable to determine whether $packageSpec already exists on npm: $publishedLookupError"
    }

    $publishPlan += [pscustomobject]@{
        Package = $package
        PackageSpec = $packageSpec
    }
}

foreach ($candidate in $publishPlan) {
    Write-Host "`nPublishing $($candidate.Package) ..." -ForegroundColor Cyan
    & $NpmCommand publish $candidate.Package
    if ($LASTEXITCODE -ne 0) {
        throw "npm publish failed for $($candidate.Package)."
    }
}

Write-Host "`nSelected Pi packages completed successfully." -ForegroundColor Green
