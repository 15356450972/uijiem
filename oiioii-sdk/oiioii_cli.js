#!/usr/bin/env node
/**
 * OiiOii.ai SDK 命令行工具
 *
 * 子命令：
 *   register              全自动注册（临时邮箱 + 验证码破解 + 邮箱验证），凭证写入账号文件
 *   login                 登录并缓存 Token 到账号文件
 *   points                查询积分余额
 *   signin                每日签到领积分
 *   pricing               查询所有模型定价
 *   models                列出内置模型别名
 *   image                 生成图片（提交 + 轮询 + 下载）
 *   video                 生成视频（提交 + 轮询 + 下载）
 *   upload                上传参考图，返回 hogi:// URI
 *   download              下载 hogi:// / CDN / URL 资源到本地
 *
 * 通用选项：
 *   --email, --password   账号凭证（未提供时读取账号文件）
 *   --token               直接提供 JWT（跳过登录）
 *   --account=<file>      账号文件路径（默认 ./oiioii_account.json）
 *   --no-account          不读写账号文件
 *   --no-proxy            直连，不走本地代理
 *   --proxy=host:port     指定本地代理（默认 127.0.0.1:7890）
 *   --mail-provider=<name> 注册邮箱来源：gptmail 或 10minutemail
 *   --output=<dir>        下载目录（默认 ./downloads）
 *   --debug               输出调试信息
 *
 * 示例：
 *   node oiioii_cli.js register
 *   node oiioii_cli.js login --email=a@b.com --password=xxx
 *   node oiioii_cli.js points
 *   node oiioii_cli.js image --prompt="一只在草地奔跑的柴犬" --model=nano-pro --download
 *   node oiioii_cli.js video --prompt="城市夜景延时" --model=gemini --duration=8 --download
 *   node oiioii_cli.js download hogi://video/xxx.mp4
 */

const path = require('path');
const { OiiOiiClient } = require('./oiioii_sdk');

// ---------------------------------------------------------------------------
// 参数解析：支持 --key=value、--key value、--flag、位置参数
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok.startsWith('--')) {
      const body = tok.slice(2);
      const eq = body.indexOf('=');
      if (eq !== -1) {
        args[body.slice(0, eq)] = body.slice(eq + 1);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        args[body] = argv[++i];
      } else {
        args[body] = true;
      }
    } else {
      args._.push(tok);
    }
  }
  return args;
}

function bool(v, def = false) {
  if (v === undefined) return def;
  if (typeof v === 'boolean') return v;
  return !/^(false|0|no|off)$/i.test(String(v));
}

// 从参数构造 client（统一处理代理 / 账号文件 / 凭证）
function buildClient(args) {
  let proxy;
  if (args.proxy && typeof args.proxy === 'string') {
    const [host, port] = args.proxy.split(':');
    proxy = { host, port: parseInt(port) || 7890 };
  }

  const accountFile = args.account ? path.resolve(args.account) : undefined;
  const useAccount = !(args['no-account'] || args.noaccount);

  const client = new OiiOiiClient({
    email: args.email,
    password: args.password,
    token: args.token,
    workspaceId: args.workspace,
    useProxy: !(args['no-proxy'] || args.noproxy),
    proxy,
    outputDir: args.output || './downloads',
    debug: bool(args.debug)
  });

  if (useAccount) {
    client._accountFile = accountFile;
    try { client.loadAccount(accountFile); } catch (e) { /* 文件不存在或损坏则忽略 */ }
  } else {
    client._accountFile = null;
  }
  return client;
}

function persist(client) {
  if (client._accountFile === null) return;
  try { client.saveAccount(client._accountFile); } catch (e) { /* 忽略写入失败 */ }
}

// 需要登录态的命令：确保有 token
async function ensureAuth(client) {
  if (client.token) return;
  if (!client.email || !client.password) {
    throw new Error('缺少登录态：请先 `register` / `login`，或传入 --token / --email --password');
  }
  await client.login();
  persist(client);
}

function out(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

// ---------------------------------------------------------------------------
// 子命令实现
// ---------------------------------------------------------------------------
const commands = {
  async register(client, args) {
    const res = await client.register({
      email: args.email,
      password: args.password,
      inviteCode: args.invite || '',
      language: args.lang || 'zh',
      mailProvider: args['mail-provider'] || args.mailProvider || args.mail_provider,
      maxWait: args.maxWait ? parseInt(args.maxWait) : undefined
    });
    persist(client);
    console.log('\n注册成功，凭证已保存。');
    out(res);
  },

  async login(client, args) {
    await client.login({ force: bool(args.force) });
    persist(client);
    console.log('\n登录成功，Token 已缓存。');
    out({ email: client.email, token: client.token.slice(0, 24) + '...' });
  },

  async points(client) {
    await ensureAuth(client);
    const p = await client.getPoints();
    out(p);
  },

  async signin(client) {
    await ensureAuth(client);
    const r = await client.signIn();
    out(r);
  },

  async pricing(client) {
    await ensureAuth(client);
    const models = await client.getModelPricings();
    out(models);
  },

  async models() {
    out(OiiOiiClient.listModels());
  },

  async upload(client, args) {
    await ensureAuth(client);
    const file = args.file || args._[1];
    if (!file) throw new Error('用法: upload <图片路径> 或 --file=<路径>');
    const uri = await client.uploadImage(file);
    out({ uri, cdnUrl: client.hogiToUrl(uri) });
  },

  async image(client, args) {
    await ensureAuth(client);
    const refs = args.ref ? String(args.ref).split(',').map(s => s.trim()).filter(Boolean) : [];
    const res = await client.generateImage({
      prompt: args.prompt,
      model: args.model,
      aspectRatio: args.ratio || args.aspectRatio,
      resolution: args.resolution,
      referenceImages: refs,
      styleUri: args.style,
      download: bool(args.download),
      filename: args.filename,
      outputDir: args.output,
      maxWait: args.maxWait ? parseInt(args.maxWait) : undefined
    });
    out(res);
  },

  async video(client, args) {
    await ensureAuth(client);
    const refs = args.ref
      ? String(args.ref).split(',').map(s => s.trim()).filter(Boolean)
      : (args.image ? [args.image] : []);
    const res = await client.generateVideo({
      prompt: args.prompt,
      model: args.model,
      aspectRatio: args.ratio || args.aspectRatio,
      duration: args.duration ? parseInt(args.duration) : undefined,
      resolution: args.resolution,
      generateMode: args.generateMode || args.generate_mode || args['generate-mode'],
      referenceImages: refs,
      download: bool(args.download),
      filename: args.filename,
      outputDir: args.output,
      maxWait: args.maxWait ? parseInt(args.maxWait) : undefined
    });
    out(res);
  },

  async download(client, args) {
    const uri = args.uri || args._[1];
    if (!uri) throw new Error('用法: download <hogi://... | https://... > [--out=<路径>]');
    // hogi:// 通过鉴权接口下载，需要 token；CDN/直链则不需要
    if (uri.startsWith('hogi://')) await ensureAuth(client);
    const dest = args.out ? path.resolve(args.out) : undefined;
    const r = await client.download(uri, dest);
    console.log(`下载完成: ${r.path} (${(r.size / 1024 / 1024).toFixed(2)} MB)`);
    out(r);
  }
};

const HELP = `OiiOii.ai SDK CLI

用法: node oiioii_cli.js <command> [options]

命令:
  register            全自动注册（临时邮箱 + 验证码 + 邮箱验证）
  login               登录并缓存 Token
  points              查询积分余额
  signin              每日签到领积分
  pricing             查询所有模型定价
  models              列出内置模型别名
  upload <img>        上传参考图，返回 hogi:// URI
  image               生成图片
  video               生成视频
  download <uri>      下载资源到本地

通用选项:
  --email --password  账号凭证（缺省读取账号文件）
  --token             直接提供 JWT
  --account=<file>    账号文件（默认 ./oiioii_account.json）
  --no-account        不读写账号文件
  --no-proxy          直连不走代理
  --proxy=host:port   指定本地代理（默认 127.0.0.1:7890）
  --output=<dir>      下载目录（默认 ./downloads）
  --debug             调试输出

生成选项:
  --prompt="..."      提示词
  --model=<别名>      模型（见 models 命令）
  --ratio=16:9        画面比例
  --resolution=2K     图片 1K/2K/4K，视频 720p/1080p/4K
  --duration=8        视频时长秒数
  --ref=uri1,uri2     参考图（hogi:// 或本地路径，自动上传）
  --image=<path>      视频单参考图（等价 --ref）
  --download          生成后自动下载
  --filename=<name>   下载文件名

示例:
  node oiioii_cli.js register
  node oiioii_cli.js points
  node oiioii_cli.js image --prompt="草地上的柴犬" --model=nano-pro --download
  node oiioii_cli.js video --prompt="城市夜景延时" --model=gemini --duration=8 --download
  node oiioii_cli.js download hogi://video/xxx.mp4 --out=./out.mp4
`;

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const cmd = args._[0];

  if (!cmd || args.help || cmd === 'help') {
    console.log(HELP);
    process.exit(cmd && cmd !== 'help' ? 1 : 0);
  }

  const handler = commands[cmd];
  if (!handler) {
    console.error(`未知命令: ${cmd}\n`);
    console.log(HELP);
    process.exit(1);
  }

  const client = buildClient(args);
  try {
    await handler(client, args);
    process.exit(0);
  } catch (err) {
    console.error(`\n[失败] ${err.message}`);
    if (bool(args.debug) && err.stack) console.error(err.stack);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { parseArgs, buildClient, commands };
