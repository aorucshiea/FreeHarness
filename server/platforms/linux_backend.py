# -*- coding: utf-8 -*-
"""Linux 后端。

命令/文件类零依赖；GUI 类依赖系统工具（缺失时给出明确的安装命令）：
  - 鼠标/键盘/窗口：xdotool（Wayland 受限，建议 X11）
  - 剪贴板：wl-clipboard（Wayland）或 xclip / xsel
  - 截图：grim（Wayland）或 ImageMagick(import) / scrot
  - 打开程序/网址：xdg-open
"""

import os
import shutil
import signal
import subprocess
import tempfile
import time

from .base import BackendBase, decode_bytes

# 通用键名 -> xdotool 键名
_KEYMAP = {
    "enter": "Return", "esc": "Escape", "tab": "Tab", "space": "space",
    "backspace": "BackSpace", "delete": "Delete", "insert": "Insert",
    "up": "Up", "down": "Down", "left": "Left", "right": "Right",
    "home": "Home", "end": "End", "pageup": "Prior", "pagedown": "Next",
    "ctrl": "ctrl", "alt": "alt", "shift": "shift", "win": "super",
}


def _which(*names):
    for n in names:
        p = shutil.which(n)
        if p:
            return p
    return None


def _need(names, hint):
    p = _which(*names)
    if not p:
        raise RuntimeError("缺少系统命令 %s，请先安装：%s" % ("/".join(names), hint))
    return p


def _run(args, timeout=20, stdin_text=None):
    p = subprocess.run(args, capture_output=True, text=True, timeout=timeout,
                       input=stdin_text)
    if p.returncode != 0:
        raise RuntimeError("%s 执行失败: %s" % (args[0], (p.stderr or p.stdout or "").strip()[:300]))
    return p.stdout


class LinuxBackend(BackendBase):
    name = "linux"

    # ---- 命令 ----
    def run_command(self, cmd, cwd, timeout):
        out_f = tempfile.TemporaryFile()
        err_f = tempfile.TemporaryFile()
        proc = None
        timed_out = False
        try:
            proc = subprocess.Popen(cmd, shell=True, stdout=out_f, stderr=err_f,
                                    cwd=cwd, start_new_session=True)
            try:
                proc.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                timed_out = True
                try:
                    os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
                except Exception:
                    try:
                        proc.kill()
                    except Exception:
                        pass
                try:
                    proc.wait(timeout=5)
                except Exception:
                    pass
            out_f.seek(0)
            err_f.seek(0)
            out = decode_bytes(out_f.read())
            err = decode_bytes(err_f.read())
        finally:
            out_f.close()
            err_f.close()
        parts = []
        if out:
            parts.append(out.rstrip())
        if err:
            parts.append("[stderr]\n" + err.rstrip())
        if not parts:
            parts.append("(无输出)")
        if timed_out:
            parts.append("[已超时终止（%d 秒），输出可能不完整]" % timeout)
        rc = proc.returncode if proc and proc.returncode is not None else -1
        parts.append("[exit code: %d]" % rc)
        return "\n".join(parts)

    def open_target(self, target):
        xdg = _need(["xdg-open"], "sudo apt install xdg-utils")
        subprocess.Popen([xdg, target], start_new_session=True,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return "已打开"

    # ---- 剪贴板 ----
    def clipboard_read(self):
        if _which("wl-paste"):
            return _run(["wl-paste", "--no-newline"], timeout=10)
        if _which("xclip"):
            return _run(["xclip", "-selection", "clipboard", "-o"], timeout=10)
        if _which("xsel"):
            return _run(["xsel", "-ob"], timeout=10)
        raise RuntimeError("缺少剪贴板工具，请安装：sudo apt install wl-clipboard（Wayland）或 xclip（X11）")

    def clipboard_write(self, text):
        if _which("wl-copy"):
            _run(["wl-copy"], stdin_text=text)
            return
        if _which("xclip"):
            _run(["xclip", "-selection", "clipboard", "-i"], stdin_text=text)
            return
        if _which("xsel"):
            _run(["xsel", "-ib"], stdin_text=text)
            return
        raise RuntimeError("缺少剪贴板工具，请安装：sudo apt install wl-clipboard 或 xclip")

    # ---- 截图 ----
    def screenshot(self, path, monitor):
        if _which("grim"):
            _run(["grim", path], timeout=30)
            return "截图已保存: %s" % path
        if _which("import"):
            _run(["import", "-window", "root", path], timeout=30)
            return "截图已保存: %s" % path
        if _which("scrot"):
            _run(["scrot", "-o", path], timeout=30)
            return "截图已保存: %s" % path
        raise RuntimeError("缺少截图工具，请安装：sudo apt install imagemagick（X11）或 grim（Wayland）")

    # ---- 窗口 ----
    def list_windows(self):
        if _which("xdotool"):
            out = _run(["xdotool", "search", "--onlyvisible", "--name", "", "getwindowname", "%@"], timeout=15)
            titles = [t for t in out.splitlines() if t.strip()]
            return titles
        if _which("wmctrl"):
            out = _run(["wmctrl", "-l"], timeout=15)
            titles = []
            for line in out.splitlines():
                parts = line.split(None, 3)
                if len(parts) == 4 and parts[3].strip():
                    titles.append(parts[3].strip())
            return titles
        raise RuntimeError("缺少窗口工具，请安装：sudo apt install xdotool")

    def activate_window(self, keyword):
        if _which("xdotool"):
            ids = _run(["xdotool", "search", "--onlyvisible", "--name", keyword], timeout=15).split()
            if not ids:
                raise LookupError("未找到标题含 %r 的可见窗口（可用 list_windows 查看）" % keyword)
            _run(["xdotool", "windowactivate", "--sync", ids[0]], timeout=15)
            title = _run(["xdotool", "getwindowname", ids[0]], timeout=10).strip()
            return title
        if _which("wmctrl"):
            _run(["wmctrl", "-a", keyword], timeout=15)
            return keyword
        raise RuntimeError("缺少窗口工具，请安装：sudo apt install xdotool")

    # ---- 鼠标 ----
    def mouse_move(self, x, y):
        xdo = _need(["xdotool"], "sudo apt install xdotool")
        _run([xdo, "mousemove", str(x), str(y)], timeout=10)

    def mouse_click(self, x, y, button, double):
        xdo = _need(["xdotool"], "sudo apt install xdotool")
        btn = {"left": "1", "middle": "2", "right": "3"}[button]
        args = [xdo]
        if x is not None and y is not None:
            args += ["mousemove", str(x), str(y)]
        args += ["click", "--repeat", "2" if double else "1", btn]
        _run(args, timeout=15)
        return "双" if double else "单"

    def mouse_scroll(self, x, y, amount):
        xdo = _need(["xdotool"], "sudo apt install xdotool")
        args = [xdo]
        if x is not None and y is not None:
            args += ["mousemove", str(x), str(y)]
        # X11 滚轮：4=上滚 5=下滚
        btn = "5" if amount > 0 else "4"
        args += ["click", "--repeat", str(abs(amount)), btn]
        _run(args, timeout=15)

    def mouse_drag(self, fx, fy, tx, ty):
        xdo = _need(["xdotool"], "sudo apt install xdotool")
        _run([xdo, "mousemove", str(fx), str(fy)], timeout=10)
        time.sleep(0.15)
        _run([xdo, "mousedown", "1"], timeout=10)
        time.sleep(0.1)
        steps = 12
        for i in range(1, steps + 1):
            _run([xdo, "mousemove", str(fx + (tx - fx) * i // steps), str(fy + (ty - fy) * i // steps)], timeout=10)
            time.sleep(0.02)
        time.sleep(0.1)
        _run([xdo, "mouseup", "1"], timeout=10)

    # ---- 键盘 ----
    def key_press(self, keys):
        xdo = _need(["xdotool"], "sudo apt install xdotool")
        parts = [k.strip().lower() for k in keys.split("+") if k.strip()]
        mapped = []
        for k in parts:
            if k in _KEYMAP:
                mapped.append(_KEYMAP[k])
            elif len(k) == 1 or (k.startswith("f") and k[1:].isdigit()):
                mapped.append(k.upper() if k.startswith("f") and k[1:].isdigit() else k)
            else:
                raise ValueError("未知按键 %r" % k)
        _run([xdo, "key", "--clearmodifiers", "+".join(mapped)], timeout=15)

    def type_text(self, text):
        # 优先 xdotool type（ASCII 准确）；中文等输入用剪贴板粘贴兜底
        if _which("xdotool"):
            try:
                p = subprocess.run(["xdotool", "type", "--clearmodifiers", "--delay", "15", "--", text],
                                   capture_output=True, timeout=60)
                if p.returncode == 0 and not p.stderr.strip():
                    return
            except Exception:
                pass
        self.clipboard_write(text)
        time.sleep(0.1)
        self.key_press("ctrl+v")
