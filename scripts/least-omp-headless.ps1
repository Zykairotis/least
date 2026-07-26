param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$RawArgs
)

$ErrorActionPreference = "Stop"

function Resolve-RepoRoot {
  param([string]$StartDir)

  $current = [System.IO.DirectoryInfo]::new($StartDir)
  while ($null -ne $current) {
    $agentRuns = Join-Path $current.FullName ".ai-bridge\agent-runs"
    if (Test-Path $agentRuns) {
      return $current.FullName
    }
    $current = $current.Parent
  }
  return $null
}

function Resolve-AgentRunDir {
  param(
    [string]$RepoRoot,
    [string]$TaskId
  )

  if ([string]::IsNullOrWhiteSpace($RepoRoot) -or [string]::IsNullOrWhiteSpace($TaskId)) {
    return $null
  }

  $agentRunsRoot = Join-Path $RepoRoot ".ai-bridge\agent-runs"
  if (-not (Test-Path $agentRunsRoot)) {
    return $null
  }

  foreach ($entry in Get-ChildItem -Path $agentRunsRoot -Directory -ErrorAction SilentlyContinue) {
    $statusPath = Join-Path $entry.FullName "status.json"
    if (-not (Test-Path $statusPath)) {
      continue
    }
    try {
      $status = Get-Content -Raw -Path $statusPath | ConvertFrom-Json
      if ($status.taskId -eq $TaskId) {
        return $entry.FullName
      }
    } catch {
      continue
    }
  }

  return $null
}

function Unique-Dirs {
  param([string[]]$Paths)

  $seen = New-Object "System.Collections.Generic.HashSet[string]" ([System.StringComparer]::OrdinalIgnoreCase)
  $dirs = @()
  foreach ($path in $Paths) {
    if ([string]::IsNullOrWhiteSpace($path)) {
      continue
    }
    if ($seen.Add($path)) {
      $dirs += $path
    }
  }
  return $dirs
}

function Write-JsonAtomic {
  param(
    [string]$Path,
    [object]$Value
  )

  New-Item -ItemType Directory -Force -Path ([System.IO.Path]::GetDirectoryName($Path)) | Out-Null
  $tmpPath = "$Path.$PID.tmp"
  $json = ($Value | ConvertTo-Json -Depth 8)
  [System.IO.File]::WriteAllText($tmpPath, $json + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
  if (Test-Path $Path) {
    Remove-Item -LiteralPath $Path -Force
  }
  Move-Item -LiteralPath $tmpPath -Destination $Path -Force
}

function Append-DebugLine {
  param(
    [string[]]$Dirs,
    [hashtable]$Payload
  )

  $json = ($Payload | ConvertTo-Json -Compress -Depth 8)
  foreach ($dir in $Dirs) {
    try {
      New-Item -ItemType Directory -Force -Path $dir | Out-Null
      Add-Content -Path (Join-Path $dir "launch-debug.jsonl") -Value $json -Encoding UTF8
    } catch {
      # Best effort only.
    }
  }
}

function Write-JsonToDirs {
  param(
    [string[]]$Dirs,
    [string]$Name,
    [hashtable]$Payload
  )

  foreach ($dir in $Dirs) {
    Write-JsonAtomic -Path (Join-Path $dir $Name) -Value $Payload
  }
}

function Promote-TempFile {
  param(
    [string]$TempPath,
    [string]$FinalPath
  )

  if (Test-Path $FinalPath) {
    Remove-Item -LiteralPath $FinalPath -Force
  }
  Move-Item -LiteralPath $TempPath -Destination $FinalPath -Force
}

function Mirror-FileToDirs {
  param(
    [string]$SourcePath,
    [string[]]$Dirs,
    [string]$Name
  )

  foreach ($dir in $Dirs) {
    $destination = Join-Path $dir $Name
    if ([System.StringComparer]::OrdinalIgnoreCase.Equals($SourcePath, $destination)) {
      continue
    }
    Copy-Item -Force -LiteralPath $SourcePath -Destination $destination
  }
}

function Parse-WrapperArgs {
  param([string[]]$InputArgs)

  $promptFile = $null
  $outputDir = $null
  $promptParts = @()

  for ($i = 0; $i -lt $InputArgs.Length; $i += 1) {
    $arg = $InputArgs[$i]
    switch ($arg) {
      "--prompt-file" {
        if ($i + 1 -ge $InputArgs.Length) {
          throw "--prompt-file requires a path."
        }
        $promptFile = $InputArgs[$i + 1]
        $i += 1
      }
      "--output-dir" {
        if ($i + 1 -ge $InputArgs.Length) {
          throw "--output-dir requires a path."
        }
        $outputDir = $InputArgs[$i + 1]
        $i += 1
      }
      "--help" {
        Write-Output "least-omp-headless.ps1 [--prompt-file <path>] [--output-dir <path>] [prompt...]"
        exit 0
      }
      default {
        $promptParts += $arg
      }
    }
  }

  return @{
    PromptFile = $promptFile
    OutputDir = $outputDir
    PromptParts = $promptParts
  }
}

function Resolve-PromptText {
  param(
    [string]$PromptFile,
    [string[]]$PromptParts
  )

  if (-not [string]::IsNullOrWhiteSpace($PromptFile)) {
    if (-not (Test-Path $PromptFile)) {
      throw "Prompt file does not exist: $PromptFile"
    }
    return (Get-Content -Raw -Path $PromptFile).Trim()
  }

  return ($PromptParts -join " ").Trim()
}

function Quote-CommandLineArgument {
  param([string]$Value)

  if ($null -eq $Value) {
    return '""'
  }
  if ($Value -notmatch '[\s"]') {
    return $Value
  }

  $result = '"'
  $backslashes = 0
  foreach ($char in $Value.ToCharArray()) {
    if ($char -eq '\') {
      $backslashes += 1
      continue
    }
    if ($char -eq '"') {
      $result += ('\' * ($backslashes * 2 + 1))
      $result += '"'
      $backslashes = 0
      continue
    }
    if ($backslashes -gt 0) {
      $result += ('\' * $backslashes)
      $backslashes = 0
    }
    $result += $char
  }
  if ($backslashes -gt 0) {
    $result += ('\' * ($backslashes * 2))
  }
  $result += '"'
  return $result
}

function Build-CommandLine {
  param([string[]]$Arguments)

  return ($Arguments | ForEach-Object { Quote-CommandLineArgument -Value $_ }) -join " "
}

function Resolve-OmpExecutable {
  if (-not [string]::IsNullOrWhiteSpace($env:LEAST_OMP_EXECUTABLE)) {
    return $env:LEAST_OMP_EXECUTABLE
  }
  $command = Get-Command omp.exe -ErrorAction SilentlyContinue
  if ($null -eq $command) {
    $command = Get-Command omp -ErrorAction SilentlyContinue
  }
  if ($null -eq $command) {
    throw "omp executable was not found in PATH."
  }
  return $command.Source
}

function Resolve-OmpPrefixArgs {
  if ([string]::IsNullOrWhiteSpace($env:LEAST_OMP_EXECUTABLE_ARGS_JSON)) {
    return @()
  }
  $parsed = ConvertFrom-Json -InputObject $env:LEAST_OMP_EXECUTABLE_ARGS_JSON
  if ($parsed -is [System.Array]) {
    return @($parsed | ForEach-Object { [string]$_ })
  }
  throw "LEAST_OMP_EXECUTABLE_ARGS_JSON must be a JSON array."
}

function Read-FirstLine {
  param([string]$Text)

  if ([string]::IsNullOrWhiteSpace($Text)) {
    return $null
  }
  return ($Text -split "\r?\n")[0].Trim()
}

function Write-TextFileUtf8 {
  param(
    [string]$Path,
    [string]$Text
  )

  [System.IO.File]::WriteAllText($Path, $Text, [System.Text.UTF8Encoding]::new($false))
}

$parsedArgs = Parse-WrapperArgs -InputArgs $RawArgs
$worktreeDir = (Get-Location).Path
$repoRoot = Resolve-RepoRoot -StartDir $worktreeDir
$rawTaskId = if ($null -ne $env:GROUNDCREW_TASK_ID) { [string]$env:GROUNDCREW_TASK_ID } else { "" }
$taskId = $rawTaskId -replace "^least:", ""
$jobDir = Resolve-AgentRunDir -RepoRoot $repoRoot -TaskId $taskId
$localOutputDir = Join-Path $worktreeDir ".ai-bridge"
$primaryOutputDir = if (-not [string]::IsNullOrWhiteSpace($parsedArgs.OutputDir)) {
  $parsedArgs.OutputDir
} elseif ($jobDir) {
  $jobDir
} else {
  $localOutputDir
}
$allOutputDirs = Unique-Dirs @($primaryOutputDir, $jobDir, $localOutputDir)

foreach ($dir in $allOutputDirs) {
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
}

$promptText = Resolve-PromptText -PromptFile $parsedArgs.PromptFile -PromptParts $parsedArgs.PromptParts
if ([string]::IsNullOrWhiteSpace($promptText)) {
  throw "least-omp-headless.ps1 requires a non-empty prompt."
}

$ompExecutable = Resolve-OmpExecutable
$ompPrefixArgs = Resolve-OmpPrefixArgs
$ompVersion = $null
try {
  $ompVersion = Read-FirstLine -Text (& $ompExecutable @($ompPrefixArgs + @("--version")) 2>$null | Out-String)
} catch {
  $ompVersion = $null
}

$stdoutPath = Join-Path $primaryOutputDir "stdout.log"
$stderrPath = Join-Path $primaryOutputDir "stderr.log"
$resultPath = Join-Path $primaryOutputDir "result.md"
$stdoutTempPath = Join-Path $primaryOutputDir "stdout.log.tmp"
$stderrTempPath = Join-Path $primaryOutputDir "stderr.log.tmp"
$resultTempPath = Join-Path $primaryOutputDir "result.md.tmp"
$startedAt = (Get-Date).ToString("o")

Append-DebugLine -Dirs $allOutputDirs -Payload @{
  ts = $startedAt
  layer = "least-omp-headless"
  cwd = $worktreeDir
  task_id = $taskId
  repo_root = $repoRoot
  prompt_file = $parsedArgs.PromptFile
  prompt_bytes = [System.Text.Encoding]::UTF8.GetByteCount($promptText)
  output_dir = $primaryOutputDir
  local_output_dir = $localOutputDir
  job_dir = $jobDir
  omp_executable = $ompExecutable
  omp_version = $ompVersion
  stdout_path = $stdoutPath
  stderr_path = $stderrPath
  result_path = $resultPath
}

Write-JsonToDirs -Dirs $allOutputDirs -Name "started.json" -Payload @{
  startedAt = $startedAt
  cwd = $worktreeDir
  taskId = $taskId
  promptFile = $parsedArgs.PromptFile
  promptBytes = [System.Text.Encoding]::UTF8.GetByteCount($promptText)
  outputDir = $primaryOutputDir
  ompExecutable = $ompExecutable
  ompVersion = $ompVersion
}

$processStartedAt = $null
$processExitedAt = $null
$exitCode = 1
$stdoutText = ""
$stderrText = ""

try {
  $ompArgs = @($ompPrefixArgs + @("-p", "--approval-mode", "write", "--mode", "text", "--no-session", $promptText))
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $ompExecutable
  $startInfo.Arguments = Build-CommandLine -Arguments $ompArgs
  $startInfo.WorkingDirectory = $worktreeDir
  $startInfo.UseShellExecute = $false
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.CreateNoWindow = $true

  Append-DebugLine -Dirs $allOutputDirs -Payload @{
    ts = (Get-Date).ToString("o")
    layer = "least-omp-headless"
    cwd = $worktreeDir
    task_id = $taskId
    command = $startInfo.FileName
    arguments = $ompArgs
  }

  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  $processStartedAt = (Get-Date).ToString("o")
  $null = $process.Start()
  $stdoutText = $process.StandardOutput.ReadToEnd()
  $stderrText = $process.StandardError.ReadToEnd()
  $process.WaitForExit()
  $processExitedAt = (Get-Date).ToString("o")
  $exitCode = $process.ExitCode
} catch {
  $processExitedAt = (Get-Date).ToString("o")
  $stderrText = ($stderrText + [Environment]::NewLine + $_.Exception.Message).Trim()
  $exitCode = 1
}

$stdoutFinalText = $stdoutText.TrimEnd("`r", "`n")
$stderrFinalText = $stderrText.TrimEnd("`r", "`n")
$resultFinalText = $stdoutFinalText

if ($stdoutFinalText.Length -gt 0) {
  $stdoutFinalText += [Environment]::NewLine
}
if ($stderrFinalText.Length -gt 0) {
  $stderrFinalText += [Environment]::NewLine
}
if ($resultFinalText.Length -gt 0) {
  $resultFinalText += [Environment]::NewLine
}

Write-TextFileUtf8 -Path $stdoutTempPath -Text $stdoutFinalText
Write-TextFileUtf8 -Path $stderrTempPath -Text $stderrFinalText
Write-TextFileUtf8 -Path $resultTempPath -Text $resultFinalText

Promote-TempFile -TempPath $stdoutTempPath -FinalPath $stdoutPath
Promote-TempFile -TempPath $stderrTempPath -FinalPath $stderrPath
Promote-TempFile -TempPath $resultTempPath -FinalPath $resultPath

$mirrorDirs = $allOutputDirs | Where-Object { -not [System.StringComparer]::OrdinalIgnoreCase.Equals($_, $primaryOutputDir) }
Mirror-FileToDirs -SourcePath $stdoutPath -Dirs $mirrorDirs -Name "stdout.log"
Mirror-FileToDirs -SourcePath $stderrPath -Dirs $mirrorDirs -Name "stderr.log"
Mirror-FileToDirs -SourcePath $resultPath -Dirs $mirrorDirs -Name "result.md"

$stdoutBytes = (Get-Item -LiteralPath $stdoutPath).Length
$stderrBytes = (Get-Item -LiteralPath $stderrPath).Length
$resultBytes = (Get-Item -LiteralPath $resultPath).Length

Append-DebugLine -Dirs $allOutputDirs -Payload @{
  ts = (Get-Date).ToString("o")
  layer = "least-omp-headless"
  cwd = $worktreeDir
  task_id = $taskId
  process_started_at = $processStartedAt
  process_exited_at = $processExitedAt
  exit_code = $exitCode
  stdout_bytes = $stdoutBytes
  stderr_bytes = $stderrBytes
  result_bytes = $resultBytes
}

if ($exitCode -eq 0 -and $resultBytes -eq 0) {
  $captureError = @{
    failedAt = (Get-Date).ToString("o")
    cwd = $worktreeDir
    taskId = $taskId
    reason = "omp exited successfully but produced no output."
    exitCode = $exitCode
    stdoutBytes = $stdoutBytes
    stderrBytes = $stderrBytes
    resultBytes = $resultBytes
  }
  Write-JsonToDirs -Dirs $allOutputDirs -Name "capture-error.json" -Payload $captureError
  if ($stderrBytes -eq 0) {
    $message = "omp exited successfully but produced no output." + [Environment]::NewLine
    Write-TextFileUtf8 -Path $stderrPath -Text $message
    Mirror-FileToDirs -SourcePath $stderrPath -Dirs $mirrorDirs -Name "stderr.log"
  }
  Write-Error "omp exited successfully but produced no output."
  exit 1
}

if ($exitCode -ne 0) {
  $captureError = @{
    failedAt = (Get-Date).ToString("o")
    cwd = $worktreeDir
    taskId = $taskId
    reason = "omp exited with a non-zero code."
    exitCode = $exitCode
    stdoutBytes = $stdoutBytes
    stderrBytes = $stderrBytes
    resultBytes = $resultBytes
  }
  Write-JsonToDirs -Dirs $allOutputDirs -Name "capture-error.json" -Payload $captureError
  exit $exitCode
}

Write-JsonToDirs -Dirs $allOutputDirs -Name "completed.json" -Payload @{
  completedAt = (Get-Date).ToString("o")
  cwd = $worktreeDir
  taskId = $taskId
  exitCode = $exitCode
  stdoutBytes = $stdoutBytes
  stderrBytes = $stderrBytes
  resultBytes = $resultBytes
}

if ($stdoutFinalText.Length -gt 0) {
  Write-Output $stdoutFinalText.TrimEnd("`r", "`n")
}

exit $exitCode
