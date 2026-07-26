@echo off
REM Groundcrew zellij tab layouts spawn panes with command="sh".
REM Prefer Git's native POSIX shell on Windows so native zellij tabs can run
REM Windows-oriented commands without WSL path translation.
set "LEAST_SH_CMD_CWD=%CD%"
set "LEAST_SH_CMD_ARGV_RAW=%*"
set "LEAST_SH_CMD_COMSPEC=%COMSPEC%"
set "LEAST_SH_CMD_PATH=%PATH%"
set "LEAST_SH_CMD_SH_LAUNCH=%~dp0sh-launch.ps1"
if exist "C:\Program Files\Git\bin\bash.exe" (
  if /I "%~1"=="-c" (
    setlocal EnableDelayedExpansion
    set "LEAST_SH_CMD_ALL_ARGS=%*"
    set "LEAST_SH_CMD_COMMAND=!LEAST_SH_CMD_ALL_ARGS!"
    if /I "!LEAST_SH_CMD_COMMAND:~0,3!"=="-c " set "LEAST_SH_CMD_COMMAND=!LEAST_SH_CMD_COMMAND:~3!"
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0sh-launch.ps1" -c "!LEAST_SH_CMD_COMMAND!"
    exit /b %ERRORLEVEL%
  ) else (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0sh-launch.ps1" %*
    exit /b %ERRORLEVEL%
  )
)
REM Fallback for hosts without Git for Windows.
wsl.exe sh %*
