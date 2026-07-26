param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Args
)

$ErrorActionPreference = "Stop"

function Resolve-RepoRoot {
  param([string]$StartDir)

  if ([string]::IsNullOrWhiteSpace($StartDir) -or -not (Test-Path $StartDir)) {
    return $null
  }

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

function Write-DebugLine {
  param(
    [string[]]$Dirs,
    [hashtable]$Payload
  )

  $json = ($Payload | ConvertTo-Json -Compress -Depth 6)
  foreach ($dir in $Dirs) {
    try {
      New-Item -ItemType Directory -Force -Path $dir | Out-Null
      Add-Content -Path (Join-Path $dir "launch-debug.jsonl") -Value $json -Encoding UTF8
    } catch {
      # Diagnostics are best effort.
    }
  }
}

function Parse-LaunchContext {
  param([string[]]$InputArgs)

  $command = $null
  if ($InputArgs.Length -ge 2 -and $InputArgs[0] -eq "-c") {
    $command = $InputArgs[1]
  }

  $launchScriptWin = $null
  if ($command -and $command -match "bash '([^']+)'") {
    $launchScriptWin = $Matches[1]
  }

  $taskId = $null
  $worktreeDir = $null
  $promptFile = $null
  $promptDir = $null
  $execLine = $null
  $ompWrapperCmd = $null
  $nativeOmpRelay = $false
  if ($launchScriptWin -and (Test-Path $launchScriptWin)) {
    try {
      $launchText = Get-Content -Raw -Path $launchScriptWin
      if ($launchText -match "GROUNDCREW_TASK_ID='least:([^']+)'") {
        $taskId = $Matches[1]
      }
      if ($launchText -match "cd '([^']+)'") {
        $worktreeDir = $Matches[1]
      }
      if ($launchText -match "_p=\$\(cat '([^']+)'\)") {
        $promptFile = $Matches[1]
      }
      if ($promptFile) {
        $promptDir = Split-Path -Parent $promptFile
      } elseif ($launchText -match "_p=\$\(cat '[^']+'\) && rm -rf '([^']+)' && exec ") {
        $promptDir = $Matches[1]
      } elseif ($launchText -match "rm -rf '([^']+)'") {
        $promptDir = $Matches[1]
      }
      if ($launchText -match "exec ([^\r\n]+)") {
        $execLine = $Matches[1].Trim()
      }
      if ($launchText -match 'exec cmd\.exe /c "([^"]*least-omp-headless\.cmd)" "\$_p"') {
        $ompWrapperCmd = $Matches[1]
        $nativeOmpRelay = $true
      }
    } catch {
      # Keep best-effort context.
    }
  }

  $repoRoot = Resolve-RepoRoot -StartDir $worktreeDir
  $jobDir = Resolve-AgentRunDir -RepoRoot $repoRoot -TaskId $taskId
  $debugDirs = Unique-Dirs @(
    $jobDir,
    $(if ($worktreeDir) { Join-Path $worktreeDir ".ai-bridge" })
  )

  return @{
    command = $command
    launchScriptWin = $launchScriptWin
    taskId = $taskId
    worktreeDir = $worktreeDir
    promptFile = $promptFile
    promptDir = $promptDir
    execLine = $execLine
    ompWrapperCmd = $ompWrapperCmd
    nativeOmpRelay = $nativeOmpRelay
    repoRoot = $repoRoot
    jobDir = $jobDir
    debugDirs = $debugDirs
  }
}

function Invoke-NativeOmpRelay {
  param(
    [hashtable]$Context,
    [string[]]$DebugDirs
  )

  if (-not $Context.nativeOmpRelay) {
    return $null
  }
  if ([string]::IsNullOrWhiteSpace($Context.worktreeDir) -or -not (Test-Path $Context.worktreeDir)) {
    return $null
  }
  if ([string]::IsNullOrWhiteSpace($Context.promptFile) -or -not (Test-Path $Context.promptFile)) {
    return $null
  }

  $ompWrapperPs1 = [System.IO.Path]::ChangeExtension($Context.ompWrapperCmd, ".ps1")
  if ([string]::IsNullOrWhiteSpace($ompWrapperPs1) -or -not (Test-Path $ompWrapperPs1)) {
    return $null
  }

  $relayArgs = @(
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    $ompWrapperPs1,
    "--prompt-file",
    $Context.promptFile
  )
  if (-not [string]::IsNullOrWhiteSpace($Context.jobDir)) {
    $relayArgs += @("--output-dir", $Context.jobDir)
  }

  $previousTaskId = $env:GROUNDCREW_TASK_ID
  if (-not [string]::IsNullOrWhiteSpace($Context.taskId)) {
    $env:GROUNDCREW_TASK_ID = "least:$($Context.taskId)"
  }

  $relayExitCode = 1
  Push-Location $Context.worktreeDir
  try {
    Write-DebugLine -Dirs $DebugDirs -Payload @{
      ts = (Get-Date).ToString("o")
      layer = "sh-launch"
      cwd = (Get-Location).Path
      resolved_launch_path = $Context.launchScriptWin
      git_bash = $bashPath
      powershell = $PSVersionTable.PSVersion.ToString()
      mode = "native-omp-relay"
      task_id = $Context.taskId
      job_dir = $Context.jobDir
      prompt_file = $Context.promptFile
      prompt_dir = $Context.promptDir
      final_command = @("powershell.exe") + $relayArgs
      exec_line = $Context.execLine
    }
    & powershell.exe @relayArgs
    $relayExitCode = $LASTEXITCODE
  } finally {
    Pop-Location
    if ([string]::IsNullOrWhiteSpace($previousTaskId)) {
      Remove-Item Env:GROUNDCREW_TASK_ID -ErrorAction SilentlyContinue
    } else {
      $env:GROUNDCREW_TASK_ID = $previousTaskId
    }
    if (-not [string]::IsNullOrWhiteSpace($Context.promptDir)) {
      Remove-Item -LiteralPath $Context.promptDir -Recurse -Force -ErrorAction SilentlyContinue
    }
  }

  return @{
    exitCode = $relayExitCode
    mode = "native-omp-relay"
    finalCommand = @("powershell.exe") + $relayArgs
  }
}

$bashPath = "C:\Program Files\Git\bin\bash.exe"
if (-not (Test-Path $bashPath)) {
  throw "Git Bash was not found at $bashPath"
}

$context = Parse-LaunchContext -InputArgs $Args
$debugDirs = $context.debugDirs

Write-DebugLine -Dirs $debugDirs -Payload @{
  ts = (Get-Date).ToString("o")
  layer = "sh.cmd"
  cwd = $env:LEAST_SH_CMD_CWD
  argv_raw = $env:LEAST_SH_CMD_ARGV_RAW
  comspec = $env:LEAST_SH_CMD_COMSPEC
  path = $env:LEAST_SH_CMD_PATH
  sh_launch = $env:LEAST_SH_CMD_SH_LAUNCH
  task_id = $context.taskId
  job_dir = $context.jobDir
}

$exitCode = 1
$mode = "direct"
$resolvedLaunchPath = $context.launchScriptWin
$finalCommand = $null
$tmpScript = $null

try {
  if ($Args.Length -ge 2 -and $Args[0] -eq "-c") {
    $command = $Args[1]
    if ($resolvedLaunchPath) {
      $nativeRelay = Invoke-NativeOmpRelay -Context $context -DebugDirs $debugDirs
      if ($nativeRelay) {
        $mode = [string]$nativeRelay.mode
        $finalCommand = @($nativeRelay.finalCommand)
        $exitCode = [int]$nativeRelay.exitCode
      } else {
        $launchPathForBash = $resolvedLaunchPath
        $finalCommand = @($bashPath, $launchPathForBash)
        Write-DebugLine -Dirs $debugDirs -Payload @{
          ts = (Get-Date).ToString("o")
          layer = "sh-launch"
          cwd = (Get-Location).Path
          received_args = $Args
          resolved_launch_path = $resolvedLaunchPath
          converted_launch_path = $launchPathForBash
          git_bash = $bashPath
          powershell = $PSVersionTable.PSVersion.ToString()
          final_command = $finalCommand
          mode = "launch-script"
          task_id = $context.taskId
          job_dir = $context.jobDir
          prompt_file = $context.promptFile
          prompt_dir = $context.promptDir
          exec_line = $context.execLine
        }
        & $bashPath $launchPathForBash
        $exitCode = $LASTEXITCODE
      }
    } else {
      $mode = "inline-script"
      $tmpScript = Join-Path ([System.IO.Path]::GetTempPath()) ("least-groundcrew-sh-" + [System.Guid]::NewGuid().ToString("N") + ".sh")
      Set-Content -Path $tmpScript -Value ($command + [Environment]::NewLine) -Encoding ASCII
      $extraArgs = if ($Args.Length -gt 2) { $Args[2..($Args.Length - 1)] } else { @() }
      $finalCommand = @($bashPath, $tmpScript) + $extraArgs
      Write-DebugLine -Dirs $debugDirs -Payload @{
        ts = (Get-Date).ToString("o")
        layer = "sh-launch"
        cwd = (Get-Location).Path
        received_args = $Args
        resolved_launch_path = $null
        converted_launch_path = $tmpScript
        git_bash = $bashPath
        powershell = $PSVersionTable.PSVersion.ToString()
        final_command = $finalCommand
        mode = $mode
        task_id = $context.taskId
        job_dir = $context.jobDir
      }
      & $bashPath $tmpScript @extraArgs
      $exitCode = $LASTEXITCODE
    }
  } else {
    $finalCommand = @($bashPath) + $Args
    Write-DebugLine -Dirs $debugDirs -Payload @{
      ts = (Get-Date).ToString("o")
      layer = "sh-launch"
      cwd = (Get-Location).Path
      received_args = $Args
      resolved_launch_path = $resolvedLaunchPath
      converted_launch_path = $resolvedLaunchPath
      git_bash = $bashPath
      powershell = $PSVersionTable.PSVersion.ToString()
      final_command = $finalCommand
      mode = $mode
      task_id = $context.taskId
      job_dir = $context.jobDir
    }
    & $bashPath @Args
    $exitCode = $LASTEXITCODE
  }
} catch {
  Write-DebugLine -Dirs $debugDirs -Payload @{
    ts = (Get-Date).ToString("o")
    layer = "sh-launch"
    cwd = (Get-Location).Path
    received_args = $Args
    resolved_launch_path = $resolvedLaunchPath
    git_bash = $bashPath
    powershell = $PSVersionTable.PSVersion.ToString()
    final_command = $finalCommand
    mode = $mode
    task_id = $context.taskId
    job_dir = $context.jobDir
    error = $_.Exception.Message
  }
  throw
} finally {
  if ($tmpScript) {
    Remove-Item -LiteralPath $tmpScript -Force -ErrorAction SilentlyContinue
  }
  Write-DebugLine -Dirs $debugDirs -Payload @{
    ts = (Get-Date).ToString("o")
    layer = "sh-launch"
    cwd = (Get-Location).Path
    resolved_launch_path = $resolvedLaunchPath
    git_bash = $bashPath
    powershell = $PSVersionTable.PSVersion.ToString()
    mode = $mode
    task_id = $context.taskId
    job_dir = $context.jobDir
    exit_code = $exitCode
  }
}

exit $exitCode
