# -*- coding: utf-8 -*-
"""服务端工具函数单元测试：直接调用 execute_call，不依赖 HTTP。"""
import os
import sys
import tempfile
import time
import json

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness_server import execute_call, TOOLS  # noqa: E402

PASS, FAIL = 0, 0


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print("  PASS %s" % name)
    else:
        FAIL += 1
        print("  FAIL %s  %s" % (name, detail))


print("== run_command ==")
r = execute_call({"tool": "run_command", "params": {"command": "echo hello_webharness"}})
check("echo 成功", r["ok"] and "hello_webharness" in r["result"], r)

r = execute_call({"tool": "run_command", "params": {"command": "exit /b 3"}})
check("exit code 透传", r["ok"] and "exit code: 3" in r["result"], r)

r = execute_call({"tool": "run_command", "params": {"command": "format C: /q"}})
check("format 被拦截", not r["ok"] and "黑名单" in r["error"], r)

r = execute_call({"tool": "run_command", "params": {"command": "rd /s /q C:\\"}})
check("rd /s /q 盘根被拦截", not r["ok"], r)

r = execute_call({"tool": "run_command", "params": {"command": "shutdown /s"}})
check("shutdown 被拦截", not r["ok"], r)

r = execute_call({"tool": "run_command", "params": {"command": "ping -n 30 127.0.0.1", "timeout": 2}})
check("超时终止(带部分输出)", r["ok"] and "已超时终止" in r["result"], r)

# GBK 输出解码
r = execute_call({"tool": "run_command", "params": {"command": "echo 中文测试输出"}})
check("中文输出不乱码", r["ok"] and "中文测试输出" in r["result"], r)

print("== 文件工具 ==")
tmp = tempfile.mkdtemp(prefix="wh_test_")
p1 = os.path.join(tmp, "a.txt")

r = execute_call({"tool": "write_file", "params": {"path": p1, "content": "第一行\n"}})
check("write_file", r["ok"], r)

r = execute_call({"tool": "append_file", "params": {"path": p1, "content": "第二行\n"}})
check("append_file", r["ok"], r)

r = execute_call({"tool": "read_file", "params": {"path": p1}})
check("read_file 内容正确", r["ok"] and "第一行" in r["result"] and "第二行" in r["result"], r)

r = execute_call({"tool": "read_file", "params": {"path": os.path.join(tmp, "不存在.txt")}})
check("读不存在文件报错", not r["ok"] and "不存在" in r["error"], r)

# 二进制防护：图片扩展名直接拒绝并引导 view_image
png = os.path.join(tmp, "fake.png")
with open(png, "wb") as f:
    f.write(b"\x89PNG\r\n\x1a\n" + b"\x00" * 100)
r = execute_call({"tool": "read_file", "params": {"path": png}})
check("PNG 被拒绝并提示 view_image", not r["ok"] and "view_image" in r["error"], r)

# 二进制防护：无扩展名但内容含 NUL 也拒绝
raw = os.path.join(tmp, "noext")
with open(raw, "wb") as f:
    f.write(b"MZ\x90\x00\x03\x00\x00\x00" + b"\x00" * 64)
r = execute_call({"tool": "read_file", "params": {"path": raw}})
check("无扩展名二进制被拒", not r["ok"] and "二进制" in r["error"], r)

# 二进制防护：纯控制字符内容也拒绝
ctl = os.path.join(tmp, "ctl.dat")
with open(ctl, "wb") as f:
    f.write(bytes([1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 14, 15] * 100))
r = execute_call({"tool": "read_file", "params": {"path": ctl}})
check("高控制字符占比被拒", not r["ok"] and "二进制" in r["error"], r)

# UTF-16 LE BOM 文本文件不误伤
u16 = os.path.join(tmp, "u16.txt")
with open(u16, "wb") as f:
    f.write("繁體中文測試\n".encode("utf-16"))
r = execute_call({"tool": "read_file", "params": {"path": u16}})
check("UTF-16 BOM 文本可读", r["ok"] and "繁體中文測試" in r["result"], r)

# UTF-8 BOM 文本文件不误伤
u8 = os.path.join(tmp, "u8.txt")
with open(u8, "wb") as f:
    f.write(b"\xef\xbb\xbf" + "带BOM的中文\n".encode("utf-8"))
r = execute_call({"tool": "read_file", "params": {"path": u8}})
check("UTF-8 BOM 文本可读", r["ok"] and "带BOM的中文" in r["result"], r)

# 写入自动创建父目录
p2 = os.path.join(tmp, "sub", "dir", "b.txt")
r = execute_call({"tool": "write_file", "params": {"path": p2, "content": "nested"}})
check("自动建父目录", r["ok"] and os.path.isfile(p2), r)

r = execute_call({"tool": "list_dir", "params": {"path": tmp}})
check("list_dir 列出文件", r["ok"] and "a.txt" in r["result"] and "sub" in r["result"], r)

# 路径展开 ~
r = execute_call({"tool": "list_dir", "params": {"path": "~"}})
check("~ 展开", r["ok"], r)

print("== 协议边界 ==")
r = execute_call({"tool": "unknown_tool", "params": {}})
check("未知工具报错并列出可用", not r["ok"] and "run_command" in r["error"], r)

r = execute_call({"tool": "run_command", "params": {"command": ""}})
check("空命令报错", not r["ok"], r)

r = execute_call(None)
check("非对象调用不崩溃", not r["ok"], r)

r = execute_call({"tool": "run_command"})
check("缺 params 不崩溃", isinstance(r, dict), r)

print("== 屏幕/应用/剪贴板/窗口 ==")

# 截图（PIL 可用环境）
shot_path = os.path.join(tmp, "shot.png")
r = execute_call({"tool": "screenshot", "params": {"path": shot_path}})
check("截图保存成功", r["ok"] and os.path.isfile(shot_path), r)

r = execute_call({"tool": "screenshot", "params": {"path": os.path.join(tmp, "no_such_dir", "s.png")}})
check("截图自动建目录", r["ok"], r)

# open_app 参数校验（不实际启动应用，避免打扰桌面）
r = execute_call({"tool": "open_app", "params": {"target": ""}})
check("open_app 空目标报错", not r["ok"], r)
r = execute_call({"tool": "open_app", "params": {"target": "C:\\no_such_file_haha.xyz"}})
check("open_app 不存在目标报错", not r["ok"], r)
r = execute_call({"tool": "open_app", "params": {"target": "format C:"}})
check("open_app 黑名单拦截", not r["ok"] and "黑名单" in r["error"], r)

# 剪贴板：备份 → 写读往返 → 恢复
orig = ""
try:
    from harness_server import _clipboard_read, _clipboard_write
    try:
        orig = _clipboard_read()
    except Exception:
        orig = ""
    r = execute_call({"tool": "clipboard_write", "params": {"text": "webharness_roundtrip_42"}})
    check("clipboard_write", r["ok"], r)
    r = execute_call({"tool": "clipboard_read", "params": {}})
    check("clipboard_read 往返", r["ok"] and "webharness_roundtrip_42" in r["result"], r)
finally:
    try:
        _clipboard_write(orig)
    except Exception:
        pass

# 窗口
r = execute_call({"tool": "list_windows", "params": {}})
check("list_windows 非空", r["ok"] and "可见窗口" in r["result"], r)

r = execute_call({"tool": "activate_window", "params": {"title_keyword": ""}})
check("activate_window 空关键词报错", not r["ok"], r)
r = execute_call({"tool": "activate_window", "params": {"title_keyword": "绝不可能存在的窗口标题xyz123"}})
check("activate_window 找不到报错", not r["ok"] and "未找到" in r["error"], r)

# view_image：生成小 PNG → 验证 base64 结构
img_path = os.path.join(tmp, "t.png")
from PIL import Image
Image.new("RGB", (2, 2), (255, 0, 0)).save(img_path)
r = execute_call({"tool": "view_image", "params": {"path": img_path}})
check("view_image 返回图像结构", r["ok"], r)
if r["ok"]:
    meta = json.loads(r["result"])
    check("view_image 结构字段", meta.get("__image__") is True and meta.get("mime") == "image/png"
          and len(meta.get("data", "")) > 20 and meta.get("name") == "t.png", meta.keys())

r = execute_call({"tool": "view_image", "params": {"path": os.path.join(tmp, "no.png")}})
check("view_image 不存在报错", not r["ok"], r)

print("== 鼠标/键盘 ==")
# 成功路径会真实移动光标/点击/按键，自动化只验证参数校验与工具注册

check("mouse_move 已注册", "mouse_move" in TOOLS, True)
check("mouse_click 已注册", "mouse_click" in TOOLS, True)
check("key_press 已注册", "key_press" in TOOLS, True)

r = execute_call({"tool": "mouse_move", "params": {"x": -1, "y": 10}})
check("mouse_move 负坐标报错", not r["ok"] and "非负" in r["error"], r)

r = execute_call({"tool": "mouse_click", "params": {"button": "side"}})
check("mouse_click 非法按键报错", not r["ok"] and "left/right/middle" in r["error"], r)

r = execute_call({"tool": "key_press", "params": {"keys": ""}})
check("key_press 空按键报错", not r["ok"], r)

r = execute_call({"tool": "key_press", "params": {"keys": "ctrl+hyperjump"}})
check("key_press 未知按键报错", not r["ok"] and "未知按键" in r["error"], r)

print("\n结果: %d 通过, %d 失败" % (PASS, FAIL))
sys.exit(1 if FAIL else 0)
