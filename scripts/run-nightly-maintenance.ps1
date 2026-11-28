param(
    [Parameter(Mandatory = $true)][string]$StateDir,
    [switch]$Preview,
    [switch]$CheckRuntime
)

$ErrorActionPreference = 'Stop'
$python = Get-ChildItem -LiteralPath (Join-Path $env:LOCALAPPDATA 'Programs\Python') -Directory |
    Where-Object { $_.Name -match '^Python3\d+$' -and (Test-Path (Join-Path $_.FullName 'python.exe')) } |
    Sort-Object { [int]($_.Name.Substring(6)) } -Descending |
    Select-Object -First 1
if (-not $python) { throw 'Python 3.12+ is required.' }
$env:Path = ((Join-Path $env:ProgramFiles 'Git\cmd'), (Join-Path $env:LOCALAPPDATA 'Programs\GitHubCLI\bin'), $python.FullName, $env:Path) -join ';'
$env:PYTHONUTF8 = '1'
$env:GIT_TERMINAL_PROMPT = '0'
$env:GH_PROMPT_DISABLED = '1'
$env:PYTHONDONTWRITEBYTECODE = '1'
$arguments = @((Join-Path $PSScriptRoot 'nightly_maintenance.py'), '--state-dir', $StateDir)
if ($Preview) { $arguments += '--preview' }
if ($CheckRuntime) { $arguments += '--check-runtime' }
& (Join-Path $python.FullName 'python.exe') @arguments
exit $LASTEXITCODE
