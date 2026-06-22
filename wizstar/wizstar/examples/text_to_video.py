"""文生视频示例（task_type=1）。"""

import json
import sys

from wizstar import Model, Ratio, WizstarClient, WizstarCredentials


def main() -> None:
    if len(sys.argv) < 2:
        print("用法: python -m wizstar.examples.text_to_video <credentials.json> [prompt]")
        sys.exit(1)

    creds = WizstarCredentials.from_dict(json.load(open(sys.argv[1], encoding="utf-8")))
    prompt = sys.argv[2] if len(sys.argv) > 2 else (
        "A red panda walking through a snowy forest at golden hour, "
        "cinematic, soft volumetric light"
    )

    client = WizstarClient(creds)
    client._warm_up_session()

    task = client.create_text_to_video(
        prompt=prompt,
        model=Model.SEEDANCE_2_0,
        video_ratio=Ratio.PORTRAIT,
        video_duration=5,
        video_num=1,
    )
    print(f"task_id={task['task_id']}")

    result = client.poll_task(task["task_id"], max_wait=900, interval=15)
    print(f"video_url={result.get('video_url')}")


if __name__ == "__main__":
    main()
