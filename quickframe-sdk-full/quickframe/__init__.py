"""QuickFrame AI 非官方 Python SDK.

基于对 https://ai.quickframe.com 真实网络请求的抓包逆向，覆盖完整链路：
注册/登录 -> 上传图片 -> 生成视频 -> 轮询进度 -> 无水印下载。

典型用法::

    from quickframe import QuickFrameClient

    qf = QuickFrameClient(access_token="<浏览器里复制的 Bearer token>")
    result = qf.generate_video_from_image(
        image_path="storyboard.png",
        prompt="[Image 1]根据分镜帮我生成视频",
        download_to="output.mp4",
    )
    print(result.video_url, result.local_path)
"""

from .client import QuickFrameClient
from .auth import QuickFrameAuth, TempMail
from .models import Asset, GenerationJob, GenerationResult, Session
from .exceptions import (
    QuickFrameError,
    AuthError,
    UploadError,
    GenerationError,
    GenerationTimeout,
    APIError,
)

__version__ = "0.1.0"

__all__ = [
    "QuickFrameClient",
    "QuickFrameAuth",
    "TempMail",
    "Asset",
    "GenerationJob",
    "GenerationResult",
    "Session",
    "QuickFrameError",
    "AuthError",
    "UploadError",
    "GenerationError",
    "GenerationTimeout",
    "APIError",
]
