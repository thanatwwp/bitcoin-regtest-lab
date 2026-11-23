param([string]$Distribution = 'Ubuntu')
$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $PSScriptRoot
$runtimeDirectory = Join-Path $projectDirectory '.runtime'
$nodeDirectory = Join-Path $runtimeDirectory 'node-linux'
if ((Test-Path -LiteralPath $nodeDirectory) -and @(Get-ChildItem -LiteralPath $nodeDirectory -Force).Count -gt 0) {
    throw 'The project-local Linux runtime already exists. It will not be overwritten.'
}
$architecture = (& wsl.exe -d $Distribution -- uname -m).Trim()
if ($LASTEXITCODE -ne 0 -or $architecture -ne 'x86_64') {
    throw 'This installer requires an x86_64 Ubuntu/WSL distribution.'
}
# Download only from the official Node.js distribution directory. Verify the
# archive against the published checksum before extracting or running it.
$releaseBase = 'https://nodejs.org/dist/latest-v24.x/'
$checksums = (Invoke-WebRequest -UseBasicParsing ($releaseBase + 'SHASUMS256.txt')).Content
$releaseMatch = [regex]::Match([string]$checksums, '(?m)^([a-f0-9]{64})\s+(node-v24\.\d+\.\d+-linux-x64\.tar\.xz)\r?$')
if (!$releaseMatch.Success) { throw 'Could not locate an official Node.js 24 Linux release checksum.' }
$archiveName = $releaseMatch.Groups[2].Value
$expectedHash = $releaseMatch.Groups[1].Value
$version = [regex]::Match($archiveName, 'v24\.\d+\.\d+').Value
$pinnedUrl = "https://nodejs.org/dist/$version/$archiveName"
New-Item -ItemType Directory -Force -Path $runtimeDirectory | Out-Null
$archivePath = Join-Path $runtimeDirectory $archiveName
if (!(Test-Path -LiteralPath $archivePath)) {
    Invoke-WebRequest -UseBasicParsing $pinnedUrl -OutFile $archivePath
}
$actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash
if ($actualHash.ToLowerInvariant() -ne $expectedHash) { throw 'Checksum mismatch. Nothing was extracted or executed.' }
New-Item -ItemType Directory -Force -Path $nodeDirectory | Out-Null
$linuxArchive = [string](& wsl.exe -d $Distribution -- wslpath -a $archivePath.Replace('\', '/'))
if ($LASTEXITCODE -ne 0) { throw 'Could not resolve the archive path in WSL.' }
$linuxTarget = [string](& wsl.exe -d $Distribution -- wslpath -a $nodeDirectory.Replace('\', '/'))
if ($LASTEXITCODE -ne 0) { throw 'Could not resolve the runtime path in WSL.' }
& wsl.exe -d $Distribution -- tar -xJf $linuxArchive -C $linuxTarget --strip-components=1
if ($LASTEXITCODE -ne 0) { throw 'The verified archive could not be extracted.' }
& wsl.exe -d $Distribution -- "$linuxTarget/bin/node" --version
if ($LASTEXITCODE -ne 0) { throw 'The local runtime could not start.' }
Write-Host 'Project-local Linux runtime installed. No global packages were changed.'
