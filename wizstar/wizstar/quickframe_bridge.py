"""QuickFrame 通道桥接层 — 把 quickframe-sdk-full 封装成可被本地服务调用的能力。

提供：
- 配置读写（YesCaptcha key、动态 IP / 链式旋转代理参数），存到本地 json。
- 临时邮箱（GPTMail）域名列表 + 邮箱自动生成。
- 全自动注册（单条 / 批量并发），复用 SDK 的 register_full.register_one。
- Bearer 刷新（用 cs_session 重新换 token）。
- 图生视频（QuickFrameClient），供内容创作的「渠道三」调用。

设计上与 pixmax.py 一致：环境变量 > 本地配置文件 > 默认值。
注册/生成依赖本机可用的 Clash + ipwo 代理与有余额的 YesCaptcha，
缺失时会在调用处抛出可读错误，由上层透传给前端。
"""

import json
import os
import random
import string
import sys
import threading
import time
import urllib.request
import urllib.parse
from pathlib import Path
from typing import Any, Dict, List, Optional
from .app_paths import get_wizstar_data_dir

# ---- 把 quickframe-sdk-full 放进 import 路径 ----
# 本文件位于 <repo>/wizstar/wizstar/quickframe_bridge.py
# SDK 位于    <repo>/quickframe-sdk-full/
_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.abspath(os.path.join(_HERE, "..", ".."))
_SDK_DIR = os.path.join(_REPO_ROOT, "quickframe-sdk-full")
if os.path.isdir(_SDK_DIR) and _SDK_DIR not in sys.path:
    sys.path.insert(0, _SDK_DIR)

# 设置界面保存的本地配置文件（与 wizstar.db / pixmax_config.json 同目录）。
CONFIG_PATH = os.path.join(get_wizstar_data_dir(), "quickframe_config.json")

# GPTMail 域名状态接口（用于临时邮箱选择 / 自动生成）。
_GPTMAIL_DOMAINS_URL = "https://mail.chatgpt.org.uk/api/domains/status"
_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"
)

# 代理默认值（与 SDK chain_proxy 内置一致），仅当配置缺省时兜底。
_PROXY_DEFAULTS = {
    "proxy_local_host": "127.0.0.1",
    "proxy_local_port": 7890,
    "proxy_remote_host": "us.ipwo.net",
    "proxy_remote_port": 7878,
    "proxy_user": "mengjun66_custom_zone_US",
    "proxy_pass": "mengjun66",
    # requests 走的本地代理（生成时用，需与注册同区域出口）
    "requests_proxy": "http://127.0.0.1:7890",
}


class QuickFrameError(RuntimeError):
    """QuickFrame 通道调用失败（注册 / 生成 / 配置）。"""


# ====================== 配置读写 ======================

def _load_config() -> dict:
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


def save_config(
    yescap_key: Optional[str] = None,
    use_proxy: Optional[bool] = None,
    proxy_local_host: Optional[str] = None,
    proxy_local_port: Optional[int] = None,
    proxy_remote_host: Optional[str] = None,
    proxy_remote_port: Optional[int] = None,
    proxy_user: Optional[str] = None,
    proxy_pass: Optional[str] = None,
    requests_proxy: Optional[str] = None,
) -> dict:
    """保存配置，仅更新传入的非 None 字段。"""
    config = _load_config()
    if yescap_key is not None:
        config["yescap_key"] = yescap_key.strip()
    if use_proxy is not None:
        config["use_proxy"] = bool(use_proxy)
    if proxy_local_host is not None:
        config["proxy_local_host"] = proxy_local_host.strip()
    if proxy_local_port is not None:
        config["proxy_local_port"] = int(proxy_local_port)
    if proxy_remote_host is not None:
        config["proxy_remote_host"] = proxy_remote_host.strip()
    if proxy_remote_port is not None:
        config["proxy_remote_port"] = int(proxy_remote_port)
    if proxy_user is not None:
        config["proxy_user"] = proxy_user.strip()
    if proxy_pass is not None:
        config["proxy_pass"] = proxy_pass.strip()
    if requests_proxy is not None:
        config["requests_proxy"] = requests_proxy.strip()
    Path(CONFIG_PATH).parent.mkdir(parents=True, exist_ok=True)
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(config, f, ensure_ascii=False, indent=2)
    return config


def get_yescap_key() -> str:
    """优先级：环境变量 > 本地配置 > SDK 的 _yescap_key.txt。"""
    env = os.environ.get("QF_YESCAP_KEY", "").strip()
    if env:
        return env
    saved = _load_config().get("yescap_key", "").strip()
    if saved:
        return saved
    key_file = os.path.join(_SDK_DIR, "_yescap_key.txt")
    if os.path.isfile(key_file):
        try:
            with open(key_file, encoding="utf-8") as f:
                return f.read().strip()
        except OSError:
            return ""
    return ""


def get_proxy_settings() -> dict:
    """合并默认值与本地配置，返回完整代理参数。"""
    cfg = _load_config()
    merged = dict(_PROXY_DEFAULTS)
    for k in _PROXY_DEFAULTS:
        if cfg.get(k) not in (None, ""):
            merged[k] = cfg[k]
    merged["use_proxy"] = bool(cfg.get("use_proxy", False))
    return merged


def config_status() -> dict:
    """供前端展示的配置状态（key 脱敏）。"""
    key = get_yescap_key()
    proxy = get_proxy_settings()
    return {
        "yescap_configured": bool(key),
        "yescap_key_masked": (key[:6] + "***" + key[-4:]) if len(key) > 12 else ("***" if key else ""),
        "use_proxy": proxy["use_proxy"],
        "proxy_local_host": proxy["proxy_local_host"],
        "proxy_local_port": proxy["proxy_local_port"],
        "proxy_remote_host": proxy["proxy_remote_host"],
        "proxy_remote_port": proxy["proxy_remote_port"],
        "proxy_user": proxy["proxy_user"],
        "requests_proxy": proxy["requests_proxy"],
        "sdk_available": os.path.isdir(_SDK_DIR),
    }


def test_proxy() -> dict:
    """测试动态 IP / 出口连通性，供注册前自检。

    返回结构（尽量不抛异常，把每段失败原因放进结果里）：
    {
      use_proxy, exit_ip, exit_country, exit_org,   # 出口 IP 信息
      authorize_status,                              # auth/login 探测到的 HTTP 状态
      authorize_ok,                                  # 是否拿到 state（200 且能解析）
      ok, message                                    # 总体是否可注册 + 人类可读说明
    }
    """
    proxy = get_proxy_settings()
    use_proxy = proxy["use_proxy"]
    result = {
        "use_proxy": use_proxy,
        "exit_ip": None,
        "exit_country": None,
        "exit_org": None,
        "authorize_status": None,
        "authorize_ok": False,
        "ok": False,
        "message": "",
    }

    # ---- 1) 查出口 IP ----
    try:
        if use_proxy:
            import chain_proxy  # type: ignore
            chain_proxy.LOCAL_HOST = proxy["proxy_local_host"]
            chain_proxy.LOCAL_PORT = int(proxy["proxy_local_port"])
            chain_proxy.REMOTE_HOST = proxy["proxy_remote_host"]
            chain_proxy.REMOTE_PORT = int(proxy["proxy_remote_port"])
            chain_proxy.PROXY_USER = proxy["proxy_user"]
            chain_proxy.PROXY_PASS = proxy["proxy_pass"]
            raw = chain_proxy.open_chain_socket("ipinfo.io", 443, timeout=30)
            import ssl as _ssl
            tls = _ssl.create_default_context().wrap_socket(raw, server_hostname="ipinfo.io")
            try:
                tls.sendall(b"GET /json HTTP/1.1\r\nHost: ipinfo.io\r\n"
                            b"User-Agent: curl/8.0\r\nAccept: */*\r\nConnection: close\r\n\r\n")
                buf = b""
                while True:
                    try:
                        c = tls.recv(4096)
                    except Exception:
                        break
                    if not c:
                        break
                    buf += c
            finally:
                tls.close()
            text = buf.decode("utf-8", "ignore")
            body = text.split("\r\n\r\n", 1)[1] if "\r\n\r\n" in text else text
            s, e = body.find("{"), body.rfind("}")
            info = json.loads(body[s:e + 1]) if s >= 0 else {}
        else:
            opener = urllib.request.build_opener()
            req = urllib.request.Request("https://ipinfo.io/json", headers={"User-Agent": "curl/8.0"})
            with opener.open(req, timeout=30) as r:
                info = json.loads(r.read().decode())
        result["exit_ip"] = info.get("ip")
        result["exit_country"] = info.get("country")
        result["exit_org"] = info.get("org")
    except Exception as e:  # noqa: BLE001
        result["message"] = f"查询出口 IP 失败：{e}"
        return result

    # ---- 2) 探 authorize 第 0 步（能否拿到 state，而非 403）----
    try:
        if not os.path.isdir(_SDK_DIR):
            result["message"] = f"未找到 SDK 目录：{_SDK_DIR}"
            return result
        import register_full as rf  # type: ignore
        if use_proxy:
            import chain_proxy  # type: ignore
            rf.chain_proxy = chain_proxy
        rf.USE_PROXY = use_proxy
        opener, _jar = rf.make_session()
        url = ("https://server.cs.quickframe.com/auth/login?returnUrl="
               + urllib.parse.quote("https://ai.quickframe.com/", safe=""))
        status, _headers, page, final_url, _chain = rf.follow(opener, url)
        result["authorize_status"] = status
        state = rf.extract_state(page, final_url)
        result["authorize_ok"] = bool(state)
    except Exception as e:  # noqa: BLE001
        result["message"] = f"出口 IP={result['exit_ip']}（{result['exit_country']}）；探测 authorize 失败：{e}"
        return result

    # ---- 3) 汇总判断 ----
    country = (result["exit_country"] or "").upper()
    if result["authorize_ok"]:
        result["ok"] = True
        result["message"] = f"通道可用：出口 {result['exit_ip']}（{country}），authorize 已拿到 state"
    elif country and country != "US":
        result["message"] = (f"出口 IP 在 {country}（{result['exit_ip']}），非美国，QuickFrame 会拦截"
                             f"（authorize={result['authorize_status']}）。请把代理切到美国节点。")
    else:
        result["message"] = (f"出口 {result['exit_ip']}（{country}）但 authorize 返回 "
                             f"{result['authorize_status']}，未拿到 state，可能被风控或代理异常。")
    return result


# ====================== 临时邮箱（GPTMail） ======================

def list_temp_domains() -> List[str]:
    """拉取 GPTMail 当前可用域名列表（mx_valid 且 active）。"""
    req = urllib.request.Request(
        _GPTMAIL_DOMAINS_URL,
        headers={"User-Agent": _UA, "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            data = json.loads(r.read().decode())
    except Exception as e:  # noqa: BLE001 — 网络问题统一转可读错误
        raise QuickFrameError(f"获取临时邮箱域名失败: {e}")
    domains = [
        d["domain_name"]
        for d in data.get("data", {}).get("domains", [])
        if d.get("mx_valid") and d.get("is_active")
    ]
    if not domains:
        raise QuickFrameError("GPTMail 暂无可用域名，请稍后重试")
    return domains


def gen_email(domain: Optional[str] = None) -> str:
    """生成一个随机 GPTMail 邮箱地址。未指定域名时从可用域名里随机选。"""
    if not domain:
        domain = random.choice(list_temp_domains())
    prefix = "".join(random.choices(string.ascii_lowercase + string.digits, k=10))
    return f"{prefix}@{domain}"


# ====================== 注册 ======================

def _prepare_register_module():
    """导入并按当前配置装配 SDK 的 register_full 模块。

    register_full 在 import 时就读取 USE_PROXY / YESCAP_KEY，
    这里在导入后用最新配置覆盖模块全局，并确保 chain_proxy 已按配置就绪。
    """
    if not os.path.isdir(_SDK_DIR):
        raise QuickFrameError(f"未找到 quickframe-sdk-full 目录: {_SDK_DIR}")

    key = get_yescap_key()
    if not key:
        raise QuickFrameError("未配置 YesCaptcha Key，请在设置 → 渠道三 中填写")

    proxy = get_proxy_settings()
    try:
        import chain_proxy  # type: ignore
        import register_full as rf  # type: ignore
    except Exception as e:  # noqa: BLE001
        raise QuickFrameError(f"加载 QuickFrame SDK 失败: {e}")

    # 按配置覆盖链式代理参数
    chain_proxy.LOCAL_HOST = proxy["proxy_local_host"]
    chain_proxy.LOCAL_PORT = int(proxy["proxy_local_port"])
    chain_proxy.REMOTE_HOST = proxy["proxy_remote_host"]
    chain_proxy.REMOTE_PORT = int(proxy["proxy_remote_port"])
    chain_proxy.PROXY_USER = proxy["proxy_user"]
    chain_proxy.PROXY_PASS = proxy["proxy_pass"]

    # 覆盖注册模块的运行期开关
    rf.YESCAP_KEY = key
    rf.USE_PROXY = bool(proxy["use_proxy"])
    rf.chain_proxy = chain_proxy  # 确保 make_session 在开代理时能取到模块
    return rf


def register_one(email: Optional[str] = None, domain: Optional[str] = None) -> dict:
    """注册单个 QuickFrame 账号。返回 register_full.register_one 的结果字典。

    成功结构: {email, ok=True, cs_session, bearer, elapsed}
    失败结构: {email, ok=False, stage, err, ...}
    """
    rf = _prepare_register_module()
    if not email:
        email = gen_email(domain)
    try:
        return rf.register_one(email)
    except Exception as e:  # noqa: BLE001
        return {"email": email, "ok": False, "stage": "exception", "err": f"{type(e).__name__}: {e}"}


def register_batch(count: int, concurrency: int = 3, domain: Optional[str] = None) -> dict:
    """批量并发注册 count 个账号。返回 {success: [...], failed: [...]}。"""
    rf = _prepare_register_module()
    count = max(1, int(count))
    concurrency = max(1, min(int(concurrency), 10))

    # 预生成邮箱（一次取域名，避免并发重复请求域名接口）
    emails = [gen_email(domain) for _ in range(count)]

    import concurrent.futures

    results = {"success": [], "failed": []}

    def worker(addr: str) -> dict:
        try:
            return rf.register_one(addr)
        except Exception as e:  # noqa: BLE001
            return {"email": addr, "ok": False, "stage": "exception", "err": f"{type(e).__name__}: {e}"}

    with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as pool:
        futs = {pool.submit(worker, e): e for e in emails}
        for fut in concurrent.futures.as_completed(futs):
            r = fut.result()
            (results["success"] if r.get("ok") else results["failed"]).append(r)
    return results


def refresh_bearer(cs_session: str) -> str:
    """用 cs_session 重新换取 Bearer（24h）。开代理时走链式隧道（同区域出口）。"""
    if not cs_session:
        raise QuickFrameError("缺少 cs_session，无法刷新 token")
    proxy = get_proxy_settings()
    body = json.dumps({
        "audience": "https://ai.quickframe.com",
        "scope": "openid profile email",
    }).encode()
    headers = {
        "Content-Type": "application/json",
        "User-Agent": _UA,
        "Origin": "https://ai.quickframe.com",
        "Cookie": f"cs_session={cs_session}",
    }
    req = urllib.request.Request(
        "https://server.cs.quickframe.com/token", data=body, headers=headers, method="POST"
    )
    try:
        if proxy["use_proxy"]:
            import chain_proxy  # type: ignore
            chain_proxy.LOCAL_HOST = proxy["proxy_local_host"]
            chain_proxy.LOCAL_PORT = int(proxy["proxy_local_port"])
            chain_proxy.REMOTE_HOST = proxy["proxy_remote_host"]
            chain_proxy.REMOTE_PORT = int(proxy["proxy_remote_port"])
            chain_proxy.PROXY_USER = proxy["proxy_user"]
            chain_proxy.PROXY_PASS = proxy["proxy_pass"]
            opener = chain_proxy.build_chain_opener(timeout=40)
            with opener.open(req, timeout=40) as r:
                tk = json.loads(r.read().decode())
        else:
            with urllib.request.urlopen(req, timeout=40) as r:
                tk = json.loads(r.read().decode())
    except Exception as e:  # noqa: BLE001
        raise QuickFrameError(f"刷新 Bearer 失败: {e}")
    bearer = tk.get("accessToken")
    if not bearer:
        raise QuickFrameError(f"刷新 Bearer 未返回 accessToken: {tk}")
    return bearer


# ====================== 视频生成（图生视频） ======================

# 内存任务表：task_id -> {status, video_url, error, progress}
_JOBS: Dict[str, Dict[str, Any]] = {}
_JOBS_LOCK = threading.Lock()


def _build_client(bearer: str):
    """构造 QuickFrameClient，走链式隧道（Clash -> ipwo -> 目标）。

    QuickFrame API 对普通 Clash 出口 IP 返回 403，必须经 ipwo 旋转代理
    拿到美区住宅 IP 才能正常调用。这里给 requests.Session 挂一个自定义
    HTTPAdapter，底层用 chain_proxy.open_chain_socket 建隧道。
    """
    try:
        from quickframe.client import QuickFrameClient  # type: ignore
    except Exception as e:  # noqa: BLE001
        raise QuickFrameError(f"加载 QuickFrame 客户端失败: {e}")
    client = QuickFrameClient(access_token=bearer)
    proxy = get_proxy_settings()
    if proxy["use_proxy"]:
        _mount_chain_adapter(client.http, proxy)
    return client


def _mount_chain_adapter(session, proxy: dict):
    """给 requests.Session 挂载链式隧道适配器，所有 HTTPS 请求走 chain_proxy。"""
    import chain_proxy  # type: ignore
    from urllib3.util.connection import allowed_gai_family  # noqa: F401
    from requests.adapters import HTTPAdapter
    from urllib3.poolmanager import PoolManager
    from urllib3.connection import HTTPSConnection as U3Conn
    import ssl

    chain_proxy.LOCAL_HOST = proxy["proxy_local_host"]
    chain_proxy.LOCAL_PORT = int(proxy["proxy_local_port"])
    chain_proxy.REMOTE_HOST = proxy["proxy_remote_host"]
    chain_proxy.REMOTE_PORT = int(proxy["proxy_remote_port"])
    chain_proxy.PROXY_USER = proxy["proxy_user"]
    chain_proxy.PROXY_PASS = proxy.get("proxy_pass", "mengjun66")

    class ChainConnection(U3Conn):
        def connect(self):
            raw = chain_proxy.open_chain_socket(
                self._dns_host or self.host, self.port or 443, timeout=self.timeout or 60
            )
            ctx = ssl.create_default_context()
            self.sock = ctx.wrap_socket(raw, server_hostname=self._dns_host or self.host)
            self.is_verified = True

    class ChainPoolManager(PoolManager):
        def _new_pool(self, scheme, host, port, request_context=None):
            pool = super()._new_pool(scheme, host, port, request_context)
            pool.ConnectionCls = ChainConnection
            return pool

    class ChainAdapter(HTTPAdapter):
        def init_poolmanager(self, *args, **kwargs):
            self.poolmanager = ChainPoolManager(num_pools=4, maxsize=2)

    adapter = ChainAdapter()
    session.mount("https://", adapter)


def submit_generation(
    bearer: str,
    image_path: str,
    prompt: str,
    aspect_ratio: str = "16:9",
    duration: int = 5,
    generate_audio: bool = True,
) -> str:
    """提交图生视频任务，后台线程跑完整流程，返回内存 task_id。

    前端用 get_job_status(task_id) 轮询，结构与 wizstar/pixmax 任务对齐。
    """
    if not bearer:
        raise QuickFrameError("缺少 Bearer token")
    if not image_path or not os.path.isfile(image_path):
        raise QuickFrameError(f"图片不存在: {image_path}")

    task_id = "qf-" + "".join(random.choices(string.ascii_lowercase + string.digits, k=16))
    with _JOBS_LOCK:
        _JOBS[task_id] = {"status": "processing", "video_url": "", "error": "", "progress": 0}

    def run():
        try:
            client = _build_client(bearer)
            result = client.generate_video_from_image(
                image_path=image_path,
                prompt=prompt,
                aspect_ratio=aspect_ratio,
                duration=duration,
                generate_audio=generate_audio,
                wait=True,
            )
            with _JOBS_LOCK:
                _JOBS[task_id] = {
                    "status": "completed" if result.video_url else "failed",
                    "video_url": result.video_url or "",
                    "error": "" if result.video_url else "生成完成但未返回视频地址",
                    "progress": 100,
                }
        except Exception as e:  # noqa: BLE001
            with _JOBS_LOCK:
                _JOBS[task_id] = {"status": "failed", "video_url": "", "error": str(e), "progress": 0}

    threading.Thread(target=run, daemon=True).start()
    return task_id


def get_job_status(task_id: str) -> dict:
    """查询内存任务状态。未知 task_id 视为失败。"""
    with _JOBS_LOCK:
        job = _JOBS.get(task_id)
    if not job:
        return {"status": "failed", "video_url": "", "fail_reason": "任务不存在或已过期", "progress": 0}
    return {
        "status": job["status"],
        "video_url": job["video_url"],
        "progress": job.get("progress"),
        "fail_reason": job.get("error", ""),
        "queue_position": None,
    }
