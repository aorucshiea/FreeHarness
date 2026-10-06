# -*- coding: utf-8 -*-
"""
WebHarness 本地执行服务
监听 127.0.0.1:8765，接收浏览器扩展转发来的 AI 工具调用并在本机执行。
零第三方依赖，仅 Python 标准库（Python 3.8+）。

安全设计：
  - 仅监听 127.0.0.1，不对外网开放
  - 响应不带 CORS 头：普通网页的跨域 fetch 会被浏览器拦截（预检失败），
    只有持有 host_permissions 的扩展才能调用
  - 高危命令黑名单（format / diskpart / 整盘删除等）
  - 命令超时上限、输出大小截断
"""
import datetime
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = "127.0.0.1"
PORT = 8765

MAX_OUTPUT_CHARS = 60000      # 单次结果最大字符数（发回网页输入框）
MAX_READ_BYTES = 200_000      # read_file 默认最多读取
MAX_WRITE_BYTES = 2_000_000   # write_file 单次最大
MAX_DIR_ENTRIES = 1000        # list_dir 最多列出
DEFAULT_TIMEOUT = 60          # 命令默认超时（秒）
MAX_TIMEOUT = 300             # 命令超时上限（秒）
MAX_CALLS_PER_REQ = 10        # 单次请求最多调用数

# 高危命令黑名单（正则，忽略大小写）
DANGEROUS_PATTERNS = [
    r"\bformat(\.com)?\s+[a-z]:",                      # format c:
    r"\bdiskpart\b",                                   # 分区操作
    r"\bcipher\s+/w",                                  # 盘数据擦除
    r"\brd\s+/s\s+/q\s+[a-z]:\\",                      # rd /s /q C:\
    r"\bdel\s+/[fs].*\\{0,1}\s*$",                    # del /f /q 盘根清空（粗匹配）
    r"(?i)\brm\s+[^|;&]*-[a-z]*r[a-z]*f[^|;&]*\s+/(\s|$)",  # rm -rf /
    r"(?i)\brm\s+[^|;&]*-[a-z]*f[a-z]*r[^|;&]*\s+/(\s|$)",  # rm -fr /
    r"\bshutdown\b",                                   # 关机重启
    r"\bvssadmin\s+delete\s+shadows",                  # 删卷影副本（勒索软件行为）
]


def now():
    return time.strftime("%H:%M:%S")


def truncate(s, n=MAX_OUTPUT_CHARS):
    if len(s) <= n:
        return s
    return s[:n] + "\n...[已截断, 原文共 %d 字符]" % len(s)


def decode_bytes(b):
    b = b or b""
    for enc in ("utf-8", "gbk"):
        try:
            return b.decode(enc)
        except (UnicodeDecodeError, LookupError):
            continue
    return b.decode("utf-8", errors="replace")


# 已知的二进制/图片扩展名（read_file 直接拒绝，避免二进制垃圾灌进对话窗口）
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".ico", ".tiff", ".tif"}
BINARY_EXTS = IMAGE_EXTS | {
    ".exe", ".dll", ".sys", ".com", ".msi", ".scr", ".drv",
    ".zip", ".rar", ".7z", ".tar", ".gz", ".bz2", ".xz",
    ".mp3", ".wav", ".mp4", ".mkv", ".avi", ".mov", ".flv",
    ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
    ".woff", ".woff2", ".ttf", ".otf", ".class", ".jar", ".pyc",
}


def _looks_binary(data):
    """启发式嗅探：前 8KB 含 NUL 字节、或控制字符占比超过 5% 视为二进制。
    带 UTF-16/32 BOM 的文件直接放行（其内容本含大量 NUL）。"""
    if not data:
        return False
    if data[:4] in (b"\xff\xfe\x00\x00", b"\x00\x00\xfe\xff"):
        return False
    if data[:2] in (b"\xff\xfe", b"\xfe\xff"):
        return False
    sample = data[:8192]
    if b"\x00" in sample:
        return True
    bad = 0
    for b in sample:
        if b < 32 and b not in (9, 10, 13):
            bad += 1
    return bad * 20 > len(sample)


def _decode_text(data):
    """带 BOM 检测的文本解码（UTF-16/32 带 BOM 的文本文件不致误判为二进制）。"""
    if data.startswith(b"\xff\xfe\x00\x00") or data.startswith(b"\x00\x00\xfe\xff"):
        return data.decode("utf-32", errors="replace")
    if data.startswith(b"\xff\xfe") or data.startswith(b"\xfe\xff"):
        return data.decode("utf-16", errors="replace")
    if data.startswith(b"\xef\xbb\xbf"):
        return data.decode("utf-8", errors="replace")
    return decode_bytes(data)


def resolve_path(p):
    path = os.path.expandvars(os.path.expanduser(str(p)))
    return os.path.abspath(path)


def check_dangerous(cmd):
    for pat in DANGEROUS_PATTERNS:
        if re.search(pat, cmd, re.IGNORECASE):
            raise PermissionError("命令命中安全黑名单（毁灭性操作已拦截）: %s" % cmd[:100])


# ---------------- 工具实现 ----------------

def tool_run_command(p):
    cmd = str(p.get("command", "")).strip()
    if not cmd:
        raise ValueError("command 不能为空")
    check_dangerous(cmd)
    try:
        timeout = int(p.get("timeout", DEFAULT_TIMEOUT) or DEFAULT_TIMEOUT)
    except (TypeError, ValueError):
        timeout = DEFAULT_TIMEOUT
    timeout = max(1, min(timeout, MAX_TIMEOUT))
    cwd = p.get("cwd")
    if cwd:
        cwd = resolve_path(cwd)
        if not os.path.isdir(cwd):
            raise FileNotFoundError("cwd 目录不存在: %s" % cwd)
    flags = subprocess.CREATE_NEW_PROCESS_GROUP if sys.platform == "win32" else 0
    # 输出走临时文件而非 PIPE：Windows 下多线程 + 管道 communicate 有永久挂起 bug，
    # 且孙进程继承管道句柄会导致等待不结束；文件重定向 + wait() 从物理上避开
    out_f = tempfile.TemporaryFile()
    err_f = tempfile.TemporaryFile()
    try:
        proc = subprocess.Popen(
            cmd, shell=True, stdout=out_f, stderr=err_f,
            cwd=cwd, creationflags=flags,
        )
        timed_out = False
        try:
            proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            # 杀整个进程树，防止孙进程残留
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
        out_b = _rewind_read(out_f)
        err_b = _rewind_read(err_f)
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
    return truncate("\n".join(parts))


def _rewind_read(f):
    try:
        f.seek(0)
        return f.read()
    except Exception:
        return b""


def tool_read_file(p):
    path = resolve_path(p.get("path"))
    if not os.path.isfile(path):
        raise FileNotFoundError("文件不存在: %s" % path)
    ext = os.path.splitext(path)[1].lower()
    if ext in BINARY_EXTS:
        if ext in IMAGE_EXTS:
            raise ValueError(
                "这是图片文件(%s)，read_file 不能读取二进制。请改用 view_image 工具查看图片内容。" % ext
            )
        raise ValueError(
            "这是二进制文件(%s)，read_file 只能读取文本文件，请改用其他方式处理。" % ext
        )
    size = os.path.getsize(path)
    try:
        limit = int(p.get("max_bytes", MAX_READ_BYTES))
    except (TypeError, ValueError):
        limit = MAX_READ_BYTES
    with open(path, "rb") as f:
        data = f.read(max(1, limit))
    if _looks_binary(data):
        raise ValueError(
            "检测到二进制内容，read_file 只能读取文本文件。图片请改用 view_image 工具查看。"
        )
    head = "[读取 %s | 文件共 %d 字节%s]\n" % (
        path, size, ("，本次读取前 %d 字节" % limit) if size > limit else ""
    )
    return head + truncate(_decode_text(data))


def tool_write_file(p, mode="w"):
    path = resolve_path(p.get("path"))
    content = str(p.get("content", ""))
    if len(content.encode("utf-8")) > MAX_WRITE_BYTES:
        raise ValueError("内容超过 %d 字节上限" % MAX_WRITE_BYTES)
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(path, mode, encoding="utf-8", newline="") as f:
        f.write(content)
    verb = "追加" if mode == "a" else "写入"
    return "已%s %s（%d 字符）" % (verb, path, len(content))


def tool_append_file(p):
    return tool_write_file(p, mode="a")


def tool_list_dir(p):
    path = resolve_path(p.get("path", "."))
    if not os.path.isdir(path):
        raise FileNotFoundError("目录不存在: %s" % path)
    items = []
    with os.scandir(path) as it:
        for i, e in enumerate(it):
            if i >= MAX_DIR_ENTRIES:
                items.append("...(超过 %d 项，已截断)" % MAX_DIR_ENTRIES)
                break
            try:
                st = e.stat()
                sz = 0 if e.is_dir() else st.st_size
                mt = datetime.datetime.fromtimestamp(st.st_mtime).strftime("%m-%d %H:%M")
            except OSError:
                sz, mt = -1, "?"
            flag = "<DIR>  " if e.is_dir() else "       "
            items.append("%s%-50s %12d  %s" % (flag, e.name, sz, mt))
    return "[%s] 共 %d 项\n%s" % (path, len(items), "\n".join(items))


# ---------------- 屏幕 / 应用 / 剪贴板 / 窗口 ----------------

def tool_screenshot(p):
    try:
        from PIL import ImageGrab
    except ImportError:
        raise RuntimeError("截图需要 Pillow 库：pip install pillow")
    import ctypes
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)  # DPI 感知，坐标/尺寸才准确
    except Exception:
        pass
    path = p.get("path")
    if not path:
        ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        path = os.path.join(os.path.expanduser("~"), "Desktop", "webharness_shot_%s.png" % ts)
    path = resolve_path(path)
    mon = str(p.get("monitor", "all"))
    img = ImageGrab.grab(all_screens=(mon == "all"))
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    img.save(path)
    return "截图已保存: %s（%dx%d）" % (path, img.size[0], img.size[1])


def tool_open_app(p):
    target = str(p.get("target", "")).strip()
    if not target:
        raise ValueError("target 不能为空（程序名、文件路径或 URL 均可）")
    for pat in DANGEROUS_PATTERNS:
        if re.search(pat, target, re.IGNORECASE):
            raise PermissionError("目标命中安全黑名单: %s" % target[:100])
    os.startfile(target)  # Windows：按系统关联打开程序/文件/网址
    return "已打开: %s" % target


def _win_user32():
    import ctypes
    from ctypes import wintypes
    u32 = ctypes.windll.user32
    k32 = ctypes.windll.kernel32
    u32.OpenClipboard.argtypes = [wintypes.HWND]
    u32.OpenClipboard.restype = wintypes.BOOL
    u32.GetClipboardData.argtypes = [wintypes.UINT]
    u32.GetClipboardData.restype = wintypes.HANDLE
    u32.SetClipboardData.argtypes = [wintypes.UINT, wintypes.HANDLE]
    u32.SetClipboardData.restype = wintypes.HANDLE
    k32.GlobalAlloc.argtypes = [wintypes.UINT, ctypes.c_size_t]
    k32.GlobalAlloc.restype = wintypes.HGLOBAL
    k32.GlobalLock.argtypes = [wintypes.HGLOBAL]
    k32.GlobalLock.restype = wintypes.LPVOID
    k32.GlobalUnlock.argtypes = [wintypes.HGLOBAL]
    k32.GlobalSize.argtypes = [wintypes.HGLOBAL]
    return u32, k32

CF_UNICODETEXT = 13
GMEM_MOVEABLE = 0x0002
GMEM_ZEROINIT = 0x0040


def _clipboard_read():
    import ctypes
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
    import ctypes
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
        ctypes.memmove(p, data, len(data))
        k32.GlobalUnlock(h)
        if not u32.SetClipboardData(CF_UNICODETEXT, h):
            raise RuntimeError("SetClipboardData 失败")
    finally:
        u32.CloseClipboard()


def tool_clipboard_read(p):
    text = _clipboard_read()
    head = "[剪贴板文本 %d 字符]\n" % len(text)
    return head + (truncate(text) if text else "(剪贴板为空或非文本)")


def tool_clipboard_write(p):
    text = str(p.get("text", ""))
    if len(text.encode("utf-8")) > MAX_WRITE_BYTES:
        raise ValueError("内容超过 %d 字节上限" % MAX_WRITE_BYTES)
    _clipboard_write(text)
    return "已写入剪贴板（%d 字符）" % len(text)


def _enum_visible_windows():
    import ctypes
    from ctypes import wintypes
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


def tool_view_image(p):
    """读取图片并 base64 返回，扩展端会将其作为附件上传到对话，AI 即可“看到”图片。"""
    import base64
    path = resolve_path(p.get("path"))
    if not os.path.isfile(path):
        raise FileNotFoundError("文件不存在: %s" % path)
    ext = os.path.splitext(path)[1].lower()
    mime = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
            ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp"}.get(ext)
    if not mime:
        raise ValueError("不支持的图片格式 %s（支持 png/jpg/gif/webp/bmp）" % ext)
    size = os.path.getsize(path)
    if size > 8 * 1024 * 1024:
        raise ValueError("图片 %.1f MB 超过 8MB 上限" % (size / 1048576))
    with open(path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("ascii")
    return json.dumps({
        "__image__": True, "mime": mime,
        "name": os.path.basename(path), "size": size, "data": b64,
    })


def tool_list_windows(p):
    titles = _enum_visible_windows()
    return "可见窗口 %d 个：\n%s" % (len(titles), "\n".join("- " + t for t in titles))


def tool_activate_window(p):
    import ctypes
    from ctypes import wintypes
    kw = str(p.get("title_keyword", "")).strip()
    if not kw:
        raise ValueError("title_keyword 不能为空")
    kw_lower = kw.lower()
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
        raise LookupError("未找到标题含 %r 的可见窗口（可用 list_windows 查看）" % kw)
    hwnd, title = found[0]
    user32.ShowWindow(hwnd, 9)  # SW_RESTORE
    user32.keybd_event(0x12, 0, 0, 0)  # Alt 解除前台锁
    user32.keybd_event(0x12, 0, 2, 0)
    user32.SetForegroundWindow(hwnd)
    return "已激活窗口: %s" % title


# ---------------- 鼠标/键盘控制（ctypes 直调 user32，须设 argtypes 防 64 位截断） ----------------
import ctypes
from ctypes import wintypes

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


def tool_mouse_move(p):
    x = int(p.get("x", -1))
    y = int(p.get("y", -1))
    if x < 0 or y < 0:
        raise ValueError("x/y 必须是非负整数（物理像素坐标，可用截图查看）")
    _ensure_dpi_aware()
    user32 = ctypes.windll.user32
    user32.SetCursorPos.argtypes = [ctypes.c_int, ctypes.c_int]
    user32.SetCursorPos.restype = wintypes.BOOL
    if not user32.SetCursorPos(x, y):
        raise OSError("SetCursorPos(%d,%d) 失败" % (x, y))
    return "光标已移动到 (%d, %d)" % (x, y)


_MOUSE_BUTTONS = {
    "left": (0x0002, 0x0004),    # MOUSEEVENTF_LEFTDOWN / LEFTUP
    "right": (0x0008, 0x0010),   # MOUSEEVENTF_RIGHTDOWN / RIGHTUP
    "middle": (0x0020, 0x0040),  # MOUSEEVENTF_MIDDLEDOWN / MIDDLUP
}


def tool_mouse_click(p):
    button = str(p.get("button", "left")).lower()
    if button not in _MOUSE_BUTTONS:
        raise ValueError("button 必须是 left/right/middle 之一")
    x, y = p.get("x"), p.get("y")
    if x is not None and y is not None:
        tool_mouse_move({"x": x, "y": y})  # 先移动到指定位置再点
    _ensure_dpi_aware()
    down, up = _MOUSE_BUTTONS[button]
    double = bool(p.get("double", False))
    user32 = ctypes.windll.user32
    user32.mouse_event.argtypes = [wintypes.DWORD] * 4 + [ctypes.c_void_p]
    user32.mouse_event.restype = None
    # 双击必须内部连发：两次独立工具调用之间的网络延迟会超过系统双击阈值（500ms）
    clicks = 2 if double else 1
    for i in range(clicks):
        user32.mouse_event(down, 0, 0, 0, None)
        time.sleep(0.04)
        user32.mouse_event(up, 0, 0, 0, None)
        if i == 0:
            time.sleep(0.06)
    if x is not None and y is not None:
        return "已在 (%s, %s) %s击%s键" % (x, y, "双" if double else "单", button)
    return "已%s击%s键（当前位置）" % ("双" if double else "点", button)


_KEY_VK = {
    "enter": 0x0D, "esc": 0x1B, "tab": 0x09, "space": 0x20,
    "backspace": 0x08, "delete": 0x2E, "insert": 0x2D,
    "up": 0x26, "down": 0x28, "left": 0x25, "right": 0x27,
    "home": 0x24, "end": 0x23, "pageup": 0x21, "pagedown": 0x22,
    "ctrl": 0x11, "alt": 0x12, "shift": 0x10,
    "f1": 0x70, "f2": 0x71, "f3": 0x72, "f4": 0x73, "f5": 0x74,
    "f6": 0x75, "f7": 0x76, "f8": 0x77, "f9": 0x78, "f10": 0x79,
    "f11": 0x7A, "f12": 0x7B,
}


def tool_key_press(p):
    """按键或组合键，如 {"keys":"ctrl+v"}、{"keys":"enter"}、{"keys":"alt+tab"}。
    输入长文本请用 clipboard_write + key_press ctrl+v。"""
    keys = str(p.get("keys", "")).strip().lower()
    if not keys:
        raise ValueError("keys 不能为空，如 \"enter\"、\"ctrl+v\"、\"alt+tab\"")
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
    for vk in vks:  # 按下（顺序）
        user32.keybd_event(vk, 0, 0, None)
        time.sleep(0.03)
    for vk in reversed(vks):  # 抬起（逆序）
        user32.keybd_event(vk, 0, 2, None)
        time.sleep(0.03)
    return "已按键: " + keys


TOOLS = {
    "run_command": tool_run_command,
    "read_file": tool_read_file,
    "write_file": tool_write_file,
    "append_file": tool_append_file,
    "list_dir": tool_list_dir,
    "screenshot": tool_screenshot,
    "open_app": tool_open_app,
    "clipboard_read": tool_clipboard_read,
    "clipboard_write": tool_clipboard_write,
    "list_windows": tool_list_windows,
    "activate_window": tool_activate_window,
    "view_image": tool_view_image,
    "mouse_move": tool_mouse_move,
    "mouse_click": tool_mouse_click,
    "key_press": tool_key_press,
}


def execute_call(call):
    """执行单个工具调用，返回 {ok, result|error}。永不抛异常。"""
    if not isinstance(call, dict):
        return {"ok": False, "error": "调用格式错误: %r" % (call,)}
    tool = call.get("tool")
    params = call.get("params") or {}
    if not isinstance(params, dict):
        return {"ok": False, "error": "params 必须是对象"}
    if tool not in TOOLS:
        return {
            "ok": False,
            "error": "未知工具 %r。可用工具: %s" % (tool, ", ".join(TOOLS)),
        }
    try:
        result = TOOLS[tool](params)
        return {"ok": True, "result": result}
    except Exception as e:
        return {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}


# ---------------- HTTP ----------------

class Handler(BaseHTTPRequestHandler):
    server_version = "WebHarness/0.1"

    def log_message(self, fmt, *args):  # 覆盖默认杂乱日志
        pass

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        try:
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass  # 客户端（扩展 fetch 超时等）已断开，忽略写失败

    def do_GET(self):
        if self.path == "/health":
            self._json(200, {"ok": True, "service": "webharness", "tools": sorted(TOOLS)})
        else:
            self._json(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        if self.path != "/execute":
            self._json(404, {"ok": False, "error": "not found"})
            return
        try:
            n = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception as e:
            self._json(400, {"ok": False, "error": "请求体解析失败: %s" % e})
            return
        calls = body.get("calls")
        if not calls and body.get("tool"):
            calls = [body]  # 兼容单个调用
        if not isinstance(calls, list) or not calls:
            self._json(400, {"ok": False, "error": "缺少 calls 数组"})
            return
        if len(calls) > MAX_CALLS_PER_REQ:
            self._json(400, {"ok": False, "error": "单次最多 %d 个调用" % MAX_CALLS_PER_REQ})
            return
        results = []
        for c in calls:
            r = execute_call(c)
            results.append(r)
            tool = (c or {}).get("tool", "?")
            preview = (r.get("result") or r.get("error") or "")[:60].replace("\n", " ")
            print("[%s] %-14s %s | %s" % (now(), tool, "OK " if r["ok"] else "ERR", preview))
        self._json(200, {"ok": all(r["ok"] for r in results), "results": results})


def _configure_stdout():
    """按控制台实际代码页适配输出编码（GBK 控制台也能正常显示中文）。"""
    try:
        import ctypes
        cp = ctypes.windll.kernel32.GetConsoleOutputCP()
        enc = {936: "gbk", 950: "big5", 932: "cp932"}.get(cp, "utf-8")
    except Exception:
        enc = "utf-8"
    try:
        sys.stdout.reconfigure(encoding=enc, errors="replace")
        sys.stderr.reconfigure(encoding=enc, errors="replace")
    except Exception:
        pass


def main():
    _configure_stdout()
    print("=" * 56)
    print(" WebHarness 本地执行服务  v0.1")
    print(" 地址: http://%s:%d" % (HOST, PORT))
    print(" 工具: %s" % ", ".join(TOOLS))
    print(" 安全: 仅本机可访问 | 高危命令黑名单已启用")
    print(" 关闭: 直接关本窗口 或 Ctrl+C")
    print("=" * 56)
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n[%s] 服务已停止" % now())


if __name__ == "__main__":
    main()
