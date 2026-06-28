@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0least-omp-headless.ps1" %*
exit /b %ERRORLEVEL%
