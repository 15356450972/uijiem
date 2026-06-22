"""GPTMail 收码脚本：建立 session -> 轮询收件箱 -> 提取验证码。"""

import re
import sys
import time
import json
import urllib.request
import urllib.parse

HOST = "mail.chatgpt.org.uk"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")


def req(path, method="GET", headers=None, body=None, timeout=20):
    url = f"https://{HOST}{path}"
    h = {"User-Agent": UA}
    if headers:
        h.update(headers)
    data = body.encode() if body else None
    r = urllib.request.Request(url, data=data, headers=h, method=method)
    with urllib.request.urlopen(r, timeout=timeout) as resp:
        raw = resp.read().decode("utf-8", "ignore")
        set_cookies = resp.headers.get_all("Set-Cookie") or []
        cookies = [c.split(";")[0] for c in set_cookies]
        try:
            j = json.loads(raw)
        except ValueError:
            j = None
        return {"status": resp.status, "text": raw, "json": j, "cookies": cookies}


def build_session(email):
    page = req(f"/zh/{email}", headers={"Accept": "text/html"})
    cookies = page["cookies"]
    cookie_str = "; ".join(cookies)
    payload = json.dumps({"email": email})
    token_resp = req(
        "/api/inbox-token",
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Cookie": cookie_str,
            "Referer": f"https://{HOST}/zh/{email}",
        },
        body=payload,
    )
    token = None
    if token_resp["json"] and token_resp["json"].get("success"):
        token = token_resp["json"].get("auth", {}).get("token")
    return cookies, token, token_resp["text"]


def get_emails(email, cookies, token):
    import urllib.parse
    cookie_str = "; ".join([c for c in cookies if c.startswith("gm_sid")])
    res = req(
        f"/api/emails?email={urllib.parse.quote(email)}",
        headers={
            "Cookie": cookie_str,
            "X-Inbox-Token": token or "",
            "Accept": "application/json",
            "Referer": f"https://{HOST}/zh/{email}",
        },
    )
    return res["json"] or {"success": False, "raw": res["text"][:200]}


def get_email_detail(email_id, cookies, token):
    cookie_str = "; ".join([c for c in cookies if c.startswith("gm_sid")])
    res = req(
        f"/api/email/{email_id}",
        headers={
            "Cookie": cookie_str,
            "X-Inbox-Token": token or "",
            "Accept": "application/json",
        },
    )
    return res["json"] or {"success": False, "raw": res["text"][:300]}


def _extract_code(html):
    """从 HTML 邮件正文里提取验证码：先剥离 <style>/<script>/标签，再找数字。"""
    if not html:
        return None
    text = re.sub(r"(?is)<style.*?</style>", " ", html)
    text = re.sub(r"(?is)<script.*?</script>", " ", text)
    text = re.sub(r"(?s)<[^>]+>", " ", text)
    text = re.sub(r"&nbsp;", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    # QuickFrame 验证码通常是 6 位数字，优先取独立的数字串
    candidates = re.findall(r"\b(\d{4,8})\b", text)
    for c in candidates:
        if 4 <= len(c) <= 8:
            return c
    return None


def wait_for_code(email, max_wait=120, min_ts=0):
    cookies, token, raw = build_session(email)
    print(f"  session: cookies={len(cookies)} token={'OK' if token else 'NULL'}")
    if not token:
        print(f"  token raw: {raw[:200]}")
    start = time.time()
    while time.time() - start < max_wait:
        result = get_emails(email, cookies, token)
        if result.get("success") and result.get("data", {}).get("emails"):
            emails = result["data"]["emails"]
            # 选时间戳最新的一封，避免拿到过期旧码
            emails = sorted(emails, key=lambda m: m.get("timestamp", 0), reverse=True)
            mail = emails[0]
            ts = mail.get("timestamp", 0)
            if min_ts and ts <= min_ts:
                elapsed = int(time.time() - start)
                print(f"  等待新邮件... ({elapsed}s) 当前最新 ts={ts} <= min_ts={min_ts}", end="\r")
                time.sleep(2)
                continue
            print(f"  收到邮件 from={mail.get('from_address')} subject={mail.get('subject')} ts={ts}")
            mail_id = mail.get("id") or mail.get("email_id") or mail.get("_id")
            html = mail.get("html_content") or ""
            if (not html) and mail_id:
                detail = get_email_detail(mail_id, cookies, token)
                d = detail.get("data") or detail
                if isinstance(d, dict):
                    html = d.get("html_content") or d.get("content") or ""
            code = _extract_code(html)
            if code:
                return code
            print(f"  正文里没找到验证码，HTML 长度={len(html)}")
            return None
        elapsed = int(time.time() - start)
        print(f"  轮询中... ({elapsed}s)", end="\r")
        time.sleep(2)
    print()
    return None


if __name__ == "__main__":
    import os
    import urllib.parse
    _HERE = os.path.dirname(os.path.abspath(__file__))
    if len(sys.argv) > 1:
        email = sys.argv[1]
    else:
        with open(os.path.join(_HERE, "_gptmail_email.txt")) as _f:
            email = _f.read().strip()
    min_ts = int(sys.argv[2]) if len(sys.argv) > 2 else 0
    print(f"邮箱: {email}  min_ts={min_ts}")
    code = wait_for_code(email, max_wait=120, min_ts=min_ts)
    if code:
        print(f"\n验证码: {code}")
        with open(os.path.join(_HERE, "_gptmail_code.txt"), "w") as f:
            f.write(code)
    else:
        print("\n未收到验证码")
        sys.exit(1)
