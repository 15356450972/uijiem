# Framia 独立注册脚本

这个目录是独立版注册入口，不依赖外层 `framia_test.py`。

## 安装依赖

```bash
cd "/Users/mengjun/编程/2/framia_register_standalone"
python3 -m pip install -r requirements.txt
```

如果 Patchright 浏览器还没安装，执行：

```bash
python3 -m patchright install chromium
```

## 运行

```bash
python3 register.py
```

默认会打开浏览器，自动完成：

1. 生成临时邮箱
2. 建立 GPTMail 收信会话
3. 打开 Framia
4. 触发浏览器 fingerprint
5. 创建 Framia risk-session
6. 跳转 Auth0 注册
7. 自动处理 Turnstile、邮箱验证码、密码提交
8. 回到 Framia 后读取 `/api/auth/token`

## 输出

成功：

```text
framia-token-browser.json
```

失败：

```text
framia-credentials-browser.json
```

## 可选参数

```bash
python3 register.py --headless
python3 register.py --email "xxx@example.com"
python3 register.py --password "YourPassword123@"
python3 register.py --output token.json
```