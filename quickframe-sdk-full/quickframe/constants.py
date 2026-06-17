"""所有端点、常量配置。

数值均来自对 ai.quickframe.com 的真实抓包，可按需通过环境变量覆盖。
"""

import os

# ---- 后端 API (Hapi + tRPC) ----
API_BASE = os.getenv("QF_API_BASE", "https://server.cs.quickframe.com")
WEB_ORIGIN = os.getenv("QF_WEB_ORIGIN", "https://ai.quickframe.com")

# ---- Auth0 (注册/登录) ----
# JWT 的 iss=https://login.quickframe.com/  azp=13P092MMSNWNgzEVpOV5fLRUmWuUn8pR
AUTH0_DOMAIN = os.getenv("QF_AUTH0_DOMAIN", "login.quickframe.com")
AUTH0_CLIENT_ID = os.getenv("QF_AUTH0_CLIENT_ID", "13P092MMSNWNgzEVpOV5fLRUmWuUn8pR")
AUTH0_AUDIENCE = os.getenv("QF_AUTH0_AUDIENCE", "https://api.mountain.com")
AUTH0_REALM = os.getenv("QF_AUTH0_REALM", "Username-Password-Authentication")
AUTH0_SCOPE = "openid profile email offline_access"

# ---- Cloudinary (素材存储) ----
CLOUDINARY_CLOUD_NAME = os.getenv("QF_CLOUDINARY_CLOUD", "creative-suite")
CLOUDINARY_UPLOAD_BASE = "https://api.cloudinary.com/v1_1"
CLOUDINARY_RES_BASE = "https://res.cloudinary.com"

# ---- 默认生成参数 ----
DEFAULT_ASPECT_RATIO = "16:9"
DEFAULT_DURATION = 15
DEFAULT_MODEL = "Seedance 2"  # 对应后端 dreamina-seedance-2-0-fast

# ---- 轮询 ----
POLL_INTERVAL_SECONDS = 5
POLL_TIMEOUT_SECONDS = 600  # 生成预计 5 分钟，留足余量

# ---- 浏览器 UA (与抓包一致，降低被风控概率) ----
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"
)


def trpc_url(procedure: str, batch: bool = True) -> str:
    """构造 tRPC 端点 URL。

    例如 procedure="assets.registerDirectUpload" ->
        https://server.cs.quickframe.com/trpc/assets.registerDirectUpload?batch=1
    """
    url = f"{API_BASE}/trpc/{procedure}"
    if batch:
        url += "?batch=1"
    return url


def cloudinary_upload_url(resource_type: str = "image") -> str:
    """Cloudinary 直传地址。resource_type: image / video / raw。"""
    return f"{CLOUDINARY_UPLOAD_BASE}/{CLOUDINARY_CLOUD_NAME}/{resource_type}/upload"
