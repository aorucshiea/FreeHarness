# -*- coding: utf-8 -*-
"""平台后端统一入口：按 sys.platform 选择实现。

Windows 用 ctypes 直调 Win32（零依赖）；
Linux 用 xdotool / xclip / import 等系统命令（缺失时给出安装提示）；
macOS 用 osascript / pbcopy / screencapture（系统自带）。
"""

def decode_bytes(b):
    """UTF-8 优先、GBK 兜底的解码（Windows 命令输出常为 GBK）。"""
    b = b or b""
    for enc in ("utf-8", "gbk"):
        try:
            return b.decode(enc)
        except (UnicodeDecodeError, LookupError):
            continue
    return b.decode("utf-8", errors="replace")


class BackendBase(object):
    """所有平台实现的公共约定。每个方法成功返回描述字符串，失败抛异常。"""
    name = "base"

    # ---- 平台无关（子类可覆盖） ----
    def run_command(self, cmd, cwd, timeout):
        raise NotImplementedError

    def open_target(self, target):
        raise NotImplementedError

    # ---- GUI ----
    def screenshot(self, path, monitor):
        raise NotImplementedError

    def clipboard_read(self):
        raise NotImplementedError

    def clipboard_write(self, text):
        raise NotImplementedError

    def list_windows(self):
        raise NotImplementedError

    def activate_window(self, keyword):
        raise NotImplementedError

    def mouse_move(self, x, y):
        raise NotImplementedError

    def mouse_click(self, x, y, button, double):
        raise NotImplementedError

    def mouse_scroll(self, x, y, amount):
        raise NotImplementedError

    def mouse_drag(self, fx, fy, tx, ty):
        raise NotImplementedError

    def key_press(self, keys):
        raise NotImplementedError

    def type_text(self, text):
        raise NotImplementedError
