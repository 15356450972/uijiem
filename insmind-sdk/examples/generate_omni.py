#!/usr/bin/env python3
"""上传一张图并用 omni_reference 生成短视频。"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from insmind import InsMindClient  # noqa: E402


def main() -> None:
    token = (os.environ.get("INSMIND_TOKEN") or "").strip()
    if not token and len(sys.argv) > 1:
        token = sys.argv[1].strip()
    if not token:
        raise SystemExit("usage: INSMIND_TOKEN=... python examples/generate_omni.py [token]")

    image = Path(os.environ.get("INSMIND_IMAGE") or "/tmp/insmind_test.png")
    client = InsMindClient(token)
    print("repos:", client.list_repositories())
    uploaded = client.upload_file(image)
    print("uploaded:", uploaded["url"])
    result = client.generate_omni(
        prompt=f"[image1] A gentle camera push-in on the subject, cinematic lighting, 5 seconds",
        image_urls=[uploaded["url"]],
        resolution="480P",
        duration="5",
        ratio="original",
        wait=True,
    )
    out = {k: v for k, v in result.items() if k != "raw"}
    print(json.dumps(out, ensure_ascii=False, indent=2))
    Path("/tmp/insmind_generate_result.json").write_text(
        json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


if __name__ == "__main__":
    main()
