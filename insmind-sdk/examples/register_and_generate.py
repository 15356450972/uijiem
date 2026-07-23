#!/usr/bin/env python3
"""注册账号 → 绑租户 → 上传 → 提交 omni 生成。"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from insmind import InsMindClient, register_account  # noqa: E402


def main() -> None:
    image = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/insmind_ref1.png")
    if not image.is_file():
        raise SystemExit(f"image not found: {image}")

    acc = register_account(bind_tenant=True)
    Path("/tmp/insmind_account.json").write_text(
        json.dumps(acc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print("registered:", acc["email"], "org:", acc.get("org_id"))

    client = InsMindClient(
        acc["access_token"],
        cookie=acc.get("cookie"),
        auto_ensure_tenant=True,
    )
    up = client.upload_file(image)
    print("uploaded:", up["url"])

    result = client.generate_omni(
        prompt=f"[image1] gentle camera push-in, soft cinematic light",
        image_urls=[up["url"]],
        resolution="480P",
        duration="15",
        wait=False,
    )
    print(json.dumps({"task_id": result["task_id"], "content_id": result["content_id"]}, indent=2))


if __name__ == "__main__":
    main()
