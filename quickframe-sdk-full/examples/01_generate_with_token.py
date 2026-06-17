"""示例 1（推荐）：使用已有 access_token 完成端到端生成。

如何获取 token：
1. 浏览器登录 https://ai.quickframe.com
2. 打开开发者工具 -> Network
3. 找任意一个发往 server.cs.quickframe.com 的请求
4. 复制请求头 Authorization: Bearer <token> 里的 token

运行：
    pip install -r ../requirements.txt
    set QF_ACCESS_TOKEN=eyJ...    (Windows)
    export QF_ACCESS_TOKEN=eyJ... (macOS/Linux)
    python 01_generate_with_token.py
"""

import os
from quickframe import QuickFrameClient

ACCESS_TOKEN = os.getenv("QF_ACCESS_TOKEN", "<在此粘贴你的 access_token>")


def main() -> None:
    qf = QuickFrameClient(access_token=ACCESS_TOKEN)

    # 校验 token
    session = qf.get_session()
    print(f"已登录: {session.email} (active={session.active})")

    # 端到端：上传分镜图 -> 生成视频 -> 等待 -> 无水印下载
    result = qf.generate_video_from_image(
        image_path="storyboard.png",
        prompt="根据分镜帮我生成视频",
        aspect_ratio="16:9",
        duration=15,
        generate_audio=True,
        download_to="output/generated_video.mp4",
    )

    print("生成完成!")
    print(f"  assetId : {result.asset_id}")
    print(f"  模型    : {result.model}")
    print(f"  分辨率  : {result.width}x{result.height}")
    print(f"  时长    : {result.duration}s")
    print(f"  无水印URL: {result.video_url}")
    print(f"  本地文件 : {result.local_path}")


if __name__ == "__main__":
    main()
