"""命令行入口：python -m wizstar [serve|demo]"""

import argparse
import sys

from .enums import Model, Ratio, Resolution


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="python -m wizstar",
        description="Wizstar SDK — 本地服务 / 端到端 demo",
    )
    sub = parser.add_subparsers(dest="command")

    # ---- serve 子命令 ----
    serve_parser = sub.add_parser("serve", help="启动本地 HTTP API 服务")
    serve_parser.add_argument("--host", default="127.0.0.1")
    serve_parser.add_argument("--port", type=int, default=8765)

    # ---- demo 子命令 ----
    demo_parser = sub.add_parser("demo", help="端到端 demo：注册 -> 上传 -> 生成")
    demo_parser.add_argument("email", help="Outlook 邮箱")
    demo_parser.add_argument("password", help="账号密码（注册时使用）")
    demo_parser.add_argument("client_id", help="Outlook OAuth2 client_id")
    demo_parser.add_argument("refresh_token", help="Outlook OAuth2 refresh_token")
    demo_parser.add_argument("image_path", help="本地图片路径，用于图生视频")
    demo_parser.add_argument(
        "--prompt",
        default="Cinematic warm soft light, gentle camera push-in, cozy and friendly atmosphere",
    )
    demo_parser.add_argument(
        "--model", default=Model.SEEDANCE_2_0,
        choices=[Model.SEEDANCE_2_0, Model.SEEDANCE_1_5, Model.KLING],
    )
    demo_parser.add_argument(
        "--ratio", default=Ratio.PORTRAIT,
        choices=[Ratio.PORTRAIT, Ratio.LANDSCAPE],
    )
    demo_parser.add_argument("--resolution", default=Resolution.P720)
    demo_parser.add_argument("--duration", type=int, default=5, choices=[5, 10])
    demo_parser.add_argument("--num", type=int, default=1, choices=[1, 2, 3, 4])
    demo_parser.add_argument("--creds-out", default="credentials.json")

    args = parser.parse_args()

    if args.command == "serve":
        from .server import start_server
        start_server(host=args.host, port=args.port)

    elif args.command == "demo":
        from .demo import end_to_end_demo
        end_to_end_demo(
            email=args.email,
            password=args.password,
            client_id=args.client_id,
            refresh_token=args.refresh_token,
            image_path=args.image_path,
            prompt=args.prompt,
            model=args.model,
            video_ratio=args.ratio,
            video_resolution=args.resolution,
            video_duration=args.duration,
            video_num=args.num,
            output_creds_path=args.creds_out,
        )
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
