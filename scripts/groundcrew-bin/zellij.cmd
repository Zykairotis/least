@echo off
REM Groundcrew zellij adapter expects POSIX shell panes; forward to WSL zellij.
wsl.exe zellij %*