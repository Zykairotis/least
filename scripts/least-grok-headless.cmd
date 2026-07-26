@echo off
REM Least/Groundcrew Grok Build wrapper for Windows.
REM Usage: least-grok-headless.cmd <prompt...>
grok --no-auto-update -p %* --output-format streaming-json
