$ErrorActionPreference = 'Stop'
$env:COREPACK_ENABLE_NETWORK = '0'
$env:COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'
$env:PNPM_CONFIG_OFFLINE = 'true'

try {
    $root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
    $node = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    $pnpm = Get-Command pnpm.cmd -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $node -or -not $pnpm) {
        throw 'prerequisite: installed native Windows Node.js 22+ and pnpm.cmd 9.15.9 are required.'
    }
    & $node.Source -e 'process.exit(parseInt(process.versions.node, 10) >= 22 ? 0 : 1)'
    if ($LASTEXITCODE -ne 0) {
        throw 'prerequisite: installed Node.js 22+ is required.'
    }
    $version = & $pnpm.Source --version
    if ($LASTEXITCODE -ne 0) {
        throw 'prerequisite: installed pnpm 9.15.9 is required; downloads are disabled.'
    }
    if (($version -join "`n").Trim() -ne '9.15.9') {
        throw 'prerequisite: installed pnpm 9.15.9 is required.'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $root 'node_modules') -PathType Container)) {
        throw 'prerequisite: dependencies must already be installed; this harness never installs them.'
    }
    Set-Location -LiteralPath $root
    & $pnpm.Source --filter '@9thlevelsoftware/legion-cli-core...' run build
    $buildStatus = $LASTEXITCODE
    if ($buildStatus -ne 0) {
        [Console]::Error.WriteLine('autoresearch: offline core dependency build failed.')
        exit $buildStatus
    }
    & $node.Source (Join-Path $PSScriptRoot 'autoresearch-evidence.mjs')
    exit $LASTEXITCODE
} catch {
    [Console]::Error.WriteLine("autoresearch: $($_.Exception.Message)")
    exit 1
}
