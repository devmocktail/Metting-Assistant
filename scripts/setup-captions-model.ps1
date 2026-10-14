$ErrorActionPreference = 'Stop'
$modelName = 'sherpa-onnx-streaming-zipformer-en-2023-06-26'
$modelRoot = Join-Path $env:APPDATA 'private-meeting-overlay\models'
$modelPath = Join-Path $modelRoot $modelName
$archive = Join-Path $env:TEMP "$modelName.tar.bz2"
$url = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/$modelName.tar.bz2"

New-Item -ItemType Directory -Force -Path $modelRoot | Out-Null
Write-Host "Downloading the English offline speech model from the sherpa-onnx project..."
Invoke-WebRequest -Uri $url -OutFile $archive
Write-Host 'Extracting model files...'
tar.exe -xjf $archive -C $modelRoot
Remove-Item -LiteralPath $archive -Force
if (-not (Test-Path (Join-Path $modelPath 'tokens.txt'))) {
  throw "Model extraction did not create $modelPath"
}
Write-Host "Speech model ready at $modelPath"
