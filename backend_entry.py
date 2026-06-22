"""PyInstaller 打包用的后端入口。

打包后会被冻结成 wizstar-server.exe，由 Electron 主进程在生产环境拉起。
负责：把随包携带的 SDK / 包目录加入 sys.path，然后启动 FastAPI 服务。

包结构说明：
  <repo>/wizstar/wizstar/  —— 真正的包（含 __init__.py，内部使用相对导入）
  <repo>/quickframe-sdk-full/ —— QuickFrame SDK（被 quickframe_bridge 动态导入）

为避免 “wizstar.wizstar” 命名空间包在冻结后解析困难，这里把
<repo>/wizstar 加进 sys.path，使内层包以顶层名 `wizstar` 导入。
"""

import os
import sys


def _base_dir() -> str:
    """返回随包资源根目录：冻结后为 _MEIPASS，开发时为本文件所在目录。"""
    if getattr(sys, "frozen", False):
        return getattr(sys, "_MEIPASS", os.path.dirname(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))


def _setup_paths() -> None:
    base = _base_dir()
    # 内层包父目录（使 `import wizstar` 命中真正的包）
    pkg_parent = os.path.join(base, "wizstar")
    # QuickFrame SDK（被 quickframe_bridge 动态 import chain_proxy / register_full 等）
    sdk_dir = os.path.join(base, "quickframe-sdk-full")
    for p in (pkg_parent, sdk_dir):
        if os.path.isdir(p) and p not in sys.path:
            sys.path.insert(0, p)


def main() -> None:
    _setup_paths()

    host = os.getenv("WIZSTAR_HOST", "127.0.0.1")
    port = int(os.getenv("WIZSTAR_PORT", "8765"))

    from wizstar.server import start_server
    start_server(host=host, port=port)


if __name__ == "__main__":
    main()
