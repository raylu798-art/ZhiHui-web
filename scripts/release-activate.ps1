[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ReleaseDirectory,
    [Parameter(Mandatory)][ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_.@-]+$')][string]$Server,
    [ValidatePattern('^/[A-Za-z0-9_./-]+$')][string]$RemoteRoot = '/opt/zhihui-web',
    [string]$DesktopPublishScript,
    [string]$DesktopRollbackScript,
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$ReleaseDirectory = (Resolve-Path -LiteralPath $ReleaseDirectory).Path
$Manifest = Get-Content -LiteralPath (Join-Path $ReleaseDirectory 'release-manifest.json') -Raw | ConvertFrom-Json
$ReleaseId = [string]$Manifest.releaseId
if ($ReleaseId -notmatch '^\d+\.\d+\.\d+-web\.\d+$') { throw 'Invalid release ID.' }
if ($Manifest.mode -notin @('WebOnly', 'Paired')) { throw 'Invalid release mode.' }
if ($RemoteRoot.Contains('..') -or $RemoteRoot -eq '/') { throw 'Remote root must be a dedicated absolute deployment directory.' }
if ($Manifest.mode -eq 'WebOnly' -and ($DesktopPublishScript -or $DesktopRollbackScript)) { throw 'WebOnly release cannot run desktop publication scripts.' }
if ($Manifest.mode -eq 'Paired' -and (-not $DesktopPublishScript -or -not $DesktopRollbackScript)) {
    throw 'Paired activation requires explicit existing -DesktopPublishScript and -DesktopRollbackScript. The publisher must atomically publish only the already verified installer; rollback must restore the prior updater manifest.'
}
function Invoke-Checked([string]$Command, [string[]]$Arguments) {
    Write-Host "$Command $($Arguments -join ' ')"
    if (-not $DryRun) {
        & $Command @Arguments
        if ($LASTEXITCODE -ne 0) { throw "$Command failed (exit $LASTEXITCODE)." }
    }
}
if ($DesktopPublishScript) { $DesktopPublishScript = (Resolve-Path -LiteralPath $DesktopPublishScript).Path }
if ($DesktopRollbackScript) { $DesktopRollbackScript = (Resolve-Path -LiteralPath $DesktopRollbackScript).Path }
$WebActivated = $false
$DesktopAttempted = $false
try {
    # Upload is a separate, reviewable step; stage verifies image hash/ID and uses
    # isolated data. The SSH host must already be trusted in known_hosts.
    Invoke-Checked 'ssh' @('-o', 'BatchMode=yes', $Server, 'bash', "$RemoteRoot/deploy.sh", 'stage', $ReleaseId)
    Invoke-Checked 'ssh' @('-o', 'BatchMode=yes', $Server, 'bash', "$RemoteRoot/deploy.sh", 'activate', $ReleaseId)
    $WebActivated = $true
    if ($DryRun) {
        Write-Host "Would validate HTTPS health product=$($Manifest.productVersion) build=$($Manifest.webBuild)."
    } else {
        $HealthText = & curl.exe --fail --silent --show-error --max-time 15 https://zhihui.helms.wiki/api/v1/health
        if ($LASTEXITCODE -ne 0) { throw 'Public HTTPS health request failed.' }
        $Health = $HealthText | ConvertFrom-Json
        if (-not $Health.ok -or $Health.version -ne $Manifest.productVersion -or [string]$Health.build -ne [string]$Manifest.webBuild) { throw 'Public HTTPS version/build differs from staged release.' }
    }
    if ($DesktopPublishScript) {
        $DesktopAttempted = $true
        Invoke-Checked 'powershell.exe' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $DesktopPublishScript)
    }
} catch {
    $Failure = $_
    if ($DesktopAttempted) {
        try { Invoke-Checked 'powershell.exe' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $DesktopRollbackScript) }
        catch { Write-Warning 'Desktop rollback script failed; inspect the existing desktop channel immediately.' }
    }
    if ($WebActivated) {
        try { Invoke-Checked 'ssh' @('-o', 'BatchMode=yes', $Server, 'bash', "$RemoteRoot/deploy.sh", 'rollback') }
        catch { Write-Warning 'Web rollback failed or no prior Web exists; inspect deployment status and verified backups.' }
    }
    throw $Failure
}
