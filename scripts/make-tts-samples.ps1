# Synthesizes caption test speech with the voices built into Windows (no downloads).
# Synthetic voices are for boundary and regression checks, not accent accuracy claims.
param([string]$OutDir = (Join-Path (Split-Path -Parent $PSScriptRoot) 'artifacts\captions\tts'))
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force $OutDir | Out-Null
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1

$passages = [ordered]@{
  continuous = 'The quarterly planning meeting will cover the new pricing model for enterprise customers and the timeline for migrating existing accounts to the updated billing platform and we also need to agree on who will own the communication plan for the sales team and how we measure adoption over the first ninety days after launch because the board expects a clear update at the end of the month'
  repetition = 'Before we close I want to say that this point is very very important for everyone on the call because the customer has asked us twice already to confirm the delivery date and we cannot afford to miss it again so please please make sure your updates are in the tracker today and that your team knows the plan'
  numbers = 'Priya will send the third quarter report to Daniel by four thirty on the twenty first of March. The budget is one point two million dollars, up fifteen percent from last year. Call me on extension four five seven if anything changes.'
}
$voices = 'Microsoft David', 'Microsoft Zira', 'Microsoft George', 'Microsoft Heera', 'Microsoft Ravi'
$synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
$all = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices
$manifest = @()
foreach ($voiceName in $voices) {
  $voice = $all | Where-Object { $_.DisplayName -eq $voiceName } | Select-Object -First 1
  if (-not $voice) { Write-Warning "$voiceName is not installed"; continue }
  $synth.Voice = $voice
  foreach ($key in $passages.Keys) {
    $task = $asTask.MakeGenericMethod([Windows.Media.SpeechSynthesis.SpeechSynthesisStream]).Invoke($null, @($synth.SynthesizeTextToStreamAsync($passages[$key])))
    $task.Wait()
    $name = '{0}-{1}' -f $key, ($voiceName -replace '^Microsoft ', '').ToLower()
    $path = Join-Path $OutDir "$name.wav"
    $source = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($task.Result)
    $file = [System.IO.File]::Create($path)
    try { $source.CopyTo($file) } finally { $file.Close(); $source.Close() }
    $manifest += [ordered]@{ name = $name; audio = $path; reference = $passages[$key]; reference_kind = 'synthetic'; source = "Windows TTS: $($voice.DisplayName) ($($voice.Language))" }
  }
}
[System.IO.File]::WriteAllText((Join-Path $OutDir 'manifest.json'), (ConvertTo-Json -InputObject $manifest), (New-Object System.Text.UTF8Encoding $false))
"Wrote $($manifest.Count) samples to $OutDir"
