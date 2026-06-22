"""示例 2：全自动注册（临时邮箱 + 邮箱验证码）-> 生成视频。

QuickFrame 登录页是「邮箱优先 + 验证码」流程（Auth0 passwordless email）。
本示例完整还原：
  申请临时邮箱 -> 发送验证码 -> 收码 -> 换 access_token -> 生成视频。

注意：
- 首次用某邮箱验证通过即自动创建账号。
- 自动注册可能受风控/人机校验限制；若失败，最稳妥仍是示例 01 的 token 方式。

运行：
    python 02_register_and_generate.py
"""

from quickframe import QuickFrameAuth, TempMail, QuickFrameClient


def main() -> None:
    # 1) 申请临时邮箱（mail.tm）
    mail = TempMail()
    account = mail.create_account()
    email = account["address"]
    print(f"临时邮箱: {email}")

    # 2) Auth0 passwordless：发码 -> 自动收码 -> 换 access_token
    auth = QuickFrameAuth()
    try:
        token = auth.register_with_email_code(email, temp_mail=mail, code_timeout=120)
    except Exception as exc:  # noqa: BLE001
        print(f"自动注册失败（可能是风控/验证码格式变化）：{exc}")
        print("建议改用示例 01 的 token 方式。")
        return

    print(f"拿到 access_token，长度 {len(token)}")

    # 3) 用 token 生成视频
    qf = QuickFrameClient(access_token=token)
    print("当前会话:", qf.get_session().email)

    result = qf.generate_video_from_image(
        image_path="storyboard.png",
        prompt="根据分镜帮我生成视频",
        download_to="output/generated_video.mp4",
    )
    print("完成:", result.video_url, "->", result.local_path)


if __name__ == "__main__":
    main()
