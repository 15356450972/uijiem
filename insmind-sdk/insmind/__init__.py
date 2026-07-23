"""insMind 纯协议 SDK：注册、上传、Seedance 生成。"""

from .auth import exchange_verify_code, register_account, send_email_code
from .client import InsMindClient
from .gptmail import GPTMailClient
from .http import ApiError
from .tenant import ensure_tenant

__all__ = [
    "ApiError",
    "GPTMailClient",
    "InsMindClient",
    "ensure_tenant",
    "exchange_verify_code",
    "register_account",
    "send_email_code",
]
__version__ = "0.1.0"
