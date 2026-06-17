"""任务类型 / 模型 / 比例 / 分辨率 常量

来源：实测 https://wizstar.com/wizstar/tools/common/tags?task_type=N
"""


class TaskType:
    """wizstar 平台支持的任务类型常量"""

    TEXT_TO_VIDEO = 1            # 文生视频
    IMAGE_TO_VIDEO = 2           # 图生视频
    VIDEO_REFERENCE = 3          # 视频参考（仅 kling）
    PRODUCT_VIDEO = 4            # 商品视频（带电商类目/区域/币种）
    TRANSLATION = 5              # 视频翻译 / 唇形同步
    LIPSYNC = 6                  # LipSync
    DIGITAL_HUMAN = 7            # 图生数字人
    AVATAR_VIDEO = 8             # Avatar 视频（1080P）


class Model:
    """视频生成模型常量"""

    SEEDANCE_2_0 = "seedance2.0"     # 默认，最贵：18 pts/秒/视频
    SEEDANCE_1_5 = "seedance1.5"     # 13 pts/秒/视频
    KLING = "kling"                  # 最便宜：8 pts/秒/视频


class Ratio:
    """视频比例常量"""

    PORTRAIT = "9:16"   # 默认（竖版）
    LANDSCAPE = "16:9"


class Resolution:
    """视频分辨率常量"""

    P720 = "720P"
    P1080 = "1080P"   # 仅 Avatar 视频（task_type=8）
