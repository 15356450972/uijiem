# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller 打包配置：把 wizstar FastAPI 后端冻结为独立可执行（onedir）。

设计：
- 入口 backend_entry.py 在运行期把随包的 `wizstar`(内层包父目录) 与
  `quickframe-sdk-full` 加入 sys.path，因此这两份源码以 *数据目录* 形式随包携带。
- quickframe_bridge.py 运行期会校验 `quickframe-sdk-full` 物理目录是否存在，
  并动态 import chain_proxy / register_full / quickframe.client，故必须实地携带该目录。
- 所有第三方依赖(fastapi/uvicorn/starlette/pydantic/requests/pycryptodome 等)
  通过 collect_all + hiddenimports 显式冻结，保证数据目录里的源码运行时可用。
"""

from PyInstaller.utils.hooks import collect_all, collect_submodules

datas = []
binaries = []
hiddenimports = []

# 内层 wizstar 包（含 __init__.py，使用相对导入）。放到 dist 的 wizstar/wizstar 下，
# 由 backend_entry 将 <base>/wizstar 加入 sys.path 后以顶层名 `wizstar` 导入。
datas += [('wizstar/wizstar', 'wizstar/wizstar')]
# QuickFrame SDK：被 quickframe_bridge 动态导入，且有 isdir 物理校验。
datas += [('quickframe-sdk-full', 'quickframe-sdk-full')]

# 第三方依赖整包收集（含数据文件，如 certifi 的 cacert.pem）。
for pkg in (
    'fastapi',
    'starlette',
    'uvicorn',
    'websockets',
    'pydantic',
    'pydantic_core',
    'anyio',
    'requests',
    'urllib3',
    'certifi',
    'charset_normalizer',
    'idna',
    'h11',
    'click',
    'sniffio',
    'Crypto',          # pycryptodome
    'aiosqlite',
):
    try:
        d, b, h = collect_all(pkg)
        datas += d
        binaries += b
        hiddenimports += h
    except Exception:
        pass

# uvicorn 运行期按需加载协议/循环实现，确保全部子模块在场。
hiddenimports += collect_submodules('uvicorn')

# quickframe-sdk-full 顶层模块名（被动态 import，分析阶段不一定可见）。
hiddenimports += ['chain_proxy', 'register_full', 'register_concurrent', 'gptmail_getcode']
hiddenimports += collect_submodules('quickframe')

block_cipher = None

a = Analysis(
    ['backend_entry.py'],
    pathex=['quickframe-sdk-full', 'wizstar'],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['tkinter', 'matplotlib', 'numpy', 'PIL', 'pandas'],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='wizstar-server',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name='wizstar-server',
)
