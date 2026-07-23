# insMind SDK

纯协议 Python SDK（零第三方依赖）：邮箱注册、个人租户绑定、DAM 上传、Seedance 生成。

## 目录

```
insmind-sdk/
├── README.md
├── pyproject.toml
├── examples/
│   ├── generate_omni.py
│   └── register_and_generate.py
└── insmind/
    ├── __init__.py
    ├── __main__.py
    ├── auth.py          # GPTMail + 验证码注册
    ├── tenant.py        # 个人组织创建 + org-bind
    ├── client.py        # 上传 / 生成 / 轮询
    ├── gptmail.py
    ├── captcha.py       # SVG→PNG→YesCaptcha
    ├── aws_sigv4.py     # OSS PutObject
    ├── http.py
    ├── constants.py
    └── cli.py
```

## 环境

- Python >= 3.9
- YesCaptcha key：环境变量 `YESCAP_KEY`，或旁路文件 `../quickframe-sdk-full/_yescap_key.txt`
- macOS 上图形验证码转 PNG 需要 Chrome 或 `qlmanage`

## 用法

```bash
cd insmind-sdk
export PYTHONPATH="$PWD"
# 可选：pip install -e .

# 注册（含租户绑定）
python3 -m insmind register --out /tmp/insmind_account.json

# 上传 + omni 生成（480P / 15s / 多参考）
export INSMIND_TOKEN="$(python3 -c "import json;print(json.load(open('/tmp/insmind_account.json'))['access_token'])")"
python3 -m insmind generate \
  --account /tmp/insmind_account.json \
  --ensure-tenant \
  --prompt 'gentle camera push-in' \
  --upload /path/to/a.png \
  --image 'https://already-uploaded.png' \
  --resolution 480P --duration 15
```

Python：

```python
from insmind import InsMindClient, register_account

acc = register_account(bind_tenant=True)  # 含 org-bind
client = InsMindClient(acc["access_token"], cookie=acc.get("cookie"), auto_ensure_tenant=True)

u1 = client.upload_file("a.png")
u2 = client.upload_file("b.png")
task = client.generate_omni(
    prompt="[image1][image2] cinematic camera move",
    image_urls=[u1["url"], u2["url"]],
    resolution="480P",
    duration="15",
    wait=True,
)
print(task["video_url"])
```

## 关键接口

| 步骤 | API |
|------|-----|
| 注册 | UMS `verify-code` + `oauth/tokens` |
| 建个人组织 | `POST /api/structure/company/personal/free` |
| 切组织 | `POST /actions/switch-org` |
| 绑租户 | `POST https://sso.insmind.com/api/token/org-bind` |
| 上传 | DAM `asset/id` → `upload/tokens` → OSS SigV4 PUT |
| 生成 | `POST /api/gdesign/tool/v1/dify/call_async` |
| 轮询 | `POST /api/gdesign/tool/v1/dify/process/batch` |

默认模型：`agent-Seedance-2-0-Mini`，模式：`omni_reference` / `start_end_frame`。
