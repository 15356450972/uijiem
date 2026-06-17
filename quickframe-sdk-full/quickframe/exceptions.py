"""SDK 异常类型。"""

from typing import Any, Optional


class QuickFrameError(Exception):
    """所有 SDK 异常的基类。"""


class AuthError(QuickFrameError):
    """注册/登录/换取 token 失败。"""


class UploadError(QuickFrameError):
    """素材上传失败（签名、Cloudinary 或注册任一环节）。"""


class GenerationError(QuickFrameError):
    """视频生成请求被后端拒绝或任务失败。"""


class GenerationTimeout(GenerationError):
    """轮询超时仍未完成。"""


class APIError(QuickFrameError):
    """通用 HTTP/接口错误，保留状态码与响应体便于排查。"""

    def __init__(
        self,
        message: str,
        status_code: Optional[int] = None,
        payload: Any = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.payload = payload

    def __str__(self) -> str:
        base = super().__str__()
        if self.status_code is not None:
            return f"[HTTP {self.status_code}] {base}"
        return base
