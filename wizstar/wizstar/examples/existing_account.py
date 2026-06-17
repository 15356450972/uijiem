"""演示如何从 credentials.json 复用已注册账号，并一次性生成 4 个视频。"""

import json

from wizstar import Model, Ratio, WizstarClient, WizstarCredentials


def run(credentials_file: str, image_path: str) -> None:
    creds = WizstarCredentials.from_dict(json.load(open(credentials_file, encoding="utf-8")))
    client = WizstarClient(creds)

    info = client.user_info()
    balance = client.points_balance()
    print(f"user: {info.get('data', {}).get('email')}  balance: {balance.get('data')}")

    pic_url = client.upload_image(image_path)
    print(f"pic_url={pic_url}")

    task = client.create_image_to_video(
        pic_url=pic_url,
        prompt="Cinematic warm soft light, gentle camera push-in",
        model=Model.SEEDANCE_2_0,
        video_ratio=Ratio.PORTRAIT,
        video_duration=5,
        video_num=4,
    )
    print(f"task_id={task['task_id']}")

    final = client.poll_task(task["task_id"], max_wait=900, interval=15)
    print(f"video_url={final.get('video_url')}")


if __name__ == "__main__":
    import sys

    if len(sys.argv) < 3:
        print("用法: python -m wizstar.examples.existing_account <credentials.json> <image>")
        sys.exit(1)
    run(sys.argv[1], sys.argv[2])
