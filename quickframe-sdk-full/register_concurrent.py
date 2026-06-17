"""5 并发注册测试：复用 register_full.register_one，线程池并发。

每个线程：独立 GPTMail 邮箱 + 独立 cookie jar + 独立 YesCaptcha 任务。
汇总：成功率、各阶段失败分布、耗时、bot/限流表现。
"""

import os
import sys
import json
import time
import random
import string
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
import register_full as rf

N = int(sys.argv[1]) if len(sys.argv) > 1 else 5
UA = rf.UA


def gen_emails(n):
    dreq = urllib.request.Request(
        "https://mail.chatgpt.org.uk/api/domains/status",
        headers={"User-Agent": UA, "Accept": "application/json"})
    dom = json.loads(urllib.request.urlopen(dreq, timeout=20).read())
    valid = [d["domain_name"] for d in dom["data"]["domains"]
             if d["mx_valid"] and d["is_active"]]
    emails = []
    for _ in range(n):
        domain = random.choice(valid)
        prefix = "".join(random.choices(string.ascii_lowercase + string.digits, k=10))
        emails.append(f"{prefix}@{domain}")
    return emails


def worker(email):
    try:
        return rf.register_one(email)
    except Exception as e:
        return {"email": email, "ok": False, "stage": "exception",
                "err": f"{type(e).__name__}: {e}"}


def main():
    emails = gen_emails(N)
    print(f"\n{'#'*70}\n# {N} 并发注册，邮箱:\n" +
          "\n".join(f"#   {e}" for e in emails) + f"\n{'#'*70}")

    t0 = time.time()
    results = []
    with ThreadPoolExecutor(max_workers=N) as pool:
        futs = {pool.submit(worker, e): e for e in emails}
        for fut in as_completed(futs):
            results.append(fut.result())
    total = time.time() - t0

    ok = [r for r in results if r.get("ok")]
    fail = [r for r in results if not r.get("ok")]

    print(f"\n{'#'*70}\n# 汇总\n{'#'*70}")
    print(f"总数: {N}  成功: {len(ok)}  失败: {len(fail)}  总耗时: {total:.0f}s")
    if ok:
        avg = sum(r.get("elapsed", 0) for r in ok) / len(ok)
        print(f"成功平均单条耗时: {avg:.0f}s")
    print("\n成功:")
    for r in ok:
        print(f"  [OK] {r['email']}  ({r.get('elapsed',0):.0f}s)")
    print("\n失败:")
    for r in fail:
        print(f"  [X]  {r['email']}  stage={r.get('stage')}  err={r.get('err')}  http={r.get('http')}")

    # 保存成功账号的凭证
    creds = [{"email": r["email"], "cs_session": r.get("cs_session"),
              "bearer": r.get("bearer")} for r in ok]
    with open(os.path.join(_HERE, "_concurrent_accounts.json"), "w") as f:
        json.dump(creds, f, indent=2)
    print(f"\n{len(creds)} 个成功账号凭证已存到 _concurrent_accounts.json")


if __name__ == "__main__":
    main()
