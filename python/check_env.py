#!/usr/bin/env python3
"""
歇一会 - 环境检测脚本
检测当前是否处于全屏应用（游戏/视频）或 Windows 免打扰模式。
退出码: 0=正常（可以弹窗）, 1=检测到全屏/免打扰（跳过休息）
"""

import ctypes
import ctypes.wintypes
import winreg
import sys


class MONITORINFO(ctypes.Structure):
    _fields_ = [
        ("cbSize", ctypes.wintypes.DWORD),
        ("rcMonitor", ctypes.wintypes.RECT),
        ("rcWork", ctypes.wintypes.RECT),
        ("dwFlags", ctypes.wintypes.DWORD),
    ]


def get_foreground_screen_size():
    """前台窗口所在显示器的宽高；取不到时回退主屏分辨率"""
    try:
        user32 = ctypes.windll.user32
        hwnd = user32.GetForegroundWindow()
        # MONITOR_DEFAULTTONEAREST = 2：取前台窗口所在（最近）的显示器
        monitor = user32.MonitorFromWindow(hwnd, 2)
        info = MONITORINFO()
        info.cbSize = ctypes.sizeof(MONITORINFO)
        if user32.GetMonitorInfoW(monitor, ctypes.byref(info)):
            r = info.rcMonitor
            return r.right - r.left, r.bottom - r.top
    except Exception:
        pass
    sw = ctypes.windll.user32.GetSystemMetrics(0)
    sh = ctypes.windll.user32.GetSystemMetrics(1)
    return sw, sh


def is_fullscreen():
    """检测前台窗口是否全屏（按窗口所在显示器的分辨率，而非主屏）"""
    try:
        user32 = ctypes.windll.user32
        hwnd = user32.GetForegroundWindow()
        rect = ctypes.wintypes.RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(rect))
        sw, sh = get_foreground_screen_size()
        w = rect.right - rect.left
        h = rect.bottom - rect.top
        return w == sw and h == sh
    except Exception:
        return False


def is_dnd_on():
    """检测 Windows 专注助手（免打扰）是否开启"""
    try:
        key = winreg.OpenKey(winreg.HKEY_CURRENT_USER,
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\Notifications\Settings")
        value, _ = winreg.QueryValueEx(key, "NOC_GLOBAL_SETTING_ALLOW_QUIET_HOURS")
        return value == 1
    except Exception:
        return False


if __name__ == "__main__":
    fs = is_fullscreen()
    dnd = is_dnd_on()
    print(f"fullscreen={fs} dnd={dnd}")
    sys.exit(1 if (fs or dnd) else 0)
