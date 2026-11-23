param(
    [string]$Distribution = 'Ubuntu',
    [string]$BitcoinConfigPath = '',
    [ValidateRange(1024,65535)][int]$Port = 3000
)
$ErrorActionPreference = 'Stop'
$linuxProject = [string](& wsl.exe -d $Distribution -- wslpath -a $PSScriptRoot.Replace('\', '/'))
if ($LASTEXITCODE -ne 0) { throw 'Ubuntu/WSL is unavailable.' }
if (!$BitcoinConfigPath) {
    $linuxUserDirectory = [string](& wsl.exe -d $Distribution -- printenv HOME)
    if ($LASTEXITCODE -ne 0 -or !$linuxUserDirectory.StartsWith('/')) {
        throw 'Could not locate your WSL home directory. Supply -BitcoinConfigPath with the absolute Linux path to bitcoin.conf.'
    }
    $BitcoinConfigPath = $linuxUserDirectory.TrimEnd('/') + '/.bitcoin/bitcoin.conf'
}
$localRuntime = Join-Path $PSScriptRoot '.runtime/node-linux/bin/node'
$nodeExecutable = if (Test-Path -LiteralPath $localRuntime) { "$linuxProject/.runtime/node-linux/bin/node" } else { 'node' }
Write-Host "Starting the dashboard at http://127.0.0.1:$Port"
Write-Host 'Leave this window open. Press Ctrl+C to stop only the dashboard.'
# No credentials are copied into arguments or files. The Linux backend reads
# the existing configuration directly. Core and electrs are never started,
# stopped, or reconfigured by this launcher.
& wsl.exe -d $Distribution --cd $linuxProject -- env "BITCOIN_CONFIG_PATH=$BitcoinConfigPath" "DASHBOARD_PORT=$Port" $nodeExecutable server.mjs
if ($LASTEXITCODE -ne 0) {
    Write-Host 'The dashboard stopped. Check whether this port is already in use and whether Node.js 20+ is installed in WSL.'
    Write-Host 'Optional local runtime installer: powershell -File scripts/install-wsl-runtime.ps1'
    exit $LASTEXITCODE
}
