# -*- coding: utf-8 -*-
"""注册 / 更新 FreeHarness Native Messaging Host，并可开启登录自启。

用法：
    python install_host.py                  # 自动检测已加载的扩展并注册（推荐）
    python install_host.py --auto           # 同上（显式）
    python install_host.py --autostart      # 注册 + 开启登录自启（服务每次登录静默启动）
    python install_host.py --remove-autostart   # 关闭登录自启
    python install_host.py <扩展ID>          # 手动指定扩展 ID（自动检测失败时用）

自动检测：扫描各 Chromium 浏览器的配置目录，找出「加载路径指向本仓库 extension/ 目录」
或「清单名含 FreeHarness」的已加载扩展，把它们的 ID 全部写进 allowed_origins。
换目录 / 重载扩展导致 ID 变化后，扩展会通过服务自注册（POST /register），或下次服务启动时自动更新。

平台差异：
  - Windows：写 HKCU 注册表（Edge / Chrome / Brave / Vivaldi），无需管理员
  - macOS / Linux：把 host manifest 复制到各浏览器约定的 NativeMessagingHosts 目录
"""
import json
import os
import shutil
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
MANIFEST_NAME = "com.webharness.launcher.json"
MANIFEST = os.path.join(BASE, MANIFEST_NAME)
HOST_NAME = "com.webharness.launcher"
EXPECTED_EXT_DIR = os.path.normcase(os.path.normpath(os.path.join(os.path.dirname(os.path.dirname(BASE)), "extension")))

AUTOSTART_RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
AUTOSTART_VALUE = "FreeHarnessServer"
AUTOSTART_VBS = os.path.join(BASE, "autostart_server.vbs")

WIN_KEYS = [
    r"Software\Microsoft\Edge\NativeMessagingHosts\%s" % HOST_NAME,
    r"Software\Google\Chrome\NativeMessagingHosts\%s" % HOST_NAME,
    r"Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\%s" % HOST_NAME,
    r"Software\Vivaldi\NativeMessagingHosts\%s" % HOST_NAME,
]

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


def enable_autostart(quiet=False):
    """把服务加入当前用户登录自启（Windows：Run 键；静默无窗口）。"""
    if sys.platform != "win32":
        if not quiet:
            print("非 Windows 平台：请把 start_server.sh 加入桌面环境的登录自启（如 ~/.config/autostart）。")
        return False
    import winreg
    cmd = 'wscript.exe "%s"' % AUTOSTART_VBS
    try:
        k = winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, AUTOSTART_RUN_KEY, 0, winreg.KEY_WRITE)
        winreg.SetValueEx(k, AUTOSTART_VALUE, 0, winreg.REG_SZ, cmd)
        winreg.CloseKey(k)
        if not quiet:
            print("已开启登录自启:", cmd)
        return True
    except Exception as e:
        if not quiet:
            print("开启自启失败:", e)
        return False


def disable_autostart(quiet=False):
    """移除登录自启。"""
    if sys.platform != "win32":
        return False
    import winreg
    try:
        k = winreg.OpenKey(winreg.HKEY_CURRENT_USER, AUTOSTART_RUN_KEY, 0, winreg.KEY_WRITE)
        winreg.DeleteValue(k, AUTOSTART_VALUE)
        winreg.CloseKey(k)
        if not quiet:
            print("已关闭登录自启")
        return True
    except FileNotFoundError:
        if not quiet:
            print("登录自启本就未开启")
        return True
    except Exception as e:
        if not quiet:
            print("关闭自启失败:", e)
        return False


def _browser_profile_dirs():
    """枚举各 Chromium 浏览器里含 Preferences 的配置目录。"""
    if sys.platform == "win32":
        local = os.environ.get("LOCALAPPDATA", "")
        appdata = os.environ.get("APPDATA", "")
        roots = [
            os.path.join(local, "Microsoft", "Edge", "User Data"),
            os.path.join(local, "Google", "Chrome", "User Data"),
            os.path.join(local, "BraveSoftware", "Brave-Browser", "User Data"),
            os.path.join(local, "Vivaldi", "User Data"),
            os.path.join(appdata, "Opera Software", "Opera Stable"),
        ]
    elif sys.platform == "darwin":
        home = os.path.expanduser("~")
        roots = [
            os.path.join(home, "Library", "Application Support", "Google", "Chrome"),
            os.path.join(home, "Library", "Application Support", "Microsoft Edge"),
            os.path.join(home, "Library", "Application Support", "Chromium"),
            os.path.join(home, "Library", "Application Support", "BraveSoftware", "Brave-Browser"),
        ]
    else:
        home = os.path.expanduser("~")
        roots = [
            os.path.join(home, ".config", "google-chrome"),
            os.path.join(home, ".config", "microsoft-edge"),
            os.path.join(home, ".config", "chromium"),
            os.path.join(home, ".config", "BraveSoftware", "Brave-Browser"),
        ]
    for root in roots:
        if not os.path.isdir(root):
            continue
        yield root
        try:
            subs = sorted(os.listdir(root))
        except OSError:
            continue
        for d in subs:
            p = os.path.join(root, d)
            if not os.path.isdir(p):
                continue
            if os.path.isfile(os.path.join(p, "Preferences")) or os.path.isfile(os.path.join(p, "Secure Preferences")):
                yield p


def detect_extension_ids():
    """扫描浏览器配置，返回已加载 FreeHarness 扩展的 ID 集合。"""
    ids = set()
    for prof in _browser_profile_dirs():
        for fname in ("Secure Preferences", "Preferences"):
            p = os.path.join(prof, fname)
            if not os.path.isfile(p):
                continue
            try:
                with open(p, encoding="utf-8") as f:
                    d = json.load(f)
            except Exception:
                continue
            settings = ((d.get("extensions") or {}).get("settings")) or {}
            for eid, v in settings.items():
                if not isinstance(v, dict):
                    continue
                path = str(v.get("path") or "")
                if not path:
                    continue
                if os.path.normcase(os.path.normpath(path)) == EXPECTED_EXT_DIR:
                    ids.add(eid)
                    continue
                try:
                    with open(os.path.join(path, "manifest.json"), encoding="utf-8") as f:
                        name = str(json.load(f).get("name") or "")
                except Exception:
                    name = ""
                if "freeharness" in name.lower():
                    ids.add(eid)
    return ids


def _existing_origins():
    try:
        with open(MANIFEST, encoding="utf-8") as f:
            return [str(o) for o in (json.load(f).get("allowed_origins") or [])]
    except Exception:
        return []


def _write_manifest(ids):
    with open(MANIFEST, encoding="utf-8") as f:
        m = json.load(f)
    m["path"] = _host_launcher()
    m["allowed_origins"] = ["chrome-extension://%s/" % i for i in ids]
    with open(MANIFEST, "w", encoding="utf-8") as f:
        json.dump(m, f, indent=2, ensure_ascii=False)
    return m


def _register(m, quiet=False):
    if sys.platform == "win32":
        import winreg
        for sub in WIN_KEYS:
            try:
                k = winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, sub, 0, winreg.KEY_WRITE)
                winreg.SetValueEx(k, "", 0, winreg.REG_SZ, MANIFEST)
                winreg.CloseKey(k)
                if not quiet:
                    print("OK", sub, "->", MANIFEST)
            except Exception as e:
                if not quiet:
                    print("skip", sub, "-", e)
        return

    dirs = UNIX_DIRS.get("darwin" if sys.platform == "darwin" else "linux", [])
    for d in dirs:
        path = os.path.expanduser(d)
        try:
            os.makedirs(path, exist_ok=True)
            shutil.copy2(MANIFEST, os.path.join(path, MANIFEST_NAME))
            if not quiet:
                print("OK", os.path.join(path, MANIFEST_NAME))
        except Exception as e:
            if not quiet:
                print("skip", path, "-", e)


def install(ext_ids=None, quiet=False, detect=True):
    ids = set(ext_ids or [])
    if detect:
        ids |= detect_extension_ids()
    # 合并清单里已有的 origins，避免把之前注册的 ID 冲掉
    for o in _existing_origins():
        ids.add(o.replace("chrome-extension://", "").rstrip("/"))
    ids = sorted(i for i in ids if i)
    if not ids:
        if not quiet:
            print("没有可注册的扩展 ID：请先在浏览器加载 extension 目录，或运行 python install_host.py <扩展ID>")
        return False
    m = _write_manifest(ids)
    if not quiet:
        print("host 启动脚本:", m["path"])
        print("allowed_origins:", m["allowed_origins"])
    _register(m, quiet=quiet)
    return True


def auto_detect_and_install(quiet=True):
    """服务启动时调用：自动检测并注册，尽力而为。"""
    try:
        return install(None, quiet=quiet)
    except Exception:
        return False


if __name__ == "__main__":
    flags = [a for a in sys.argv[1:] if a.startswith("--")]
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    quiet = "--quiet" in flags or "--auto" in flags
    if args:
        install(args, quiet=quiet)
    else:
        install(None, quiet=quiet)
    if "--autostart" in flags:
        enable_autostart()
    if "--remove-autostart" in flags:
        disable_autostart()