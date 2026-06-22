# OiiOii.ai SDK

完整封装 OiiOii.ai 的核心能力：**注册、生成图片、生成视频、查询积分、下载**。
提供一个可编程的 `OiiOiiClient` 类（`oiioii_sdk.js`）和一个命令行工具（`oiioii_cli.js`）。

## 能力一览

| 能力 | 方法 | CLI 命令 | 说明 |
|------|------|----------|------|
| 注册 | `register()` | `register` | 临时邮箱 + TCaptcha 破解 + 邮箱验证，全自动 |
| 登录 | `login()` | `login` | 账号密码登录获取 JWT Token（自动破解验证码） |
| 查询积分 | `getPoints()` | `points` | 余额、限时/永久积分、今日是否签到 |
| 每日签到 | `signIn()` | `signin` | 领取签到积分 |
| 积分规则 | `getPointsConfig()` | — | 各类积分获取/消耗规则 |
| 模型定价 | `getModelPricings()` | `pricing` | 所有图片/视频模型与价格 |
| 上传参考图 | `uploadImage()` | `upload` | 返回 `hogi://` URI |
| 生成图片 | `generateImage()` | `image` | 提交 + 轮询 + 可选下载 |
| 生成视频 | `generateVideo()` | `video` | 提交 + 轮询 + 可选下载 |
| 下载 | `download()` | `download` | 支持 `hogi://` / CDN / 完整 URL |

## 运行要求

- Node.js >= 16
- 默认通过本地代理 `127.0.0.1:7890`（新加坡出口）访问 API；如本机直连可用，加 `--no-proxy`
- 注册功能依赖同目录的 `tcaptcha_crack.js`（验证码破解）与 `gptmail.js`（临时邮箱）

安装依赖：

```bash
npm install
```

## 快速开始（CLI）

```bash
# 1. 全自动注册，凭证写入 ./oiioii_account.json
node oiioii_cli.js register

# 2. 查询积分（自动复用账号文件里的 Token）
node oiioii_cli.js points

# 3. 每日签到
node oiioii_cli.js signin

# 4. 生成图片并下载
node oiioii_cli.js image --prompt="草地上奔跑的柴犬，电影感" --model=nano-pro --download

# 5. 生成视频并下载
node oiioii_cli.js video --prompt="城市夜景延时摄影" --model=gemini --duration=8 --download

# 6. 单独下载某个资源
node oiioii_cli.js download hogi://video/xxx.mp4 --out=./out.mp4
```

已有账号时跳过注册，直接登录：

```bash
node oiioii_cli.js login --email=you@example.com --password=yourpass
```

或在任意命令上直接带 Token：

```bash
node oiioii_cli.js points --token=eyJhbGciOi...
```

### 通用选项

| 选项 | 说明 |
|------|------|
| `--email` / `--password` | 账号凭证（缺省时读取账号文件） |
| `--token` | 直接提供 JWT，跳过登录 |
| `--account=<file>` | 账号文件路径（默认 `./oiioii_account.json`） |
| `--no-account` | 不读写账号文件 |
| `--no-proxy` | 直连，不走本地代理 |
| `--proxy=host:port` | 指定本地代理（默认 `127.0.0.1:7890`） |
| `--output=<dir>` | 下载目录（默认 `./downloads`） |
| `--debug` | 输出调试信息 |

### 生成选项（image / video 通用）

| 选项 | 说明 |
|------|------|
| `--prompt="..."` | 提示词 |
| `--model=<别名>` | 模型别名，见下表或 `node oiioii_cli.js models` |
| `--ratio=16:9` | 画面比例 |
| `--resolution=2K` | 图片 `1K/2K/3K/4K`；视频 `720p/1080p/4K` |
| `--duration=8` | 视频时长（秒） |
| `--ref=a,b` | 参考图，逗号分隔，支持 `hogi://` 或本地路径（自动上传） |
| `--image=<path>` | 视频单参考图（等价 `--ref`） |
| `--download` | 生成完成后自动下载 |
| `--filename=<name>` | 指定下载文件名 |

### 模型别名

图片：`gpt-image2`、`nano-pro`、`nano2`、`seedream5`、`seedream45`、`midjourney`、`novelai`、`gpt4o`

视频：`gemini`、`seedance-pro`、`seedance-fast`、`sora2`、`happyhorse`、`vidu`、`wan`、`grok`

## 作为模块引用

```js
const { OiiOiiClient } = require('./oiioii_sdk');

(async () => {
  // 方式 A：注册新账号
  const client = new OiiOiiClient({ debug: true });
  await client.register();           // 临时邮箱 + 验证码 + 邮箱验证
  client.saveAccount();              // 写入 ./oiioii_account.json

  // 方式 B：用已有账号登录
  // const client = new OiiOiiClient({ email, password });
  // await client.login();

  // 方式 C：从账号文件恢复
  // const client = OiiOiiClient.fromAccount();
  // await client.login();           // 若 token 已存在会自动跳过

  // 查询积分 + 签到
  console.log(await client.getPoints());
  await client.signIn();

  // 生成图片
  const img = await client.generateImage({
    prompt: '一只在草地上奔跑的柴犬，电影感',
    model: 'nano-pro',
    aspectRatio: '16:9',
    resolution: '2K',
    download: true
  });
  console.log('图片:', img.cdnUrl, '->', img.localPath);

  // 生成视频（带参考图，自动上传本地图片）
  const video = await client.generateVideo({
    prompt: '镜头缓缓推进，电影质感',
    model: 'gemini',
    duration: 8,
    referenceImages: ['./ref.jpg'],
    download: true
  });
  console.log('视频:', video.cdnUrl, '->', video.localPath);

  // 单独下载
  await client.download('hogi://video/xxx.mp4', './out.mp4');
})();
```

### `OiiOiiClient` 构造选项

```js
new OiiOiiClient({
  email, password, token,   // 凭证（任选其一组合）
  workspaceId,              // 复用已有 workspace（不传则自动创建）
  useProxy: true,           // 是否走本地代理
  proxy: { host: '127.0.0.1', port: 7890 },
  outputDir: './downloads', // 下载目录
  debug: false,
  logger: console.log       // 自定义日志函数
});
```

### 生成结果结构

```js
{
  success: true,
  taskId: 'video_generate_...',
  outputUri: 'hogi://video/xxx.mp4',
  cdnUrl: 'https://static-oiioii-sg.hogiai.cn/video/xxx.mp4',
  downloadUrl: 'https://api-qc.oiioii.ai/res/read_file?uri=...',
  localPath: './downloads/xxx.mp4', // 仅 download:true 时
  fileSize: 8560514,                // 字节
  task: { /* 原始任务对象 */ }
}
```

## API 流程说明

| 步骤 | 方法 | 路径 |
|------|------|------|
| 验证码配置 | POST | `/auth/tencent_captcha_config` |
| 注册/登录 | POST | `/auth/signin_with_password` |
| 积分余额 | POST | `/points/current_user_points` |
| 签到 | POST | `/points/add` |
| 模型定价 | POST | `/points/mcp_model_pricings` |
| 创建工作区 | POST | `/workspace/create_workspace` |
| 检查上传 | POST | `/res/check_upload_file` |
| 上传文件 | POST | `/res/upload_file` |
| 提交图片任务 | POST | `/media/generate_image_asset/submit` |
| 提交视频任务 | POST | `/media/generate_video_asset/submit` |
| 轮询任务 | GET | `/media/canvas_async_tasks/sync?workspaceId=...` |
| 下载文件 | GET | `/res/read_file?uri=...` |
| 文件元数据 | GET | `/res/file_meta?uri=...` |

## 注意事项

- 注册依赖临时邮箱 `mail.chatgpt.org.uk` 与腾讯 TCaptcha 破解模块，网络/出口 IP 不稳定时可能失败，可重试。
- 积分消耗：图片约 7 分，视频约 5-25 分（随模型/分辨率/时长变化，详见 `pricing`）。
- `hogi://` 资源下载需登录态；CDN 直链与普通 URL 无需鉴权。
- 同一账号的请求建议使用同一出口 IP（代理 keepAlive 已保证）。
