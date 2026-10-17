@echo off
cd /d "%~dp0"
where python >nul 2>nul
if %errorlevel%==0 (
    python native_host.py
) else (
    py native_host.py
)
