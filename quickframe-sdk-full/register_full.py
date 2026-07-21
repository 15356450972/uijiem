"""单条完整注册流程：YesCaptcha + Auth0 Universal Login + 邮箱收码。

验证核心未知数：YesCaptcha 在它自己环境解出的 Turnstile token，
能否被 login.quickframe.com 的 Auth0 后端接受（异地 token 可用性）。

流程：
  /authorize -> 落地 identifier 页(取 state+sitekey)
  -> YesCaptcha 解 Turnstile -> 带 token POST identifier(触发发码)
  -> 落地 passwordless-email-challenge 页
  -> 全局邮箱库/兼容 GPTMail 收码 -> POST code
  -> /authorize/resume -> server.cs.quickframe.com/auth/callback (拿 cs_session)
  -> POST /token 刷 Bearer 验证
"""

import re
import os
import sys
import json
import gzip
import ssl
import time
import http.cookiejar
import urllib.request
import urllib.parse
import urllib.error

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
import gptmail_getcode as gm
import applemail_getcode as am

# 是否让 QuickFrame/Auth0 的请求走链式旋转代理（每个 session 独立出口 IP，绕开 429）
USE_PROXY = os.getenv("QF_USE_PROXY", "0") == "1"
if USE_PROXY:
    import chain_proxy

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36")
CLIENT_ID = "13P092MMSNWNgzEVpOV5fLRUmWuUn8pR"
REDIRECT_URI = "https://server.cs.quickframe.com/auth/callback"
# YesCaptcha key：优先环境变量 QF_YESCAP_KEY，其次本目录 _yescap_key.txt
YESCAP_KEY = os.getenv("QF_YESCAP_KEY", "").strip()
if not YESCAP_KEY:
    _key_file = os.path.join(_HERE, "_yescap_key.txt")
    if os.path.isfile(_key_file):
        with open(_key_file) as _f:
            YESCAP_KEY = _f.read().strip()

ctx = ssl.create_default_context()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def make_session():
    jar = http.cookiejar.CookieJar()
    if USE_PROXY:
        # 链式代理：本 opener 的所有 HTTPS 请求走同一条隧道 = 同一出口 IP
        opener = chain_proxy.build_chain_opener(
            extra_handlers=[urllib.request.HTTPCookieProcessor(jar), NoRedirect()],
            timeout=40)
    else:
        opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(jar),
            NoRedirect(),
            urllib.request.HTTPSHandler(context=ctx),
        )
    return opener, jar


def do(opener, method, url, headers=None, body=None):
    h = {"User-Agent": UA,
         "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
         "Accept-Language": "en-US,en;q=0.9"}
    if headers:
        h.update(headers)
    data = body.encode() if isinstance(body, str) else body
    req = urllib.request.Request(url, data=data, headers=h, method=method)
    try:
        r = opener.open(req, timeout=40)
        raw = r.read()
        if r.headers.get("Content-Encoding") == "gzip":
            raw = gzip.decompress(raw)
        return r.status, dict(r.headers), raw.decode("utf-8", "ignore"), r.geturl()
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            if e.headers.get("Content-Encoding") == "gzip":
                raw = gzip.decompress(raw)
        except Exception:
            pass
        return e.code, dict(e.headers), raw.decode("utf-8", "ignore"), e.headers.get("Location")


def follow(opener, url, max_hops=10, log_prefix=""):
    """跟随重定向直到非 3xx，返回 (status, headers, text, final_url, chain)。"""
    chain = []
    cur, method = url, "GET"
    status = headers = text = None
    for i in range(max_hops):
        status, headers, text, loc = do(opener, method, cur)
        chain.append((method, cur, status, loc))
        print(f"{log_prefix}[{i}] {method} {cur[:70]}... -> {status}"
              + (f"  -> {loc[:70]}" if loc else ""))
        if status in (301, 302, 303, 307, 308) and loc:
            if loc.startswith("/"):
                base = re.match(r"(https://[^/]+)", cur).group(1)
                loc = base + loc
            cur, method = loc, "GET"
            continue
        break
    return status, headers, text, cur, chain


def _post_json_retry(url, payload, timeout=30, retries=4, label=""):
    """POST JSON，对网络抖动(连接重置/超时)自动重试。"""
    data = json.dumps(payload).encode()
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(
                url, data=data,
                headers={"Content-Type": "application/json"}, method="POST")
            with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
                return json.loads(r.read().decode())
        except Exception as e:
            last = e
            if attempt < retries - 1:
                time.sleep(2 * (attempt + 1))
                continue
    raise RuntimeError(f"{label} 网络失败(重试{retries}次): {last}")


def solve_turnstile(website_url, sitekey):
    """用 YesCaptcha 解 Turnstile，返回 token。"""
    resp = _post_json_retry(
        "https://api.yescaptcha.com/createTask",
        {"clientKey": YESCAP_KEY,
         "task": {"type": "TurnstileTaskProxyless",
                  "websiteURL": website_url, "websiteKey": sitekey}},
        label="createTask")
    if resp.get("errorId"):
        raise RuntimeError(f"createTask 失败: {resp}")
    task_id = resp["taskId"]
    print(f"    [yescap] taskId={task_id}")

    for attempt in range(40):
        time.sleep(3)
        res = _post_json_retry(
            "https://api.yescaptcha.com/getTaskResult",
            {"clientKey": YESCAP_KEY, "taskId": task_id},
            label="getTaskResult")
        if res.get("errorId"):
            raise RuntimeError(f"getTaskResult 失败: {res}")
        if res.get("status") == "ready":
            tok = res["solution"]["token"]
            print(f"    [yescap] 解出 token ({attempt*3}s): {tok[:40]}...")
            return tok
        print(f"    [yescap] processing... ({attempt*3}s)", end="\r")
    raise RuntimeError("YesCaptcha 超时未解出")


def extract_state(text, url):
    m = re.search(r'name="state"\s+value="([^"]+)"', text)
    if m:
        return m.group(1)
    m = re.search(r'state=([A-Za-z0-9_\-]+)', url)
    return m.group(1) if m else None


def has_captcha(text):
    return bool(re.search(r'data-captcha-sitekey="([^"]+)"', text))


def get_sitekey(text):
    m = re.search(r'data-captcha-sitekey="([^"]+)"', text)
    return m.group(1) if m else None


def register_one(email, mailbox=None):
    t0 = time.time()
    opener, jar = make_session()
    print(f"\n{'='*60}\n邮箱: {email}\n{'='*60}")

    # ---- 步骤 0：从后端登录入口发起（让后端建立 PKCE/state 上下文）----
    # 直接打 Auth0 /authorize 会导致 callback 400，必须从 server 的 /auth/login 发起
    url = ("https://server.cs.quickframe.com/auth/login?returnUrl="
           + urllib.parse.quote("https://ai.quickframe.com/", safe=""))
    print("[0] 从后端 /auth/login 发起 OAuth")
    status, headers, text, final_url, _ = follow(
        opener, url, log_prefix="    ",
        )
    state = extract_state(text, final_url)
    sitekey = get_sitekey(text) or "0x4AAAAAACwSuI5jPtwnNwc5"
    print(f"    state={state[:30] if state else None}...  sitekey={sitekey}")
    if not state:
        return {"email": email, "ok": False, "stage": "authorize", "err": "no state"}

    # ---- 步骤 1：解 Turnstile ----
    print("[1] YesCaptcha 解 Turnstile")
    token = solve_turnstile(final_url, sitekey)

    # ---- 步骤 2：带 token 提交邮箱，触发发码 ----
    print("[2] 提交邮箱 + captcha token")
    verification_requested_at = time.time()
    submit_url = f"https://login.quickframe.com/u/login/identifier?state={state}"
    form = urllib.parse.urlencode({
        "state": state, "username": email, "captcha": token,
        "js-available": "true", "webauthn-available": "false",
        "is-brave": "false", "webauthn-platform-available": "false",
        "action": "default",
    })
    status, headers, text, loc = do(
        opener, "POST", submit_url,
        headers={"Content-Type": "application/x-www-form-urlencoded",
                 "Origin": "https://login.quickframe.com", "Referer": submit_url},
        body=form)
    print(f"    -> HTTP {status}" + (f"  Location: {loc[:70]}" if loc else ""))
    if status == 400 or (status == 200 and has_captcha(text)):
        # 仍停在 identifier 页 = captcha 被拒
        err = re.search(r'"(?:description|message)":"([^"]+)"', text)
        print(f"    [拒绝] token 未被接受。{err.group(1) if err else ''}")
        return {"email": email, "ok": False, "stage": "identifier_submit",
                "err": "captcha rejected", "http": status}
    if status not in (302, 303) or not loc:
        return {"email": email, "ok": False, "stage": "identifier_submit",
                "err": f"unexpected http {status}", "http": status}

    # 跟随到 challenge 页
    if loc.startswith("/"):
        loc = "https://login.quickframe.com" + loc
    print("[2b] 跟随到验证码页")
    status, headers, text, chal_url, _ = follow(opener, loc, log_prefix="    ")
    chal_state = extract_state(text, chal_url)
    print(f"    challenge state={chal_state[:30] if chal_state else None}...")
    if "passwordless-email-challenge" not in chal_url:
        return {"email": email, "ok": False, "stage": "challenge_page",
                "err": f"not at challenge: {chal_url[:80]}"}
    print("    >>> 发码成功！token 被 Auth0 接受")

    # ---- 步骤 3：邮箱收码 ----
    if mailbox:
        print("[3] 全局邮箱库（小苹果 API）收码")
        code = am.wait_for_code(
            mailbox,
            max_wait=90,
            min_ts=verification_requested_at - 120,
        )
    else:
        print("[3] GPTMail 收码")
        code = gm.wait_for_code(email, max_wait=90)
    if not code:
        return {"email": email, "ok": False, "stage": "get_code", "err": "no code"}
    print(f"    验证码: {code}")

    # ---- 步骤 4：提交验证码 ----
    print("[4] 提交验证码")
    chal_submit = f"https://login.quickframe.com/u/login/passwordless-email-challenge?state={chal_state}"
    cform = urllib.parse.urlencode({"state": chal_state, "code": code, "action": "default"})
    status, headers, text, loc = do(
        opener, "POST", chal_submit,
        headers={"Content-Type": "application/x-www-form-urlencoded",
                 "Origin": "https://login.quickframe.com", "Referer": chal_submit},
        body=cform)
    print(f"    -> HTTP {status}" + (f"  Location: {loc[:70]}" if loc else ""))
    if status not in (302, 303) or not loc:
        err = re.search(r'"(?:description|message)":"([^"]+)"', text)
        return {"email": email, "ok": False, "stage": "code_submit",
                "err": err.group(1) if err else f"http {status}"}

    # ---- 步骤 5：跟随 resume -> callback，拿 cs_session ----
    if loc.startswith("/"):
        loc = "https://login.quickframe.com" + loc
    print("[5] 跟随 resume -> callback")
    status, headers, text, final, chain = follow(opener, loc, log_prefix="    ")
    cs_session = None
    for c in jar:
        if c.name == "cs_session":
            cs_session = c.value
    print(f"    cs_session: {'拿到 ('+str(len(cs_session))+'字符)' if cs_session else '未拿到'}")
    if not cs_session:
        return {"email": email, "ok": False, "stage": "callback", "err": "no cs_session"}

    # ---- 步骤 6：用 cs_session 刷 Bearer 验证 ----
    # 注意：cs_session 与签发它的出口 IP/区域绑定，刷 token 必须走同一通道
    # （开代理时用 opener 走美国 IP；直连时用裸 urlopen）
    print("[6] POST /token 刷 Bearer")
    tk_body = json.dumps({"audience": "https://ai.quickframe.com",
                          "scope": "openid profile email"})
    req = urllib.request.Request(
        "https://server.cs.quickframe.com/token", data=tk_body.encode(),
        headers={"Content-Type": "application/json", "User-Agent": UA,
                 "Origin": "https://ai.quickframe.com",
                 "Cookie": f"cs_session={cs_session}"}, method="POST")
    try:
        _open = opener.open if USE_PROXY else urllib.request.urlopen
        with _open(req, timeout=30) as r:
            tk = json.loads(r.read().decode())
        bearer = tk.get("accessToken")
        print(f"    Bearer: {bearer[:40]}...  expiresIn={tk.get('expiresIn')}")
    except urllib.error.HTTPError as e:
        return {"email": email, "ok": False, "stage": "token", "err": f"http {e.code}"}

    dt = time.time() - t0
    print(f"\n[OK] {email} 注册成功，耗时 {dt:.0f}s")
    return {"email": email, "ok": True, "cs_session": cs_session,
            "bearer": bearer, "elapsed": dt}


if __name__ == "__main__":
    email = sys.argv[1] if len(sys.argv) > 1 else None
    if not email:
        # 自动生成一个 GPTMail 邮箱
        import random, string
        dreq = urllib.request.Request(
            "https://mail.chatgpt.org.uk/api/domains/status",
            headers={"User-Agent": UA, "Accept": "application/json"})
        domresp = json.loads(urllib.request.urlopen(dreq, timeout=20).read())
        valid = [d["domain_name"] for d in domresp["data"]["domains"]
                 if d["mx_valid"] and d["is_active"]]
        domain = random.choice(valid)
        prefix = "".join(random.choices(string.ascii_lowercase + string.digits, k=10))
        email = f"{prefix}@{domain}"
    result = register_one(email)
    print("\n" + json.dumps({k: v for k, v in result.items()
                             if k not in ("cs_session", "bearer")},
                            ensure_ascii=False, indent=2))
    if result.get("ok"):
        with open(os.path.join(_HERE, "_reg_result.json"), "w") as f:
            json.dump(result, f)
