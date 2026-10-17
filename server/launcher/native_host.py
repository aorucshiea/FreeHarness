# -*- coding: utf-8 -*-
"""FreeHarness Native Messaging Host
由浏览器（Edge/Chrome）按需启动：收到扩展消息后拉起本地服务 start_server.bat，
然后回一个确认包。stdout 只允许输出协议二进制，绝不能 print 杂音。
"""
import json
import os
import struct
import subprocess
import sys


def read_message():
    """读取浏览器发来的一条消息（4 字节长度 + JSON）。"""
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    (n,) = struct.unpack("=I", raw)
    body = sys.stdin.buffer.read(n)
    try:
        return json.loads(body.decode("utf-8", "replace"))
    except Exception:
        return {}


def send_message(obj):
    data = json.dumps(obj).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("=I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def port_alive():
    """8765 端口是否已在监听（服务已运行）。"""
    import socket
    try:
        s = socket.create_connection(("127.0.0.1", 8765), timeout=0.5)
        s.close()
        return True
    except Exception:
        return False


def main():
    msg = read_message()
    here = os.path.dirname(os.path.abspath(__file__))
    server_dir = os.path.dirname(here)

    if port_alive():
        send_message({"ok": True, "already": True})
        return

    # Windows：start_server.bat（最小化 cmd 窗口，方便用户随时关闭）
    if sys.platform == "win32":
        bat = os.path.join(server_dir, "start_server.bat")
        if not os.path.isfile(bat):
            send_message({"ok": False, "error": "start_server.bat not found: " + bat})
            return
        try:
            subprocess.Popen(
                'start "" /min "%s"' % bat,
                shell=True,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            send_message({"ok": True, "started": True})
        except Exception as e:
            send_message({"ok": False, "error": str(e)})
        return

    # macOS / Linux：静默后台运行（日志见 server/harness_server.log）
    sh = os.path.join(server_dir, "start_server.sh")
    if not os.path.isfile(sh):
        send_message({"ok": False, "error": "start_server.sh not found: " + sh})
        return
    try:
        subprocess.Popen(
            ["/bin/sh", sh],
            start_new_session=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        send_message({"ok": True, "started": True})
    except Exception as e:
        send_message({"ok": False, "error": str(e)})


if __name__ == "__main__":
    main()
