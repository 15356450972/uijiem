"""Wizstar 全自动 SDK（纯协议）

功能:
  1. 注册邮箱账号（RSA 加密邮箱密码 + OAuth2 IMAP 自动取验证码）
  2. 上传图片到 wizstar 私有 S3（init -> S3 PUT -> complete）
  3. 创建文生 / 图生 / 视频参考等多种视频任务
  4. 在线 / 离线积分估算
  5. 轮询任务详情拿到最终视频 URL

依赖:
  pip install -r requirements.txt
"""

from .enums import TaskType, Model, Ratio, Resolution
from .capabilities import (
    CAPABILITY_MATRIX,
    POINT_TABLE,
    estimate_points_offline,
)
from .crypto import rsa_encrypt
from .mailbox import OutlookMailbox
from .client import WizstarClient, WizstarCredentials, BASE_URL, DEFAULT_HEADERS
from .demo import end_to_end_demo

__all__ = [
    "TaskType",
    "Model",
    "Ratio",
    "Resolution",
    "CAPABILITY_MATRIX",
    "POINT_TABLE",
    "estimate_points_offline",
    "rsa_encrypt",
    "OutlookMailbox",
    "WizstarClient",
    "WizstarCredentials",
    "BASE_URL",
    "DEFAULT_HEADERS",
    "end_to_end_demo",
]

__version__ = "1.0.0"
