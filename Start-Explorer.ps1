param(
    [string]$Distribution = 'Ubuntu',
    [string]$BitcoinConfigPath = '',
    [ValidateRange(1024,65535)][int]$Port = 3002
)
$ErrorActionPreference = 'Stop'
$linuxProject = [string](& wsl.exe -d $Distribution -- wslpath -a $PSScriptRoot.Replace('\', '/'))
if ($LASTEXITCODE -ne 0) { throw 'Ubuntu/WSL is unavailable.' }
if (!$BitcoinConfigPath) {
    $linuxUserHome = [string](& wsl.exe -d $Distribution -- printenv HOME)
    if ($LASTEXITCODE -ne 0 -or !$linuxUserHome) { throw 'Could not find your Linux home directory.' }
    $BitcoinConfigPath = "$($linuxUserHome.Trim())/.bitcoin/bitcoin.conf"
}
$localRuntime = Join-Path $PSScriptRoot '.runtime/node-linux/bin/node'
$nodeExecutable = if (Test-Path -LiteralPath $localRuntime) { "$linuxProject/.runtime/node-linux/bin/node" } else { 'node' }
Write-Host "Chain Atlas: http://127.0.0.1:$Port/explorer/"
Write-Host 'Leave this window open. Ctrl+C stops only the explorer.'
# Reads existing configuration in the backend. Does not start or modify Core/electrs.
& wsl.exe -d $Distribution --cd $linuxProject -- env "BITCOIN_CONFIG_PATH=$BitcoinConfigPath" "DASHBOARD_PORT=$Port" $nodeExecutable server.mjs --explorer
if ($LASTEXITCODE -ne 0) { throw 'Explorer stopped. Check the port, existing Bitcoin configuration and WSL Node.js 20+ installation.' }
