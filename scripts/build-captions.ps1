$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$cargoCommand = Get-Command cargo -ErrorAction SilentlyContinue
$cargoPath = if ($cargoCommand) { $cargoCommand.Source } else { Join-Path $env:USERPROFILE '.cargo\bin\cargo.exe' }
if (-not (Test-Path -LiteralPath $cargoPath)) { throw 'Install Rust stable and Visual Studio C++ Build Tools first.' }
& $cargoPath build --release --manifest-path (Join-Path $repoRoot 'native\captions\Cargo.toml') --bin audio-capture
if ($LASTEXITCODE -ne 0) { throw 'Could not build the system audio capture helper.' }
