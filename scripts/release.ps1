[CmdletBinding()]
param(
    [ValidateSet('WebOnly', 'Paired')][string]$Mode = 'WebOnly',
    [string]$DesktopBuildScript,
    [string]$DesktopArtifact,
    [ValidatePattern('^[0-9a-fA-F]{64}$')][string]$DesktopSha256,
    [string]$OutputDirectory,
    [ValidateSet('docker.io', 'mirror.gcr.io', 'public.ecr.aws/docker')][string]$BaseRegistry = 'docker.io',
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$WebRoot = Split-Path -Parent $PSScriptRoot
$RepoRoot = Split-Path -Parent $WebRoot
$Baseline = Get-Content -LiteralPath (Join-Path $WebRoot 'baseline.json') -Raw | ConvertFrom-Json
$Version = [string]$Baseline.productVersion
$Build = [string]$Baseline.webBuild
if ($Version -notmatch '^\d+\.\d+\.\d+$' -or $Build -notmatch '^\d+$') { throw 'Invalid baseline version/build.' }
$ReleaseId = "$Version-web.$Build"
$Image = "zhihui-web:$ReleaseId"
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $WebRoot "artifacts/$ReleaseId" }
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
$WebPrefix = $WebRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if (-not $OutputDirectory.StartsWith($WebPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Release output must stay inside web/.' }
$OutputParent = $OutputDirectory
while ($OutputParent -and $OutputParent -ne $WebRoot) {
    if ((Test-Path -LiteralPath $OutputParent) -and ((Get-Item -LiteralPath $OutputParent -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Release output cannot traverse a symlink/junction.' }
    $OutputParent = Split-Path -Parent $OutputParent
}
if ($Mode -eq 'Paired' -and -not $DesktopArtifact) { throw 'Paired mode requires an explicit newly built -DesktopArtifact.' }
if (-not $DesktopArtifact) { $DesktopArtifact = Join-Path $RepoRoot '_build-tools/updater/publish/0.6.6/Zhihui_0.6.6_x64-setup.exe' }
$DesktopArtifact = [IO.Path]::GetFullPath($DesktopArtifact)
if (-not $DesktopSha256 -and $Mode -eq 'WebOnly' -and $Version -eq '0.6.6') {
    $DesktopSha256 = '579ca480d6fba67372715c307750879d5e800ecf7aa6fb110282f23dcac8106e'
}
if ($Mode -eq 'Paired' -and -not $DesktopBuildScript) { throw 'Paired mode requires an explicit existing -DesktopBuildScript.' }
if ($Mode -eq 'WebOnly' -and -not $DesktopSha256) { throw 'WebOnly mode requires the published installer -DesktopSha256.' }
function Invoke-Checked([string]$Command, [string[]]$Arguments) {
    Write-Host "$Command $($Arguments -join ' ')"
    if (-not $DryRun) {
        & $Command @Arguments
        if ($LASTEXITCODE -ne 0) { throw "$Command failed (exit $LASTEXITCODE)." }
    }
}
function Get-SourceFingerprint {
    $Rows = [System.Collections.Generic.List[string]]::new()
    $Excluded = @('node_modules', '.next', 'out', 'target', 'artifacts', '.artifacts', '.runtime', '.test-data', 'data', 'backups', 'secrets', '.git', 'test-results', 'tmp', '.cache')
    function Read-SourceTree([string]$Directory) {
        foreach ($Entry in Get-ChildItem -LiteralPath $Directory -Force | Sort-Object Name) {
            if ($Entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Source symlink/junction is not allowed: $($Entry.Name)" }
            if ($Entry.PSIsContainer) {
                if ($Entry.Name -notin $Excluded) { Read-SourceTree $Entry.FullName }
            } elseif ($Entry.Name -notlike '.env*' -and $Entry.Name -notmatch '(?i)(\.sqlite.*|\.db.*|\.pem|\.key|\.log|\.tmp|\.tsbuildinfo)$' -and $Entry.Name -notlike 'master*key*') {
                $Relative = $Entry.FullName.Substring($WebRoot.Length + 1).Replace('\', '/')
                $Rows.Add("$Relative`0$((Get-FileHash -LiteralPath $Entry.FullName -Algorithm SHA256).Hash.ToLowerInvariant())")
            }
        }
    }
    # An explicit source allowlist excludes test runtimes, recordings, credentials,
    # logs and archives even if new runtime directories appear under web/.
    foreach ($Relative in @('frontend/src', 'frontend/public', 'frontend/scripts', 'frontend/tests', 'server/src', 'server/templates', 'server/tests', 'deploy', 'scripts', 'tests')) {
        $Path = Join-Path $WebRoot $Relative
        if (Test-Path -LiteralPath $Path -PathType Container) { Read-SourceTree $Path }
    }
    foreach ($Relative in @('baseline.json', 'API.md', 'README.md', 'DEPLOY.md', '.gitignore', 'server/Cargo.toml', 'server/Cargo.lock', 'frontend/package.json', 'frontend/pnpm-lock.yaml', 'frontend/next.config.js', 'frontend/tsconfig.json', 'frontend/tailwind.config.ts', 'frontend/postcss.config.js', 'frontend/postcss.config.mjs', 'frontend/components.json', 'frontend/.eslintrc.json')) {
        $Path = Join-Path $WebRoot $Relative
        if (Test-Path -LiteralPath $Path -PathType Leaf) { $Rows.Add("$Relative`0$((Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant())") }
    }
    $Hasher = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($Hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes(($Rows -join "`n"))))).Replace('-', '').ToLowerInvariant() }
    finally { $Hasher.Dispose() }
}
Push-Location $RepoRoot
try {
    Invoke-Checked 'node' @('web/scripts/baseline.mjs', 'verify')
    Invoke-Checked 'node' @('web/scripts/check-native-deps.mjs')
    if ($Mode -eq 'Paired') {
        $DesktopBuildScript = (Resolve-Path -LiteralPath $DesktopBuildScript).Path
        Invoke-Checked 'powershell.exe' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $DesktopBuildScript)
    }
    if (-not $DryRun) {
        if (-not (Test-Path -LiteralPath $DesktopArtifact -PathType Leaf)) { throw 'Published desktop installer not found.' }
        $ActualDesktopHash = (Get-FileHash -LiteralPath $DesktopArtifact -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($DesktopSha256 -and $ActualDesktopHash -ne $DesktopSha256.ToLowerInvariant()) { throw 'Desktop installer hash does not match published reference.' }
        $DesktopSha256 = $ActualDesktopHash
        if (Test-Path -LiteralPath $OutputDirectory) { throw 'Release directory exists; choose a new Web build number. Existing releases are immutable.' }
    }
    Push-Location (Join-Path $WebRoot 'frontend')
    $PreviousWebBuild = $env:NEXT_PUBLIC_WEB_BUILD
    try {
        $env:NEXT_PUBLIC_WEB_BUILD = $Build
        Invoke-Checked 'pnpm' @('install', '--frozen-lockfile')
        Invoke-Checked 'pnpm' @('build')
    } finally {
        if ($null -eq $PreviousWebBuild) { Remove-Item Env:NEXT_PUBLIC_WEB_BUILD -ErrorAction SilentlyContinue }
        else { $env:NEXT_PUBLIC_WEB_BUILD = $PreviousWebBuild }
        Pop-Location
    }
    Invoke-Checked 'cargo' @('test', '--locked', '--manifest-path', 'web/server/Cargo.toml')
    Invoke-Checked 'node' @('--test', 'web/tests/image-identity.test.mjs')
    Invoke-Checked 'node' @('web/scripts/baseline.mjs', 'verify')
    $SourceSha = if ($DryRun) { '<calculated-source-sha256>' } else { Get-SourceFingerprint }
    Invoke-Checked 'docker' @('build', '--platform', 'linux/amd64', '--file', 'web/deploy/Dockerfile', '--build-arg', "BASE_REGISTRY=$BaseRegistry", '--build-arg', "PRODUCT_VERSION=$Version", '--build-arg', "WEB_BUILD=$Build", '--build-arg', "SOURCE_SHA=$SourceSha", '--tag', $Image, 'web')
    if ($DryRun) {
        Write-Host "Would save image and release-manifest.json to $OutputDirectory. No SSH, DNS, server change, desktop rebuild (WebOnly), or update-manifest write."
        return
    }
    if ((Get-SourceFingerprint) -ne $SourceSha) { throw 'Web sources changed during build; no release directory was created. Freeze sources and rebuild.' }
    New-Item -ItemType Directory -Path $OutputDirectory | Out-Null
    $ImageFile = Join-Path $OutputDirectory 'image.tar'
    Invoke-Checked 'docker' @('save', '--output', $ImageFile, $Image)
    $ImageId = (& docker image inspect '--format' '{{.Id}}' $Image | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $ImageId -notmatch '^sha256:[0-9a-f]{64}$') { throw 'Could not read built image ID.' }
    $IdentityJson = (& node (Join-Path $PSScriptRoot 'image-identity.mjs') $ImageFile $Image $SourceSha $ReleaseId | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Exported image config identity verification failed.' }
    $ImageConfigId = [string](($IdentityJson | ConvertFrom-Json).imageConfigId)
    if ($ImageConfigId -notmatch '^sha256:[0-9a-f]{64}$') { throw 'Could not derive exported image config ID.' }
    if ((Get-SourceFingerprint) -ne $SourceSha) { throw 'Web sources changed during build; release is invalid. Use a fresh build number.' }
    Invoke-Checked 'node' @('web/scripts/baseline.mjs', 'verify')
    $Manifest = [ordered]@{
        productVersion = $Version; webBuild = [int]$Build; releaseId = $ReleaseId; mode = $Mode
        image = $Image; imageId = $ImageId; imageConfigId = $ImageConfigId; imageArchive = 'image.tar'; baseRegistry = $BaseRegistry
        imageSha256 = (Get-FileHash -LiteralPath $ImageFile -Algorithm SHA256).Hash.ToLowerInvariant()
        sourceSha256 = $SourceSha; databaseSchemaVersion = 1
        desktop = @{ file = [IO.Path]::GetFileName($DesktopArtifact); sha256 = $DesktopSha256; rebuilt = ($Mode -eq 'Paired') }
        createdAt = [DateTime]::UtcNow.ToString('o')
    }
    $Manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'release-manifest.json') -Encoding UTF8
    Copy-Item -LiteralPath (Join-Path $WebRoot 'deploy/compose.yml') -Destination $OutputDirectory
    Write-Host "Prepared $ReleaseId at $OutputDirectory. Stage on the server before activation. Desktop publication is unchanged."
} finally { Pop-Location }
