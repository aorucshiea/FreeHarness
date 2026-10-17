# -*- coding: utf-8 -*-
"""注册 / 更新 FreeHarness Native Messaging Host。

用法：
    python install_host.py                  # 用现有扩展 ID 注册
    python install_host.py <扩展ID>          # 更新 allowed_origins 后注册（换扩展/移目录时用）

平台差异：
  - Windows：写 HKCU 注册表（Edge + Chrome），无需管理员
  - macOS / Linux：把 host manifest 复制到各浏览器约定的 NativeMessagingHosts 目录
扩展 ID 获取：edge://extensions 或 chrome://extensions 打开开发人员模式，卡片上显示。
"""
import json
import os
import shutil
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
MANIFEST_NAME = "com.webharness.launcher.json"
MANIFEST = os.path.join(BASE, MANIFEST_NAME)
HOST_NAME = "com.webharness.launcher"

WIN_KEYS = [
    r"Software\Microsoft\Edge\NativeMessagingHosts\%s" % HOST_NAME,
    r"Software\Google\Chrome\NativeMessagingHosts\%s" % HOST_NAME,
]

# macOS / Linux 下各浏览器读取 host manifest 的目录（文件式注册）
UNIX_DIRS = {
    "darwin": [
        "~/Library/Application Support/Google/Chrome/NativeMessagingHosts",
        "~/Library/Application Support/Microsoft Edge/NativeMessagingHosts",
        "~/Library/Application Support/Chromium/NativeMessagingHosts",
        "~/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts",
    ],
    "linux": [
        "~/.config/google-chrome/NativeMessagingHosts",
        "~/.config/microsoft-edge/NativeMessagingHosts",
        "~/.config/chromium/NativeMessagingHosts",
        "~/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts",
    ],
}


def _host_launcher():
    """当前平台应使用的 host 启动脚本。"""
    if sys.platform == "win32":
        return os.path.join(BASE, "launcher_host.bat")
    return os.path.join(BASE, "launcher_host.sh")


def _write_manifest(ext_id=None):
    with open(MANIFEST, encoding="utf-8") as f:
        m = json.load(f)
    m["path"] = _host_launcher()
    if ext_id:
        m["allowed_origins"] = ["chrome-extension://%s/" % ext_id]
    with open(MANIFEST, "w", encoding="utf-8") as f:
        json.dump(m, f, indent=2, ensure_ascii=False)
    return m


def install(ext_id=None):
    m = _write_manifest(ext_id)
    print("host 启动脚本:", m["path"])
    print("allowed_origins:", m["allowed_origins"])

    if sys.platform == "win32":
        import winreg
        for sub in WIN_KEYS:
            k = winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, sub, 0, winreg.KEY_WRITE)
            winreg.SetValueEx(k, "", 0, winreg.REG_SZ, MANIFEST)
            winreg.CloseKey(k)
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, sub) as vk:
                print("OK", sub, "->", winreg.QueryValueEx(vk, "")[0])
        return

    dirs = UNIX_DIRS.get("darwin" if sys.platform == "darwin" else "linux", [])
    for d in dirs:
        path = os.path.expanduser(d)
        try:
            os.makedirs(path, exist_ok=True)
            shutil.copy2(MANIFEST, os.path.join(path, MANIFEST_NAME))
            print("OK", os.path.join(path, MANIFEST_NAME))
        except Exception as e:
            print("skip", path, "-", e)


if __name__ == "__main__":
    install(sys.argv[1] if len(sys.argv) > 1 else None)
