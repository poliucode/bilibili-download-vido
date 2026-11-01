$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $taskRoot
$resourceRoot = Join-Path $taskRoot 'build-resources'
$toolRoot = Join-Path $resourceRoot 'tools'
$licenseRoot = Join-Path $resourceRoot 'licenses'
New-Item -ItemType Directory -Force -Path $resourceRoot, $toolRoot, $licenseRoot | Out-Null

python -m PyInstaller --noconfirm --onedir --console --name vido-engine `
    --collect-all yt_dlp `
    --distpath (Join-Path $taskRoot 'engine/dist') `
    --workpath (Join-Path $taskRoot 'engine/build') `
    (Join-Path $taskRoot 'engine/worker.py')
if ($LASTEXITCODE -ne 0) {
    throw 'Engine build failed. Install engine/requirements.txt first.'
}

$engineSource = Join-Path $taskRoot 'engine/dist/vido-engine'
$engineTarget = Join-Path $resourceRoot 'engine'
New-Item -ItemType Directory -Force -Path $engineTarget | Out-Null
Copy-Item -Path (Join-Path $engineSource '*') -Destination $engineTarget -Recurse -Force

foreach ($toolName in @('ffmpeg', 'ffprobe')) {
    $toolCommand = Get-Command $toolName -ErrorAction Stop
    Copy-Item -LiteralPath $toolCommand.Source -Destination (Join-Path $toolRoot "$toolName.exe") -Force
}

$ffmpegCommand = Get-Command ffmpeg -ErrorAction Stop
$ffmpegRoot = Split-Path -Parent (Split-Path -Parent $ffmpegCommand.Source)
$ffmpegLicense = Join-Path $ffmpegRoot 'LICENSE'
if (-not (Test-Path -LiteralPath $ffmpegLicense)) {
    throw 'FFmpeg LICENSE not found. Use a complete FFmpeg distribution.'
}
Copy-Item -LiteralPath $ffmpegLicense -Destination (Join-Path $licenseRoot 'FFmpeg-LICENSE.txt') -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'THIRD-PARTY-NOTICES.md') -Destination $licenseRoot -Force

python (Join-Path $PSScriptRoot 'collect-licenses.py')
if ($LASTEXITCODE -ne 0) {
    throw 'Failed to collect third-party notices.'
}

@{ action = 'health'; requestId = 'package-check'; toolsDirectory = $toolRoot } |
    ConvertTo-Json -Compress | & (Join-Path $engineTarget 'vido-engine.exe')
if ($LASTEXITCODE -ne 0) {
    throw 'Packaged engine health check failed.'
}
Write-Host 'Engine and media tools are ready.'
