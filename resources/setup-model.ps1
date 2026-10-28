# One-time on-device captions-engine setup, run by the installer during setup.
# Downloads the engine files into the app's per-user data folder so the app opens
# ready with no in-app download. Served from the A2solveX domain (generic path).
$ErrorActionPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$dir = Join-Path $env:APPDATA 'private-meeting-overlay\models\speech-pack'
New-Item -ItemType Directory -Force -Path $dir | Out-Null

$base  = 'https://a2solvex.a2cloud.in/deps/speech-pack'
$files = @('encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt')

$wc = New-Object System.Net.WebClient
foreach ($f in $files) {
  $out = Join-Path $dir $f
  if (-not (Test-Path $out)) {
    try { $wc.DownloadFile("$base/$f", $out) } catch { }
  }
}
