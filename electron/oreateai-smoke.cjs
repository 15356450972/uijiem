const { app, BrowserWindow } = require('electron');
const { registerOreateaiWithBrowser } = require('./oreateai-browser.cjs');

const stepLabels = {
  mailbox_connecting: '连接小苹果邮件 API',
  browser_opening: '启动真实 Chromium',
  ticket_request: '获取注册票据',
  risk_request: '生成页面风控凭证',
  signup_submit: '提交注册',
  email_wait: '等待验证邮件',
  email_verify: '打开验证链接',
  login_check: '确认登录状态',
  complete: '导出 Cookie',
};

app.whenReady().then(async () => {
  try {
    const state = await registerOreateaiWithBrowser({
      app,
      BrowserWindow,
      mailbox: {
        email: process.env.OREATEAI_MAIL_EMAIL,
        client_id: process.env.OREATEAI_MAIL_CLIENT_ID,
        refresh_token: process.env.OREATEAI_MAIL_REFRESH_TOKEN,
        api_url: process.env.OREATEAI_MAIL_API_URL,
      },
      visible: process.env.OREATEAI_HEADLESS !== '1',
      keepOpen: false,
      mailTimeout: Number(process.env.OREATEAI_MAIL_TIMEOUT || 180000),
      onStep: (step, data) => {
        const detail = data?.email ? ` ${data.email}` : '';
        console.log(`[oreateai-smoke] ${stepLabels[step] || step}${detail}`);
      },
    });
    let persisted = null;
    const persistUrl = process.env.OREATEAI_PERSIST_URL;
    if (persistUrl) {
      const response = await fetch(`${persistUrl.replace(/\/$/, '')}/oreateai/accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: state.email,
          password: state.password,
          cookie: state.cookie,
          cookies: state.cookies,
          user_agent: state.user_agent,
          location: state.location,
          note: 'Electron Chromium 冒烟测试',
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.detail || '渠道8账号持久化失败');
      persisted = {
        id: payload.data?.id,
        configured: payload.data?.configured,
        cookieCount: payload.data?.cookie_count,
      };
    }
    console.log(`[oreateai-smoke] success ${JSON.stringify({
      email: state.email,
      passwordLength: state.password.length,
      passwordValid: /^(?=.*\d)(?=.*[A-Za-z])(?=.*[^A-Za-z0-9]).{8,16}$/.test(state.password),
      cookieCount: state.cookies.length,
      location: state.location,
      persisted,
    })}`);
    app.exit(0);
  } catch (error) {
    console.error(`[oreateai-smoke] failed ${error?.stack || error}`);
    app.exit(1);
  }
});