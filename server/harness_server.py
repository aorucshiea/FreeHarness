# -*- coding: utf-8 -*-
"""
FreeHarness 本地执行服务（跨平台：Windows / macOS / Linux）
监听 127.0.0.1:8765，接收浏览器扩展转发来的 AI 工具调用并在本机执行。
零第三方依赖，仅 Python 标准库（Python 3.8+）；截图建议安装 Pillow（也可用系统截图命令）。

安全设计：
  - 仅监听 127.0.0.1，不对外网开放
  - 响应不带 CORS 头 + 强制 Content-Type: application/json：
    浏览器"简单请求"（text/plain 等，不触发预检）会被 403 拒绝，
    堵住恶意网页绕过 CORS 直达本地服务的通道
  - 高危命令黑名单（format / diskpart / 整盘删除等）
  - 命令超时上限、输出大小截断

平台相关实现见 platforms/：win32_backend.py / darwin_backend.py / linux_backend.py
"""
import datetime
import json
import os
import re
import sys
import tempfile
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from platforms import get_backend, platform_name
from platforms.base import decode_bytes

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


LOG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "harness_server.log")


def log_line(msg):
    """控制台 + 日志文件双写（文件超过 2MB 自动保留最近 2000 行）。"""
    line = "[%s] %s" % (now(), msg)
    try:
        print(line)
    except Exception:
        pass
    try:
        if os.path.exists(LOG_FILE) and os.path.getsize(LOG_FILE) > 2_000_000:
            with open(LOG_FILE, "r", encoding="utf-8", errors="replace") as f:
                tail = f.readlines()[-2000:]
            with open(LOG_FILE, "w", encoding="utf-8") as f:
                f.writelines(tail)
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


def _cleanup_old_shots(folder, keep=20):
    """截图目录只保留最近 keep 张，防无限堆积。"""
    try:
        import glob
        files = sorted(glob.glob(os.path.join(folder, "shot_*.png")),
                       key=os.path.getmtime, reverse=True)
        for f in files[keep:]:
            try:
                os.remove(f)
            except OSError:
                pass
    except Exception:
        pass


def truncate(s, n=MAX_OUTPUT_CHARS):
    if len(s) <= n:
        return s
    return s[:n] + "\n...[已截断, 原文共 %d 字符]" % len(s)


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


# ---------------- 工具实现（平台无关部分） ----------------

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
    out = get_backend().run_command(cmd, cwd, timeout)
    return truncate(out)


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


# ---------------- 工具实现（平台相关，委托 backend） ----------------

def tool_screenshot(p):
    path = p.get("path")
    if not path:
        ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        # 默认存临时目录而非桌面：截图是高频操作，堆桌面很快就乱
        path = os.path.join(tempfile.gettempdir(), "webharness", "shot_%s.png" % ts)
        _cleanup_old_shots(os.path.dirname(path))
    path = resolve_path(path)
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    mon = str(p.get("monitor", "all"))
    return get_backend().screenshot(path, mon)


def tool_open_app(p):
    target = str(p.get("target", "")).strip()
    if not target:
        raise ValueError("target 不能为空（程序名、文件路径或 URL 均可）")
    for pat in DANGEROUS_PATTERNS:
        if re.search(pat, target, re.IGNORECASE):
            raise PermissionError("目标命中安全黑名单: %s" % target[:100])
    get_backend().open_target(target)
    return "已打开: %s" % target


def tool_clipboard_read(p):
    text = get_backend().clipboard_read()
    head = "[剪贴板文本 %d 字符]\n" % len(text)
    return head + (truncate(text) if text else "(剪贴板为空或非文本)")


def tool_clipboard_write(p):
    text = str(p.get("text", ""))
    if len(text.encode("utf-8")) > MAX_WRITE_BYTES:
        raise ValueError("内容超过 %d 字节上限" % MAX_WRITE_BYTES)
    get_backend().clipboard_write(text)
    return "已写入剪贴板（%d 字符）" % len(text)


def tool_list_windows(p):
    titles = get_backend().list_windows()
    return "可见窗口 %d 个：\n%s" % (len(titles), "\n".join("- " + t for t in titles))


def tool_activate_window(p):
    kw = str(p.get("title_keyword", "")).strip()
    if not kw:
        raise ValueError("title_keyword 不能为空")
    title = get_backend().activate_window(kw)
    return "已激活窗口: %s" % title


def tool_mouse_move(p):
    x = int(p.get("x", -1))
    y = int(p.get("y", -1))
    if x < 0 or y < 0:
        raise ValueError("x/y 必须是非负整数（物理像素坐标，可用截图查看）")
    return get_backend().mouse_move(x, y)


def tool_mouse_click(p):
    button = str(p.get("button", "left")).lower()
    if button not in ("left", "right", "middle"):
        raise ValueError("button 必须是 left/right/middle 之一")
    x, y = p.get("x"), p.get("y")
    double = bool(p.get("double", False))
    kind = get_backend().mouse_click(x, y, button, double)
    if x is not None and y is not None:
        return "已在 (%s, %s) %s击%s键" % (x, y, kind, button)
    return "已%s击%s键（当前位置）" % (kind, button)


def tool_mouse_scroll(p):
    x, y = p.get("x"), p.get("y")
    try:
        amount = int(p.get("amount", 3))
    except (TypeError, ValueError):
        amount = 3
    amount = max(-50, min(50, amount))
    if amount == 0:
        return "滚动量为 0，未执行"
    get_backend().mouse_scroll(x, y, amount)
    return "已滚动 %d 格（%s%s）" % (
        abs(amount), "向下" if amount > 0 else "向上",
        ("，位置 (%s,%s)" % (x, y)) if x is not None else "",
    )


def tool_mouse_drag(p):
    try:
        fx, fy = int(p.get("from_x")), int(p.get("from_y"))
        tx, ty = int(p.get("to_x")), int(p.get("to_y"))
    except (TypeError, ValueError):
        raise ValueError("需要 from_x/from_y/to_x/to_y 四个整数坐标")
    if min(fx, fy, tx, ty) < 0:
        raise ValueError("坐标必须是非负整数（物理像素）")
    get_backend().mouse_drag(fx, fy, tx, ty)
    return "已从 (%d,%d) 拖拽到 (%d,%d)" % (fx, fy, tx, ty)


def tool_key_press(p):
    """按键或组合键，如 {"keys":"ctrl+v"}、{"keys":"enter"}、{"keys":"alt+tab"}。
    输入长文本请用 type_text 或 clipboard_write + 粘贴键。"""
    keys = str(p.get("keys", "")).strip()
    if not keys:
        raise ValueError("keys 不能为空，如 \"enter\"、\"ctrl+v\"、\"alt+tab\"")
    get_backend().key_press(keys)
    return "已按键: " + keys


def tool_type_text(p):
    """向当前焦点处输入任意文字（含中文）。内部经剪贴板粘贴，剪贴板内容会被替换。"""
    text = str(p.get("text", ""))
    if not text:
        raise ValueError("text 不能为空")
    if len(text) > 20000:
        raise ValueError("单次最多 20000 字符（可分段发送）")
    get_backend().type_text(text)
    return "已输入 %d 字符（经剪贴板粘贴；剪贴板内容已被替换为该文本）" % len(text)


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
    "mouse_scroll": tool_mouse_scroll,
    "mouse_drag": tool_mouse_drag,
    "key_press": tool_key_press,
    "type_text": tool_type_text,
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
    server_version = "FreeHarness/0.9.2"

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
            self._json(200, {
                "ok": True, "service": "webharness",
                "platform": platform_name(),
                "tools": sorted(TOOLS),
            })
        else:
            self._json(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        if self.path != "/execute":
            self._json(404, {"ok": False, "error": "not found"})
            return
        # 安全：强制 application/json。
        # 浏览器"简单请求"（text/plain 等）不触发 CORS 预检、可直达本服务，恶意网页
        # 正是借它绕过"无 CORS 头"的防护；而 Content-Type 为 application/json 会触发
        # 预检（本服务不回 CORS 头 → 预检失败），扩展的 fetch 不受此限。
        ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if ctype != "application/json":
            self._json(403, {"ok": False, "error": "Content-Type 必须为 application/json"})
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
            log_line("%-14s %s | %s" % (tool, "OK " if r["ok"] else "ERR", preview))
        self._json(200, {"ok": all(r["ok"] for r in results), "results": results})


def _configure_stdout():
    """统一控制台编码为 UTF-8。

    Windows 下控制台代码页（936/437/65001）与 Python 输出编码不一致时中文必乱码。
    做法：先把控制台切到 65001（Windows 10+ 支持），输出也用 utf-8，两侧一致；
    切换失败时退回按实际代码页映射（GBK 控制台就用 gbk 输出）。
    """
    enc = "utf-8"
    try:
        import ctypes
        k = ctypes.windll.kernel32
        k.SetConsoleOutputCP(65001)
        k.SetConsoleCP(65001)
    except Exception:
        try:
            import ctypes
            cp = ctypes.windll.kernel32.GetConsoleOutputCP()
            enc = {936: "gbk", 950: "big5", 932: "cp932"}.get(cp, "utf-8")
        except Exception:
            enc = "utf-8"
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding=enc, errors="replace")
        except Exception:
            pass


def main():
    _configure_stdout()
    tools = sorted(TOOLS)
    print("=" * 62)
    print(" FreeHarness 本地执行服务  v0.9.2  (%s)" % platform_name())
    print(" 地址: http://%s:%d" % (HOST, PORT))
    print(" 工具: %d 个" % len(tools))
    for i in range(0, len(tools), 4):  # 每行 4 个，避免一行太长折行
        print("   " + "  ".join("%-15s" % t for t in tools[i:i + 4]).rstrip())
    print(" 安全: 仅本机可访问 | 高危命令黑名单已启用")
    print(" 关闭: 直接关本窗口 或 Ctrl+C")
    print("=" * 62)
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n[%s] 服务已停止" % now())


if __name__ == "__main__":
    main()
