# -*- coding: utf-8 -*-
"""注册 / 更新 FreeHarness Native Messaging Host（无需管理员，只写 HKCU）。

用法：
    python install_host.py                  # 用 manifest 里现有的扩展 ID 注册
    python install_host.py <扩展ID>          # 更新 allowed_origins 后注册（换扩展时用）

扩展 ID 获取：edge://extensions 打开开发人员模式，卡片上显示的 ID。
"""
import json
import os
import sys
import winreg

BASE = os.path.dirname(os.path.abspath(__file__))
MANIFEST = os.path.join(BASE, "com.webharness.launcher.json")
HOST_NAME = "com.webharness.launcher"
KEYS = [
    r"Software\Microsoft\Edge\NativeMessagingHosts\%s" % HOST_NAME,
    r"Software\Google\Chrome\NativeMessagingHosts\%s" % HOST_NAME,
]


def install(ext_id=None):
    if ext_id:
        with open(MANIFEST, encoding="utf-8") as f:
            m = json.load(f)
        m["allowed_origins"] = ["chrome-extension://%s/" % ext_id]
        with open(MANIFEST, "w", encoding="utf-8") as f:
            json.dump(m, f, indent=2, ensure_ascii=False)
        print("allowed_origins ->", m["allowed_origins"])
    for sub in KEYS:
        k = winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, sub, 0, winreg.KEY_WRITE)
        winreg.SetValueEx(k, "", 0, winreg.REG_SZ, MANIFEST)
        winreg.CloseKey(k)
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, sub) as vk:
            print("OK", sub, "->", winreg.QueryValueEx(vk, "")[0])


if __name__ == "__main__":
    install(sys.argv[1] if len(sys.argv) > 1 else None)
