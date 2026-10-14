$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$project = Join-Path $repoRoot 'native\captions-windows-ai\captions-windows-ai.csproj'
$output = Join-Path $repoRoot 'native\captions-windows-ai\publish'

dotnet publish $project --configuration Release --runtime win-x64 --self-contained true --output $output
if ($LASTEXITCODE -ne 0) {
  throw 'The Windows AI captions worker did not publish successfully.'
}

Write-Host "Windows AI speech prototype published to $output"
Write-Host 'This experimental worker requires the Windows App SDK runtime and an MSIX package identity with the systemAIModels capability.'
