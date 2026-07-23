"""极简 AWS SigV4（S3 PutObject，对齐浏览器 aws-sdk-js 上传）。"""

from __future__ import annotations

import datetime as dt
import hashlib
import hmac
from urllib.parse import quote


def _hmac(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()


def _sign_key(secret: str, datestamp: str, region: str, service: str) -> bytes:
    k_date = _hmac(("AWS4" + secret).encode("utf-8"), datestamp)
    k_region = _hmac(k_date, region)
    k_service = _hmac(k_region, service)
    return _hmac(k_service, "aws4_request")


def put_object(
    *,
    endpoint: str,
    bucket: str,
    object_name: str,
    access_key_id: str,
    access_key_secret: str,
    session_token: str,
    region: str,
    body: bytes,
    content_type: str,
    timeout: int = 120,
) -> None:
    """PUT object 到 S3 兼容桶（virtual-hosted + UNSIGNED-PAYLOAD）。"""
    from .http import request

    host = endpoint.replace("https://", "").replace("http://", "").rstrip("/")
    vhost = f"{bucket}.{host}"
    amz_date = dt.datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
    datestamp = amz_date[:8]
    payload_hash = "UNSIGNED-PAYLOAD"
    canonical_uri = "/" + "/".join(quote(part, safe="") for part in object_name.split("/"))
    canonical_querystring = "x-id=PutObject"
    content_length = str(len(body))
    canonical_headers = (
        f"content-length:{content_length}\n"
        f"content-type:{content_type}\n"
        f"host:{vhost}\n"
        f"x-amz-content-sha256:{payload_hash}\n"
        f"x-amz-date:{amz_date}\n"
        f"x-amz-security-token:{session_token}\n"
    )
    signed_headers = (
        "content-length;content-type;host;"
        "x-amz-content-sha256;x-amz-date;x-amz-security-token"
    )
    canonical_request = "\n".join(
        [
            "PUT",
            canonical_uri,
            canonical_querystring,
            canonical_headers,
            signed_headers,
            payload_hash,
        ]
    )
    credential_scope = f"{datestamp}/{region}/s3/aws4_request"
    string_to_sign = "\n".join(
        [
            "AWS4-HMAC-SHA256",
            amz_date,
            credential_scope,
            hashlib.sha256(canonical_request.encode("utf-8")).hexdigest(),
        ]
    )
    signature = hmac.new(
        _sign_key(access_key_secret, datestamp, region, "s3"),
        string_to_sign.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    authorization = (
        "AWS4-HMAC-SHA256 "
        f"Credential={access_key_id}/{credential_scope}, "
        f"SignedHeaders={signed_headers}, "
        f"Signature={signature}"
    )
    url = f"https://{vhost}{canonical_uri}?{canonical_querystring}"
    resp = request(
        url,
        method="PUT",
        headers={
            "Content-Type": content_type,
            "Content-Length": content_length,
            "Host": vhost,
            "x-amz-content-sha256": payload_hash,
            "x-amz-date": amz_date,
            "x-amz-security-token": session_token,
            "Authorization": authorization,
        },
        raw_body=body,
        timeout=timeout,
    )
    if resp["status"] >= 300:
        raise RuntimeError(f"OSS PutObject failed: {resp['status']} {resp.get('text', '')[:500]}")
