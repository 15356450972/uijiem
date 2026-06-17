"""Wizstar 注册接口的 RSA-OAEP(SHA-256) 加密

公钥从前端 JS 中提取得到。注册时邮箱、密码字段需要先经过此函数加密成 base64。
"""

import base64

from Crypto.Cipher import PKCS1_OAEP
from Crypto.Hash import SHA256
from Crypto.PublicKey import RSA


PUBLIC_KEY_PEM = """-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAzCM8McWpLNBfGfysJMST
vgsBfkj9vUyP8M8hZd6vnZV1Y3SL/x9JzOQRW27yAUjcFAWN8x98d9vfvv4t0y2u
V0hqLOTZIYhbQUdWE82KZ+BpNAAaFlRBIwu1g/drkovlHsoOJbGfKGCjwD7/ZAhl
BL3KlXAsVcdE8gD6v2rrM1wvDffm5nZiJ4VYq0UgyXt2Mj84JR9+T6phzBXeJemn
lVMBsod1bi4nU7Zwk0lw0fpa1tl1hKRmFM1nvm3Tjfmu97bsJh0ruthhZhTr5tLx
tEUW57RkRijKKpGfv3Y9rEV5SwKzD8aVXvXJKtsR4ubIQ1++YFjyahJtZh/j1csy
yQIDAQAB
-----END PUBLIC KEY-----"""


def rsa_encrypt(plaintext: str) -> str:
    """RSA-OAEP(SHA-256) 加密 + base64。用于注册接口的 email / password 字段。"""
    key = RSA.import_key(PUBLIC_KEY_PEM)
    cipher = PKCS1_OAEP.new(
        key,
        hashAlgo=SHA256,
        mgfunc=lambda x, y: PKCS1_OAEP.MGF1(x, y, SHA256),
    )
    return base64.b64encode(cipher.encrypt(plaintext.encode("utf-8"))).decode("utf-8")
