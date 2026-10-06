@echo off
title WebHarness Server
cd /d %~dp0
where python >nul 2>nul
if %errorlevel%==0 (
    python harness_server.py
) else (
    py harness_server.py
)
echo.
echo Server exited. If it closed instantly, check that Python is installed (python --version).
pause >nul
