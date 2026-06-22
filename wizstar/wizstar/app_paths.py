"""运行时路径工具：为打包后的 Windows 环境选择稳定可写的数据目录。"""

import os
from pathlib import Path


def get_wizstar_data_dir() -> str:
    """返回本地数据目录，并确保目录存在。

    优先级：
    1. `WIZSTAR_HOME`
    2. Windows `LOCALAPPDATA`
    3. Windows `APPDATA`
    4. 用户主目录 `~/.wizstar`
    5. 当前工作目录 `.wizstar`
    """

    candidates = [
        os.environ.get("WIZSTAR_HOME", "").strip(),
        os.path.join(os.environ.get("LOCALAPPDATA", "").strip(), "Wizstar") if os.environ.get("LOCALAPPDATA", "").strip() else "",
        os.path.join(os.environ.get("APPDATA", "").strip(), "Wizstar") if os.environ.get("APPDATA", "").strip() else "",
        os.path.join(os.path.expanduser("~"), ".wizstar"),
        os.path.join(os.getcwd(), ".wizstar"),
    ]

    for candidate in candidates:
        if not candidate:
            continue
        try:
            Path(candidate).mkdir(parents=True, exist_ok=True)
            return candidate
        except OSError:
            continue

    # 理论上不会到这里；兜底再尝试当前目录。
    fallback = os.path.join(os.getcwd(), ".wizstar")
    Path(fallback).mkdir(parents=True, exist_ok=True)
    return fallback
