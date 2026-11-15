@echo off
chcp 936 >nul
title FreeHarness 一键安装
cd /d "%~dp0"
echo ============================================================
echo   FreeHarness 一键安装
echo   自动检测已加载的扩展 - 注册 native host - 开启登录自启
echo ============================================================
echo.
set "PY=python"
where python >nul 2>nul
if errorlevel 1 set "PY=py"
%PY% "server\launcher\install_host.py" --autostart
if errorlevel 1 (
    echo.
    echo [失败] 请确认已安装 Python，且扩展已在浏览器中加载。
    echo 手动方式：python server\launcher\install_host.py --autostart
    pause >nul
    exit /b 1
)
echo.
echo [完成] 注册成功，正在后台启动服务...
wscript.exe "%~dp0server\launcher\autostart_server.vbs"
echo.
echo 服务已在后台运行。打开扩展弹窗应显示 18 个工具就绪。
echo 以后登录系统会自动启动服务，无需再双击任何东西。
echo.
pause >nul
