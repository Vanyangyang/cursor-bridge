param(
    [Parameter(Mandatory = $true)][string]$NodeBinary,
    [Parameter(Mandatory = $true)][string]$HostScript,
    [Parameter(Mandatory = $true)][string]$StatePath,
    [Parameter(Mandatory = $true)][string]$GrokBinary,
    [Parameter(Mandatory = $true)][string]$LeaderSocket,
    [Parameter(Mandatory = $true)][string]$LeaderOwnerToken,
    [Parameter(Mandatory = $true)][string]$WorkingDirectory,
    [Parameter(Mandatory = $true)][ValidateSet("new", "resume")][string]$Mode,
    [Parameter(Mandatory = $true)][string]$SessionId,
    [Parameter(Mandatory = $true)][string]$LaunchId
)

$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $WorkingDirectory

$hostArguments = @(
    $HostScript,
    "--state-path", $StatePath,
    "--grok-binary", $GrokBinary,
    "--leader-socket", $LeaderSocket,
    "--leader-owner-token", $LeaderOwnerToken,
    "--cwd", $WorkingDirectory,
    "--mode", $Mode,
    "--session-id", $SessionId,
    "--launch-id", $LaunchId
)

& $NodeBinary @hostArguments
exit $LASTEXITCODE
