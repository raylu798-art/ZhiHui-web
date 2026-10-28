param(
    [int]$Port = 18810,
    [string]$Executable = '',
    [string]$Ffmpeg = '',
    [string]$Ffprobe = ''
)
$ErrorActionPreference = 'Stop'
$webRoot = Split-Path $PSScriptRoot -Parent
$repoRoot = Split-Path $webRoot -Parent
$runtimeRoot = Join-Path $webRoot '.runtime/local'
if (!$Executable) { $Executable = Join-Path $webRoot 'server/target/debug/zhihui-web.exe' }
if (!$Ffmpeg) { $Ffmpeg = Join-Path $repoRoot 'ZhiHui/frontend/src-tauri/binaries/ffmpeg-x86_64-pc-windows-msvc.exe' }
if (!$Ffprobe) { $Ffprobe = Join-Path $webRoot '.artifacts/tools/package/ffprobe.exe' }
foreach ($required in @($Executable, $Ffmpeg, $Ffprobe, (Join-Path $runtimeRoot 'secrets/master_key'))) {
    if (!(Test-Path -LiteralPath $required -PathType Leaf)) { throw "Missing local preview dependency: $required" }
}
$env:ZHIHUI_BIND = "127.0.0.1:$Port"
$env:ZHIHUI_PUBLIC_URL = "http://127.0.0.1:$Port"
$env:ZHIHUI_DATA_DIR = Join-Path $runtimeRoot 'data'
$env:ZHIHUI_MASTER_KEY_FILE = Join-Path $runtimeRoot 'secrets/master_key'
$env:ZHIHUI_STATIC_DIR = Join-Path $webRoot 'frontend/out'
$env:ZHIHUI_BUILD = [string](Get-Content -LiteralPath (Join-Path $webRoot 'baseline.json') -Raw | ConvertFrom-Json).webBuild
$env:ZHIHUI_FFMPEG = $Ffmpeg
$env:ZHIHUI_FFPROBE = $Ffprobe
& $Executable serve
if ($LASTEXITCODE -ne 0) { throw "Local Web service exited with code $LASTEXITCODE" }
