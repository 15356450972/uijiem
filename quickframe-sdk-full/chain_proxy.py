"""链式旋转代理模块：本地 Clash(7890) -> ipwo -> 目标。

提供 ProxyHTTPSConnection / 自定义 opener，让 urllib 的请求走链式隧道，
每个 opener 实例 = 一条隧道 = 一个固定出口 IP（同 worker 内 cookie/session 一致）。
不同 worker 用不同 opener = 不同出口 IP，绕开同 IP 限流。
"""

import ssl
import socket
import base64
import random
import threading
import time as _time
import http.client
import urllib.request

LOCAL_HOST = "127.0.0.1"
LOCAL_PORT = 7890
REMOTE_HOST = "us.ipwo.net"
REMOTE_PORT = 7878
PROXY_USER = "mengjun66_custom_zone_US"
PROXY_PASS = "mengjun66"

_CTX = ssl.create_default_context()


class _FatalProxyError(Exception):
    """不可重试的代理错误（如 407 认证失败）：重试也没用，直接上抛。"""


# ---- 全局建隧道节流 ----
# ipwo 旋转代理对“短时间突发新建隧道”会限流（返回 403/431）。
# OAuth/authorize 是多跳重定向流程，会在一两秒内连开五六条隧道，必然撞墙。
# 这里用一个全局最小间隔，把突发摊平成有节奏的请求；并发注册时同样受此限流保护。
_MIN_TUNNEL_INTERVAL = 1.6  # 秒；两条新隧道之间的最小间隔
_TUNNEL_LOCK = threading.Lock()
_LAST_TUNNEL_TS = 0.0


def _throttle_tunnel():
    """串行预约一个建隧道时隙，确保两条隧道之间至少间隔 _MIN_TUNNEL_INTERVAL 秒。"""
    global _LAST_TUNNEL_TS
    with _TUNNEL_LOCK:
        now = _time.monotonic()
        wait = _MIN_TUNNEL_INTERVAL - (now - _LAST_TUNNEL_TS)
        if wait > 0:
            _time.sleep(wait)
        _LAST_TUNNEL_TS = _time.monotonic()


def _read_headers(sock):
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = sock.recv(4096)
        if not chunk:
            break
        buf += chunk
    return buf.decode("latin-1")


def _status_code(resp_line):
    """从响应首行解析 HTTP 状态码，解析失败返回 None。"""
    try:
        return int(resp_line.split(" ", 2)[1])
    except (IndexError, ValueError):
        return None


def _backoff(attempt):
    """指数退避 + 随机抖动。

    ipwo 旋转代理对“短时间突发新建隧道”会临时回 403/429（限流窗口约几秒），
    必须用带抖动的较长等待跳出同一个限流窗口，否则连环重试会全部撞墙。
    """
    base = min(1.2 * (2 ** attempt), 6.0)
    return base + random.uniform(0, 0.8)


def open_chain_socket(target_host, target_port, timeout=30, retries=8):
    """建立 本地Clash -> ipwo -> target 的链式隧道，返回裸 TCP socket（未 TLS）。

    旋转代理上游偶发 502/超时/431/403（网关轮换抖动 + 突发限流），带退避重试。
    每次重试都是一条全新隧道（= 可能换到一个更健康的出口）。
    注：经 Clash 之后 ipwo 看到的是海外出口，链式 403 基本是“突发限流/出口临时不可用”，
    退避后重试即可恢复；只有少数永久错误（407 认证失败）才直接放弃。
    """
    auth = base64.b64encode(f"{PROXY_USER}:{PROXY_PASS}".encode()).decode()
    # 这些状态码属于旋转代理网关的瞬时抖动 / 突发限流，退避后换条隧道（新出口）通常就好。
    transient = {403, 408, 425, 429, 431, 500, 502, 503, 504}
    last_err = None
    for attempt in range(retries):
        s = None
        try:
            _throttle_tunnel()
            s = socket.create_connection((LOCAL_HOST, LOCAL_PORT), timeout=timeout)
            s.settimeout(timeout)
            s.sendall(
                f"CONNECT {REMOTE_HOST}:{REMOTE_PORT} HTTP/1.1\r\n"
                f"Host: {REMOTE_HOST}:{REMOTE_PORT}\r\n\r\n".encode())
            resp = _read_headers(s)
            first = resp.split("\r\n")[0] if resp else "empty"
            if " 200 " not in first:
                # 第一跳是本地 Clash，失败多半是 Clash 没开 / 端口不对，重试也无意义
                raise RuntimeError(f"第一跳 CONNECT(本地Clash) 失败: {first}")
            s.sendall(
                f"CONNECT {target_host}:{target_port} HTTP/1.1\r\n"
                f"Host: {target_host}:{target_port}\r\n"
                f"Proxy-Authorization: Basic {auth}\r\n\r\n".encode())
            resp = _read_headers(s)
            line = resp.split("\r\n")[0] if resp else "empty"
            if " 200 " not in line:
                code = _status_code(line)
                # 407 = 代理认证失败（用户名/密码错），重试无意义，直接抛
                if code == 407:
                    raise _FatalProxyError(f"第二跳 CONNECT 代理认证失败(407)，请检查代理用户名/密码: {line}")
                last_err = RuntimeError(f"第二跳 CONNECT 失败: {line}")
                try:
                    s.close()
                except Exception:
                    pass
                if code is None or code in transient:
                    if attempt < retries - 1:
                        _time.sleep(_backoff(attempt))
                        continue
                # 其它未知码：也再重试，反正换条隧道成本低
                if attempt < retries - 1:
                    _time.sleep(_backoff(attempt))
                    continue
                raise last_err
            return s
        except _FatalProxyError:
            raise
        except RuntimeError as e:
            # 第一跳失败这种致命错误：首行带“本地Clash”标识，不重试
            if "本地Clash" in str(e):
                raise
            last_err = e
            if s:
                try:
                    s.close()
                except Exception:
                    pass
            if attempt < retries - 1:
                _time.sleep(_backoff(attempt))
                continue
        except Exception as e:
            last_err = e
            if s:
                try:
                    s.close()
                except Exception:
                    pass
            if attempt < retries - 1:
                _time.sleep(_backoff(attempt))
                continue
    raise RuntimeError(f"建隧道失败(重试{retries}次): {last_err}")


class ChainHTTPSConnection(http.client.HTTPSConnection):
    """走链式隧道的 HTTPS 连接：每次 connect 新建一条隧道并 TLS 握手。"""

    def connect(self):
        raw = open_chain_socket(self.host, self.port or 443, timeout=self.timeout)
        self.sock = _CTX.wrap_socket(raw, server_hostname=self.host)


class ChainHTTPSHandler(urllib.request.HTTPSHandler):
    def https_open(self, req):
        return self.do_open(ChainHTTPSConnection, req)


def build_chain_opener(extra_handlers=None, timeout=30):
    """构造一个走链式代理的 urllib opener。

    关键：必须显式塞入一个空的 ProxyHandler({})，否则 urllib 会自动读取系统代理
    （Windows 上 Clash 通常把系统代理设成 127.0.0.1:7890），把每个请求改写成
    “经 127.0.0.1:7890 代理”，导致我们的链式隧道把目标 host 误连成 127.0.0.1:7890
    （表现为第二跳 CONNECT 127.0.0.1:7890 -> 403）。空 ProxyHandler 禁用自动代理探测，
    让 ChainHTTPSHandler 直接对真实目标域名建隧道。
    """
    handlers = [urllib.request.ProxyHandler({}), ChainHTTPSHandler()]
    if extra_handlers:
        handlers = list(extra_handlers) + handlers
    return urllib.request.build_opener(*handlers)


def current_ip(timeout=30):
    """通过一条链式隧道查当前出口 IP。"""
    import json
    raw = open_chain_socket("ipinfo.io", 443, timeout=timeout)
    tls = _CTX.wrap_socket(raw, server_hostname="ipinfo.io")
    try:
        tls.sendall(b"GET /json HTTP/1.1\r\nHost: ipinfo.io\r\n"
                    b"User-Agent: curl/8.0\r\nAccept: */*\r\nConnection: close\r\n\r\n")
        data = b""
        while True:
            try:
                c = tls.recv(4096)
            except socket.timeout:
                break
            if not c:
                break
            data += c
        text = data.decode("utf-8", "ignore")
        body = text.split("\r\n\r\n", 1)[1] if "\r\n\r\n" in text else text
        s, e = body.find("{"), body.rfind("}")
        return json.loads(body[s:e + 1]).get("ip") if s >= 0 else None
    finally:
        tls.close()
