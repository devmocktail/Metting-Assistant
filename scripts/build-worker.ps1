# Freezes the caption worker (Python, models' runtimes, Silero VAD) into a standalone
# folder for the installer: build\worker-dist\caption-worker\caption-worker.exe
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$python = Join-Path $repoRoot '.venv-captions\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python)) { throw 'Run npm run setup:captions-local first.' }
& $python -m PyInstaller --version | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'PyInstaller is missing: .venv-captions\Scripts\python.exe -m pip install -r native\captions-local\requirements-build.txt' }
$build = Join-Path $repoRoot 'build'
& $python -m PyInstaller --noconfirm --clean --onedir --console --name caption-worker `
    --distpath (Join-Path $build 'worker-dist') --workpath (Join-Path $build 'worker-work') --specpath $build `
    --collect-all sherpa_onnx --collect-all ctranslate2 --collect-all onnxruntime --collect-data faster_whisper `
    --exclude-module tkinter --exclude-module matplotlib `
    (Join-Path $repoRoot 'native\captions-local\worker.py')
if ($LASTEXITCODE -ne 0) { throw 'Could not build the caption worker.' }
# onnxruntime's model conversion and tuning tools are never imported for captions, and
# their deepest paths are too long for the uninstaller under a long install folder.
foreach ($unused in 'tools', 'transformers', 'quantization') {
    $folder = Join-Path $build "worker-dist\caption-worker\_internal\onnxruntime\$unused"
    if (Test-Path -LiteralPath $folder) { Remove-Item -LiteralPath $folder -Recurse -Force }
}
