# -*- coding: utf-8 -*-
"""平台后端包：按 sys.platform 自动选择 Windows / macOS / Linux 实现。"""

import sys

_impl = None


def get_backend():
    global _impl
    if _impl is not None:
        return _impl
    if sys.platform == "win32":
        from .win32_backend import Win32Backend as B
    elif sys.platform == "darwin":
        from .darwin_backend import DarwinBackend as B
    else:
        from .linux_backend import LinuxBackend as B
    _impl = B()
    return _impl


def platform_name():
    return {"win32": "windows", "darwin": "macos"}.get(sys.platform, "linux")


__all__ = ["get_backend", "platform_name"]
