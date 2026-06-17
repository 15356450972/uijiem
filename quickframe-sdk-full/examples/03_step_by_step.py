"""示例 3：分步调用，便于理解每个 API 的输入输出。

适合想单独复用上传 / 生成 / 下载某一步的场景。
"""

import os
from quickframe import QuickFrameClient

ACCESS_TOKEN = os.getenv("QF_ACCESS_TOKEN", "<在此粘贴你的 access_token>")


def main() -> None:
    qf = QuickFrameClient(access_token=ACCESS_TOKEN)

    # 步骤 1：上传图片（取签名 -> Cloudinary -> 注册素材）
    asset = qf.upload_asset("storyboard.png", asset_type="image")
    print(f"[1] 上传完成 assetId={asset.asset_id} url={asset.cloudinary_url}")

    # 步骤 2：创建项目（一步式生成入口）
    project_id = qf.create_project_from_generation(
        prompt="根据分镜帮我生成视频",
        media_asset_ids=[asset.asset_id],
    )
    print(f"[2] 项目已创建 projectId={project_id}")

    # 步骤 3：编辑器内生成（确保图片进入 referenceImagesAssetIds）
    job = qf.generate_video(
        prompt="[Image 1]根据分镜帮我生成视频",
        project_id=project_id,
        reference_image_asset_ids=[asset.asset_id],
        aspect_ratio="16:9",
        duration=15,
    )
    print(f"[3] 任务已提交 jobId={job.job_id}")

    # 步骤 4：轮询直到完成
    result = qf.wait_for_generation(job)
    print(f"[4] 生成完成 video_url={result.video_url}")

    # 步骤 5：无水印下载
    path = qf.download_video(result.video_url, "output/generated_video.mp4")
    print(f"[5] 已下载到 {path}")


if __name__ == "__main__":
    main()
