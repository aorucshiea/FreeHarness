# -*- coding: utf-8 -*-
"""Windows 后端：ctypes 直调 Win32 API，零第三方依赖。"""

import ctypes
import datetime
import os
import subprocess
import tempfile
import time
from ctypes import wintypes

from .base import BackendBase, decode_bytes

CF_UNICODETEXT = 13
GMEM_MOVEABLE = 0x0002
GMEM_ZEROINIT = 0x0040

_MOUSE_BUTTONS = {
    "left": (0x0002, 0x0004),    # MOUSEEVENTF_LEFTDOWN / LEFTUP
    "right": (0x0008, 0x0010),   # MOUSEEVENTF_RIGHTDOWN / RIGHTUP
    "middle": (0x0020, 0x0040),  # MOUSEEVENTF_MIDDLEDOWN / MIDDLUP
}

_KEY_VK = {
    "enter": 0x0D, "esc": 0x1B, "escape": 0x1B, "tab": 0x09, "space": 0x20,
    "backspace": 0x08, "delete": 0x2E, "insert": 0x2D,
    "up": 0x26, "down": 0x28, "left": 0x25, "right": 0x27,
    "home": 0x24, "end": 0x23, "pageup": 0x21, "pagedown": 0x22,
    "ctrl": 0x11, "alt": 0x12, "shift": 0x10,
    "f1": 0x70, "f2": 0x71, "f3": 0x72, "f4": 0x73, "f5": 0x74,
    "f6": 0x75, "f7": 0x76, "f8": 0x77, "f9": 0x78, "f10": 0x79,
    "f11": 0x7A, "f12": 0x7B,
}

_dpi_fixed = False


def _ensure_dpi_aware():
    """坐标一律按物理像素（截图即物理像素）。必须 DPI 感知，否则 SetCursorPos 被虚拟化偏移。"""
    global _dpi_fixed
    if _dpi_fixed:
        return
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)  # PROCESS_PER_MONITOR_DPI_AWARE
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass
    _dpi_fixed = True


def _win_user32():
    from ctypes import wintypes as wt
    u32 = ctypes.windll.user32
    k32 = ctypes.windll.kernel32
    u32.OpenClipboard.argtypes = [wt.HWND]
    u32.OpenClipboard.restype = wt.BOOL
    u32.GetClipboardData.argtypes = [wt.UINT]
    u32.GetClipboardData.restype = wt.HANDLE
    u32.SetClipboardData.argtypes = [wt.UINT, wt.HANDLE]
    u32.SetClipboardData.restype = wt.HANDLE
    k32.GlobalAlloc.argtypes = [wt.UINT, ctypes.c_size_t]
    k32.GlobalAlloc.restype = wt.HGLOBAL
    k32.GlobalLock.argtypes = [wt.HGLOBAL]
    k32.GlobalLock.restype = wt.LPVOID
    k32.GlobalUnlock.argtypes = [wt.HGLOBAL]
    k32.GlobalSize.argtypes = [wt.HGLOBAL]
    return u32, k32


def _clipboard_read():
    u32, k32 = _win_user32()
    if not u32.OpenClipboard(None):
        raise RuntimeError("无法打开剪贴板（可能被其他程序占用）")
    try:
        if not u32.IsClipboardFormatAvailable(CF_UNICODETEXT):
            return ""
        h = u32.GetClipboardData(CF_UNICODETEXT)
        if not h:
            return ""
        p = k32.GlobalLock(h)
        if not p:
            return ""
        try:
            n = k32.GlobalSize(h)
            raw = ctypes.string_at(p, n)
        finally:
            k32.GlobalUnlock(h)
        return raw.decode("utf-16-le", errors="replace").rstrip("\x00")
    finally:
        u32.CloseClipboard()


def _clipboard_write(text):
    u32, k32 = _win_user32()
    data = text.encode("utf-16-le") + b"\x00\x00"
    if not u32.OpenClipboard(None):
        raise RuntimeError("无法打开剪贴板（可能被其他程序占用）")
    try:
        u32.EmptyClipboard()
        h = k32.GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, len(data))
        if not h:
            raise RuntimeError("GlobalAlloc 失败")
        p = k32.GlobalLock(h)
        if not p:
            raise RuntimeError("GlobalLock 失败")
        try:
            ctypes.memmove(p, data, len(data))
        finally:
            k32.GlobalUnlock(h)
        if not u32.SetClipboardData(CF_UNICODETEXT, h):
            raise RuntimeError("SetClipboardData 失败")
    finally:
        u32.CloseClipboard()


def _enum_visible_windows():
    user32 = ctypes.windll.user32
    titles = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def cb(hwnd, lp):
        if not user32.IsWindowVisible(hwnd):
            return True
        n = user32.GetWindowTextLengthW(hwnd)
        if n == 0:
            return True
        buf = ctypes.create_unicode_buffer(n + 1)
        user32.GetWindowTextW(hwnd, buf, n + 1)
        titles.append(buf.value)
        return True

    user32.EnumWindows(cb, 0)
    return titles


class Win32Backend(BackendBase):
    name = "windows"

    # ---- 命令 ----
    def run_command(self, cmd, cwd, timeout):
        flags = subprocess.CREATE_NEW_PROCESS_GROUP
        # 输出走临时文件而非 PIPE：Windows 下多线程 + 管道 communicate 有永久挂起 bug，
        # 且孙进程继承管道句柄会导致等待不结束；文件重定向 + wait() 从物理上避开
        out_f = tempfile.TemporaryFile()
        err_f = tempfile.TemporaryFile()
        try:
            proc = subprocess.Popen(cmd, shell=True, stdout=out_f, stderr=err_f, cwd=cwd, creationflags=flags)
            timed_out = False
            try:
                proc.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                timed_out = True
                try:
                    subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                                   capture_output=True, timeout=10)
                except Exception:
                    try:
                        proc.kill()
                    except Exception:
                        pass
                try:
                    proc.wait(timeout=5)
                except Exception:
                    pass
            out_b = self._rewind_read(out_f)
            err_b = self._rewind_read(err_f)
        finally:
            out_f.close()
            err_f.close()
        out = decode_bytes(out_b)
        err = decode_bytes(err_b)
        parts = []
        if out:
            parts.append(out.rstrip())
        if err:
            parts.append("[stderr]\n" + err.rstrip())
        if not parts:
            parts.append("(无输出)")
        if timed_out:
            parts.append("[已超时终止（%d 秒），输出可能不完整]" % timeout)
        rc = proc.returncode if proc.returncode is not None else -1
        parts.append("[exit code: %d]" % rc)
        return "\n".join(parts)

    @staticmethod
    def _rewind_read(f):
        try:
            f.seek(0)
            return f.read()
        except Exception:
            return b""

    def open_target(self, target):
        os.startfile(target)

    # ---- 截图 ----
    def screenshot(self, path, monitor):
        try:
            from PIL import ImageGrab
        except ImportError:
            raise RuntimeError("截图需要 Pillow 库：pip install pillow")
        _ensure_dpi_aware()
        img = ImageGrab.grab(all_screens=(monitor == "all"))
        img.save(path)
        return "截图已保存: %s（%dx%d）" % (path, img.size[0], img.size[1])

    # ---- 剪贴板 ----
    def clipboard_read(self):
        return _clipboard_read()

    def clipboard_write(self, text):
        _clipboard_write(text)

    # ---- 窗口 ----
    def list_windows(self):
        return _enum_visible_windows()

    def activate_window(self, keyword):
        kw_lower = keyword.lower()
        user32 = ctypes.windll.user32
        found = []

        @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        def cb(hwnd, lp):
            if not user32.IsWindowVisible(hwnd):
                return True
            n = user32.GetWindowTextLengthW(hwnd)
            if n == 0:
                return True
            buf = ctypes.create_unicode_buffer(n + 1)
            user32.GetWindowTextW(hwnd, buf, n + 1)
            if kw_lower in buf.value.lower():
                found.append((hwnd, buf.value))
            return True

        user32.EnumWindows(cb, 0)
        if not found:
            raise LookupError("未找到标题含 %r 的可见窗口（可用 list_windows 查看）" % keyword)
        hwnd, title = found[0]
        user32.ShowWindow(hwnd, 9)  # SW_RESTORE
        user32.keybd_event(0x12, 0, 0, 0)  # Alt 解除前台锁
        user32.keybd_event(0x12, 0, 2, 0)
        user32.SetForegroundWindow(hwnd)
        return title

    # ---- 鼠标 ----
    def mouse_move(self, x, y):
        _ensure_dpi_aware()
        user32 = ctypes.windll.user32
        user32.SetCursorPos.argtypes = [ctypes.c_int, ctypes.c_int]
        user32.SetCursorPos.restype = wintypes.BOOL
        if not user32.SetCursorPos(x, y):
            raise OSError("SetCursorPos(%d,%d) 失败" % (x, y))
        return "光标已移动到 (%d, %d)" % (x, y)

    def mouse_click(self, x, y, button, double):
        if x is not None and y is not None:
            self.mouse_move(x, y)
        _ensure_dpi_aware()
        down, up = _MOUSE_BUTTONS[button]
        user32 = ctypes.windll.user32
        user32.mouse_event.argtypes = [wintypes.DWORD] * 4 + [ctypes.c_void_p]
        user32.mouse_event.restype = None
        clicks = 2 if double else 1
        for i in range(clicks):
            user32.mouse_event(down, 0, 0, 0, None)
            time.sleep(0.04)
            user32.mouse_event(up, 0, 0, 0, None)
            if i == 0:
                time.sleep(0.06)
        return "双" if double else "单"

    def mouse_scroll(self, x, y, amount):
        _ensure_dpi_aware()
        if x is not None and y is not None:
            self.mouse_move(x, y)
        user32 = ctypes.windll.user32
        user32.mouse_event.argtypes = [wintypes.DWORD] * 4 + [ctypes.c_void_p]
        user32.mouse_event.restype = None
        delta = 120 if amount > 0 else -120
        dw = wintypes.DWORD(delta & 0xFFFFFFFF)
        for _ in range(abs(amount)):
            user32.mouse_event(0x0800, 0, 0, dw, None)  # MOUSEEVENTF_WHEEL
            time.sleep(0.03)

    def mouse_drag(self, fx, fy, tx, ty):
        _ensure_dpi_aware()
        user32 = ctypes.windll.user32
        user32.SetCursorPos.argtypes = [ctypes.c_int, ctypes.c_int]
        user32.SetCursorPos.restype = wintypes.BOOL
        user32.mouse_event.argtypes = [wintypes.DWORD] * 4 + [ctypes.c_void_p]
        user32.mouse_event.restype = None
        user32.SetCursorPos(fx, fy)
        time.sleep(0.15)
        user32.mouse_event(0x0002, 0, 0, 0, None)  # LEFT DOWN
        time.sleep(0.1)
        steps = 12
        for i in range(1, steps + 1):
            user32.SetCursorPos(fx + (tx - fx) * i // steps, fy + (ty - fy) * i // steps)
            time.sleep(0.02)
        time.sleep(0.1)
        user32.mouse_event(0x0004, 0, 0, 0, None)  # LEFT UP

    # ---- 键盘 ----
    def key_press(self, keys):
        parts = [k.strip() for k in keys.split("+") if k.strip()]
        vks = []
        for k in parts:
            if k in _KEY_VK:
                vks.append(_KEY_VK[k])
            elif len(k) == 1:
                vk = ctypes.windll.user32.VkKeyScanA(ord(k)) & 0xFF
                if vk == 0xFF:
                    raise ValueError("无法映射字符 %r 到虚拟键码" % k)
                vks.append(vk)
            else:
                raise ValueError("未知按键 %r（支持: %s）" % (k, ", ".join(sorted(_KEY_VK))))
        user32 = ctypes.windll.user32
        user32.keybd_event.argtypes = [wintypes.BYTE, wintypes.BYTE, wintypes.DWORD, ctypes.c_void_p]
        user32.keybd_event.restype = None
        for vk in vks:
            user32.keybd_event(vk, 0, 0, None)
            time.sleep(0.03)
        for vk in reversed(vks):
            user32.keybd_event(vk, 0, 2, None)
            time.sleep(0.03)

    def type_text(self, text):
        _clipboard_write(text)
        time.sleep(0.1)
        self.key_press("ctrl+v")
