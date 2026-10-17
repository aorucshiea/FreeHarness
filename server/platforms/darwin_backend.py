# -*- coding: utf-8 -*-
"""macOS 后端。

命令/文件类零依赖；GUI 类全部走系统自带工具：
  - 剪贴板：pbcopy / pbpaste
  - 截图：screencapture
  - 打开程序/网址：open
  - 窗口/键盘：osascript（System Events，需在 系统设置→隐私与安全性→辅助功能 里授权终端/Python）
  - 鼠标：osascript -l JavaScript + CoreGraphics ObjC 桥（同为系统自带）

注意：GUI 控制未在本机实测（开发环境为 Windows），如遇问题请附报错反馈。
"""

import os
import signal
import subprocess
import tempfile
import time

from .base import BackendBase, decode_bytes

# 通用键名 -> (类型, 值)
#   ("code", n)  → key code n
#   ("char", c)  → keystroke "c"
_SPECIAL_KEYS = {
    "enter": 36, "esc": 53, "escape": 53, "tab": 48, "space": 49,
    "backspace": 51, "delete": 117, "insert": 114,
    "left": 123, "right": 124, "down": 125, "up": 126,
    "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97,
    "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
}

_MOD_MAP = {"ctrl": "control down", "alt": "option down", "shift": "shift down",
            "win": "command down", "cmd": "command down", "meta": "command down"}

_ACCESS_HINT = ("（macOS 需要在 系统设置→隐私与安全性→辅助功能 中授权终端/Python 控制电脑；"
                "首次运行 osascript 也会弹窗询问）")


def _osascript(script, timeout=20):
    p = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=timeout)
    if p.returncode != 0:
        raise RuntimeError("osascript 失败: %s %s" % ((p.stderr or "").strip()[:300], _ACCESS_HINT))
    return p.stdout


def _jxa(script, timeout=20):
    p = subprocess.run(["osascript", "-l", "JavaScript", "-e", script],
                       capture_output=True, text=True, timeout=timeout)
    if p.returncode != 0:
        raise RuntimeError("osascript(JXA) 失败: %s %s" % ((p.stderr or "").strip()[:300], _ACCESS_HINT))
    return p.stdout


def _esc_applescript(s):
    return str(s).replace("\\", "\\\\").replace('"', '\\"')


class DarwinBackend(BackendBase):
    name = "macos"

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
        subprocess.Popen(["open", target], start_new_session=True,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return "已打开"

    # ---- 剪贴板 ----
    def clipboard_read(self):
        p = subprocess.run(["pbpaste"], capture_output=True, text=True, timeout=10)
        if p.returncode != 0:
            raise RuntimeError("pbpaste 失败: %s" % (p.stderr or "").strip()[:200])
        return p.stdout

    def clipboard_write(self, text):
        p = subprocess.run(["pbcopy"], input=text, text=True, timeout=10)
        if p.returncode != 0:
            raise RuntimeError("pbcopy 失败: %s" % (p.stderr or "").strip()[:200])

    # ---- 截图 ----
    def screenshot(self, path, monitor):
        args = ["screencapture", "-x"]
        if str(monitor).isdigit():
            args += ["-D", str(monitor)]  # 指定显示器（1 起）
        args.append(path)
        p = subprocess.run(args, capture_output=True, text=True, timeout=60)
        if p.returncode != 0:
            raise RuntimeError("screencapture 失败: %s %s" % ((p.stderr or "").strip()[:300], _ACCESS_HINT))
        return "截图已保存: %s" % path

    # ---- 窗口 ----
    def list_windows(self):
        script = (
            'tell application "System Events"\n'
            '  set out to ""\n'
            '  repeat with p in (every process whose visible is true)\n'
            '    try\n'
            '      set out to out & (name of p) & linefeed\n'
            '    end try\n'
            '  end repeat\n'
            '  return out\n'
            'end tell'
        )
        out = _osascript(script)
        return [t.strip() for t in out.splitlines() if t.strip()]

    def activate_window(self, keyword):
        kw = _esc_applescript(keyword)
        script = (
            'tell application "System Events"\n'
            '  set hits to (every process whose visible is true and name contains "%s")\n'
            '  if (count of hits) is 0 then error "no such window"\n'
            '  set frontmost of (item 1 of hits) to true\n'
            '  return name of (item 1 of hits)\n'
            'end tell' % kw
        )
        try:
            return _osascript(script).strip()
        except RuntimeError as e:
            if "no such window" in str(e):
                raise LookupError("未找到名称含 %r 的可见应用/窗口（可用 list_windows 查看）" % keyword)
            raise

    # ---- 鼠标（CoreGraphics 事件，经 JXA ObjC 桥） ----
    def _cg(self, body, timeout=20):
        script = "ObjC.import('CoreGraphics');\nObjC.import('Foundation');\n" + \
                 "function pt(x,y){return $.CGPointMake(x,y);}\n" + \
                 "function post(ev){$.CGEventPost($.kCGHIDEventTap, ev);}\n" + body
        return _jxa(script, timeout=timeout)

    def mouse_move(self, x, y):
        self._cg("post($.CGEventCreateMouseEvent($(), $.kCGEventMouseMoved, pt(%d,%d), $.kCGMouseButtonLeft));" % (x, y))
        return "光标已移动到 (%d, %d)" % (x, y)

    def mouse_click(self, x, y, button, double):
        if x is None or y is None:
            # 当前位置点击：取当前鼠标位置
            pos = self._cg(
                "var e = $.CGEventCreate($());\n"
                "var loc = $.CGEventGetLocation(e);\n"
                "loc.x + ',' + loc.y;"
            ).strip()
            try:
                x, y = [int(float(v)) for v in pos.split(",")]
            except Exception:
                raise ValueError("无法获取当前光标位置，请显式传 x/y")
        kind = {"left": "Left", "right": "Right", "middle": "Left"}[button]
        down = "$.kCGEvent%sMouseDown" % kind
        up = "$.kCGEvent%sMouseUp" % kind
        clicks = 2 if double else 1
        for i in range(clicks):
            self._cg("post($.CGEventCreateMouseEvent($(), %s, pt(%d,%d), $.kCGMouseButtonLeft));" % (down, x, y))
            time.sleep(0.03)
            self._cg("post($.CGEventCreateMouseEvent($(), %s, pt(%d,%d), $.kCGMouseButtonLeft));" % (up, x, y))
            if i == 0:
                time.sleep(0.06)
        return "双" if double else "单"

    def mouse_scroll(self, x, y, amount):
        if x is not None and y is not None:
            self.mouse_move(x, y)
        self._cg("post($.CGEventCreateScrollWheelEvent($(), $.kCGScrollEventUnitLine, 1, %d));" % amount)

    def mouse_drag(self, fx, fy, tx, ty):
        body = (
            "post($.CGEventCreateMouseEvent($(), $.kCGEventLeftMouseDown, pt(%d,%d), $.kCGMouseButtonLeft));\n"
            "for (var i=1;i<=12;i++){\n"
            "  $.NSThread.sleepForTimeInterval(0.02);\n"
            "  post($.CGEventCreateMouseEvent($(), $.kCGEventLeftMouseDragged, pt(%d+(%d-%d)*i/12, %d+(%d-%d)*i/12), $.kCGMouseButtonLeft));\n"
            "}\n"
            "$.NSThread.sleepForTimeInterval(0.1);\n"
            "post($.CGEventCreateMouseEvent($(), $.kCGEventLeftMouseUp, pt(%d,%d), $.kCGMouseButtonLeft));"
            % (fx, fy, fx, tx, fx, fy, ty, fy, tx, ty)
        )
        self._cg(body, timeout=30)

    # ---- 键盘（System Events） ----
    def key_press(self, keys):
        parts = [k.strip().lower() for k in keys.split("+") if k.strip()]
        mods = []
        main = None
        for k in parts:
            if k in _MOD_MAP:
                mods.append(_MOD_MAP[k])
            else:
                main = k
        if not main:
            raise ValueError("按键组合里缺少主键（如 ctrl+v 的 v）")
        using = (" using {%s}" % ", ".join(mods)) if mods else ""
        if main in _SPECIAL_KEYS:
            script = 'tell application "System Events" to key code %d%s' % (_SPECIAL_KEYS[main], using)
        elif len(main) == 1:
            script = 'tell application "System Events" to keystroke "%s"%s' % (_esc_applescript(main), using)
        else:
            raise ValueError("未知按键 %r" % main)
        _osascript(script)

    def type_text(self, text):
        self.clipboard_write(text)
        time.sleep(0.1)
        self.key_press("cmd+v")
