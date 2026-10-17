#!/bin/sh
# Native Messaging Host 包装（macOS / Linux）：stdout 只留给协议，不能有任何杂音
cd "$(dirname "$0")" || exit 1
if command -v python3 >/dev/null 2>&1; then
    exec python3 native_host.py
else
    exec python native_host.py
fi
