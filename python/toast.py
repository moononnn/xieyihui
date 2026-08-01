#!/usr/bin/env python3
"""
歇一会 - Windows 系统通知（WinRT toast）
来源名显示为「歇一会」（注册 AppUserModelID + 注册表 DisplayName），
不再是 PowerShell 进程名，也不会被字符串拼接注入影响。

标题/正文通过环境变量传给 notify.ps1，脚本本身无任何用户内容拼接。
"""

import os
import subprocess
import sys
import pathlib

PS1_NAME = "notify.ps1"


def _ps1_path():
    return pathlib.Path(__file__).resolve().parent / PS1_NAME


def send_notification(title, message):
    """发一条系统 toast 通知（注册逻辑在 notify.ps1 内，幂等）"""
    ps1 = _ps1_path()
    if not ps1.exists():
        return
    env = os.environ.copy()
    env["XYH_TITLE"] = str(title)
    env["XYH_MSG"] = str(message)
    result = subprocess.run(
        ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-STA", "-File", str(ps1)],
        env=env,
        capture_output=True,
        timeout=20,
    )
    if result.returncode != 0:
        err = result.stderr.decode("utf-8", errors="replace").strip()
        sys.stderr.write(f"[歇一会] 通知发送失败: {err}\n")


if __name__ == "__main__":
    if len(sys.argv) >= 3:
        send_notification(sys.argv[1], sys.argv[2])
