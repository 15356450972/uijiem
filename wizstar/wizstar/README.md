# Wizstar SDK

纯协议实现的 wizstar.com 全自动 SDK：注册 → 上传图 → 生成视频 → 轮询拿结果，全程不依赖浏览器。

## 安装

```bash
pip install -r requirements.txt
```

依赖只有两个：`requests` + `pycryptodome`。

## 包结构

```
wizstar/
├── __init__.py        公开 API
├── __main__.py        python -m wizstar 命令行入口
├── enums.py           TaskType / Model / Ratio / Resolution
├── capabilities.py    能力矩阵 + 离线积分价格表 + 参数校验
├── crypto.py          注册接口的 RSA-OAEP(SHA-256) 加密
├── mailbox.py         OutlookMailbox（OAuth2 + IMAP 自动取验证码）
├── client.py          WizstarClient 主体（注册/上传/创建/轮询）
├── demo.py            end_to_end_demo 端到端流程
├── requirements.txt
└── examples/
    ├── quickstart.py        最简单：用已有凭证跑图生视频
    ├── existing_account.py  从 credentials.json 加载账号
    └── text_to_video.py     文生视频示例
```

## 模型与价格（实测）

来源：`/wizstar/tools/common/tags` + `/wizstar/tools/common/point`

| task_type | model | 5s 单价 | 10s 单价 | 备注 |
|---|---|---|---|---|
| 1 文生 | seedance2.0 | 90 pts | 180 pts | 默认 |
| 1 文生 | seedance1.5 | 65 pts | – | |
| 1 文生 | kling | 40 pts | – | 最便宜 |
| 2 图生 | seedance2.0 | 90 pts | 180 pts | 默认 |
| 2 图生 | seedance1.5 | 65 pts | – | |
| 2 图生 | kling | 40 pts | – | 最便宜 |
| 3 视频参考 | kling | 40 pts | – | 仅 kling |

总价 = 单价 × `video_num`（最多 4 个），其它任务类型可调用 `client.estimate_points()` 在线估算。

## 命令行（一键端到端）

```bash
python -m wizstar <email> <password> <client_id> <refresh_token> <image_path> \
    --model seedance2.0 \
    --ratio 9:16 \
    --duration 5 \
    --num 1 \
    --prompt "Cinematic warm soft light, gentle camera push-in"
```

参数说明：

- `--model` 三选一：`seedance2.0` / `seedance1.5` / `kling`
- `--ratio` 二选一：`9:16` / `16:9`
- `--duration` 二选一：`5` / `10`
- `--num` 一次生成几个视频：`1` ~ `4`

跑完以后会在当前目录生成 `credentials.json`（包含 `osduss` + `passOsRefreshTk`，下次复用账号直接 load 即可）。

## 作为库使用

### 1) 已有账号，跑图生视频

```python
import json
from wizstar import WizstarClient, WizstarCredentials, Model, Ratio

creds = WizstarCredentials.from_dict(json.load(open("credentials.json")))
client = WizstarClient(creds)

pic_url = client.upload_image("./pic.jpg")
task = client.create_image_to_video(
    pic_url=pic_url,
    prompt="Cinematic warm soft light, gentle camera push-in",
    model=Model.KLING,
    video_ratio=Ratio.PORTRAIT,
    video_duration=5,
    video_num=1,
)
result = client.poll_task(task["task_id"])
print(result["video_url"])
```

### 2) 全新账号，一键端到端

```python
from wizstar import end_to_end_demo, Model

result = end_to_end_demo(
    email="xxx@outlook.com",
    password="xxxxx",
    client_id="9e5f94bc-e8a4-4e73-b8be-63364c29d753",
    refresh_token="M.C5xx_xxxxx",
    image_path="./pic.jpg",
    prompt="Cinematic warm soft light, gentle camera push-in",
    model=Model.KLING,
    video_duration=5,
)
print(result["result"]["video_url"])
```

### 3) 文生视频

```python
from wizstar import WizstarClient, WizstarCredentials, Model
import json

creds = WizstarCredentials.from_dict(json.load(open("credentials.json")))
client = WizstarClient(creds)

task = client.create_text_to_video(
    prompt="A red panda walking through a snowy forest at golden hour, cinematic",
    model=Model.SEEDANCE_2_0,
    video_duration=5,
)
result = client.poll_task(task["task_id"])
print(result["video_url"])
```

### 4) 视频参考（视频转视频，目前仅 kling）

```python
client.create_video_reference(
    video_url="https://.../source.mp4",
    prompt="Same scene, but in cyberpunk neon style",
)
```

### 5) 通用入口（任意 task_type）

```python
client.create_task(
    task_type=2,
    prompt="...",
    model="seedance2.0",
    params={"pic_url": "https://..."},
    extra={"subtitle_on": 2},
)
```

## 在线能力 / 估算

```python
client.get_tags(task_type=2)            # 单类型动态能力
client.get_all_tags()                   # 全部 1-8 类型
client.estimate_points(task_type=2, model="seedance2.0",
                       video_duration=5, video_num=1, prompt="x",
                       params=json.dumps({"pic_url": "..."}))
client.points_balance()                 # 当前余额
```

## 认证机制说明

注册接口下发的关键字段：

| 字段 | 用途 |
|---|---|
| `osduss` | 主认证 cookie（必带）|
| `passOsRefreshTk` | refresh token cookie |
| `WIZSTARID` | 业务侧会话 cookie，**首次调 `/wizstar/user/info` 后才下发** |

`register_auto()` 会自动调用 `_warm_up_session()` 先 hit 一次 `user/info` 拿 `WIZSTARID`，否则后续 `upload/init`、`tools/create` 会报 `user not exists`。

## 任务类型清单

| task_type | 名称 | SDK 便捷方法 |
|---|---|---|
| 1 | Text-to-Video | `create_text_to_video()` |
| 2 | Image-to-Video | `create_image_to_video()` |
| 3 | Video-Reference | `create_video_reference()` |
| 4 | Product-Video | `create_task(task_type=4, ...)` |
| 5 | Translation / Lip-Sync | `create_task(task_type=5, ...)` |
| 6 | LipSync | `create_task(task_type=6, ...)` |
| 7 | Image-to-Digital-Human | `create_task(task_type=7, ...)` |
| 8 | Avatar-Video（1080P） | `create_task(task_type=8, ...)` |

未提供便捷方法的任务类型，先用 `client.get_tags(task_type=N)` 看清楚字段，再 `create_task(task_type=N, params={...}, extra={...})` 即可。

## 离线积分估算

```python
from wizstar import estimate_points_offline, TaskType, Model

estimate_points_offline(TaskType.IMAGE_TO_VIDEO, Model.SEEDANCE_2_0,
                       video_duration=10, video_num=2)   # -> 360
```

## 参数预校验

```python
from wizstar.capabilities import validate_params
from wizstar import TaskType, Model

errs = validate_params(
    TaskType.VIDEO_REFERENCE,
    model=Model.SEEDANCE_2_0,   # 错：task_type=3 只支持 kling
    video_duration=7,           # 错：只支持 5 或 10
)
print(errs)
```
