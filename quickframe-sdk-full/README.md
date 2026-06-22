# QuickFrame AI SDK（完整版）

全自动注册 + 视频生成 + 无水印下载，纯 Python，零浏览器依赖。

## 目录结构

```
quickframe-sdk-full/
├── quickframe/              # SDK 核心包
│   ├── __init__.py
│   ├── constants.py         # API 端点、Auth0 配置、默认参数
│   ├── exceptions.py        # 自定义异常
│   ├── models.py            # 数据模型（Asset, Session, GenerationJob, GenerationResult）
│   ├── auth.py              # Auth0 认证（密码/passwordless 备用路径）
│   └── client.py            # 主客户端（上传、生成、轮询、下载）
├── chain_proxy.py           # 链式旋转代理模块（Clash → ipwo → 目标）
├── gptmail_getcode.py       # GPTMail 临时邮箱收码模块
├── register_full.py         # 单条全自动注册（YesCaptcha + Auth0 表单流 + GPTMail）
├── register_concurrent.py   # N 并发注册
├── examples/
│   ├── 01_generate_with_token.py    # 已有 token 直接生成
│   ├── 02_register_and_generate.py  # 注册 + 生成
│   ├── 03_step_by_step.py           # 分步调用
│   └── e2e_generate_test.py         # 端到端测试（注册账号 → 生成 → 下载）
├── tests/
│   ├── tests_offline_parse.py       # 离线数据模型解析测试
│   ├── integration_test.py          # 集成测试
│   └── live_token_test.py           # 在线 token 验证测试
├── requirements.txt
├── setup.py
└── README.md
```

## 环境要求

- Python 3.9+
- 本地代理（Clash/V2Ray 等，监听 `127.0.0.1:7890`，用于出口到美国）
- ipwo 旋转代理账号（已内置：`mengjun66_custom_zone_US`）
- YesCaptcha 账号（clientKey 存入 `_yescap_key.txt`）

## 安装

```bash
pip install requests
```

## 快速开始

### 1. 全自动注册单个账号

```bash
# 设置 YesCaptcha key
echo "你的clientKey" > _yescap_key.txt

# 开代理注册（每个账号走独立美国出口 IP）
QF_USE_PROXY=1 python register_full.py
```

输出：邮箱、cs_session、Bearer（24h 有效）。

### 2. 5 并发注册

```bash
QF_USE_PROXY=1 python register_concurrent.py 5
```

结果存入 `_concurrent_accounts.json`。

### 3. 用注册的账号生成视频

```python
import json
from quickframe.client import QuickFrameClient

accounts = json.load(open("_concurrent_accounts.json"))
bearer = accounts[0]["bearer"]

client = QuickFrameClient(access_token=bearer)
# 注意：代理注册的账号必须走代理调用
client.http.proxies = {"https": "http://127.0.0.1:7890"}

result = client.generate_video_from_image(
    image_path="your_image.png",
    prompt="[Image 1] 根据图片生成视频",
    download_to="output.mp4",
)
print(f"视频已下载: {result.local_path}")
```

### 4. 刷新过期 Bearer（用 cs_session）

```python
import json, urllib.request
import chain_proxy, http.cookiejar

cs = accounts[0]["cs_session"]
jar = http.cookiejar.CookieJar()
opener = chain_proxy.build_chain_opener(
    extra_handlers=[urllib.request.HTTPCookieProcessor(jar)])

body = json.dumps({"audience": "https://ai.quickframe.com",
                   "scope": "openid profile email"}).encode()
req = urllib.request.Request(
    "https://server.cs.quickframe.com/token", data=body,
    headers={"Content-Type": "application/json",
             "Cookie": f"cs_session={cs}"}, method="POST")
with opener.open(req, timeout=40) as r:
    new_bearer = json.loads(r.read().decode())["accessToken"]
```

## 核心架构（逆向还原）

```
注册流程：
  /auth/login → Auth0 Universal Login（Cloudflare Turnstile）
  → YesCaptcha 解 Turnstile token → 提交邮箱（发码）
  → GPTMail 收验证码 → 提交验证码
  → /authorize/resume → /auth/callback → cs_session cookie
  → POST /token → Bearer JWT（24h 有效）

视频生成流程：
  Bearer → getDirectUploadSignature → Cloudinary 直传图片
  → registerDirectUpload → createProjectFromGeneration
  → generateSeedanceVideoForEditor → 轮询 listRecent
  → getAssetsByIds → Cloudinary 原始链接（无水印）下载
```

## 关键发现（逆向过程中验证）

| 发现 | 证据 |
|------|------|
| Auth0 `/passwordless/start` 纯 API 调用被 bot 检测拦截 | `401 requires_verification` |
| Auth0 OTP grant 未授权 | `403 unauthorized_client` |
| 登录页内嵌 Cloudflare Turnstile（`auth0_v2`） | sitekey `0x4AAAAAACwSuI5jPtwnNwc5` |
| YesCaptcha 解出的 token 被 Auth0 接受 | 302 → challenge 页 |
| cs_session 绑定签发时的出口 IP 区域 | 跨区域刷 token 返回 403 |
| 同 IP 5 并发触发 429 限流 | 加旋转代理后 5/5 成功 |
| Bearer 调用 tRPC 也需要同区域 IP | 跨区域调用返回 403 |

## 费用参考

- YesCaptcha Turnstile：25 points/次（约 ¥0.025/次）
- ipwo 旋转代理：按流量计费
- GPTMail：免费

## 注意事项

- 批量注册可能违反 QuickFrame 服务条款
- Bearer 有效期 24h，过期用 cs_session 刷新（cs_session 有效期约 30 天）
- 代理注册的账号，后续所有 API 调用都必须走代理（同区域）
- GPTMail 部分域名偶发不投递，重试即可
