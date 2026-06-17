"""最简快速上手：用已有 credentials.json 跑一个图生视频任务。

运行:
    python -m wizstar.examples.quickstart ./credentials.json ./pic.jpg
"""

import json
import sys

from wizstar import Model, Ratio, WizstarClient, WizstarCredentials


def main() -> None:
    if len(sys.argv) < 3:
        print("用法: python -m wizstar.examples.quickstart <credentials.json> <image>")
        sys.exit(1)

    creds = WizstarCredentials.from_dict(json.load(open(sys.argv[1], encoding="utf-8")))
    image_path = sys.argv[2]

    client = WizstarClient(creds)

    print("[1/4] warm-up session...")
    client._warm_up_session()

    print(f"[2/4] upload {image_path}...")
    pic_url = client.upload_image(image_path)
    print(f"  pic_url={pic_url}")

    print("[3/4] create image_to_video task (kling, 5s, 9:16) ...")
    task = client.create_image_to_video(
        pic_url=pic_url,
        prompt="Cinematic warm soft light, gentle camera push-in",
        model=Model.KLING,
        video_ratio=Ratio.PORTRAIT,
        video_duration=5,
        video_num=1,
    )
    print(f"  task_id={task['task_id']}")

    print("[4/4] polling...")
    result = client.poll_task(task["task_id"], max_wait=600, interval=15)
    print(f"\n  video_url: {result.get('video_url')}")
    print(f"  cover_url: {result.get('cover_url')}")


if __name__ == "__main__":
    main()
