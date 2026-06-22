"""数据模型：把后端返回的原始 JSON 包装成易用的对象。"""

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class Session:
    """登录会话 / 当前用户信息（来自 GET /session）。"""

    user_id: str
    email: str
    session_id: Optional[str] = None
    active: bool = False
    raw: Dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_response(cls, data: Dict[str, Any]) -> "Session":
        user = data.get("user", {}) or {}
        sess = data.get("session", {}) or {}
        return cls(
            user_id=str(user.get("id", "")),
            email=user.get("email", ""),
            session_id=sess.get("id"),
            active=bool(sess.get("active", False)),
            raw=data,
        )


@dataclass
class Asset:
    """上传后注册的素材（图片/视频/音频）。

    对应 assets.registerDirectUpload 的响应。
    """

    asset_id: int
    name: str
    asset_type: str
    cloudinary_url: str
    width: Optional[int] = None
    height: Optional[int] = None
    fmt: Optional[str] = None
    urls: Dict[str, str] = field(default_factory=dict)
    raw: Dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_response(cls, data: Dict[str, Any]) -> "Asset":
        files = data.get("assetFiles") or [{}]
        first = files[0] if files else {}
        meta = first.get("meta", {}) or {}
        urls = first.get("urls", {}) or {}
        return cls(
            asset_id=data.get("assetId"),
            name=data.get("name", ""),
            asset_type=data.get("assetType", ""),
            cloudinary_url=urls.get("original", ""),
            width=meta.get("width"),
            height=meta.get("height"),
            fmt=first.get("fileType"),
            urls=urls,
            raw=data,
        )


@dataclass
class GenerationJob:
    """已提交的生成任务（来自 effects.generateSeedanceVideoForEditor）。"""

    job_id: str
    channel: str
    project_id: Optional[int] = None
    raw: Dict[str, Any] = field(default_factory=dict)

    @property
    def run_id(self) -> str:
        """effectRunId 与 jobId 相同，用于在结果资源里匹配。"""
        return self.job_id


@dataclass
class GenerationResult:
    """生成完成后的最终视频结果。"""

    asset_id: int
    video_url: str  # 无水印原始 MP4
    width: Optional[int] = None
    height: Optional[int] = None
    duration: Optional[float] = None
    model: Optional[str] = None
    prompt: Optional[str] = None
    urls: Dict[str, str] = field(default_factory=dict)
    local_path: Optional[str] = None  # 若下载则为本地路径
    raw: Dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_asset_response(cls, data: Dict[str, Any]) -> "GenerationResult":
        files = data.get("assetFiles") or [{}]
        first = files[0] if files else {}
        meta = first.get("meta", {}) or {}
        urls = first.get("urls", {}) or {}
        return cls(
            asset_id=data.get("assetId"),
            video_url=urls.get("original", ""),
            width=meta.get("width"),
            height=meta.get("height"),
            duration=meta.get("duration"),
            model=meta.get("model"),
            prompt=meta.get("prompt"),
            urls=urls,
            raw=data,
        )
