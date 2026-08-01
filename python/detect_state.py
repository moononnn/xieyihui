#!/usr/bin/env python3
"""歇一会 - 周期环境检测
输出一行 JSON：{"fullscreen": bool, "dnd": bool, "idleSeconds": int}
Node 侧据此决定是否暂停计时（全屏 / 免打扰 / 暂离）。
"""

import ctypes
import ctypes.wintypes
import json
import sys

from check_env import is_dnd_on, is_fullscreen


def idle_seconds():
    """鼠标键盘的最后输入距今多少秒（GetLastInputInfo）"""
    try:
        class LASTINPUTINFO(ctypes.Structure):
            _fields_ = [("cbSize", ctypes.c_uint), ("dwTime", ctypes.c_uint)]

        user32 = ctypes.windll.user32
        lii = LASTINPUTINFO()
        lii.cbSize = ctypes.sizeof(LASTINPUTINFO)
        if not user32.GetLastInputInfo(ctypes.byref(lii)):
            return 0
        tick = ctypes.windll.kernel32.GetTickCount()
        # GetTickCount 约 49.7 天回绕一次，差值计算仍然正确
        return max(0, (tick - lii.dwTime) // 1000)
    except Exception:
        return 0


if __name__ == "__main__":
    print(json.dumps({
        "fullscreen": is_fullscreen(),
        "dnd": is_dnd_on(),
        "idleSeconds": idle_seconds(),
    }))
    sys.exit(0)
