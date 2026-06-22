"""离线校验：用真实抓包的响应数据验证 SDK 解析逻辑（不联网）。"""

import json
import os
import sys

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _ROOT)

from quickframe.models import Asset, GenerationResult, Session, GenerationJob

API_DIR = os.path.join(_ROOT, "videogen_data", "api")


def load(name):
    with open(os.path.join(API_DIR, name), "r", encoding="utf-8") as fh:
        return json.load(fh)


def first_data(batch):
    return batch[0]["result"]["data"]


def test_session():
    data = load("session.network-response")
    s = Session.from_response(data)
    assert s.email == "hhawkins451@sifan077.cc.cd", s.email
    assert s.active is True
    print(f"[OK] Session: {s.email} active={s.active}")


def test_asset_register():
    data = first_data(load("assets_registerDirectUpload.network-response"))
    a = Asset.from_response(data)
    assert a.asset_id == 1136895, a.asset_id
    assert a.asset_type == "image"
    assert a.cloudinary_url.startswith("https://res.cloudinary.com/"), a.cloudinary_url
    print(f"[OK] Asset: id={a.asset_id} url={a.cloudinary_url[:60]}...")


def test_generation_job():
    data = first_data(load("generateSeedanceVideoForEditor.network-response"))
    job = GenerationJob(job_id=data["jobId"], channel=data["channel"], project_id=112271)
    assert job.job_id == "eg-100438-1780122951253", job.job_id
    assert job.run_id == job.job_id
    print(f"[OK] GenerationJob: jobId={job.job_id}")


def test_generation_result():
    arr = load("assets_getAssetsByIds_result.network-response")
    data = arr[0]["result"]["data"][0]
    r = GenerationResult.from_asset_response(data)
    assert r.asset_id == 1136954, r.asset_id
    assert r.video_url.startswith("https://res.cloudinary.com/"), r.video_url
    assert r.width == 1280 and r.height == 720, (r.width, r.height)
    assert "seedance" in (r.model or "").lower(), r.model
    print(f"[OK] GenerationResult: {r.width}x{r.height} model={r.model}")
    print(f"     video_url={r.video_url}")


if __name__ == "__main__":
    test_session()
    test_asset_register()
    test_generation_job()
    test_generation_result()
    print("\n全部解析校验通过 —— SDK 模型与真实响应数据一致。")
