import React, { useState, useEffect, useRef } from 'react';
import { 
  Settings as SettingsIcon, 
  Folder, 
  HardDrive, 
  Save, 
  Info,
  CheckCircle2,
  Loader2,
  XCircle,
  Activity,
  KeyRound,
  Globe,
  Coins,
  Sparkles,
} from 'lucide-react';
import { WIZSTAR_API, WIZSTAR_PORT } from '../config';

const WIZSTAR_API_FALLBACKS = Array.from(new Set([
  WIZSTAR_API,
  `http://localhost:${WIZSTAR_PORT}`,
  `http://127.0.0.1:${WIZSTAR_PORT}`,
]));

async function fetchLocalApi(path, options) {
  let lastError;
  for (const baseUrl of WIZSTAR_API_FALLBACKS) {
    try {
      return await fetch(`${baseUrl}${path}`, options);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('本地后端不可达');
}

export default function Settings({ focusSection = '' }) {
  const [draftPath, setDraftPath] = useState('D:/daima/uijiem/drafts_cache');
  const [outputPath, setOutputPath] = useState('D:/daima/uijiem/output');
  const [isSaved, setIsSaved] = useState(false);

  // ---- Pixmax 通道配置（渠道二）：API Key ----
  const [pxApiKey, setPxApiKey] = useState('');
  const [pxApiKeyMasked, setPxApiKeyMasked] = useState('');
  const [pxConfigured, setPxConfigured] = useState(false);
  const [pxEnvOverride, setPxEnvOverride] = useState(false);
  const [pxSaving, setPxSaving] = useState(false);
  const [pxTesting, setPxTesting] = useState(false);
  const [pxResult, setPxResult] = useState(null); // { ok, msg }

  // ---- ChatGPT2API 生图配置（渠道五）：API Key + Base URL ----
  const [cgApiKey, setCgApiKey] = useState('');
  const [cgApiKeyMasked, setCgApiKeyMasked] = useState('');
  const [cgBaseUrl, setCgBaseUrl] = useState('http://64.81.113.232:3000');
  const [cgConfigured, setCgConfigured] = useState(false);
  const [cgEnvOverride, setCgEnvOverride] = useState(false);
  const [cgSaving, setCgSaving] = useState(false);
  const [cgTesting, setCgTesting] = useState(false);
  const [cgResult, setCgResult] = useState(null); // { ok, msg }

  const loadCgConfig = async () => {
    try {
      const res = await fetchLocalApi('/chatgpt2api/config');
      const data = await res.json();
      const d = data.data || {};
      setCgConfigured(!!d.configured);
      setCgApiKeyMasked(d.api_key_masked || '');
      setCgBaseUrl(d.base_url || 'http://64.81.113.232:3000');
      setCgEnvOverride(!!d.env_override);
    } catch (_) { /* backend offline */ }
  };

  const saveCgConfig = async (withTest) => {
    withTest ? setCgTesting(true) : setCgSaving(true);
    setCgResult(null);
    try {
      const body = { test: !!withTest, base_url: cgBaseUrl.trim() || 'http://64.81.113.232:3000' };
      if (cgApiKey.trim()) body.api_key = cgApiKey.trim();
      const res = await fetchLocalApi('/chatgpt2api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { const e = await res.json(); msg = e.detail || msg; } catch (_) {}
        throw new Error(msg);
      }
      const data = await res.json();
      const d = data.data || {};
      setCgConfigured(!!d.configured);
      setCgApiKeyMasked(d.api_key_masked || '');
      setCgBaseUrl(d.base_url || cgBaseUrl);
      setCgEnvOverride(!!d.env_override);
      setCgApiKey('');
      if (d.test) {
        setCgResult(d.test.ok
          ? { ok: true, msg: `连接成功，可用模型：${(d.test.models || []).join(', ') || '无返回'}` }
          : { ok: false, msg: d.test.error || '连接测试失败' });
      } else {
        setCgResult({ ok: true, msg: '配置已保存' });
      }
    } catch (e) {
      setCgResult({ ok: false, msg: e.message || String(e) });
    } finally {
      setCgSaving(false);
      setCgTesting(false);
    }
  };

  const loadPxConfig = async () => {
    try {
      const res = await fetchLocalApi('/pixmax/config');
      const data = await res.json();
      const d = data.data || {};
      setPxConfigured(!!d.configured);
      setPxApiKeyMasked(d.api_key_masked || '');
    } catch (_) { /* backend offline */ }
  };

  const savePxConfig = async (withTest) => {
    withTest ? setPxTesting(true) : setPxSaving(true);
    setPxResult(null);
    try {
      const body = { test: !!withTest };
      if (pxApiKey.trim()) body.api_key = pxApiKey.trim();
      const res = await fetchLocalApi('/pixmax/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { const e = await res.json(); msg = e.detail || msg; } catch (_) {}
        throw new Error(msg);
      }
      const data = await res.json();
      const d = data.data || {};
      setPxConfigured(!!d.configured);
      setPxApiKeyMasked(d.api_key_masked || '');
      setPxEnvOverride(!!d.env_override);
      setPxApiKey('');
      if (d.test) {
        setPxResult(d.test.ok
          ? { ok: true, msg: `${d.test.note ? `${d.test.note}；` : ''}连接成功，可用模型：${(d.test.models || []).join(', ') || '无返回'}` }
          : { ok: false, msg: d.test.error || '连接测试失败' });
      } else {
        setPxResult({ ok: true, msg: '配置已保存' });
      }
    } catch (e) {
      setPxResult({ ok: false, msg: e.message || String(e) });
    } finally {
      setPxSaving(false);
      setPxTesting(false);
    }
  };

  // ---- OiiOii 通道配置（渠道四）：代理 + 账号管理 ----
  const [oiConfigured, setOiConfigured] = useState(false);
  const [oiSdkAvailable, setOiSdkAvailable] = useState(false);
  const [oiUseProxy, setOiUseProxy] = useState(true);
  const [oiProxyHost, setOiProxyHost] = useState('127.0.0.1');
  const [oiProxyPort, setOiProxyPort] = useState(7890);
  const [oiMailProvider, setOiMailProvider] = useState('applemail');
  const [oiMailProviderOptions, setOiMailProviderOptions] = useState([
    { id: 'applemail', label: '全局邮箱库（默认）' },
    { id: 'gptmail', label: 'GPTMail' },
    { id: '10minutemail', label: '10MinuteMail.one' },
  ]);
  const [oiAccountCount, setOiAccountCount] = useState(0);
  const [oiSaving, setOiSaving] = useState(false);
  const [oiTesting, setOiTesting] = useState(false);
  const [oiResult, setOiResult] = useState(null); // { ok, msg }
  const [oiRegistering, setOiRegistering] = useState(false);
  const [dolaConfigured, setDolaConfigured] = useState(false);
  const [dolaSendModeLabel, setDolaSendModeLabel] = useState('纯 API（默认）');
  const [dolaConfigHint, setDolaConfigHint] = useState('请手动配置有效的 DOLA_COOKIE 和 DOLA_MS_TOKEN。');
  const [dolaSaving, setDolaSaving] = useState(false);
  const [dolaResult, setDolaResult] = useState(null);
  const [oreateaiRegistering, setOreateaiRegistering] = useState(false);
  const [oreateaiAccountCount, setOreateaiAccountCount] = useState(0);
  const [oreateaiResult, setOreateaiResult] = useState(null);
  const [oreateaiProgress, setOreateaiProgress] = useState('');
  const [framiaAccountCount, setFramiaAccountCount] = useState(0);
  const [framiaLoginEmail, setFramiaLoginEmail] = useState('');
  const [framiaLoginPassword, setFramiaLoginPassword] = useState('');
  const [framiaLoggingIn, setFramiaLoggingIn] = useState(false);
  const [framiaResult, setFramiaResult] = useState(null);
  const [tensorartAccountCount, setTensorartAccountCount] = useState(0);
  const [tensorartRegistering, setTensorartRegistering] = useState(false);
  const [tensorartResult, setTensorartResult] = useState(null);
  const [happyhorseAccountCount, setHappyhorseAccountCount] = useState(0);
  const [happyhorseLoginEmail, setHappyhorseLoginEmail] = useState('');
  const [happyhorseLoginPassword, setHappyhorseLoginPassword] = useState('');
  const [happyhorseLoggingIn, setHappyhorseLoggingIn] = useState(false);
  const [happyhorseQuerying, setHappyhorseQuerying] = useState(false);
  const [happyhorseSigning, setHappyhorseSigning] = useState(false);
  const [happyhorseResult, setHappyhorseResult] = useState(null);
  const [happyhorseCredits, setHappyhorseCredits] = useState(null);
  const [insmindAccountCount, setInsmindAccountCount] = useState(0);
  const [insmindRegistering, setInsmindRegistering] = useState(false);
  const [insmindResult, setInsmindResult] = useState(null);
  const [insmindImportEmail, setInsmindImportEmail] = useState('');
  const [insmindImportToken, setInsmindImportToken] = useState('');
  const [insmindImporting, setInsmindImporting] = useState(false);
  const [insmindUseProxy, setInsmindUseProxy] = useState(true);
  const [insmindProxyHost, setInsmindProxyHost] = useState('us.ipwo.net');
  const [insmindProxyPort, setInsmindProxyPort] = useState(7878);
  const [insmindProxyUser, setInsmindProxyUser] = useState('mengjun66_custom_zone_JP');
  const [insmindProxyPass, setInsmindProxyPass] = useState('mengjun66');
  const [insmindProxySaving, setInsmindProxySaving] = useState(false);
  const [insmindProxyTesting, setInsmindProxyTesting] = useState(false);
  const [insmindProxyResult, setInsmindProxyResult] = useState(null);
  const oiioiiSectionRef = useRef(null);

  const loadOiConfig = async () => {
    try {
      const res = await fetchLocalApi('/oiioii/config');
      const data = await res.json();
      const d = data.data || {};
      setOiConfigured(!!d.configured);
      setOiSdkAvailable(!!d.sdk_available);
      setOiUseProxy(d.use_proxy !== undefined ? d.use_proxy : true);
      setOiProxyHost(d.proxy_host || '127.0.0.1');
      setOiProxyPort(d.proxy_port || 7890);
      setOiMailProvider(['applemail', 'gptmail', '10minutemail'].includes(d.mail_provider) ? d.mail_provider : 'applemail');
      setOiMailProviderOptions(Array.isArray(d.mail_provider_options) && d.mail_provider_options.length > 0
        ? d.mail_provider_options
        : [
            { id: 'applemail', label: '全局邮箱库（默认）' },
            { id: 'gptmail', label: 'GPTMail' },
            { id: '10minutemail', label: '10MinuteMail.one' },
          ]);
      setOiAccountCount(d.account_count || 0);
    } catch (_) { /* backend offline */ }
  };

  const loadDolaConfig = async () => {
    try {
      const res = await fetchLocalApi('/dola/config');
      const data = await res.json();
      const d = data.data || {};
      setDolaConfigured(!!d.configured);
      setDolaSendModeLabel(d.send_mode_label || '纯 API（默认）');
      setDolaConfigHint(d.configuration_hint || '请手动配置有效的 DOLA_COOKIE 和 DOLA_MS_TOKEN。');
    } catch (_) { /* backend offline */ }
  };

  const loadOreateaiAccounts = async () => {
    try {
      const res = await fetchLocalApi('/oreateai/accounts');
      const data = await res.json();
      setOreateaiAccountCount(Array.isArray(data.data) ? data.data.length : 0);
    } catch (_) { /* backend offline */ }
  };

  const loadFramiaAccounts = async () => {
    try {
      const res = await fetchLocalApi('/framia/accounts');
      const data = await res.json();
      setFramiaAccountCount(Array.isArray(data.data) ? data.data.length : 0);
    } catch (_) { /* backend offline */ }
  };

  const loginFramiaAccount = async () => {
    if (!framiaLoginEmail.trim() || !framiaLoginPassword.trim()) {
      setFramiaResult({ ok: false, msg: '请输入邮箱和密码' });
      return;
    }
    setFramiaLoggingIn(true);
    setFramiaResult(null);
    try {
      const res = await fetchLocalApi('/framia/accounts/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: framiaLoginEmail.trim(),
          password: framiaLoginPassword.trim(),
          visible: true,
          keep_open: false,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || '登录失败');
      setFramiaResult({
        ok: true,
        msg: `已登录 ${framiaLoginEmail.trim()}，accessToken 已采集`,
      });
      setFramiaLoginEmail('');
      setFramiaLoginPassword('');
      await loadFramiaAccounts();
    } catch (error) {
      setFramiaResult({ ok: false, msg: error.message || String(error) });
    } finally {
      setFramiaLoggingIn(false);
    }
  };

  const loadTensorartAccounts = async () => {
    try {
      const res = await fetchLocalApi('/tensorart/accounts');
      const data = await res.json();
      const accounts = Array.isArray(data.data) ? data.data : [];
      setTensorartAccountCount(accounts.filter(account => account.configured).length);
    } catch (_) { /* backend offline */ }
  };

  const registerTensorartAccount = async () => {
    setTensorartRegistering(true);
    setTensorartResult(null);
    try {
      const res = await fetchLocalApi('/tensorart/accounts/register-pool', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count: 1, concurrency: 1 }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || '注册失败');
      const result = data.data || {};
      if (!result.succeeded) {
        const error = (result.results || []).find(item => !item.ok)?.error;
        throw new Error(error || '注册失败');
      }
      setTensorartResult({ ok: true, msg: '渠道十账号注册并登录成功' });
      await loadTensorartAccounts();
    } catch (error) {
      setTensorartResult({ ok: false, msg: error.message || String(error) });
    } finally {
      setTensorartRegistering(false);
    }
  };

  const loadHappyhorseAccounts = async () => {
    try {
      const res = await fetchLocalApi('/happyhorse/accounts');
      const data = await res.json();
      const accounts = Array.isArray(data.data) ? data.data : [];
      setHappyhorseAccountCount(accounts.filter((a) => a.has_token || a.configured).length || accounts.length);
    } catch (_) { /* backend offline */ }
  };

  const loginHappyhorseAccount = async () => {
    if (!happyhorseLoginEmail.trim() || !happyhorseLoginPassword.trim()) {
      setHappyhorseResult({ ok: false, msg: '请输入邮箱和密码' });
      return;
    }
    setHappyhorseLoggingIn(true);
    setHappyhorseResult(null);
    try {
      const res = await fetchLocalApi('/happyhorse/accounts/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: happyhorseLoginEmail.trim(),
          password: happyhorseLoginPassword.trim(),
          visible: true,
          keep_open: false,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || '登录失败');
      const skipped = Boolean(data?.data?.skipped);
      setHappyhorseResult({
        ok: true,
        msg: skipped
          ? `${happyhorseLoginEmail.trim()} 此前已登录，已跳过重复登录`
          : `已登录 ${happyhorseLoginEmail.trim()}，accessToken 已采集`,
      });
      if (!skipped) {
        setHappyhorseLoginEmail('');
        setHappyhorseLoginPassword('');
      }
      await loadHappyhorseAccounts();
    } catch (error) {
      setHappyhorseResult({ ok: false, msg: error.message || String(error) });
    } finally {
      setHappyhorseLoggingIn(false);
    }
  };

  const queryHappyhorseCredits = async () => {
    setHappyhorseQuerying(true);
    setHappyhorseResult(null);
    try {
      const res = await fetchLocalApi('/happyhorse/credits');
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || '查询积分失败');
      const credits = data.data || {};
      setHappyhorseCredits(credits);
      setHappyhorseResult({
        ok: true,
        msg: `${credits.account_name || '账号'} 可用积分 ${credits.credits_balance ?? credits.available_count ?? '-'}`,
      });
    } catch (error) {
      setHappyhorseResult({ ok: false, msg: error.message || String(error) });
    } finally {
      setHappyhorseQuerying(false);
    }
  };

  const signinHappyhorseDaily = async () => {
    setHappyhorseSigning(true);
    setHappyhorseResult(null);
    try {
      const res = await fetchLocalApi('/happyhorse/credits/daily-signin', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || '每日签到失败');
      const result = data.data || {};
      setHappyhorseCredits({
        credits_balance: result.credits_balance,
        available_count: result.available_count,
        play_code_details: result.play_code_details,
        account_name: result.account_name,
        account_id: result.account_id,
      });
      setHappyhorseResult({
        ok: true,
        msg: `签到成功 +${result.grant_points ?? 0}，当前可用 ${result.credits_balance ?? result.available_count ?? '-'}`,
      });
    } catch (error) {
      setHappyhorseResult({ ok: false, msg: error.message || String(error) });
    } finally {
      setHappyhorseSigning(false);
    }
  };

  const loadInsmindAccounts = async () => {
    try {
      const res = await fetchLocalApi('/insmind/accounts');
      const data = await res.json();
      const accounts = Array.isArray(data.data) ? data.data : [];
      setInsmindAccountCount(accounts.filter((a) => a.configured || a.has_token).length || accounts.length);
    } catch (_) { /* backend offline */ }
  };

  const loadInsmindConfig = async () => {
    try {
      const res = await fetchLocalApi('/insmind/config');
      const data = await res.json();
      const d = data.data || {};
      setInsmindUseProxy(d.use_proxy !== undefined ? !!d.use_proxy : true);
      setInsmindProxyHost(d.proxy_host || 'us.ipwo.net');
      setInsmindProxyPort(d.proxy_port || 7878);
      setInsmindProxyUser(d.proxy_user || 'mengjun66_custom_zone_JP');
      if (d.proxy_pass) setInsmindProxyPass(d.proxy_pass);
      setInsmindAccountCount(d.account_count || 0);
    } catch (_) { /* backend offline */ }
  };

  const saveInsmindProxyConfig = async (withTest = false) => {
    setInsmindProxySaving(true);
    if (withTest) setInsmindProxyTesting(true);
    setInsmindProxyResult(null);
    try {
      const res = await fetchLocalApi('/insmind/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          use_proxy: insmindUseProxy,
          proxy_host: insmindProxyHost,
          proxy_port: parseInt(insmindProxyPort, 10) || 7878,
          proxy_user: insmindProxyUser,
          proxy_pass: insmindProxyPass,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || '保存失败');
      const d = data.data || {};
      setInsmindUseProxy(!!d.use_proxy);
      setInsmindProxyHost(d.proxy_host || insmindProxyHost);
      setInsmindProxyPort(d.proxy_port || insmindProxyPort);
      setInsmindProxyUser(d.proxy_user || insmindProxyUser);

      if (withTest) {
        const testRes = await fetchLocalApi('/insmind/test-proxy', { method: 'POST' });
        const testData = await testRes.json().catch(() => ({}));
        if (!testRes.ok) throw new Error(testData.detail || '代理测试失败');
        const t = testData.data || {};
        setInsmindProxyResult({
          ok: !!t.ok,
          msg: t.message || (t.ok ? `出口 IP: ${t.exit_ip}` : '代理测试失败'),
        });
      } else {
        setInsmindProxyResult({ ok: true, msg: '动态代理配置已保存' });
      }
    } catch (error) {
      setInsmindProxyResult({ ok: false, msg: error.message || String(error) });
    } finally {
      setInsmindProxySaving(false);
      setInsmindProxyTesting(false);
    }
  };

  const registerInsmindAccount = async () => {
    setInsmindRegistering(true);
    setInsmindResult(null);
    try {
      const res = await fetchLocalApi('/insmind/accounts/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson, application/json' },
        body: JSON.stringify({ count: 1, concurrency: 1 }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail || '注册失败');
      }

      let finalSummary = null;
      let lastError = '';
      const contentType = String(res.headers.get('content-type') || '');
      if (!res.body || !res.body.getReader || contentType.includes('application/json')) {
        const data = await res.json().catch(() => ({}));
        finalSummary = data.data || {};
      } else {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            let event;
            try {
              event = JSON.parse(trimmed);
            } catch {
              continue;
            }
            if (event.event === 'item' && event.result && !event.result.ok) {
              lastError = event.result.error || lastError;
            }
            if (event.event === 'done') finalSummary = event;
            if (event.event === 'error') throw new Error(event.error || '注册失败');
          }
        }
      }

      const result = finalSummary || {};
      if (!result.succeeded) {
        const error = lastError
          || (result.results || []).find((item) => !item.ok)?.error
          || '注册失败';
        throw new Error(error);
      }
      setInsmindResult({ ok: true, msg: `渠道十二注册成功：${result.results?.[0]?.email || '已入库'}` });
      await loadInsmindAccounts();
    } catch (error) {
      setInsmindResult({ ok: false, msg: error.message || String(error) });
    } finally {
      setInsmindRegistering(false);
    }
  };

  const importInsmindAccount = async () => {
    if (!insmindImportEmail.trim() || !insmindImportToken.trim()) {
      setInsmindResult({ ok: false, msg: '请填写邮箱与 access_token' });
      return;
    }
    setInsmindImporting(true);
    setInsmindResult(null);
    try {
      const res = await fetchLocalApi('/insmind/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: insmindImportEmail.trim(),
          access_token: insmindImportToken.trim(),
          note: '设置页手动导入',
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || '导入失败');
      setInsmindResult({ ok: true, msg: `已导入 ${insmindImportEmail.trim()}` });
      setInsmindImportEmail('');
      setInsmindImportToken('');
      await loadInsmindAccounts();
    } catch (error) {
      setInsmindResult({ ok: false, msg: error.message || String(error) });
    } finally {
      setInsmindImporting(false);
    }
  };

  useEffect(() => {
    loadPxConfig();
    loadCgConfig();
    loadOiConfig();
    loadDolaConfig();
    loadOreateaiAccounts();
    loadFramiaAccounts();
    loadTensorartAccounts();
    loadHappyhorseAccounts();
    loadInsmindAccounts();
    loadInsmindConfig();
  }, []);

  useEffect(() => {
    if (!window.electronAPI?.onOreateaiLoginProgress) return undefined;
    const labels = {
      mailbox_connecting: '正在连接小苹果邮件 API...',
      browser_opening: '正在启动真实 Chromium...',
      ticket_request: '正在获取注册票据...',
      risk_request: '正在由页面风控运行时生成凭证...',
      signup_submit: '正在提交注册...',
      email_wait: '正在等待验证邮件...',
      email_verify: '正在打开邮箱验证链接...',
      login_check: '正在确认登录状态...',
      complete: '登录成功，正在导出 Cookie...',
    };
    return window.electronAPI.onOreateaiLoginProgress(({ step }) => {
      setOreateaiProgress(labels[step] || step || '');
    });
  }, []);

  useEffect(() => {
    if (focusSection === 'oiioii') {
      setTimeout(() => {
        oiioiiSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 120);
    }
  }, [focusSection]);

  const saveOiConfig = async (withTest) => {
    withTest ? setOiTesting(true) : setOiSaving(true);
    setOiResult(null);
    try {
      const body = {
        use_proxy: oiUseProxy,
        proxy_host: oiProxyHost,
        proxy_port: parseInt(oiProxyPort) || 7890,
        mail_provider: oiMailProvider,
        test: !!withTest,
      };
      const res = await fetchLocalApi('/oiioii/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { const e = await res.json(); msg = e.detail || msg; } catch (_) {}
        throw new Error(msg);
      }
      const data = await res.json();
      const d = data.data || {};
      setOiConfigured(!!d.configured);
      setOiSdkAvailable(!!d.sdk_available);
      setOiAccountCount(d.account_count || 0);
      setOiMailProvider(['applemail', 'gptmail', '10minutemail'].includes(d.mail_provider) ? d.mail_provider : 'applemail');
      setOiMailProviderOptions(Array.isArray(d.mail_provider_options) && d.mail_provider_options.length > 0 ? d.mail_provider_options : oiMailProviderOptions);
      if (d.test) {
        setOiResult(d.test.ok
          ? { ok: true, msg: `SDK 可用，支持模型：图片 ${Object.keys(d.test.models?.image || {}).join(', ')}；视频 ${Object.keys(d.test.models?.video || {}).join(', ')}` }
          : { ok: false, msg: d.test.error || '连接测试失败' });
      } else {
        setOiResult({ ok: true, msg: '配置已保存' });
      }
    } catch (e) {
      setOiResult({ ok: false, msg: e.message || String(e) });
    } finally {
      setOiSaving(false);
      setOiTesting(false);
    }
  };

  const saveDolaConfig = async () => {
    setDolaSaving(true);
    setDolaResult(null);
    try {
      const res = await fetchLocalApi('/dola/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ send_mode: 'api' }),
      });
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { const e = await res.json(); msg = e.detail || msg; } catch (_) {}
        throw new Error(msg);
      }
      const data = await res.json();
      const d = data.data || {};
      setDolaConfigured(!!d.configured);
      setDolaSendModeLabel(d.send_mode_label || '纯 API（默认）');
      setDolaConfigHint(d.configuration_hint || '请手动配置有效的 DOLA_COOKIE 和 DOLA_MS_TOKEN。');
      setDolaResult({ ok: true, msg: d.configured ? '已保存：纯 API 模式已启用。' : (d.configuration_hint || '已保存：请手动配置有效的 DOLA_COOKIE 和 DOLA_MS_TOKEN。') });
    } catch (e) {
      setDolaResult({ ok: false, msg: e.message || String(e) });
    } finally {
      setDolaSaving(false);
    }
  };

  const registerOiAccount = async () => {
    setOiRegistering(true);
    setOiResult(null);
    try {
      const res = await fetchLocalApi('/oiioii/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mail_provider: oiMailProvider }),
      });
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { const e = await res.json(); msg = e.detail || msg; } catch (_) {}
        throw new Error(msg);
      }
      const data = await res.json();
      const d = data.data || {};
      if (d.success) {
        setOiResult({ ok: true, msg: `注册成功：${d.email}，积分 ${d.points ?? '?'}` });
        loadOiConfig();
      } else {
        setOiResult({ ok: false, msg: d.error || '注册失败' });
      }
    } catch (e) {
      setOiResult({ ok: false, msg: e.message || String(e) });
    } finally {
      setOiRegistering(false);
    }
  };

  const registerOreateaiAccount = async () => {
    if (!window.electronAPI?.oreateaiRegisterLogin) {
      setOreateaiResult({ ok: false, msg: '请在 Electron 桌面端中使用真实浏览器注册' });
      return;
    }
    setOreateaiRegistering(true);
    setOreateaiResult(null);
    setOreateaiProgress('正在准备注册...');
    try {
      const result = await window.electronAPI.oreateaiRegisterLogin({ visible: true, keepOpen: false });
      if (!result?.ok) throw new Error(result?.error || 'OreateAI 注册登录失败');
      const single = result.results?.[0] || result;
      if (!single?.ok) throw new Error(single?.error || 'OreateAI 注册登录失败');
      setOreateaiResult({
        ok: true,
        msg: `已登录 ${single.email}，导出 ${single.cookieCount} 个 Cookie`,
      });
      await loadOreateaiAccounts();
    } catch (error) {
      setOreateaiResult({ ok: false, msg: error.message || String(error) });
    } finally {
      setOreateaiRegistering(false);
    }
  };

  const selectFolder = async (type) => {
    if (window.electronAPI) {
      const selected = await window.electronAPI.selectDirectory();
      if (selected) {
        if (type === 'draft') setDraftPath(selected);
        if (type === 'output') setOutputPath(selected);
      }
    } else {
      const selected = prompt('请模拟文件夹选择，输入路径:', type === 'draft' ? draftPath : outputPath);
      if (selected) {
        if (type === 'draft') setDraftPath(selected);
        if (type === 'output') setOutputPath(selected);
      }
    }
  };

  const handleSave = (e) => {
    e.preventDefault();
    setIsSaved(true);
    setTimeout(() => {
      setIsSaved(false);
    }, 2500);
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-dark-bg/20">
      {/* Settings Header */}
      <div className="h-14 border-b border-dark-border px-6 flex items-center justify-between shrink-0 bg-dark-bg/40">
        <div className="flex items-center space-x-2">
          <SettingsIcon className="w-4 h-4 text-brand" />
          <span className="text-sm font-bold text-white">系统全局设置</span>
        </div>
      </div>

      {/* Settings Form scroll body */}
      <div className="flex-1 overflow-y-auto p-6 no-scrollbar max-w-3xl">
        <form onSubmit={handleSave} className="space-y-6">
          
          {/* SECTION 1: Paths / File Directories */}
          <div className="space-y-4">
            <div className="flex items-center space-x-2 border-b border-dark-border/40 pb-1.5">
              <HardDrive className="w-4 h-4 text-brand" />
              <h3 className="text-xs font-bold text-white uppercase tracking-wider">路径与本地目录</h3>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="text-[10px] font-bold text-dark-muted uppercase">本地草稿高速缓存目录</label>
                <div className="flex space-x-1.5">
                  <input 
                    type="text" 
                    value={draftPath}
                    readOnly
                    className="flex-1 bg-dark-input text-xs border border-dark-border focus:outline-none rounded-lg p-2.5 text-dark-muted truncate"
                  />
                  <button 
                    type="button"
                    onClick={() => selectFolder('draft')}
                    className="px-3 bg-dark-card border border-dark-border hover:border-brand/40 text-xs text-white rounded-lg flex items-center justify-center shrink-0 hover:bg-dark-cardHover transition-colors"
                  >
                    <Folder className="w-4 h-4" />
                  </button>
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-[10px] font-bold text-dark-muted uppercase">渲染视频默认导出目录</label>
                <div className="flex space-x-1.5">
                  <input 
                    type="text" 
                    value={outputPath}
                    readOnly
                    className="flex-1 bg-dark-input text-xs border border-dark-border focus:outline-none rounded-lg p-2.5 text-dark-muted truncate"
                  />
                  <button 
                    type="button"
                    onClick={() => selectFolder('output')}
                    className="px-3 bg-dark-card border border-dark-border hover:border-brand/40 text-xs text-white rounded-lg flex items-center justify-center shrink-0 hover:bg-dark-cardHover transition-colors"
                  >
                    <Folder className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* SECTION 2: Pixmax 通道（渠道二）— API Key */}
          <div className="space-y-4">
            <div className="flex items-center justify-between border-b border-dark-border/40 pb-1.5">
              <div className="flex items-center space-x-2">
                <KeyRound className="w-4 h-4 text-brand" />
                <h3 className="text-xs font-bold text-white uppercase tracking-wider">渠道二</h3>
              </div>
              {pxConfigured ? (
                <span className="flex items-center space-x-1 text-[10px] text-brand font-bold">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>已配置</span>
                </span>
              ) : (
                <span className="flex items-center space-x-1 text-[10px] text-amber-400 font-bold">
                  <XCircle className="w-3.5 h-3.5" />
                  <span>未配置</span>
                </span>
              )}
            </div>

            <div className="grid grid-cols-1 gap-4">
              <div className="space-y-1.5">
                <label className="text-[10px] font-bold text-dark-muted uppercase">
                  API KEY {pxApiKeyMasked && <span className="text-dark-subtle normal-case font-normal">（当前：{pxApiKeyMasked}）</span>}
                </label>
                <input
                  type="password"
                  value={pxApiKey}
                  onChange={(e) => setPxApiKey(e.target.value)}
                  placeholder={pxConfigured ? '已保存，留空则不修改；如需更换请输入新 Key' : '请输入 API Key'}
                  className="w-full bg-dark-input text-xs border border-dark-border focus:border-brand focus:outline-none rounded-lg p-2.5 text-white"
                />
                <span className="text-[9px] text-dark-subtle block">推荐使用后台为你单独发放的「用户 Key」，可按配额/并发计量。Key 仅保存在本机配置文件。</span>
              </div>
            </div>

            {pxEnvOverride && (
              <div className="text-[10px] text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
                检测到环境变量 PIXMAX_API_KEY 已设置，它会覆盖这里保存的值。如需用界面配置，请移除该环境变量后重启后端。
              </div>
            )}

            <div className="flex items-center flex-wrap gap-3">
              <button
                type="button"
                onClick={() => savePxConfig(false)}
                disabled={pxSaving || pxTesting}
                className="flex items-center space-x-1.5 px-4 py-2 bg-brand hover:bg-brand-dark disabled:opacity-50 rounded-lg text-xs text-black font-bold transition-all"
              >
                {pxSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                <span>保存</span>
              </button>
              <button
                type="button"
                onClick={() => savePxConfig(true)}
                disabled={pxSaving || pxTesting}
                className="flex items-center space-x-1.5 px-4 py-2 bg-dark-card border border-dark-border hover:border-brand/40 disabled:opacity-50 rounded-lg text-xs text-white font-bold transition-all"
              >
                {pxTesting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Activity className="w-3.5 h-3.5" />}
                <span>保存并测试连接</span>
              </button>

              {pxResult && (
                <span className={`flex items-center space-x-1.5 text-[11px] font-medium ${pxResult.ok ? 'text-brand' : 'text-red-400'}`}>
                  {pxResult.ok ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> : <XCircle className="w-3.5 h-3.5 shrink-0" />}
                  <span>{pxResult.msg}</span>
                </span>
              )}
            </div>
          </div>

          {/* SECTION 3: ChatGPT2API 生图通道（渠道五）— API Key */}
          <div className="space-y-4">
            <div className="flex items-center justify-between border-b border-dark-border/40 pb-1.5">
              <div className="flex items-center space-x-2">
                <KeyRound className="w-4 h-4 text-brand" />
                <h3 className="text-xs font-bold text-white uppercase tracking-wider">渠道五（GPT-Image2 生图）</h3>
              </div>
              {cgConfigured ? (
                <span className="flex items-center space-x-1 text-[10px] text-brand font-bold">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>已配置</span>
                </span>
              ) : (
                <span className="flex items-center space-x-1 text-[10px] text-amber-400 font-bold">
                  <XCircle className="w-3.5 h-3.5" />
                  <span>未配置</span>
                </span>
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="text-[10px] font-bold text-dark-muted uppercase">
                  API KEY {cgApiKeyMasked && <span className="text-dark-subtle normal-case font-normal">（当前：{cgApiKeyMasked}）</span>}
                </label>
                <input
                  type="password"
                  value={cgApiKey}
                  onChange={(e) => setCgApiKey(e.target.value)}
                  placeholder={cgConfigured ? '已保存，留空则不修改；如需更换请输入新 Key' : '请输入 API Key'}
                  className="w-full bg-dark-input text-xs border border-dark-border focus:border-brand focus:outline-none rounded-lg p-2.5 text-white"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-[10px] font-bold text-dark-muted uppercase">Base URL</label>
                <input
                  type="text"
                  value={cgBaseUrl}
                  onChange={(e) => setCgBaseUrl(e.target.value)}
                  placeholder="http://64.81.113.232:3000"
                  className="w-full bg-dark-input text-xs border border-dark-border focus:border-brand focus:outline-none rounded-lg p-2.5 text-white"
                />
              </div>
            </div>

            <span className="text-[9px] text-dark-subtle block">对接文档中的 chatgpt2api 图片接口，支持文生图和带垫图的图生图；Key 仅保存在本机配置文件。</span>

            {cgEnvOverride && (
              <div className="text-[10px] text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
                检测到环境变量 CHATGPT2API_API_KEY 已设置，它会覆盖这里保存的值。如需用界面配置，请移除该环境变量后重启后端。
              </div>
            )}

            <div className="flex items-center flex-wrap gap-3">
              <button
                type="button"
                onClick={() => saveCgConfig(false)}
                disabled={cgSaving || cgTesting}
                className="flex items-center space-x-1.5 px-4 py-2 bg-brand hover:bg-brand-dark disabled:opacity-50 rounded-lg text-xs text-black font-bold transition-all"
              >
                {cgSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                <span>保存</span>
              </button>
              <button
                type="button"
                onClick={() => saveCgConfig(true)}
                disabled={cgSaving || cgTesting}
                className="flex items-center space-x-1.5 px-4 py-2 bg-dark-card border border-dark-border hover:border-brand/40 disabled:opacity-50 rounded-lg text-xs text-white font-bold transition-all"
              >
                {cgTesting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Activity className="w-3.5 h-3.5" />}
                <span>保存并测试连接</span>
              </button>

              {cgResult && (
                <span className={`flex items-center space-x-1.5 text-[11px] font-medium ${cgResult.ok ? 'text-brand' : 'text-red-400'}`}>
                  {cgResult.ok ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> : <XCircle className="w-3.5 h-3.5 shrink-0" />}
                  <span>{cgResult.msg}</span>
                </span>
              )}
            </div>
          </div>

          {/* SECTION 4: OiiOii 通道（渠道四）— 代理 + 自动注册账号 */}
          <div ref={oiioiiSectionRef} className="space-y-4 scroll-mt-4">
            <div className="flex items-center justify-between border-b border-dark-border/40 pb-1.5">
              <div className="flex items-center space-x-2">
                <KeyRound className="w-4 h-4 text-brand" />
                <h3 className="text-xs font-bold text-white uppercase tracking-wider">渠道四（OiiOii）</h3>
              </div>
              {oiConfigured ? (
                <span className="flex items-center space-x-1 text-[10px] text-brand font-bold">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>已配置（{oiAccountCount} 个账号）</span>
                </span>
              ) : (
                <span className="flex items-center space-x-1 text-[10px] text-amber-400 font-bold">
                  <XCircle className="w-3.5 h-3.5" />
                  <span>{oiSdkAvailable ? '需注册账号' : 'SDK 不可用'}</span>
                </span>
              )}
            </div>

            {!oiSdkAvailable && (
              <div className="text-[10px] text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
                未检测到 oiioii-sdk 目录。请确保项目根目录下存在 <code className="text-brand font-mono">oiioii-sdk/</code> 文件夹，且已运行 <code className="text-brand font-mono">npm install</code> 安装依赖。
              </div>
            )}

            {/* 代理配置 */}
            <div className="space-y-2.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-2">
                  <Globe className="w-3.5 h-3.5 text-dark-muted" />
                  <span className="text-[10px] font-bold text-dark-muted uppercase">本地代理</span>
                </div>
                <button
                  type="button"
                  onClick={() => setOiUseProxy((v) => !v)}
                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${oiUseProxy ? 'bg-brand' : 'bg-dark-border'}`}
                  title={oiUseProxy ? '已开启代理' : '未开启代理（直连）'}
                >
                  <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${oiUseProxy ? 'translate-x-4' : 'translate-x-1'}`} />
                </button>
              </div>

              <div className={`grid grid-cols-2 gap-3 transition-opacity ${oiUseProxy ? 'opacity-100' : 'opacity-40 pointer-events-none'}`}>
                <div className="space-y-1">
                  <label className="text-[9px] font-bold text-dark-subtle uppercase">代理 Host</label>
                  <input
                    type="text"
                    value={oiProxyHost}
                    onChange={(e) => setOiProxyHost(e.target.value)}
                    placeholder="127.0.0.1"
                    className="w-full bg-dark-input text-xs border border-dark-border focus:border-brand focus:outline-none rounded-lg p-2 text-white"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[9px] font-bold text-dark-subtle uppercase">代理 Port</label>
                  <input
                    type="number"
                    value={oiProxyPort}
                    onChange={(e) => setOiProxyPort(e.target.value)}
                    placeholder="7890"
                    className="w-full bg-dark-input text-xs border border-dark-border focus:border-brand focus:outline-none rounded-lg p-2 text-white"
                  />
                </div>
              </div>
              <span className="text-[9px] text-dark-subtle block">OiiOii API 需要海外出口，默认通过本地 Clash 代理（127.0.0.1:7890）访问。关闭则直连。</span>
            </div>

            <div className="space-y-2.5">
              <div className="flex items-center space-x-2">
                <KeyRound className="w-3.5 h-3.5 text-dark-muted" />
                <span className="text-[10px] font-bold text-dark-muted uppercase">注册邮箱来源</span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {oiMailProviderOptions.map((option) => {
                  const active = oiMailProvider === option.id;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      onClick={() => setOiMailProvider(option.id)}
                      className={`rounded-xl border px-4 py-3 text-left transition-all ${active ? 'border-brand bg-brand/10 text-white' : 'border-dark-border bg-dark-card text-dark-muted hover:border-brand/40 hover:text-white'}`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-bold">{option.label}</span>
                        {active && <CheckCircle2 className="w-4 h-4 text-brand" />}
                      </div>
                      <div className="mt-1 text-[10px] leading-relaxed text-current/70">
                        {option.id === 'applemail'
                          ? '从全局邮箱库领取尚未用于渠道四的 Microsoft OAuth 邮箱，并通过小苹果 API 收取验证码。'
                          : option.id === '10minutemail'
                            ? '使用 10MinuteMail.one 的 .com 临时邮箱接收渠道四注册验证邮件。'
                            : '使用原有 GPTMail 临时邮箱流程。'}
                      </div>
                    </button>
                  );
                })}
              </div>
              <span className="text-[9px] text-dark-subtle block">保存后，设置页自动注册和账号库批量注册都会使用这里选择的邮箱来源。</span>
            </div>

            <div className="flex items-center flex-wrap gap-3">
              <button
                type="button"
                onClick={() => saveOiConfig(false)}
                disabled={oiSaving || oiTesting || oiRegistering}
                className="flex items-center space-x-1.5 px-4 py-2 bg-brand hover:bg-brand-dark disabled:opacity-50 rounded-lg text-xs text-black font-bold transition-all"
              >
                {oiSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                <span>保存</span>
              </button>
              <button
                type="button"
                onClick={() => saveOiConfig(true)}
                disabled={oiSaving || oiTesting || oiRegistering}
                className="flex items-center space-x-1.5 px-4 py-2 bg-dark-card border border-dark-border hover:border-brand/40 disabled:opacity-50 rounded-lg text-xs text-white font-bold transition-all"
              >
                {oiTesting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Activity className="w-3.5 h-3.5" />}
                <span>测试 SDK</span>
              </button>
              <button
                type="button"
                onClick={registerOiAccount}
                disabled={oiSaving || oiTesting || oiRegistering || !oiSdkAvailable}
                className="flex items-center space-x-1.5 px-4 py-2 bg-dark-card border border-dark-border hover:border-brand/40 disabled:opacity-50 rounded-lg text-xs text-white font-bold transition-all"
                title="全自动注册 OiiOii 账号（临时邮箱 + 验证码破解，约 30-120 秒）"
              >
                {oiRegistering ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <KeyRound className="w-3.5 h-3.5" />}
                <span>自动注册账号</span>
              </button>

              {oiResult && (
                <span className={`flex items-center space-x-1.5 text-[11px] font-medium ${oiResult.ok ? 'text-brand' : 'text-red-400'}`}>
                  {oiResult.ok ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> : <XCircle className="w-3.5 h-3.5 shrink-0" />}
                  <span>{oiResult.msg}</span>
                </span>
              )}
            </div>

            <span className="text-[9px] text-dark-subtle block">
              渠道四支持多种视频模型（Gemini、Seedance、Sora2、Vidu 等）和图片模型（GPT-Image2、Nano、Midjourney 等），通过自动注册的账号积分生成。
            </span>
          </div>

          {/* SECTION 5: Dola 通道（渠道六）— 发送方式 */}
          <div className="space-y-4">
            <div className="flex items-center justify-between border-b border-dark-border/40 pb-1.5">
              <div className="flex items-center space-x-2">
                <Globe className="w-4 h-4 text-brand" />
                <h3 className="text-xs font-bold text-white uppercase tracking-wider">渠道六（Dola）</h3>
              </div>
              <span className={`flex items-center space-x-1 text-[10px] font-bold ${dolaConfigured ? 'text-brand' : 'text-amber-400'}`}>
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>{dolaSendModeLabel}</span>
              </span>
            </div>

            <div className="space-y-2.5">
              <div className="rounded-xl border border-dark-border bg-dark-card px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-bold text-white">纯 API 模式</div>
                    <div className="mt-1 text-[10px] leading-relaxed text-dark-subtle">
                      渠道六的生成、轮询、URL 解析、下载、单项/批量采集和失败恢复只走后端 Dola API。浏览器入口仅保留给用户手动授权、登录或诊断，不作为自动回退。
                    </div>
                  </div>
                  <span className="shrink-0 rounded-full border border-brand/30 bg-brand/10 px-2.5 py-1 text-[10px] font-bold text-brand">
                    API-only
                  </span>
                </div>
                <div className="mt-2 text-[10px] leading-relaxed text-dark-subtle">
                  {dolaConfigHint}
                </div>
              </div>
            </div>

            <div className="flex items-center flex-wrap gap-3">
              <button
                type="button"
                onClick={saveDolaConfig}
                disabled={dolaSaving}
                className="flex items-center space-x-1.5 px-4 py-2 bg-brand hover:bg-brand-dark disabled:opacity-50 rounded-lg text-xs text-black font-bold transition-all"
              >
                {dolaSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                <span>保存</span>
              </button>

              {dolaResult && (
                <span className={`flex items-center space-x-1.5 text-[11px] font-medium ${dolaResult.ok ? 'text-brand' : 'text-red-400'}`}>
                  {dolaResult.ok ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> : <XCircle className="w-3.5 h-3.5 shrink-0" />}
                  <span>{dolaResult.msg}</span>
                </span>
              )}
            </div>
          </div>

          {/* SECTION 6: OreateAI 渠道八 — 真实 Chromium 注册登录 */}
          <div className="space-y-4">
            <div className="flex items-center justify-between border-b border-dark-border/40 pb-1.5">
              <div className="flex items-center space-x-2">
                <Globe className="w-4 h-4 text-brand" />
                <h3 className="text-xs font-bold text-white uppercase tracking-wider">渠道八（OreateAI）</h3>
              </div>
              <span className={`flex items-center space-x-1 text-[10px] font-bold ${oreateaiAccountCount > 0 ? 'text-brand' : 'text-amber-400'}`}>
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>{oreateaiAccountCount > 0 ? `${oreateaiAccountCount} 个账号` : '未配置'}</span>
              </span>
            </div>

            <div className="rounded-xl border border-dark-border bg-dark-card px-4 py-3">
              <div className="text-sm font-bold text-white">独立真实浏览器注册</div>
              <div className="mt-1 text-[10px] leading-relaxed text-dark-subtle">
                从邮箱库自动选择一个尚未注册的 Microsoft OAuth 邮箱，通过小苹果取件 API 接收验证邮件。Electron 自带 Chromium 完成页面风控和登录确认，成功后 Cookie 自动写入渠道8账号库。
              </div>
            </div>

            <div className="flex items-center flex-wrap gap-3">
              <button
                type="button"
                onClick={registerOreateaiAccount}
                disabled={oreateaiRegistering}
                className="flex items-center space-x-1.5 px-4 py-2 bg-brand hover:bg-brand-dark disabled:opacity-50 rounded-lg text-xs text-black font-bold transition-all"
              >
                {oreateaiRegistering ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <KeyRound className="w-3.5 h-3.5" />}
                <span>{oreateaiRegistering ? '浏览器注册中' : '注册并登录'}</span>
              </button>
              {oreateaiRegistering && oreateaiProgress && (
                <span className="text-[11px] text-dark-muted">{oreateaiProgress}</span>
              )}
              {oreateaiResult && (
                <span className={`flex items-center space-x-1.5 text-[11px] font-medium ${oreateaiResult.ok ? 'text-brand' : 'text-red-400'}`}>
                  {oreateaiResult.ok ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> : <XCircle className="w-3.5 h-3.5 shrink-0" />}
                  <span>{oreateaiResult.msg}</span>
                </span>
              )}
            </div>
          </div>

          {/* SECTION 7: Framia 渠道九 — Google OAuth 登录采集 */}
          <div className="space-y-4">
            <div className="flex items-center justify-between border-b border-dark-border/40 pb-1.5">
              <div className="flex items-center space-x-2">
                <Globe className="w-4 h-4 text-brand" />
                <h3 className="text-xs font-bold text-white uppercase tracking-wider">渠道九（Framia）</h3>
              </div>
              <span className={`flex items-center space-x-1 text-[10px] font-bold ${framiaAccountCount > 0 ? 'text-brand' : 'text-amber-400'}`}>
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>{framiaAccountCount > 0 ? `${framiaAccountCount} 个账号` : '未配置'}</span>
              </span>
            </div>

            <div className="rounded-xl border border-dark-border bg-dark-card px-4 py-3">
              <div className="text-sm font-bold text-white">Google OAuth 自动登录</div>
              <div className="mt-1 text-[10px] leading-relaxed text-dark-subtle">
                输入 Google 账号邮箱和密码，自动启动 Chrome 完成 Framia Google OAuth 登录流程，采集 accessToken 和 cookie。登录成功后账号自动加入渠道九账号库，可用于视频生成任务。
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <input
                  type="email"
                  placeholder="Google 邮箱"
                  value={framiaLoginEmail}
                  onChange={(e) => setFramiaLoginEmail(e.target.value)}
                  className="flex-1 px-3 py-2 bg-dark-bg border border-dark-border rounded-lg text-xs text-white placeholder:text-dark-muted focus:outline-none focus:border-brand"
                />
                <input
                  type="password"
                  placeholder="Google 密码"
                  value={framiaLoginPassword}
                  onChange={(e) => setFramiaLoginPassword(e.target.value)}
                  className="flex-1 px-3 py-2 bg-dark-bg border border-dark-border rounded-lg text-xs text-white placeholder:text-dark-muted focus:outline-none focus:border-brand"
                />
              </div>
              <div className="flex items-center flex-wrap gap-3">
                <button
                  type="button"
                  onClick={loginFramiaAccount}
                  disabled={framiaLoggingIn}
                  className="flex items-center space-x-1.5 px-4 py-2 bg-brand hover:bg-brand-dark disabled:opacity-50 rounded-lg text-xs text-black font-bold transition-all"
                >
                  {framiaLoggingIn ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <KeyRound className="w-3.5 h-3.5" />}
                  <span>{framiaLoggingIn ? '登录中...' : '登录并采集'}</span>
                </button>
                {framiaResult && (
                  <span className={`flex items-center space-x-1.5 text-[11px] font-medium ${framiaResult.ok ? 'text-brand' : 'text-red-400'}`}>
                    {framiaResult.ok ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> : <XCircle className="w-3.5 h-3.5 shrink-0" />}
                    <span>{framiaResult.msg}</span>
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* SECTION 8: Tensor.Art 渠道十 — 邮箱 magic-link 注册 */}
          <div className="space-y-4">
            <div className="flex items-center justify-between border-b border-dark-border/40 pb-1.5">
              <div className="flex items-center space-x-2">
                <Globe className="w-4 h-4 text-violet-300" />
                <h3 className="text-xs font-bold text-white uppercase tracking-wider">渠道十（Tensor.Art）</h3>
              </div>
              <span className={`flex items-center space-x-1 text-[10px] font-bold ${tensorartAccountCount > 0 ? 'text-brand' : 'text-amber-400'}`}>
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>{tensorartAccountCount > 0 ? `${tensorartAccountCount} 个账号` : '未配置'}</span>
              </span>
            </div>

            <div className="rounded-xl border border-dark-border bg-dark-card px-4 py-3">
              <div className="text-sm font-bold text-white">Microsoft OAuth 邮箱纯 API 注册</div>
              <div className="mt-1 text-[10px] leading-relaxed text-dark-subtle">
                自动从全局邮箱库领取一个尚未用于渠道十的 Microsoft OAuth 邮箱，发送 Tensor.Art magic-link、读取邮件并保存 token。遇到 Turnstile 时复用「渠道三」中配置的 YesCaptcha Key。
              </div>
            </div>

            <div className="flex items-center flex-wrap gap-3">
              <button
                type="button"
                onClick={registerTensorartAccount}
                disabled={tensorartRegistering}
                className="flex items-center space-x-1.5 px-4 py-2 bg-violet-500 hover:bg-violet-400 disabled:opacity-50 rounded-lg text-xs text-white font-bold transition-all"
              >
                {tensorartRegistering ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <KeyRound className="w-3.5 h-3.5" />}
                <span>{tensorartRegistering ? '注册并等待邮件...' : '领取邮箱并注册'}</span>
              </button>
              {tensorartResult && (
                <span className={`flex items-center space-x-1.5 text-[11px] font-medium ${tensorartResult.ok ? 'text-brand' : 'text-red-400'}`}>
                  {tensorartResult.ok ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> : <XCircle className="w-3.5 h-3.5 shrink-0" />}
                  <span>{tensorartResult.msg}</span>
                </span>
              )}
            </div>
          </div>

          {/* SECTION 9: HappyHorse 渠道十一 — 登录 / 积分 / 签到 */}
          <div className="space-y-4">
            <div className="flex items-center justify-between border-b border-dark-border/40 pb-1.5">
              <div className="flex items-center space-x-2">
                <Globe className="w-4 h-4 text-emerald-300" />
                <h3 className="text-xs font-bold text-white uppercase tracking-wider">渠道十一（HappyHorse）</h3>
              </div>
              <span className={`flex items-center space-x-1 text-[10px] font-bold ${happyhorseAccountCount > 0 ? 'text-brand' : 'text-amber-400'}`}>
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>{happyhorseAccountCount > 0 ? `${happyhorseAccountCount} 个账号` : '未配置'}</span>
              </span>
            </div>

            <div className="rounded-xl border border-dark-border bg-dark-card px-4 py-3">
              <div className="text-sm font-bold text-white">Google OAuth 登录 + 积分</div>
              <div className="mt-1 text-[10px] leading-relaxed text-dark-subtle">
                登录采集 accessToken 后，可查询可用积分（availableCount），并领取每日签到（DAILY_SIGNIN，通常 +50）。批量管理请到「账号池 → 渠道十一」。
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <input
                  type="email"
                  placeholder="Google 邮箱"
                  value={happyhorseLoginEmail}
                  onChange={(e) => setHappyhorseLoginEmail(e.target.value)}
                  className="flex-1 px-3 py-2 bg-dark-bg border border-dark-border rounded-lg text-xs text-white placeholder:text-dark-muted focus:outline-none focus:border-brand"
                />
                <input
                  type="password"
                  placeholder="Google 密码"
                  value={happyhorseLoginPassword}
                  onChange={(e) => setHappyhorseLoginPassword(e.target.value)}
                  className="flex-1 px-3 py-2 bg-dark-bg border border-dark-border rounded-lg text-xs text-white placeholder:text-dark-muted focus:outline-none focus:border-brand"
                />
              </div>
              <div className="flex items-center flex-wrap gap-3">
                <button
                  type="button"
                  onClick={loginHappyhorseAccount}
                  disabled={happyhorseLoggingIn}
                  className="flex items-center space-x-1.5 px-4 py-2 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 rounded-lg text-xs text-black font-bold transition-all"
                >
                  {happyhorseLoggingIn ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <KeyRound className="w-3.5 h-3.5" />}
                  <span>{happyhorseLoggingIn ? '登录中...' : '登录并采集'}</span>
                </button>
                <button
                  type="button"
                  onClick={queryHappyhorseCredits}
                  disabled={happyhorseQuerying || happyhorseAccountCount === 0}
                  className="flex items-center space-x-1.5 px-4 py-2 bg-yellow-500/20 hover:bg-yellow-500/30 disabled:opacity-50 rounded-lg text-xs text-yellow-300 font-bold transition-all"
                >
                  {happyhorseQuerying ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Coins className="w-3.5 h-3.5" />}
                  <span>{happyhorseQuerying ? '查询中...' : '查询积分'}</span>
                </button>
                <button
                  type="button"
                  onClick={signinHappyhorseDaily}
                  disabled={happyhorseSigning || happyhorseAccountCount === 0}
                  className="flex items-center space-x-1.5 px-4 py-2 bg-brand/20 hover:bg-brand/30 disabled:opacity-50 rounded-lg text-xs text-brand font-bold transition-all"
                >
                  {happyhorseSigning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                  <span>{happyhorseSigning ? '签到中...' : '每日签到'}</span>
                </button>
                {happyhorseResult && (
                  <span className={`flex items-center space-x-1.5 text-[11px] font-medium ${happyhorseResult.ok ? 'text-brand' : 'text-red-400'}`}>
                    {happyhorseResult.ok ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> : <XCircle className="w-3.5 h-3.5 shrink-0" />}
                    <span>{happyhorseResult.msg}</span>
                  </span>
                )}
              </div>
              {happyhorseCredits && (
                <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-[11px] text-emerald-200/90">
                  <div>
                    账号 {happyhorseCredits.account_name || '-'} · 可用积分{' '}
                    <span className="font-bold text-emerald-300">
                      {happyhorseCredits.credits_balance ?? happyhorseCredits.available_count ?? '-'}
                    </span>
                  </div>
                  {Array.isArray(happyhorseCredits.play_code_details) && happyhorseCredits.play_code_details.length > 0 && (
                    <div className="mt-1 text-dark-muted">
                      {happyhorseCredits.play_code_details.map((item) => (
                        <span key={`${item.playCode}-${item.availableCount}`} className="mr-3">
                          {item.playCode}: {item.availableCount}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* SECTION 10: insMind 渠道十二 — 动态代理 + GPTMail 注册 / 导入 token */}
          <div className="space-y-4">
            <div className="flex items-center justify-between border-b border-dark-border/40 pb-1.5">
              <div className="flex items-center space-x-2">
                <Globe className="w-4 h-4 text-sky-300" />
                <h3 className="text-xs font-bold text-white uppercase tracking-wider">渠道十二（insMind）</h3>
              </div>
              <span className={`flex items-center space-x-1 text-[10px] font-bold ${insmindAccountCount > 0 ? 'text-brand' : 'text-amber-400'}`}>
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>{insmindAccountCount > 0 ? `${insmindAccountCount} 个账号` : '未配置'}</span>
              </span>
            </div>

            {/* 动态代理 */}
            <div className="space-y-2.5 rounded-xl border border-dark-border bg-dark-card px-4 py-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-2">
                  <Globe className="w-3.5 h-3.5 text-dark-muted" />
                  <span className="text-[10px] font-bold text-dark-muted uppercase">动态代理（注册用）</span>
                </div>
                <button
                  type="button"
                  onClick={() => setInsmindUseProxy((v) => !v)}
                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${insmindUseProxy ? 'bg-sky-500' : 'bg-dark-border'}`}
                  title={insmindUseProxy ? '已开启动态代理' : '未开启（直连，易限流）'}
                >
                  <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${insmindUseProxy ? 'translate-x-4' : 'translate-x-1'}`} />
                </button>
              </div>
              <div className={`grid grid-cols-2 gap-3 transition-opacity ${insmindUseProxy ? 'opacity-100' : 'opacity-40 pointer-events-none'}`}>
                <div className="space-y-1">
                  <label className="text-[9px] font-bold text-dark-subtle uppercase">主机</label>
                  <input
                    type="text"
                    value={insmindProxyHost}
                    onChange={(e) => setInsmindProxyHost(e.target.value)}
                    placeholder="us.ipwo.net"
                    className="w-full bg-dark-input text-xs border border-dark-border focus:border-sky-500 focus:outline-none rounded-lg p-2 text-white"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[9px] font-bold text-dark-subtle uppercase">端口</label>
                  <input
                    type="number"
                    value={insmindProxyPort}
                    onChange={(e) => setInsmindProxyPort(e.target.value)}
                    placeholder="7878"
                    className="w-full bg-dark-input text-xs border border-dark-border focus:border-sky-500 focus:outline-none rounded-lg p-2 text-white"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[9px] font-bold text-dark-subtle uppercase">用户名</label>
                  <input
                    type="text"
                    value={insmindProxyUser}
                    onChange={(e) => setInsmindProxyUser(e.target.value)}
                    placeholder="mengjun66_custom_zone_JP"
                    className="w-full bg-dark-input text-xs border border-dark-border focus:border-sky-500 focus:outline-none rounded-lg p-2 text-white"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[9px] font-bold text-dark-subtle uppercase">密码</label>
                  <input
                    type="password"
                    value={insmindProxyPass}
                    onChange={(e) => setInsmindProxyPass(e.target.value)}
                    placeholder="proxy password"
                    className="w-full bg-dark-input text-xs border border-dark-border focus:border-sky-500 focus:outline-none rounded-lg p-2 text-white"
                  />
                </div>
              </div>
              <span className="text-[9px] text-dark-subtle block leading-relaxed">
                注册时走动态 IP，可缓解 UMS「短信发送次数超限」(1001012)。面板里的短用户名 <code className="text-sky-300 font-mono">mengjun66</code> 会 407，需带 zone 的完整用户名（默认已填）。
              </span>
              <div className="flex items-center flex-wrap gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => saveInsmindProxyConfig(false)}
                  disabled={insmindProxySaving || insmindProxyTesting}
                  className="flex items-center space-x-1.5 px-3 py-1.5 bg-sky-500/15 hover:bg-sky-500/25 disabled:opacity-50 rounded-lg text-[11px] text-sky-300 font-bold transition-all"
                >
                  {insmindProxySaving && !insmindProxyTesting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                  <span>保存代理</span>
                </button>
                <button
                  type="button"
                  onClick={() => saveInsmindProxyConfig(true)}
                  disabled={insmindProxySaving || insmindProxyTesting}
                  className="flex items-center space-x-1.5 px-3 py-1.5 bg-emerald-500/15 hover:bg-emerald-500/25 disabled:opacity-50 rounded-lg text-[11px] text-emerald-300 font-bold transition-all"
                >
                  {insmindProxyTesting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Globe className="w-3.5 h-3.5" />}
                  <span>{insmindProxyTesting ? '测试中...' : '保存并测试出口'}</span>
                </button>
                {insmindProxyResult && (
                  <span className={`flex items-center space-x-1.5 text-[11px] font-medium ${insmindProxyResult.ok ? 'text-brand' : 'text-red-400'}`}>
                    {insmindProxyResult.ok ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> : <XCircle className="w-3.5 h-3.5 shrink-0" />}
                    <span>{insmindProxyResult.msg}</span>
                  </span>
                )}
              </div>
            </div>

            <div className="rounded-xl border border-dark-border bg-dark-card px-4 py-3">
              <div className="text-sm font-bold text-white">GPTMail 注册 / 导入 token</div>
              <div className="mt-1 text-[10px] leading-relaxed text-dark-subtle">
                一键用 GPTMail 邮箱验证码注册（需 YesCaptcha Key，与渠道三共用），或粘贴已有 access_token。免费 SKU：5s 480P/720P，10s/15s 仅 480P。批量管理请到「账号池 → 渠道十二」。
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <input
                  type="email"
                  placeholder="邮箱（导入用）"
                  value={insmindImportEmail}
                  onChange={(e) => setInsmindImportEmail(e.target.value)}
                  className="flex-1 px-3 py-2 bg-dark-bg border border-dark-border rounded-lg text-xs text-white placeholder:text-dark-muted focus:outline-none focus:border-brand"
                />
                <input
                  type="password"
                  placeholder="access_token"
                  value={insmindImportToken}
                  onChange={(e) => setInsmindImportToken(e.target.value)}
                  className="flex-1 px-3 py-2 bg-dark-bg border border-dark-border rounded-lg text-xs text-white placeholder:text-dark-muted focus:outline-none focus:border-brand"
                />
              </div>
              <div className="flex items-center flex-wrap gap-3">
                <button
                  type="button"
                  onClick={registerInsmindAccount}
                  disabled={insmindRegistering}
                  className="flex items-center space-x-1.5 px-4 py-2 bg-sky-500 hover:bg-sky-400 disabled:opacity-50 rounded-lg text-xs text-black font-bold transition-all"
                >
                  {insmindRegistering ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                  <span>{insmindRegistering ? '注册中...' : 'GPTMail 注册'}</span>
                </button>
                <button
                  type="button"
                  onClick={importInsmindAccount}
                  disabled={insmindImporting}
                  className="flex items-center space-x-1.5 px-4 py-2 bg-brand/20 hover:bg-brand/30 disabled:opacity-50 rounded-lg text-xs text-brand font-bold transition-all"
                >
                  {insmindImporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <KeyRound className="w-3.5 h-3.5" />}
                  <span>{insmindImporting ? '导入中...' : '导入 token'}</span>
                </button>
                {insmindResult && (
                  <span className={`flex items-center space-x-1.5 text-[11px] font-medium ${insmindResult.ok ? 'text-brand' : 'text-red-400'}`}>
                    {insmindResult.ok ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> : <XCircle className="w-3.5 h-3.5 shrink-0" />}
                    <span>{insmindResult.msg}</span>
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Alert Callout */}
          <div className="bg-blue-500/10 border border-blue-500/20 rounded-xl p-3.5 flex items-start space-x-2.5">
            <Info className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
            <div className="text-[10px] text-dark-muted leading-relaxed">
              <span className="text-white font-bold block mb-0.5">本地渲染要求</span>
              如果您配置了本地 GPU 运行，请确保您的计算机上已安装 Python 3.10.x、PyTorch-CUDA 环境，并提前使用 CMD 在控制台运行 <code className="text-brand font-mono">pip install -r requirements.txt</code> 导入扩散所需的第三方依赖包。
            </div>
          </div>
          {/* Action Row */}
          <div className="flex items-center space-x-4 pt-3 border-t border-dark-border/40">
            <button 
              type="submit"
              className="flex items-center space-x-1.5 px-6 py-2.5 bg-brand hover:bg-brand-dark rounded-lg text-xs text-black font-bold transition-all shadow-lg"
            >
              <Save className="w-3.5 h-3.5" />
              <span>保存全局设置</span>
            </button>

            {isSaved && (
              <div className="flex items-center space-x-1.5 text-xs text-brand animate-in fade-in duration-300">
                <CheckCircle2 className="w-4 h-4" />
                <span>全局设置已加密保存至本地配置文件 config.json</span>
              </div>
            )}
          </div>

        </form>
      </div>
    </div>
  );
}
