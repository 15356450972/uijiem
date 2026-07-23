"""命令行入口。"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from .auth import register_account
from .client import InsMindClient


def _load_token(args: argparse.Namespace) -> str:
    if args.token:
        return args.token.strip()
    env = (os.environ.get("INSMIND_TOKEN") or "").strip()
    if env:
        return env
    if args.account:
        data = json.loads(Path(args.account).read_text(encoding="utf-8"))
        token = data.get("access_token") or data.get("token")
        if token:
            return str(token)
    raise SystemExit("need --token / INSMIND_TOKEN / --account JSON with access_token")


def cmd_register(args: argparse.Namespace) -> int:
    account = register_account(email=args.email, max_wait=args.wait)
    text = json.dumps(account, ensure_ascii=False, indent=2)
    print(text)
    if args.out:
        Path(args.out).write_text(text + "\n", encoding="utf-8")
        print(f"saved {args.out}", file=sys.stderr)
    return 0


def _make_client(args: argparse.Namespace, **kwargs) -> InsMindClient:
    token = _load_token(args)
    cookie = getattr(args, "cookie", None)
    if not cookie and args.account:
        data = json.loads(Path(args.account).read_text(encoding="utf-8"))
        cookie = data.get("cookie")
    client = InsMindClient(token, user_id=args.user_id, cookie=cookie, **kwargs)
    if getattr(args, "ensure_tenant", False) or not client.cookie:
        try:
            client.ensure_tenant()
        except Exception as exc:
            if getattr(args, "ensure_tenant", False):
                raise
            print(f"ensure_tenant skipped: {exc}", file=sys.stderr)
    return client


def cmd_repos(args: argparse.Namespace) -> int:
    client = _make_client(args)
    print(json.dumps(client.list_repositories(), ensure_ascii=False, indent=2))
    return 0


def cmd_upload(args: argparse.Namespace) -> int:
    client = _make_client(args)
    result = client.upload_file(args.file, register_asset=not args.no_register)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def cmd_generate(args: argparse.Namespace) -> int:
    client = _make_client(
        args,
        poll_interval=args.poll_interval,
        poll_timeout=args.timeout,
    )
    images = list(args.image or [])
    if args.upload:
        uploaded = client.upload_file(args.upload)
        images.insert(0, uploaded["url"])
        print(f"uploaded: {uploaded['url']}", file=sys.stderr)
    if not images:
        raise SystemExit("need --image URL and/or --upload FILE")
    audios = list(args.audio or [])
    prompt = args.prompt
    if "[image" not in prompt:
        parts = [f"[image{i+1}]" for i in range(len(images))]
        if audios:
            parts += [f"[audio{i+1}]" for i in range(len(audios))]
        prompt = " ".join(parts) + " " + prompt
    if args.mode == "omni_reference":
        result = client.generate_omni(
            prompt=prompt,
            image_urls=images,
            audio_urls=audios,
            resolution=args.resolution,
            duration=args.duration,
            ratio=args.ratio,
            wait=not args.no_wait,
        )
    else:
        result = client.generate_start_end_frame(
            prompt=prompt,
            start_frame=images[0],
            resolution=args.resolution,
            duration=args.duration,
            ratio=args.ratio,
            wait=not args.no_wait,
        )
    # strip bulky nested raw for CLI output
    out = {k: v for k, v in result.items() if k != "raw"}
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0


def cmd_poll(args: argparse.Namespace) -> int:
    client = InsMindClient(_load_token(args), user_id=args.user_id, poll_timeout=args.timeout)
    result = client.wait_task(args.task_id)
    out = {k: v for k, v in result.items() if k != "raw"}
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="insmind", description="insMind pure-protocol SDK CLI")
    sub = p.add_subparsers(dest="command", required=True)

    r = sub.add_parser("register", help="GPTMail + captcha register")
    r.add_argument("--email", default=None)
    r.add_argument("--wait", type=int, default=90)
    r.add_argument("--out", default="insmind_account.json")
    r.set_defaults(func=cmd_register)

    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--token", default=None)
    common.add_argument("--account", default=None, help="JSON file with access_token")
    common.add_argument("--user-id", default=None)
    common.add_argument("--cookie", default=None, help="browser cookie header after org bind")
    common.add_argument("--ensure-tenant", action="store_true", help="create/bind personal org")

    s = sub.add_parser("repos", parents=[common], help="list DAM repositories")
    s.set_defaults(func=cmd_repos)

    u = sub.add_parser("upload", parents=[common], help="upload local file to DAM")
    u.add_argument("file")
    u.add_argument("--no-register", action="store_true")
    u.set_defaults(func=cmd_upload)

    g = sub.add_parser("generate", parents=[common], help="Seedance generate")
    g.add_argument("--mode", choices=["omni_reference", "start_end_frame"], default="omni_reference")
    g.add_argument("--prompt", required=True)
    g.add_argument("--image", action="append", default=[])
    g.add_argument("--audio", action="append", default=[])
    g.add_argument("--upload", default=None, help="local image to upload first")
    g.add_argument("--resolution", default="480P")
    g.add_argument("--duration", default="5")
    g.add_argument("--ratio", default="original")
    g.add_argument("--timeout", type=int, default=600)
    g.add_argument("--poll-interval", type=int, default=3)
    g.add_argument("--no-wait", action="store_true")
    g.set_defaults(func=cmd_generate)

    pl = sub.add_parser("poll", parents=[common], help="poll task until done")
    pl.add_argument("task_id")
    pl.add_argument("--timeout", type=int, default=600)
    pl.set_defaults(func=cmd_poll)
    return p


def main(argv: list[str] | None = None) -> None:
    parser = build_parser()
    args = parser.parse_args(argv)
    raise SystemExit(args.func(args))


if __name__ == "__main__":
    main()
