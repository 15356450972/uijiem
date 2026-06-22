"""端到端流程：注册 -> 上传图 -> 生成视频 -> 轮询 -> 拿到 video_url"""

import json

from .capabilities import estimate_points_offline
from .client import WizstarClient
from .enums import Model, Ratio, Resolution, TaskType
from .mailbox import OutlookMailbox


def end_to_end_demo(
    *,
    email: str,
    password: str,
    client_id: str,
    refresh_token: str,
    image_path: str,
    prompt: str,
    model: str = Model.SEEDANCE_2_0,
    video_ratio: str = Ratio.PORTRAIT,
    video_resolution: str = Resolution.P720,
    video_duration: int = 5,
    video_num: int = 1,
    output_creds_path: str = "credentials.json",
) -> dict:
    """注册 -> 上传 -> 生成视频 -> 轮询 -> 返回结果

    支持自定义模型、比例、分辨率、时长、数量等所有可调参数。
    """
    print("=" * 60)
    print("  Wizstar 端到端测试")
    print(
        f"  model={model} ratio={video_ratio} res={video_resolution} "
        f"duration={video_duration}s num={video_num}"
    )
    est = estimate_points_offline(
        TaskType.IMAGE_TO_VIDEO, model,
        video_duration=video_duration, video_num=video_num,
    )
    if est is not None:
        print(f"  estimated cost: {est} pts")
    print("=" * 60)

    mailbox = OutlookMailbox(email=email, client_id=client_id, refresh_token=refresh_token)
    client = WizstarClient()

    print("\n[1/5] 自动注册账号...")
    creds = client.register_auto(mailbox, password)
    with open(output_creds_path, "w", encoding="utf-8") as f:
        json.dump(creds.to_dict(), f, indent=2, ensure_ascii=False)
    print(f"  凭证已写入 {output_creds_path}")

    print("\n[2/5] 查询积分余额...")
    try:
        balance = client.points_balance()
        print(f"  balance: {balance}")
    except Exception as e:
        print(f"  (跳过) {e}")

    print(f"\n[3/5] 上传图片 {image_path}...")
    pic_url = client.upload_image(image_path)
    print(f"  pic_url: {pic_url}")

    print("\n[4/5] 创建图生视频任务...")
    task = client.create_image_to_video(
        pic_url=pic_url,
        prompt=prompt,
        model=model,
        video_ratio=video_ratio,
        video_resolution=video_resolution,
        video_duration=video_duration,
        video_num=video_num,
    )
    task_id = task["task_id"]
    print(f"  task_id: {task_id}")

    print("\n[5/5] 轮询任务结果...")
    final = client.poll_task(task_id, max_wait=600, interval=15)

    print("\n" + "=" * 60)
    print("  视频生成完成")
    print("=" * 60)
    print(f"  video_url: {final.get('video_url')}")
    print(f"  cover_url: {final.get('cover_url')}")
    print(
        f"  duration: {final.get('duration')}s  "
        f"size: {final.get('width')}x{final.get('height')}"
    )

    return {"credentials": creds.to_dict(), "task": task, "result": final}
