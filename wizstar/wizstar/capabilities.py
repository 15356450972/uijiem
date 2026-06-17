"""能力矩阵 + 离线积分价格表

数据来源：
  - /wizstar/tools/common/tags?task_type=N（每种任务支持的模型/比例/时长）
  - /wizstar/tools/common/point（实测点数）

运行时建议用 client.get_tags() 获取最新能力，本模块用于离线参考与估算。
"""

from __future__ import annotations

from .enums import TaskType, Model, Ratio, Resolution


CAPABILITY_MATRIX: dict[int, dict] = {
    TaskType.TEXT_TO_VIDEO: {
        "name": "Text-to-Video",
        "models": [Model.SEEDANCE_2_0, Model.KLING, Model.SEEDANCE_1_5],
        "ratios": [Ratio.PORTRAIT, Ratio.LANDSCAPE],
        "resolutions": [Resolution.P720],
        "durations": [5, 10],
        "video_nums": [1, 2, 3, 4],
        "required_params": [],
    },
    TaskType.IMAGE_TO_VIDEO: {
        "name": "Image-to-Video",
        "models": [Model.SEEDANCE_2_0, Model.KLING, Model.SEEDANCE_1_5],
        "ratios": [Ratio.PORTRAIT, Ratio.LANDSCAPE],
        "resolutions": [Resolution.P720],
        "durations": [5, 10],
        "video_nums": [1, 2, 3, 4],
        "required_params": ["pic_url"],
    },
    TaskType.VIDEO_REFERENCE: {
        "name": "Video-Reference",
        "models": [Model.KLING],
        "ratios": [Ratio.PORTRAIT, Ratio.LANDSCAPE],
        "resolutions": [Resolution.P720],
        "durations": [5, 10],
        "video_nums": [1, 2, 3, 4],
        "required_params": ["video_url"],
    },
    TaskType.PRODUCT_VIDEO: {
        "name": "Product-Video",
        "models": [Model.KLING, Model.SEEDANCE_2_0],
        "ratios": [Ratio.PORTRAIT, Ratio.LANDSCAPE],
        "resolutions": [Resolution.P720],
    },
    TaskType.TRANSLATION: {
        "name": "Translation / Lip-Sync",
        "translation_modes": ["lip_sync_audio", "audio_only"],
        "source_languages": ["auto", "zh-CN", "en-US"],
        "target_languages": [
            "en-US", "es-ES", "zh-CN", "pt-PT", "id-ID", "de-DE",
            "fr-FR", "th-TH", "vi-VN", "ja-JP", "ko-KR", "ar-SA",
        ],
    },
    TaskType.DIGITAL_HUMAN: {
        "name": "Image-to-Digital-Human",
        "ratios": [Ratio.PORTRAIT, Ratio.LANDSCAPE],
        "resolutions": [Resolution.P720],
        "required_params": ["pic_url"],
    },
    TaskType.AVATAR_VIDEO: {
        "name": "Avatar-Video",
        "resolutions": [Resolution.P1080],
        "target_languages": ["zh-CN", "en-US", "ja-JP", "id-ID"],
    },
}


POINT_TABLE: dict[tuple[int, str, int], int] = {
    (TaskType.TEXT_TO_VIDEO,   Model.SEEDANCE_2_0, 5):  90,
    (TaskType.TEXT_TO_VIDEO,   Model.SEEDANCE_2_0, 10): 180,
    (TaskType.TEXT_TO_VIDEO,   Model.SEEDANCE_1_5, 5):  65,
    (TaskType.TEXT_TO_VIDEO,   Model.KLING,        5):  40,
    (TaskType.IMAGE_TO_VIDEO,  Model.SEEDANCE_2_0, 5):  90,
    (TaskType.IMAGE_TO_VIDEO,  Model.SEEDANCE_2_0, 10): 180,
    (TaskType.IMAGE_TO_VIDEO,  Model.SEEDANCE_1_5, 5):  65,
    (TaskType.IMAGE_TO_VIDEO,  Model.KLING,        5):  40,
    (TaskType.VIDEO_REFERENCE, Model.KLING,        5):  40,
}


def estimate_points_offline(
    task_type: int,
    model: str,
    *,
    video_duration: int = 5,
    video_num: int = 1,
) -> int | None:
    """根据离线价格表估算积分。返回 None 表示不在表内（请用在线接口）。"""
    per = POINT_TABLE.get((task_type, model, video_duration))
    if per is None:
        return None
    return per * video_num


def validate_params(
    task_type: int,
    *,
    model: str | None = None,
    video_ratio: str | None = None,
    video_resolution: str | None = None,
    video_duration: int | None = None,
    video_num: int | None = None,
) -> list[str]:
    """根据静态能力矩阵做参数预检查，返回错误信息列表（空 = 通过）。"""
    errors: list[str] = []
    info = CAPABILITY_MATRIX.get(task_type)
    if info is None:
        return [f"unknown task_type={task_type}"]

    def _check(field: str, value, allowed):
        if value is not None and allowed and value not in allowed:
            errors.append(
                f"{field}={value!r} not in {allowed} for task_type={task_type}"
            )

    _check("model", model, info.get("models"))
    _check("video_ratio", video_ratio, info.get("ratios"))
    _check("video_resolution", video_resolution, info.get("resolutions"))
    _check("video_duration", video_duration, info.get("durations"))
    _check("video_num", video_num, info.get("video_nums"))
    return errors
