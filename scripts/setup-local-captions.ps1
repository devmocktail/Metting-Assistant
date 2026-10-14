param([ValidateSet('parakeet-en', 'small', 'large-v3-turbo', 'all')][string]$Model = 'parakeet-en')
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$venv = Join-Path $repoRoot '.venv-captions'
$python = Join-Path $venv 'Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python)) {
    python -m venv $venv
    if ($LASTEXITCODE -ne 0) { throw 'Python 3.10 or newer is required.' }
}
& $python -m pip install -r (Join-Path $repoRoot 'native\captions-local\requirements-lock.txt')
if ($LASTEXITCODE -ne 0) { throw 'Could not install the local speech runtime.' }
& $python (Join-Path $repoRoot 'native\captions-local\download_models.py') --model $Model
if ($LASTEXITCODE -ne 0) { throw 'Model download failed. Re-run setup to resume.' }
