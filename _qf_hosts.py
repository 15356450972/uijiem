import sys
import base64
import socket
import time
sys.path.insert(0, "quickframe-sdk-full")
import chain_proxy as cp

AUTH = base64.b64encode(f"{cp.PROXY_USER}:{cp.PROXY_PASS}".encode()).decode()
HOSTS = ["server.cs.quickframe.com", "login.quickframe.com", "quickframe.us.auth0.com"]


def raw_connect(target, timeout=25):
    s = socket.create_connection((cp.LOCAL_HOST, cp.LOCAL_PORT), timeout=timeout)
    s.settimeout(timeout)
    s.sendall((f"CONNECT {cp.REMOTE_HOST}:{cp.REMOTE_PORT} HTTP/1.1\r\n"
               f"Host: {cp.REMOTE_HOST}:{cp.REMOTE_PORT}\r\n\r\n").encode())
    r1 = cp._read_headers(s)
    if " 200 " not in (r1.split("\r\n")[0] if r1 else ""):
        s.close(); return "hop1 FAIL"
    s.sendall((f"CONNECT {target}:443 HTTP/1.1\r\n"
               f"Host: {target}:443\r\n"
               f"Proxy-Authorization: Basic {AUTH}\r\n\r\n").encode())
    r2 = cp._read_headers(s)
    f2 = r2.split("\r\n")[0] if r2 else "empty"
    s.close()
    return f2


for h in HOSTS:
    results = []
    for i in range(6):
        try:
            results.append(raw_connect(h))
        except Exception as e:
            results.append(f"EXC {type(e).__name__}")
        time.sleep(0.6)
    ok = sum(1 for r in results if "200" in r)
    codes = [r.replace("HTTP/1.1 ", "").split(" Connection")[0] for r in results]
    print(f"{h:32s} OK={ok}/6  {codes}")
