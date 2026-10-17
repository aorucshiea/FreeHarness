#!/bin/sh
# FreeHarness 本地服务启动脚本（macOS / Linux）
cd "$(dirname "$0")" || exit 1
if command -v python3 >/dev/null 2>&1; then
    exec python3 harness_server.py
else
    exec python harness_server.py
fi
