import React, { useState, useEffect } from 'react';
import {
  KeyRound,
  Trash2,
  RefreshCw,
  Loader2,
  AlertCircle,
  XCircle,
  Coins,
  ExternalLink,
  Eye,
  EyeOff,
  Copy,
  User,
  CheckCircle2,
  Zap,
  Sparkles,
  BarChart3,
  SlidersHorizontal,
  Mail,
} from 'lucide-react';
import { WIZSTAR_API as API_BASE } from '../config';

export default function WizstarAccounts() {
  const [activePool, setActivePool] = useState('wizstar'); // 'wizstar' | 'quickframe' | 'oiioii' | 'dola'
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshingId, setRefreshingId] = useState(null);
  const [batchRefreshing, setBatchRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [visiblePasswords, setVisiblePasswords] = useState({});
  const [selectedAccountId, setSelectedAccountId] = useState(null);
  const [savingConcurrencyId, setSavingConcurrencyId] = useState(null);

  // ---- QuickFrame 账号池状态 ----
  const [qfAccounts, setQfAccounts] = useState([]);
  const [qfLoading, setQfLoading] = useState(false);
  const [qfRefreshingId, setQfRefreshingId] = useState(null);
  const [showQfRegister, setShowQfRegister] = useState(false);
  const [qfRegCount, setQfRegCount] = useState(1);
  const [qfRegConcurrency, setQfRegConcurrency] = useState(3);
  const [qfRegistering, setQfRegistering] = useState(false);
  const [qfConfigured, setQfConfigured] = useState(true);
  const [qfStats, setQfStats] = useState(null);
  const [showQfStats, setShowQfStats] = useState(false);
  const [qfStatsLoading, setQfStatsLoading] = useState(false);

  // ---- OiiOii 渠道四账号池状态 ----
  const [oiAccounts, setOiAccounts] = useState([]);
  const [oiLoading, setOiLoading] = useState(false);
  const [oiRegistering, setOiRegistering] = useState(false);
  const [oiRefreshingPoints, setOiRefreshingPoints] = useState(false);
  const [oiRefreshingEmail, setOiRefreshingEmail] = useState(null);
  const [oiClaimingDaily, setOiClaimingDaily] = useState(false);
  const [oiCleaningZero, setOiCleaningZero] = useState(false);
  const [showOiRegister, setShowOiRegister] = useState(false);
  const [oiRegCount, setOiRegCount] = useState(1);
  const [oiRegConcurrency, setOiRegConcurrency] = useState(2);
  const [oiPointsInfo, setOiPointsInfo] = useState(null);
  const [oiSdkAvailable, setOiSdkAvailable] = useState(false);
  const [oiConfigured, setOiConfigured] = useState(false);
  const [oiProxy, setOiProxy] = useState({ use_proxy: true, proxy_host: '127.0.0.1', proxy_port: 7890 });

  // ---- Dola 渠道六账号池状态 ----
  const [dolaAccounts, setDolaAccounts] = useState([]);
  const [dolaLoading, setDolaLoading] = useState(false);
  const [dolaCapturing, setDolaCapturing] = useState(false);
  const [dolaImporting, setDolaImporting] = useState(false);
  const [dolaDeletingAll, setDolaDeletingAll] = useState(false);
  const [dolaOpeningId, setDolaOpeningId] = useState(null);
  const [showDolaGrab, setShowDolaGrab] = useState(false);
  const [showDolaImport, setShowDolaImport] = useState(false);
  const [dolaGrabCount, setDolaGrabCount] = useState(1);
  const [dolaGrabConcurrency, setDolaGrabConcurrency] = useState(1);
  const [dolaGrabHeadless, setDolaGrabHeadless] = useState(true);
  const [dolaGrabHiText, setDolaGrabHiText] = useState('你好');
  const [dolaGrabKeepOpen, setDolaGrabKeepOpen] = useState(false);
  const [dolaGrabCloseLogin, setDolaGrabCloseLogin] = useState(true);
  const [dolaGrabWaitMs, setDolaGrabWaitMs] = useState(12000);
  const [dolaGrabAccountId, setDolaGrabAccountId] = useState(0);
  const [dolaImportName, setDolaImportName] = useState('');
  const [dolaImportCookie, setDolaImportCookie] = useState('');
  const [dolaImportEnvFile, setDolaImportEnvFile] = useState('');
  const [dolaImportProfileDir, setDolaImportProfileDir] = useState('');
  const [dolaImportNote, setDolaImportNote] = useState('');

  // ---- Dola Google 批量登录 ----
  const [showDolaBatchLogin, setShowDolaBatchLogin] = useState(false);
  const [dolaBatchText, setDolaBatchText] = useState('');
  const [dolaBatchConcurrency, setDolaBatchConcurrency] = useState(2);
  const [dolaBatchStep, setDolaBatchStep] = useState('idle');
  const [dolaBatchResults, setDolaBatchResults] = useState({});
  const [dolaBatchSummary, setDolaBatchSummary] = useState(null);

  const fetchAccounts = async () => {
    try {
      setLoading(true);
      const res = await fetch(`${API_BASE}/accounts`);
      const data = await res.json();
      setAccounts(data.data || []);
      setError('');
    } catch (e) {
      setError('无法连接到渠道一服务，请确认 Python 服务已启动');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAccounts();
  }, []);

  // ---- QuickFrame 账号池 ----
  const fetchQfAccounts = async () => {
    try {
      setQfLoading(true);
      const res = await fetch(`${API_BASE}/quickframe/accounts`);
      const data = await res.json();
      setQfAccounts(data.data || []);
      setError('');
    } catch (e) {
      setError('无法连接到渠道一服务，请确认 Python 服务已启动');
    } finally {
      setQfLoading(false);
    }
  };

  const checkQfConfig = async () => {
    try {
      const res = await fetch(`${API_BASE}/quickframe/config`);
      const data = await res.json();
      setQfConfigured(!!data.data?.yescap_configured);
    } catch (_) { setQfConfigured(false); }
  };

  const fetchQfStats = async () => {
    try {
      setQfStatsLoading(true);
      const res = await fetch(`${API_BASE}/quickframe/stats`);
      const data = await res.json();
      setQfStats(data.data || null);
    } catch (e) {
      setError('获取统计数据失败');
    } finally {
      setQfStatsLoading(false);
    }
  };

  const handleToggleQfStats = () => {
    const next = !showQfStats;
    setShowQfStats(next);
    if (next) fetchQfStats();
  };

  const fetchOiAccounts = async () => {
    try {
      setOiLoading(true);
      const res = await fetch(`${API_BASE}/oiioii/config`);
      const data = await res.json();
      const d = data.data || {};
      setOiAccounts(d.accounts || []);
      setOiSdkAvailable(!!d.sdk_available);
      setOiConfigured(!!d.configured);
      setOiProxy({
        use_proxy: d.use_proxy !== undefined ? d.use_proxy : true,
        proxy_host: d.proxy_host || '127.0.0.1',
        proxy_port: d.proxy_port || 7890,
      });
      setError('');
    } catch (e) {
      setError('无法连接到渠道四服务，请确认 Python 服务已启动');
    } finally {
      setOiLoading(false);
    }
  };

  const handleOiRegister = async (e) => {
    e?.preventDefault?.();
    setOiRegistering(true);
    setError('');
    setSuccessMsg('');
    try {
      const count = Math.max(1, Math.min(parseInt(oiRegCount) || 1, 50));
      const concurrency = Math.max(1, Math.min(parseInt(oiRegConcurrency) || 1, 10, count));
      const res = await fetch(`${API_BASE}/oiioii/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count, concurrency }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP ${res.status}`);
      }
      const result = await res.json();
      const d = result.data || {};
      if (count <= 1) {
        if (!d.success) throw new Error(d.error || '注册失败');
        setSuccessMsg(`渠道四注册成功：${d.email}，积分 ${d.points ?? '?'}`);
      } else {
        setSuccessMsg(`渠道四注册完成：成功 ${d.success_count || 0} 个，失败 ${d.failed_count || 0} 个`);
        if (d.failed && d.failed.length > 0) {
          setError(d.failed.map(f => `#${f.index || '?'}: ${f.error || '注册失败'}`).join('\n'));
        }
      }
      setShowOiRegister(false);
      fetchOiAccounts();
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setOiRegistering(false);
    }
  };

  const applyOiPointResultsToAccounts = (pointResult) => {
    const successItems = Array.isArray(pointResult?.success) ? pointResult.success : [];
    if (successItems.length === 0) return;

    const byEmail = new Map(successItems.map(item => [item.email, item]));
    setOiAccounts(prev => prev.map(acc => {
      const item = byEmail.get(acc.email);
      if (!item) return acc;
      return {
        ...acc,
        points: item.points,
        availableLimited: item.availableLimited,
        availablePerm: item.availablePerm,
        hasSignedInToday: item.hasSignedInToday,
        points_updated_at: item.pointsUpdatedAt || new Date().toISOString(),
        lastDailyAdded: item.dailyAdded || item.signInResult?.added || 0,
        lastDailySignedIn: item.dailySignedIn ?? item.signInResult?.signedIn ?? false,
      };
    }));
  };

  const formatOiPoints = (d, prefix = '渠道四积分') => {
    if (Array.isArray(d.success)) {
      const total = d.success.reduce((sum, item) => sum + (Number(item.points) || 0), 0);
      const added = d.success.reduce((sum, item) => sum + (Number(item.dailyAdded ?? item.signInResult?.added) || 0), 0);
      const suffix = d.claimedDaily ? `，本次新增 ${added}` : '';
      return `${prefix}：成功更新 ${d.success_count || d.success.length} 个账号，总积分 ${total}${suffix}，失败 ${d.failed_count || 0} 个`;
    }
    const total = d.points ?? '?';
    const limited = d.availableLimited ?? '?';
    const perm = d.availablePerm ?? '?';
    const signed = d.hasSignedInToday ? '今日已领取' : '今日未领取';
    const added = d.dailyAdded ?? d.signInResult?.added;
    return `${prefix}：${d.email || '当前账号'} ${total} 分（限时 ${limited} / 永久 ${perm}，${signed}${added ? `，本次新增 ${added}` : ''}）`;
  };

  const handleOiRefreshPoints = async () => {
    setOiRefreshingPoints(true);
    setError('');
    setSuccessMsg('');
    try {
      const res = await fetch(`${API_BASE}/oiioii/points`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP ${res.status}`);
      }
      const result = await res.json();
      const d = result.data || {};
      setOiPointsInfo(d);
      applyOiPointResultsToAccounts(d);
      setSuccessMsg(formatOiPoints(d));
      if (d.failed && d.failed.length > 0) {
        setError(d.failed.map(f => `${f.email || '?'}: ${f.error || '查询失败'}`).join('\n'));
      }
      fetchOiAccounts();
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setOiRefreshingPoints(false);
    }
  };

  const handleOiRefreshAccountPoints = async (email) => {
    if (!email) return;
    setOiRefreshingEmail(email);
    setError('');
    setSuccessMsg('');
    try {
      const res = await fetch(`${API_BASE}/oiioii/accounts/${encodeURIComponent(email)}/points`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP ${res.status}`);
      }
      const result = await res.json();
      const d = result.data || {};
      setOiPointsInfo(d);
      setOiAccounts(prev => prev.map(acc => acc.email === email ? {
        ...acc,
        points: d.points,
        availableLimited: d.availableLimited,
        availablePerm: d.availablePerm,
        hasSignedInToday: d.hasSignedInToday,
        points_updated_at: d.pointsUpdatedAt || new Date().toISOString(),
        lastDailyAdded: d.dailyAdded ?? d.signInResult?.added ?? 0,
        lastDailySignedIn: d.dailySignedIn ?? d.signInResult?.signedIn ?? false,
      } : acc));
      setSuccessMsg(formatOiPoints(d));
      fetchOiAccounts();
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setOiRefreshingEmail(null);
    }
  };

  const handleOiClaimDaily = async () => {
    setOiClaimingDaily(true);
    setError('');
    setSuccessMsg('');
    try {
      const res = await fetch(`${API_BASE}/oiioii/daily-points`, { method: 'POST' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP ${res.status}`);
      }
      const result = await res.json();
      const d = result.data || {};
      setOiPointsInfo(d);
      applyOiPointResultsToAccounts(d);
      setSuccessMsg(formatOiPoints(d, '渠道四每日积分已处理'));
      if (d.failed && d.failed.length > 0) {
        setError(d.failed.map(f => `${f.email || '?'}: ${f.error || '领取失败'}`).join('\n'));
      }
      fetchOiAccounts();
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setOiClaimingDaily(false);
    }
  };

  const handleOiDelete = async (email) => {
    if (!confirm('确定删除该渠道四账号？')) return;
    try {
      const res = await fetch(`${API_BASE}/oiioii/accounts/${encodeURIComponent(email)}`, { method: 'DELETE' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || '删除失败');
      }
      setSuccessMsg('渠道四账号已删除');
      fetchOiAccounts();
    } catch (e) {
      setError(e.message || '删除失败');
    }
  };

  const handleOiCleanupZero = async () => {
    if (!confirm('确定删除所有积分为 0 的渠道四账号？此操作不可撤销。')) return;
    setOiCleaningZero(true);
    setError('');
    setSuccessMsg('');
    try {
      const res = await fetch(`${API_BASE}/oiioii/accounts/cleanup-zero`, { method: 'POST' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP ${res.status}`);
      }
      const result = await res.json();
      const d = result.data || {};
      const count = d.deleted_count || 0;
      setSuccessMsg(`已清理 ${count} 个零积分账号`);
      if (d.skipped && d.skipped.length > 0) {
        setError(`${d.skipped.length} 个账号跳过：${d.skipped.map(s => s.file).join(', ')}`);
      }
      fetchOiAccounts();
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setOiCleaningZero(false);
    }
  };

  const fetchDolaAccounts = async () => {
    try {
      setDolaLoading(true);
      const res = await fetch(`${API_BASE}/dola/accounts`);
      const data = await res.json();
      setDolaAccounts(data.data || []);
      setError('');
    } catch (e) {
      setError('无法连接到渠道六服务，请确认 Python 服务已启动');
    } finally {
      setDolaLoading(false);
    }
  };

  const handleDolaImportAccount = async (e) => {
    e?.preventDefault?.();
    const name = dolaImportName.trim();
    const cookie = dolaImportCookie.trim();
    const env_file = dolaImportEnvFile.trim();
    const profile_dir = dolaImportProfileDir.trim();
    const note = dolaImportNote.trim();
    if (!cookie && !env_file && !profile_dir) {
      setError('请至少填写 Cookie、登录态文件或 profile 目录');
      return;
    }
    setDolaImporting(true);
    setError('');
    setSuccessMsg('');
    try {
      const res = await fetch(`${API_BASE}/dola/accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, cookie, env_file, profile_dir, note }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP ${res.status}`);
      }
      const result = await res.json();
      const account = result.data || {};
      setSuccessMsg(`渠道六账号已添加：${account.name || name || '未命名账号'}`);
      setShowDolaImport(false);
      setDolaImportName('');
      setDolaImportCookie('');
      setDolaImportEnvFile('');
      setDolaImportProfileDir('');
      setDolaImportNote('');
      fetchDolaAccounts();
    } catch (e) {
      setError(e.message || '渠道六账号添加失败');
    } finally {
      setDolaImporting(false);
    }
  };

  const handleDolaDeleteAll = async () => {
    if (dolaAccounts.length === 0) return;
    if (!confirm(`确定删除全部 ${dolaAccounts.length} 个渠道六账号？`)) return;
    setDolaDeletingAll(true);
    setError('');
    setSuccessMsg('');
    try {
      const res = await fetch(`${API_BASE}/dola/accounts`, { method: 'DELETE' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || '清空失败');
      }
      const result = await res.json();
      const deleted = result.data?.deleted ?? dolaAccounts.length;
      setSuccessMsg(`已删除 ${deleted} 个渠道六账号`);
      fetchDolaAccounts();
    } catch (e) {
      setError(e.message || '清空失败');
    } finally {
      setDolaDeletingAll(false);
    }
  };

  const handleDolaGrabAccount = async (e) => {
    e?.preventDefault?.();
    const count = Math.max(1, Math.min(parseInt(dolaGrabCount, 10) || 1, 100));
    const concurrency = Math.max(1, Math.min(parseInt(dolaGrabConcurrency, 10) || 1, 20, count));
    const wait_ms = Math.max(3000, Math.min(parseInt(dolaGrabWaitMs, 10) || 12000, 60000));
    const name = `Dola 采集账号 ${new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`;
    setDolaCapturing(true);
    setError('');
    const modeText = dolaGrabHeadless ? '无头采集' : '可见窗口采集';
    setSuccessMsg(`正在以${modeText}启动 ${count} 个渠道六采集任务。系统会进入聊天页自动发送“你好”，并从这次真实请求里采集 Cookie。`);
    try {
      const res = await fetch(`${API_BASE}/dola/accounts/grab`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          count,
          concurrency,
          visible: !dolaGrabHeadless,
          keep_open: !!dolaGrabKeepOpen,
          wait_ms,
          account_id: parseInt(dolaGrabAccountId, 10) || 0,
          send_hi: true,
          hi_text: dolaGrabHiText || '你好',
          close_login: !!dolaGrabCloseLogin,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP ${res.status}`);
      }
      const result = await res.json();
      const d = result.data || {};
      if (count <= 1) {
        setSuccessMsg(`渠道六账号采集成功：${d.account?.name || name}`);
      } else {
        setSuccessMsg(`渠道六账号采集完成：成功 ${d.success_count || 0} 个，失败 ${d.failed_count || 0} 个`);
        if (d.failed?.length) {
          setError(d.failed.map(item => `#${item.index || '?'}: ${item.error || '采集失败'}`).join('\n'));
        }
      }
      setShowDolaGrab(false);
      fetchDolaAccounts();
    } catch (e) {
      setError(e.message || '渠道六账号采集失败');
    } finally {
      setDolaCapturing(false);
    }
  };

  const handleDolaDelete = async (id) => {
    if (!confirm('确定删除该渠道六账号？')) return;
    try {
      const res = await fetch(`${API_BASE}/dola/accounts/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || '删除失败');
      }
      setSuccessMsg('渠道六账号已删除');
      fetchDolaAccounts();
    } catch (e) {
      setError(e.message || '删除失败');
    }
  };

  const handleDolaOpenBrowser = async (id) => {
    setError('');
    setSuccessMsg('');
    setDolaOpeningId(id);
    try {
      const res = await fetch(`${API_BASE}/dola/accounts/${id}/open-browser`, {
        method: 'POST',
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || '打开浏览器失败');
      }
      const result = await res.json();
      const pid = result.data?.pid ? `（PID ${result.data.pid}）` : '';
      setSuccessMsg(`已打开该 Dola 账号的独立浏览器窗口${pid}，会使用该账号对应的登录态。`);
    } catch (e) {
      setError(e.message || '打开浏览器失败');
    } finally {
      setDolaOpeningId(null);
    }
  };

  // Listen for Dola batch login progress from Electron
  useEffect(() => {
    if (!window.electronAPI?.onDolaBatchProgress) return;
    const unsubscribe = window.electronAPI.onDolaBatchProgress((data) => {
      if (data?.step === 'batch_complete') {
        setDolaBatchSummary(data.data);
        setDolaBatchStep('done');
        fetchDolaAccounts();
        return;
      }
      if (data?.index !== undefined) {
        setDolaBatchResults(prev => ({
          ...prev,
          [data.index]: {
            email: data.email,
            step: data.step,
            ok: data.step === 'saved_to_db' ? data.data?.ok : prev[data.index]?.ok,
          }
        }));
      }
    });
    return unsubscribe;
  }, []);

  const handleDolaBatchLogin = async () => {
    const lines = dolaBatchText.trim().split('\n').filter(l => l.trim());
    const accounts = lines.map(line => {
      const [email, password] = line.trim().split('|');
      return { email: (email || '').trim(), password: (password || '').trim() };
    }).filter(a => a.email && a.password);
    if (accounts.length === 0) {
      setError('请输入有效的账号密码，每行一个，格式: email|password');
      return;
    }
    setDolaBatchStep('running');
    setDolaBatchResults({});
    setDolaBatchSummary(null);
    setError('');
    setSuccessMsg('');
    try {
      if (!window.electronAPI?.dolaBatchLogin) {
        throw new Error('Electron 环境不可用，请确保在 Electron 应用中运行（非浏览器 dev server）。如已更新 preload，请重启 Electron 应用。');
      }
      const result = await window.electronAPI.dolaBatchLogin({
        accounts,
        concurrency: dolaBatchConcurrency,
      });
      if (result?.ok) {
        setDolaBatchSummary({ succeeded: result.succeeded, failed: result.failed, total: accounts.length });
        setDolaBatchStep('done');
        setSuccessMsg(`批量登录完成：成功 ${result.succeeded}，失败 ${result.failed}`);
        fetchDolaAccounts();
      } else {
        setDolaBatchStep('idle');
        setError(result?.error || '批量登录失败');
      }
    } catch (e) {
      setDolaBatchStep('idle');
      setError(e.message || String(e));
    }
  };

  useEffect(() => {
    if (activePool === 'quickframe') {
      fetchQfAccounts();
      checkQfConfig();
    }
    if (activePool === 'oiioii') {
      fetchOiAccounts();
    }
    if (activePool === 'dola') {
      fetchDolaAccounts();
    }
  }, [activePool]);

  const handleQfRegister = async (e) => {
    e.preventDefault();
    setQfRegistering(true);
    setError('');
    setSuccessMsg('');
    try {
      const res = await fetch(`${API_BASE}/quickframe/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          count: parseInt(qfRegCount) || 1,
          concurrency: parseInt(qfRegConcurrency) || 3,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || '注册失败');
      }
      const result = await res.json();
      const { success_count, failed_count, failed } = result.data;
      setSuccessMsg(`渠道三注册完成：成功 ${success_count} 个，失败 ${failed_count} 个`);
      if (failed && failed.length > 0) {
        setError(failed.map(f => `${f.email || '?'}: ${f.stage || ''} ${f.err || ''}`).join('\n'));
      }
      setShowQfRegister(false);
      fetchQfAccounts();
    } catch (e) {
      setError(e.message);
    } finally {
      setQfRegistering(false);
    }
  };

  const handleQfRefresh = async (id) => {
    setQfRefreshingId(id);
    setError('');
    try {
      const res = await fetch(`${API_BASE}/quickframe/accounts/${id}/refresh`, { method: 'POST' });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || '刷新失败');
      }
      setSuccessMsg('Bearer 已刷新');
      fetchQfAccounts();
    } catch (e) {
      setError(e.message);
    } finally {
      setQfRefreshingId(null);
    }
  };

  const handleQfDelete = async (id) => {
    if (!confirm('确定删除该渠道三账号？')) return;
    try {
      await fetch(`${API_BASE}/quickframe/accounts/${id}`, { method: 'DELETE' });
      fetchQfAccounts();
    } catch (e) {
      setError('删除失败');
    }
  };

  const handleBatchRefresh = async () => {
    setBatchRefreshing(true);
    setError('');
    setSuccessMsg('');
    try {
      const res = await fetch(`${API_BASE}/accounts/batch-refresh`, { method: 'POST' });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || '刷新失败');
      }
      const result = await res.json();
      const { success, failed } = result.data;
      setSuccessMsg(`积分刷新完成：成功 ${success.length} 个，失败 ${failed.length} 个`);
      fetchAccounts();
    } catch (e) {
      setError(e.message);
    } finally {
      setBatchRefreshing(false);
    }
  };

  const handleDelete = async (id) => {
    if (!confirm('确定删除该账号？')) return;
    try {
      await fetch(`${API_BASE}/accounts/${id}`, { method: 'DELETE' });
      fetchAccounts();
    } catch (e) {
      setError('删除失败');
    }
  };

  const handleRefresh = async (id) => {
    setRefreshingId(id);
    try {
      const res = await fetch(`${API_BASE}/accounts/${id}/refresh`, { method: 'POST' });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || '刷新失败');
      }
      fetchAccounts();
    } catch (e) {
      setError(e.message);
    } finally {
      setRefreshingId(null);
    }
  };

  const handleUpdateConcurrency = async (id, value) => {
    const maxConcurrency = Math.max(1, Math.min(parseInt(value, 10) || 1, 10));
    setSavingConcurrencyId(id);
    setError('');
    setSuccessMsg('');
    try {
      const res = await fetch(`${API_BASE}/accounts/${id}/concurrency`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ max_concurrency: maxConcurrency }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || '并发保存失败');
      }
      const result = await res.json();
      const updated = result.data;
      setAccounts(prev => prev.map(acc => acc.id === id ? { ...acc, ...updated } : acc));
      setSuccessMsg(`已设置账号并发：${maxConcurrency}`);
    } catch (e) {
      setError(e.message || '并发保存失败');
    } finally {
      setSavingConcurrencyId(null);
    }
  };

  const handleOpenWebLogin = async (id) => {
    setError('');
    setSuccessMsg('');
    try {
      if (!window.electronAPI?.openWizstarBrowser) {
        window.open('https://wizstar.com/tools/generate_video', '_blank');
        setError('当前是普通浏览器环境，无法注入账号 Cookie，已打开渠道一页面但可能需要手动登录');
        return;
      }
      const result = await window.electronAPI.openWizstarBrowser(id);
      if (!result?.ok) throw new Error(result?.error || '打开网页登录失败');
      setSuccessMsg('已打开渠道一网页窗口。如果仍未登录，说明该账号缺少完整浏览器 Cookie。');
    } catch (e) {
      setError(e.message);
    }
  };

  const copyText = async (text, label) => {
    try {
      await navigator.clipboard.writeText(text || '');
      setSuccessMsg(`${label}已复制`);
      setError('');
    } catch (e) {
      setError(`${label}复制失败，请手动复制`);
    }
  };

  const togglePasswordVisible = (id) => {
    setVisiblePasswords(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const formatDate = (timestamp) => {
    if (!timestamp) return '-';
    const d = new Date(timestamp * 1000);
    return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-dark-bg/20">
      {/* Header */}
      <div className="h-14 border-b border-dark-border px-6 flex items-center justify-between shrink-0 bg-dark-bg/40">
        <div className="flex items-center space-x-3">
          <div className="flex items-center space-x-2">
            <KeyRound className="w-4 h-4 text-brand" />
            <h1 className="text-sm font-semibold text-white">账号库</h1>
          </div>
          {/* Pool tabs */}
          <div className="flex bg-dark-input border border-dark-border rounded-lg overflow-hidden">
            <button
              onClick={() => setActivePool('wizstar')}
              className={`px-3 py-1 text-xs font-medium transition-all ${activePool === 'wizstar' ? 'bg-brand text-black' : 'text-dark-muted hover:text-white'}`}
            >
              渠道一
            </button>
            <button
              onClick={() => setActivePool('quickframe')}
              className={`px-3 py-1 text-xs font-medium transition-all ${activePool === 'quickframe' ? 'bg-brand text-black' : 'text-dark-muted hover:text-white'}`}
            >
              渠道三
            </button>
            <button
              onClick={() => setActivePool('oiioii')}
              className={`px-3 py-1 text-xs font-medium transition-all ${activePool === 'oiioii' ? 'bg-brand text-black' : 'text-dark-muted hover:text-white'}`}
            >
              渠道四
            </button>
            <button
              onClick={() => setActivePool('dola')}
              className={`px-3 py-1 text-xs font-medium transition-all ${activePool === 'dola' ? 'bg-brand text-black' : 'text-dark-muted hover:text-white'}`}
            >
              渠道六
            </button>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {activePool === 'wizstar' ? (
            <>
              <button
                onClick={handleBatchRefresh}
                disabled={batchRefreshing || accounts.length === 0}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-yellow-500/10 text-yellow-400 text-sm font-medium hover:bg-yellow-500/20 disabled:opacity-50 transition-colors"
              >
                {batchRefreshing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Coins className="w-4 h-4" />}
                查询积分
              </button>
              <button
                onClick={fetchAccounts}
                className="p-2 rounded-lg text-dark-muted hover:text-white hover:bg-dark-card/50 transition-colors"
                title="刷新"
              >
                <RefreshCw className="w-4 h-4" />
              </button>
            </>
          ) : activePool === 'quickframe' ? (
            <>
              <button
                onClick={handleToggleQfStats}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${showQfStats ? 'bg-brand/15 text-brand' : 'bg-brand/10 text-brand hover:bg-brand/20'}`}
              >
                <BarChart3 className="w-4 h-4" /> 统计
              </button>
              <button
                onClick={() => setShowQfRegister(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-green-500/10 text-green-400 text-sm font-medium hover:bg-green-500/20 transition-colors"
              >
                <Sparkles className="w-4 h-4" /> 注册账号
              </button>
              <button
                onClick={fetchQfAccounts}
                className="p-2 rounded-lg text-dark-muted hover:text-white hover:bg-dark-card/50 transition-colors"
                title="刷新"
              >
                <RefreshCw className="w-4 h-4" />
              </button>
            </>
          ) : activePool === 'oiioii' ? (
            <>
              <button
                onClick={handleOiRefreshPoints}
                disabled={oiRefreshingPoints || oiAccounts.length === 0}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-yellow-500/10 text-yellow-400 text-sm font-medium hover:bg-yellow-500/20 disabled:opacity-50 transition-colors"
              >
                {oiRefreshingPoints ? <Loader2 className="w-4 h-4 animate-spin" /> : <Coins className="w-4 h-4" />}
                查询积分
              </button>
              <button
                onClick={handleOiClaimDaily}
                disabled={oiClaimingDaily || oiAccounts.length === 0}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-purple-500/10 text-purple-300 text-sm font-medium hover:bg-purple-500/20 disabled:opacity-50 transition-colors"
              >
                {oiClaimingDaily ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                领取每日积分
              </button>
              <button
                onClick={handleOiCleanupZero}
                disabled={oiCleaningZero || oiAccounts.length === 0}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-500/10 text-red-400 text-sm font-medium hover:bg-red-500/20 disabled:opacity-50 transition-colors"
              >
                {oiCleaningZero ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                清理零积分
              </button>
              <button
                onClick={() => setShowOiRegister(true)}
                disabled={oiRegistering || !oiSdkAvailable}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-green-500/10 text-green-400 text-sm font-medium hover:bg-green-500/20 disabled:opacity-50 transition-colors"
              >
                {oiRegistering ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                注册账号
              </button>
              <button
                onClick={fetchOiAccounts}
                className="p-2 rounded-lg text-dark-muted hover:text-white hover:bg-dark-card/50 transition-colors"
                title="刷新"
              >
                <RefreshCw className="w-4 h-4" />
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => setShowDolaBatchLogin(prev => !prev)}
                disabled={dolaCapturing || dolaImporting || dolaDeletingAll || dolaBatchStep === 'running'}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-500/10 text-blue-300 text-sm font-medium hover:bg-blue-500/20 disabled:opacity-50 transition-colors"
              >
                {dolaBatchStep === 'running' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />}
                Google 批量登录
              </button>
              <button
                onClick={() => setShowDolaGrab(true)}
                disabled={dolaCapturing || dolaImporting || dolaDeletingAll || dolaBatchStep === 'running'}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-orange-500/10 text-orange-300 text-sm font-medium hover:bg-orange-500/20 disabled:opacity-50 transition-colors"
              >
                {dolaCapturing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                采集账号
              </button>
              <button
                onClick={() => setShowDolaImport(prev => !prev)}
                disabled={dolaCapturing || dolaImporting || dolaDeletingAll}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-sky-500/10 text-sky-300 text-sm font-medium hover:bg-sky-500/20 disabled:opacity-50 transition-colors"
              >
                {dolaImporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <KeyRound className="w-4 h-4" />}
                手动添加
              </button>
              <button
                onClick={handleDolaDeleteAll}
                disabled={dolaDeletingAll || dolaAccounts.length === 0 || dolaCapturing || dolaImporting}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-500/10 text-red-300 text-sm font-medium hover:bg-red-500/20 disabled:opacity-50 transition-colors"
              >
                {dolaDeletingAll ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                一键清空
              </button>
              <button
                onClick={fetchDolaAccounts}
                className="p-2 rounded-lg text-dark-muted hover:text-white hover:bg-dark-card/50 transition-colors"
                title="刷新"
              >
                <RefreshCw className="w-4 h-4" />
              </button>
            </>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        {successMsg && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-green-500/10 border border-green-500/20 text-green-400 text-sm">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            {successMsg}
            <button onClick={() => setSuccessMsg('')} className="ml-auto text-green-400/60 hover:text-green-400">
              <XCircle className="w-4 h-4" />
            </button>
          </div>
        )}

        {error && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span className="whitespace-pre-wrap">{error}</span>
            <button onClick={() => setError('')} className="ml-auto text-red-400/60 hover:text-red-400 shrink-0">
              <XCircle className="w-4 h-4" />
            </button>
          </div>
        )}

        {activePool === 'dola' && showDolaGrab && (
          <div className="p-4 rounded-xl bg-dark-card border border-orange-500/20 space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-medium text-white">采集渠道六账号</h3>
                <p className="text-xs text-dark-muted mt-1">
                  默认使用无头浏览器和独立 profile 采集账号；需要扫码或人工确认时，可关闭“无头采集”。单次最多 100 个。
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowDolaGrab(false)}
                disabled={dolaCapturing}
                className="p-1.5 rounded-lg text-dark-muted hover:text-white hover:bg-dark-bg disabled:opacity-50 transition-colors"
              >
                <XCircle className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleDolaGrabAccount} className="space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <label className="space-y-1">
                  <span className="text-xs text-dark-muted">采集数量</span>
                  <input
                    type="number"
                    min="1"
                    max="100"
                    value={dolaGrabCount}
                    onChange={e => setDolaGrabCount(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-dark-bg border border-dark-border text-sm text-white focus:outline-none focus:border-brand/50"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-xs text-dark-muted">并发采集数</span>
                  <input
                    type="number"
                    min="1"
                    max="20"
                    value={dolaGrabConcurrency}
                    onChange={e => setDolaGrabConcurrency(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-dark-bg border border-dark-border text-sm text-white focus:outline-none focus:border-brand/50"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-xs text-dark-muted">等待采集时间 ms</span>
                  <input
                    type="number"
                    min="3000"
                    max="60000"
                    step="1000"
                    value={dolaGrabWaitMs}
                    onChange={e => setDolaGrabWaitMs(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-dark-bg border border-dark-border text-sm text-white focus:outline-none focus:border-brand/50"
                  />
                </label>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_auto_auto_auto] gap-3 items-end">
                <label className="space-y-1">
                  <span className="text-xs text-dark-muted">使用已有 Cookie 账号</span>
                  <select
                    value={dolaGrabAccountId}
                    onChange={e => setDolaGrabAccountId(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-dark-bg border border-dark-border text-sm text-white focus:outline-none focus:border-brand/50"
                  >
                    <option value={0}>不使用（全新采集）</option>
                    {(dolaAccounts || []).filter(a => a.status === 'active').map(acct => (
                      <option key={acct.id} value={acct.id}>
                        #{acct.id} {acct.name || `Dola账号 #${acct.id}`}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="space-y-1">
                  <span className="text-xs text-dark-muted">发送内容</span>
                  <input
                    type="text"
                    value={dolaGrabHiText}
                    onChange={e => setDolaGrabHiText(e.target.value)}
                    disabled={true}
                    placeholder="你好"
                    className="w-full px-3 py-2 rounded-lg bg-dark-bg border border-dark-border text-sm text-white disabled:opacity-50 focus:outline-none focus:border-brand/50"
                  />
                </label>
                <label className="flex items-center gap-2 px-3 py-2 rounded-lg bg-dark-bg border border-dark-border text-xs text-dark-muted">
                  <input
                    type="checkbox"
                    checked={true}
                    readOnly
                    className="accent-brand"
                  />
                  自动发送“你好”并采集请求 Cookie
                </label>
                <label className="flex items-center gap-2 px-3 py-2 rounded-lg bg-dark-bg border border-dark-border text-xs text-dark-muted">
                  <input
                    type="checkbox"
                    checked={dolaGrabHeadless}
                    onChange={e => setDolaGrabHeadless(e.target.checked)}
                    className="accent-brand"
                  />
                  无头采集
                </label>
                <label className="flex items-center gap-2 px-3 py-2 rounded-lg bg-dark-bg border border-dark-border text-xs text-dark-muted">
                  <input
                    type="checkbox"
                    checked={dolaGrabCloseLogin}
                    onChange={e => setDolaGrabCloseLogin(e.target.checked)}
                    className="accent-brand"
                  />
                  采集后清登录态
                </label>
              </div>
              <label className="flex items-center gap-2 text-xs text-dark-muted">
                <input
                  type="checkbox"
                  checked={dolaGrabKeepOpen}
                  onChange={e => setDolaGrabKeepOpen(e.target.checked)}
                  className="accent-brand"
                />
                采集完成后保留浏览器进程/窗口，方便排查采集状态
              </label>
              <div className="flex items-center gap-2 pt-1">
                <button
                  type="submit"
                  disabled={dolaCapturing}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-orange-500/15 text-orange-300 text-sm font-medium hover:bg-orange-500/25 disabled:opacity-50 transition-colors"
                >
                  {dolaCapturing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                  {dolaCapturing ? '采集中...' : `开始采集 (${dolaGrabCount || 1})`}
                </button>
                <button
                  type="button"
                  onClick={() => setShowDolaGrab(false)}
                  disabled={dolaCapturing}
                  className="px-4 py-2 rounded-lg text-dark-muted text-sm hover:text-white hover:bg-dark-card/80 disabled:opacity-50 transition-colors"
                >
                  取消
                </button>
              </div>
            </form>
          </div>
        )}

        {activePool === 'dola' && showDolaImport && (
          <div className="p-4 rounded-xl bg-dark-card border border-sky-500/20 space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-medium text-white">手动添加渠道六账号</h3>
                <p className="text-xs text-dark-muted mt-1">
                  可直接粘贴 Cookie；也可以把已有的 `.env.dola` 登录态文件或 profile 目录加入账号库，不会覆盖当前正在使用的全局配置。
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowDolaImport(false)}
                disabled={dolaImporting}
                className="p-1.5 rounded-lg text-dark-muted hover:text-white hover:bg-dark-bg disabled:opacity-50 transition-colors"
              >
                <XCircle className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleDolaImportAccount} className="space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <label className="space-y-1">
                  <span className="text-xs text-dark-muted">账号名称</span>
                  <input
                    type="text"
                    value={dolaImportName}
                    onChange={e => setDolaImportName(e.target.value)}
                    placeholder="例如：Dola 手动账号 A"
                    className="w-full px-3 py-2 rounded-lg bg-dark-bg border border-dark-border text-sm text-white focus:outline-none focus:border-brand/50"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-xs text-dark-muted">备注</span>
                  <input
                    type="text"
                    value={dolaImportNote}
                    onChange={e => setDolaImportNote(e.target.value)}
                    placeholder="可选"
                    className="w-full px-3 py-2 rounded-lg bg-dark-bg border border-dark-border text-sm text-white focus:outline-none focus:border-brand/50"
                  />
                </label>
              </div>
              <div className="grid grid-cols-1 gap-3">
                <label className="space-y-1">
                  <span className="text-xs text-dark-muted">Cookie</span>
                  <textarea
                    value={dolaImportCookie}
                    onChange={e => setDolaImportCookie(e.target.value)}
                    placeholder="ttwid=...; odin_tt=...; msToken=..."
                    rows={4}
                    className="w-full px-3 py-2 rounded-lg bg-dark-bg border border-dark-border text-sm text-white placeholder:text-dark-muted/50 focus:outline-none focus:border-brand/50 resize-y font-mono text-xs"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-xs text-dark-muted">登录态文件路径</span>
                  <input
                    type="text"
                    value={dolaImportEnvFile}
                    onChange={e => setDolaImportEnvFile(e.target.value)}
                    placeholder="可选，不填则自动保存到本地账号目录"
                    className="w-full px-3 py-2 rounded-lg bg-dark-bg border border-dark-border text-sm text-white focus:outline-none focus:border-brand/50"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-xs text-dark-muted">profile 目录路径</span>
                  <input
                    type="text"
                    value={dolaImportProfileDir}
                    onChange={e => setDolaImportProfileDir(e.target.value)}
                    placeholder="可选，不填则自动创建独立 profile 目录"
                    className="w-full px-3 py-2 rounded-lg bg-dark-bg border border-dark-border text-sm text-white focus:outline-none focus:border-brand/50"
                  />
                </label>
              </div>
              <p className="text-[11px] text-dark-subtle">
                Cookie、登录态文件、profile 目录至少填写一项。直接粘贴 Cookie 时，系统会自动生成运行所需的本地登录态文件。
              </p>
              <div className="flex items-center gap-2 pt-1">
                <button
                  type="submit"
                  disabled={dolaImporting}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-sky-500/15 text-sky-300 text-sm font-medium hover:bg-sky-500/25 disabled:opacity-50 transition-colors"
                >
                  {dolaImporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <KeyRound className="w-4 h-4" />}
                  {dolaImporting ? '添加中...' : '确认添加'}
                </button>
                <button
                  type="button"
                  onClick={() => setShowDolaImport(false)}
                  disabled={dolaImporting}
                  className="px-4 py-2 rounded-lg text-dark-muted text-sm hover:text-white hover:bg-dark-card/80 disabled:opacity-50 transition-colors"
                >
                  取消
                </button>
              </div>
            </form>
          </div>
        )}

        {activePool === 'dola' && showDolaBatchLogin && (
          <div className="p-4 rounded-xl bg-dark-card border border-blue-500/20 space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-medium text-white">Google 批量登录</h3>
                <p className="text-xs text-dark-muted mt-1">
                  每行一个账号，格式: 邮箱|密码。系统会为每个账号启动独立浏览器自动完成 Google OAuth 登录，提取 Cookie 并保存到账号库。
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  if (dolaBatchStep !== 'running') setShowDolaBatchLogin(false);
                }}
                disabled={dolaBatchStep === 'running'}
                className="p-1.5 rounded-lg text-dark-muted hover:text-white hover:bg-dark-bg disabled:opacity-50 transition-colors"
              >
                <XCircle className="w-4 h-4" />
              </button>
            </div>

            {dolaBatchStep === 'idle' && (
              <div className="space-y-3">
                <textarea
                  placeholder="email1@ffcfd.cfd|password1&#10;email2@ffcfd.cfd|password2&#10;email3@ffcfd.cfd|password3"
                  value={dolaBatchText}
                  onChange={(e) => setDolaBatchText(e.target.value)}
                  rows={8}
                  className="w-full bg-dark-input text-sm border border-dark-border focus:border-blue-500 focus:outline-none rounded-lg p-3 text-white placeholder-dark-subtle font-mono resize-none"
                />
                <div className="flex items-center gap-3">
                  <label className="text-xs text-dark-muted">并发数</label>
                  <input
                    type="number"
                    min="1"
                    max="5"
                    value={dolaBatchConcurrency}
                    onChange={(e) => setDolaBatchConcurrency(Math.max(1, Math.min(5, parseInt(e.target.value) || 2)))}
                    className="w-16 bg-dark-input text-sm border border-dark-border focus:border-blue-500 focus:outline-none rounded-lg p-2 text-white text-center"
                  />
                  <span className="text-xs text-dark-muted">同时登录的账号数量（建议 1-3）</span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleDolaBatchLogin}
                    disabled={!dolaBatchText.trim()}
                    className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-500/15 text-blue-300 text-sm font-medium hover:bg-blue-500/25 disabled:opacity-50 transition-colors"
                  >
                    <Mail className="w-4 h-4" />
                    开始批量登录（{dolaBatchText.trim().split('\n').filter(l => l.trim() && l.includes('|')).length} 个账号）
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowDolaBatchLogin(false)}
                    className="px-4 py-2 rounded-lg text-dark-muted text-sm hover:text-white hover:bg-dark-card/80 transition-colors"
                  >
                    取消
                  </button>
                </div>
              </div>
            )}

            {dolaBatchStep === 'running' && (
              <div className="space-y-2">
                <div className="flex items-center gap-2 py-1">
                  <Loader2 className="w-4 h-4 text-blue-400 animate-spin" />
                  <span className="text-sm text-white">批量登录进行中...</span>
                </div>
                <div className="space-y-1.5 max-h-72 overflow-y-auto">
                  {Object.entries(dolaBatchResults)
                    .sort(([a], [b]) => parseInt(a) - parseInt(b))
                    .map(([idx, info]) => (
                      <div key={idx} className="flex items-center justify-between bg-dark-input/50 border border-dark-border/40 rounded-lg px-3 py-2">
                        <div className="flex items-center gap-2 min-w-0">
                          {info.ok === true ? (
                            <CheckCircle2 className="w-3.5 h-3.5 text-green-400 shrink-0" />
                          ) : info.ok === false ? (
                            <AlertCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />
                          ) : (
                            <Loader2 className="w-3.5 h-3.5 text-blue-400 animate-spin shrink-0" />
                          )}
                          <span className="text-xs text-white truncate">{info.email}</span>
                        </div>
                        <span className="text-[10px] text-dark-muted shrink-0 ml-2">
                          {info.step === 'starting' ? '启动中' :
                           info.step === 'saved_to_db' ? '已保存' :
                           info.step === 'login_complete' ? '登录完成' :
                           info.step?.includes('email') ? '输入邮箱' :
                           info.step?.includes('password') ? '输入密码' :
                           info.step?.includes('terms') ? '接受条款' :
                           info.step?.includes('consent') ? '授权中' :
                           info.step?.includes('continue') ? '点击继续' :
                           info.step?.includes('redirect') ? '跳转中' :
                           info.step?.includes('age') ? '确认年龄' :
                           info.step || '处理中'}
                        </span>
                      </div>
                    ))}
                </div>
              </div>
            )}

            {dolaBatchStep === 'done' && dolaBatchSummary && (
              <div className="space-y-3">
                <div className="flex items-center gap-3 py-2">
                  {dolaBatchSummary.failed === 0 ? (
                    <CheckCircle2 className="w-5 h-5 text-green-400" />
                  ) : (
                    <AlertCircle className="w-5 h-5 text-orange-400" />
                  )}
                  <span className="text-sm text-white">
                    批量登录完成：成功 <span className="text-green-400 font-bold">{dolaBatchSummary.succeeded}</span>，
                    失败 <span className="text-red-400 font-bold">{dolaBatchSummary.failed}</span>，
                    共 {dolaBatchSummary.total} 个账号
                  </span>
                </div>
                <div className="space-y-1.5 max-h-48 overflow-y-auto">
                  {Object.entries(dolaBatchResults)
                    .sort(([a], [b]) => parseInt(a) - parseInt(b))
                    .map(([idx, info]) => (
                      <div key={idx} className="flex items-center justify-between bg-dark-input/50 border border-dark-border/40 rounded-lg px-3 py-2">
                        <div className="flex items-center gap-2 min-w-0">
                          {info.ok ? (
                            <CheckCircle2 className="w-3.5 h-3.5 text-green-400 shrink-0" />
                          ) : (
                            <AlertCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />
                          )}
                          <span className="text-xs text-white truncate">{info.email}</span>
                        </div>
                        <span className={`text-[10px] shrink-0 ml-2 ${info.ok ? 'text-green-400' : 'text-red-400'}`}>
                          {info.ok ? '已保存到账号库' : '登录失败'}
                        </span>
                      </div>
                    ))}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setShowDolaBatchLogin(false);
                    setDolaBatchStep('idle');
                    setDolaBatchText('');
                    setDolaBatchResults({});
                    setDolaBatchSummary(null);
                  }}
                  className="px-4 py-2 rounded-lg text-dark-muted text-sm hover:text-white hover:bg-dark-card/80 transition-colors"
                >
                  完成
                </button>
              </div>
            )}
          </div>
        )}

        {activePool === 'oiioii' && showOiRegister && (
          <div className="p-4 rounded-xl bg-dark-card border border-green-500/20 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-medium text-white">批量注册渠道四账号</h3>
                <p className="text-xs text-dark-muted mt-1">设置注册数量和并发数，系统会自动注册 OiiOii 账号。</p>
              </div>
              <button
                type="button"
                onClick={() => setShowOiRegister(false)}
                className="p-1.5 rounded-lg text-dark-muted hover:text-white hover:bg-dark-bg transition-colors"
              >
                <XCircle className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleOiRegister} className="grid grid-cols-1 md:grid-cols-[1fr_1fr_auto] gap-3 items-end">
              <label className="space-y-1">
                <span className="text-xs text-dark-muted">注册数量</span>
                <input
                  type="number"
                  min="1"
                  max="50"
                  value={oiRegCount}
                  onChange={e => setOiRegCount(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-dark-bg border border-dark-border text-sm text-white focus:outline-none focus:border-brand/50"
                />
              </label>
              <label className="space-y-1">
                <span className="text-xs text-dark-muted">并发数</span>
                <input
                  type="number"
                  min="1"
                  max="10"
                  value={oiRegConcurrency}
                  onChange={e => setOiRegConcurrency(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-dark-bg border border-dark-border text-sm text-white focus:outline-none focus:border-brand/50"
                />
              </label>
              <button
                type="submit"
                disabled={oiRegistering || !oiSdkAvailable}
                className="flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg bg-green-500 text-black text-sm font-bold hover:bg-green-400 disabled:opacity-50 transition-colors"
              >
                {oiRegistering ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                开始注册
              </button>
            </form>
            <p className="text-[11px] text-dark-subtle">当前代理：{oiProxy.use_proxy ? `${oiProxy.proxy_host}:${oiProxy.proxy_port}` : '直连'}。建议并发 1-3，过高可能触发风控或验证码失败。</p>
          </div>
        )}

        {activePool === 'oiioii' && oiPointsInfo && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 p-4 rounded-xl bg-yellow-500/5 border border-yellow-500/15">
            <div>
              <p className="text-[10px] text-dark-muted">账号数</p>
              <p className="text-sm font-bold text-white">{oiPointsInfo.total ?? (oiPointsInfo.success?.length || 0)}</p>
            </div>
            <div>
              <p className="text-[10px] text-dark-muted">总积分</p>
              <p className="text-sm font-bold text-yellow-400">{Array.isArray(oiPointsInfo.success) ? oiPointsInfo.success.reduce((sum, item) => sum + (Number(item.points) || 0), 0) : (oiPointsInfo.points ?? '-')}</p>
            </div>
            <div>
              <p className="text-[10px] text-dark-muted">成功 / 失败</p>
              <p className="text-xs text-white">{oiPointsInfo.success_count ?? (oiPointsInfo.success ? oiPointsInfo.success.length : '-')} / {oiPointsInfo.failed_count ?? 0}</p>
            </div>
            <div>
              <p className="text-[10px] text-dark-muted">每日积分</p>
              <p className={`text-xs font-bold ${oiPointsInfo.claimedDaily ? 'text-green-400' : 'text-amber-400'}`}>{oiPointsInfo.claimedDaily ? '已批量领取' : '仅查询'}</p>
            </div>
          </div>
        )}

        {/* Accounts List */}
        {activePool === 'wizstar' && (loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-6 h-6 text-brand animate-spin" />
          </div>
        ) : accounts.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-dark-muted">
            <KeyRound className="w-12 h-12 mb-3 opacity-30" />
            <p className="text-sm">暂无账号，请在邮箱库中选择邮箱进行注册</p>
          </div>
        ) : (
          <div className="space-y-2">
            {accounts.map((acc) => (
              <div
                key={acc.id}
                className={`rounded-xl border transition-colors ${
                  acc.status === 'forbidden'
                    ? 'bg-red-950/20 border-red-500/30 opacity-75'
                    : 'bg-dark-card border-dark-border hover:border-dark-border/80'
                }`}
              >
                <div className="flex items-center justify-between p-4">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-9 h-9 rounded-lg bg-brand/10 flex items-center justify-center shrink-0">
                    <User className="w-4 h-4 text-brand" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-white truncate flex items-center gap-2">
                      <span>{acc.email}</span>
                      {acc.status === 'forbidden' && (
                        <span className="px-1.5 py-0.5 rounded bg-red-500/15 text-red-400 border border-red-500/30 text-[10px] font-bold">已禁用</span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 text-xs text-dark-muted">
                      <span>UID: {acc.uid || '-'}</span>
                      <span>{acc.display_name || ''}</span>
                      <span>{formatDate(acc.created_at)}</span>
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-[11px] text-dark-muted">
                      <span className="font-mono bg-dark-bg/70 border border-dark-border/60 rounded px-1.5 py-0.5 text-dark-text">
                        {visiblePasswords[acc.id] ? (acc.password || '-') : '••••••••••'}
                      </span>
                      <button
                        onClick={() => togglePasswordVisible(acc.id)}
                        className="p-1 rounded text-dark-muted hover:text-white hover:bg-dark-bg transition-colors"
                        title={visiblePasswords[acc.id] ? '隐藏密码' : '显示密码'}
                      >
                        {visiblePasswords[acc.id] ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                      </button>
                      <button
                        onClick={() => copyText(acc.email, '邮箱')}
                        className="px-1.5 py-0.5 rounded text-dark-muted hover:text-brand hover:bg-brand/10 transition-colors flex items-center gap-1"
                        title="复制邮箱"
                      >
                        <Copy className="w-3 h-3" /> 邮箱
                      </button>
                      <button
                        onClick={() => copyText(acc.password || 'Wz@2024secure', '密码')}
                        className="px-1.5 py-0.5 rounded text-dark-muted hover:text-brand hover:bg-brand/10 transition-colors flex items-center gap-1"
                        title="复制密码"
                      >
                        <Copy className="w-3 h-3" /> 密码
                      </button>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <div className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-500/10 text-emerald-400 text-xs font-medium">
                    <SlidersHorizontal className="w-3.5 h-3.5" />
                    并发 {acc.max_concurrency || 1}
                  </div>
                  <div className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-yellow-500/10 text-yellow-400 text-xs font-medium">
                    <Coins className="w-3.5 h-3.5" />
                    {acc.points_balance || 0} 积分
                  </div>
                  <button
                    onClick={() => setSelectedAccountId(prev => prev === acc.id ? null : acc.id)}
                    className={`p-1.5 rounded-lg transition-colors ${selectedAccountId === acc.id ? 'text-emerald-400 bg-emerald-500/10' : 'text-dark-muted hover:text-emerald-400 hover:bg-emerald-500/10'}`}
                    title="设置并发"
                  >
                    <SlidersHorizontal className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => handleOpenWebLogin(acc.id)}
                    className="p-1.5 rounded-lg text-dark-muted hover:text-sky-400 hover:bg-sky-500/10 transition-colors"
                    title="网页登录"
                  >
                    <ExternalLink className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => handleRefresh(acc.id)}
                    disabled={refreshingId === acc.id}
                    className="p-1.5 rounded-lg text-dark-muted hover:text-brand hover:bg-brand/10 disabled:opacity-50 transition-colors"
                    title="刷新积分"
                  >
                    {refreshingId === acc.id ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <RefreshCw className="w-4 h-4" />
                    )}
                  </button>
                  <button
                    onClick={() => handleDelete(acc.id)}
                    className="p-1.5 rounded-lg text-dark-muted hover:text-red-400 hover:bg-red-500/10 transition-colors"
                    title="删除"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
                </div>
                {selectedAccountId === acc.id && (
                  <div className="px-4 pb-4 pt-3 border-t border-dark-border/70 bg-dark-bg/30">
                    <div className="flex items-center justify-between gap-4">
                      <div className="min-w-0">
                        <div className="text-xs font-medium text-white flex items-center gap-1.5">
                          <SlidersHorizontal className="w-3.5 h-3.5 text-emerald-400" />
                          账号并发
                        </div>
                        <p className="text-[11px] text-dark-muted mt-1">生成时该账号最多同时承接的任务数</p>
                      </div>
                      <div className="flex items-center gap-3 w-[360px] max-w-full">
                        <input
                          type="range"
                          min="1"
                          max="10"
                          value={acc.max_concurrency || 1}
                          disabled={savingConcurrencyId === acc.id}
                          onChange={(e) => handleUpdateConcurrency(acc.id, e.target.value)}
                          className="flex-1 accent-emerald-400"
                        />
                        <input
                          type="number"
                          min="1"
                          max="10"
                          value={acc.max_concurrency || 1}
                          disabled={savingConcurrencyId === acc.id}
                          onChange={(e) => handleUpdateConcurrency(acc.id, e.target.value)}
                          className="w-16 px-2 py-1.5 rounded-lg bg-dark-bg border border-dark-border text-sm text-white text-center focus:outline-none focus:border-emerald-400/60 disabled:opacity-50"
                        />
                        {savingConcurrencyId === acc.id && <Loader2 className="w-4 h-4 text-emerald-400 animate-spin shrink-0" />}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        ))}

        {/* QuickFrame Stats Panel */}
        {activePool === 'quickframe' && showQfStats && (
          <div className="p-4 rounded-xl bg-dark-card border border-brand/20 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-white flex items-center gap-2">
                <BarChart3 className="w-4 h-4 text-brand" /> 渠道三出片统计
              </h3>
              <button
                onClick={fetchQfStats}
                disabled={qfStatsLoading}
                className="p-1.5 rounded-lg text-dark-muted hover:text-white hover:bg-dark-card/50 disabled:opacity-50 transition-colors"
                title="刷新统计"
              >
                {qfStatsLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
              </button>
            </div>
            {qfStatsLoading && !qfStats ? (
              <div className="flex items-center justify-center py-6">
                <Loader2 className="w-5 h-5 text-brand animate-spin" />
              </div>
            ) : qfStats ? (
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                <div className="p-3 rounded-lg bg-dark-bg border border-dark-border text-center">
                  <div className="text-xl font-bold text-white">{qfStats.total ?? 0}</div>
                  <div className="text-[11px] text-dark-muted mt-0.5">累计提交</div>
                </div>
                <div className="p-3 rounded-lg bg-dark-bg border border-dark-border text-center">
                  <div className="text-xl font-bold text-green-400">{qfStats.completed ?? 0}</div>
                  <div className="text-[11px] text-dark-muted mt-0.5">成功出片</div>
                </div>
                <div className="p-3 rounded-lg bg-dark-bg border border-dark-border text-center">
                  <div className="text-xl font-bold text-sky-400">{qfStats.processing ?? 0}</div>
                  <div className="text-[11px] text-dark-muted mt-0.5">生成中</div>
                </div>
                <div className="p-3 rounded-lg bg-dark-bg border border-dark-border text-center">
                  <div className="text-xl font-bold text-red-400">{qfStats.failed ?? 0}</div>
                  <div className="text-[11px] text-dark-muted mt-0.5">失败</div>
                </div>
                <div className="p-3 rounded-lg bg-dark-bg border border-dark-border text-center">
                  <div className="text-xl font-bold text-amber-400">{qfStats.remaining_accounts ?? 0}</div>
                  <div className="text-[11px] text-dark-muted mt-0.5">剩余账号</div>
                </div>
              </div>
            ) : (
              <p className="text-xs text-dark-muted py-2">暂无统计数据</p>
            )}
          </div>
        )}

        {/* QuickFrame Register Form */}
        {activePool === 'quickframe' && showQfRegister && (
          <div className="p-4 rounded-xl bg-dark-card border border-green-500/20 space-y-3">
            <h3 className="text-sm font-medium text-white flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-green-400" /> 注册渠道三账号
            </h3>
            <p className="text-xs text-dark-muted">
              自动生成临时邮箱并完成注册。注册依赖设置中已填写的验证码 Key
              {!qfConfigured && <span className="text-amber-400">（当前未检测到 Key，请先到「设置 → 渠道三」填写）</span>}
              ；如需独立美国出口 IP，请在设置中开启动态 IP。
            </p>
            <form onSubmit={handleQfRegister} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-dark-muted mb-1">注册数量</label>
                  <input
                    type="number"
                    min="1"
                    max="50"
                    value={qfRegCount}
                    onChange={(e) => setQfRegCount(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-dark-bg border border-dark-border text-sm text-white focus:outline-none focus:border-brand/50"
                  />
                </div>
                <div>
                  <label className="block text-xs text-dark-muted mb-1">并发数量</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="range"
                      min="1"
                      max="10"
                      value={qfRegConcurrency}
                      onChange={(e) => setQfRegConcurrency(parseInt(e.target.value))}
                      className="flex-1 accent-brand"
                    />
                    <span className="text-sm text-white font-medium w-6 text-center">{qfRegConcurrency}</span>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2 pt-1">
                <button
                  type="submit"
                  disabled={qfRegistering}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-green-600 text-white text-sm font-medium hover:bg-green-600/90 disabled:opacity-50 transition-colors"
                >
                  {qfRegistering ? (
                    <><Loader2 className="w-4 h-4 animate-spin" /> 注册中...</>
                  ) : (
                    <><Zap className="w-4 h-4" /> 开始注册 ({qfRegCount})</>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => setShowQfRegister(false)}
                  disabled={qfRegistering}
                  className="px-4 py-2 rounded-lg text-dark-muted text-sm hover:text-white hover:bg-dark-card/80 transition-colors"
                >
                  取消
                </button>
                {qfRegistering && (
                  <span className="text-xs text-dark-muted ml-1">注册较慢（解验证码 + 收码），请耐心等待</span>
                )}
              </div>
            </form>
          </div>
        )}

        {/* QuickFrame Accounts List */}
        {activePool === 'quickframe' && (qfLoading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-6 h-6 text-brand animate-spin" />
          </div>
        ) : qfAccounts.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-dark-muted">
            <Sparkles className="w-12 h-12 mb-3 opacity-30" />
            <p className="text-sm">暂无渠道三账号，点击右上角「注册账号」开始</p>
          </div>
        ) : (
          <div className="space-y-2">
            {qfAccounts.map((acc) => (
              <div
                key={acc.id}
                className={`flex items-center justify-between p-4 rounded-xl border transition-colors ${
                  acc.status === 'expired'
                    ? 'bg-amber-950/20 border-amber-500/30'
                    : 'bg-dark-card border-dark-border hover:border-dark-border/80'
                }`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-9 h-9 rounded-lg bg-green-500/10 flex items-center justify-center shrink-0">
                    <Mail className="w-4 h-4 text-green-400" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-white truncate flex items-center gap-2">
                      <span>{acc.email}</span>
                      {acc.status === 'expired' && (
                        <span className="px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 border border-amber-500/30 text-[10px] font-bold">Bearer 过期</span>
                      )}
                      {acc.bearer ? (
                        <span className="px-1.5 py-0.5 rounded bg-green-500/15 text-green-400 border border-green-500/30 text-[10px] font-bold">有 Token</span>
                      ) : (
                        <span className="px-1.5 py-0.5 rounded bg-dark-muted/15 text-dark-muted border border-dark-border text-[10px] font-bold">无 Token</span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 text-xs text-dark-muted mt-0.5">
                      <span>{formatDate(acc.created_at)}</span>
                      {acc.cs_session && <span className="text-dark-subtle">cs_session 已保存</span>}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <button
                    onClick={() => copyText(acc.bearer, 'Bearer')}
                    disabled={!acc.bearer}
                    className="px-1.5 py-1 rounded-lg text-dark-muted hover:text-brand hover:bg-brand/10 disabled:opacity-40 transition-colors flex items-center gap-1 text-xs"
                    title="复制 Bearer"
                  >
                    <Copy className="w-3.5 h-3.5" /> Token
                  </button>
                  <button
                    onClick={() => handleQfRefresh(acc.id)}
                    disabled={qfRefreshingId === acc.id || !acc.cs_session}
                    className="p-1.5 rounded-lg text-dark-muted hover:text-brand hover:bg-brand/10 disabled:opacity-40 transition-colors"
                    title="用 cs_session 刷新 Bearer"
                  >
                    {qfRefreshingId === acc.id ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <RefreshCw className="w-4 h-4" />
                    )}
                  </button>
                  <button
                    onClick={() => handleQfDelete(acc.id)}
                    className="p-1.5 rounded-lg text-dark-muted hover:text-red-400 hover:bg-red-500/10 transition-colors"
                    title="删除"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        ))}
        {/* OiiOii Accounts List */}
        {activePool === 'oiioii' && (oiLoading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-6 h-6 text-brand animate-spin" />
          </div>
        ) : !oiSdkAvailable ? (
          <div className="flex flex-col items-center justify-center py-20 text-dark-muted">
            <AlertCircle className="w-12 h-12 mb-3 opacity-30" />
            <p className="text-sm">渠道四 SDK 不可用，请先确认 oiioii-sdk 已安装</p>
          </div>
        ) : oiAccounts.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-dark-muted">
            <Sparkles className="w-12 h-12 mb-3 opacity-30" />
            <p className="text-sm">暂无渠道四账号，点击右上角「注册账号」开始</p>
            <p className="text-xs text-dark-subtle mt-2">当前代理：{oiProxy.use_proxy ? `${oiProxy.proxy_host}:${oiProxy.proxy_port}` : '直连'}</p>
          </div>
        ) : (
          <div className="space-y-2">
            {!oiConfigured && (
              <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-300 text-xs">
                已检测到 SDK，但当前账号尚未完整配置。可刷新或重新注册账号。
              </div>
            )}
            {oiAccounts.map((acc) => (
              <div
                key={acc.file || acc.email}
                className="flex items-center justify-between p-4 rounded-xl border bg-dark-card border-dark-border hover:border-dark-border/80 transition-colors"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-9 h-9 rounded-lg bg-purple-500/10 flex items-center justify-center shrink-0">
                    <Sparkles className="w-4 h-4 text-purple-400" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-white truncate flex items-center gap-2">
                      <span>{acc.email || '未知账号'}</span>
                      {acc.has_token ? (
                        <span className="px-1.5 py-0.5 rounded bg-green-500/15 text-green-400 border border-green-500/30 text-[10px] font-bold">有 Token</span>
                      ) : (
                        <span className="px-1.5 py-0.5 rounded bg-dark-muted/15 text-dark-muted border border-dark-border text-[10px] font-bold">无 Token</span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 text-xs text-dark-muted mt-0.5">
                      <span>{acc.saved_at || '-'}</span>
                      <span className="text-dark-subtle">{acc.file || ''}</span>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <div className="flex flex-col items-end gap-1 mr-1">
                    <button
                      type="button"
                      onClick={() => handleOiRefreshAccountPoints(acc.email)}
                      disabled={!acc.email || !acc.has_token || oiRefreshingEmail === acc.email || oiRefreshingPoints || oiClaimingDaily}
                      className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-yellow-500/10 text-yellow-400 text-xs font-bold hover:bg-yellow-500/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      title={acc.has_token ? '点击查询该账号积分' : '该账号暂无 Token，无法查询积分'}
                    >
                      {oiRefreshingEmail === acc.email ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Coins className="w-3.5 h-3.5" />}
                      {oiRefreshingEmail === acc.email ? '查询中' : `${acc.points ?? '-'} 积分`}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleOiRefreshAccountPoints(acc.email)}
                      disabled={!acc.email || !acc.has_token || oiRefreshingEmail === acc.email || oiRefreshingPoints || oiClaimingDaily}
                      className="text-[10px] text-dark-muted whitespace-nowrap hover:text-yellow-400 disabled:hover:text-dark-muted disabled:cursor-not-allowed transition-colors"
                      title={acc.has_token ? '点击查询该账号积分' : '该账号暂无 Token，无法查询积分'}
                    >
                      限时/永久 {acc.availableLimited ?? '-'} / {acc.availablePerm ?? '-'} · {acc.hasSignedInToday === true ? '今日已领' : acc.hasSignedInToday === false ? '今日未领' : '未查询'}
                    </button>
                  </div>
                  <button
                    onClick={() => copyText(acc.email, '邮箱')}
                    disabled={!acc.email}
                    className="px-1.5 py-1 rounded-lg text-dark-muted hover:text-brand hover:bg-brand/10 disabled:opacity-40 transition-colors flex items-center gap-1 text-xs"
                    title="复制邮箱"
                  >
                    <Copy className="w-3.5 h-3.5" /> 邮箱
                  </button>
                  <button
                    onClick={() => handleOiDelete(acc.email)}
                    disabled={!acc.email}
                    className="p-1.5 rounded-lg text-dark-muted hover:text-red-400 hover:bg-red-500/10 disabled:opacity-40 transition-colors"
                    title="删除"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        ))}

        {activePool === 'dola' && (dolaLoading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-6 h-6 text-brand animate-spin" />
          </div>
        ) : dolaAccounts.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-dark-muted">
            <Sparkles className="w-12 h-12 mb-3 opacity-30" />
            <p className="text-sm">暂无渠道六账号，点击右上角「采集账号」或「手动添加」开始</p>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center justify-between rounded-xl border border-dark-border bg-dark-card/60 px-4 py-3 text-xs text-dark-muted">
              <span>当前共 {dolaAccounts.length} 个渠道六账号。可手动补录已有登录态，也可一键清空账号库。</span>
              <span>采集 / 删除不会影响其它渠道账号池。</span>
            </div>
            {dolaAccounts.map((acc) => (
              <div
                key={acc.id}
                className={`flex items-center justify-between p-4 rounded-xl border transition-colors ${
                  acc.status === 'active'
                    ? 'bg-dark-card border-dark-border hover:border-dark-border/80'
                    : 'bg-amber-950/20 border-amber-500/30'
                }`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-9 h-9 rounded-lg bg-orange-500/10 flex items-center justify-center shrink-0">
                    <Sparkles className="w-4 h-4 text-orange-300" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-white truncate flex items-center gap-2">
                      <span>{acc.name || 'Dola 采集账号'}</span>
                      <span className={`px-1.5 py-0.5 rounded border text-[10px] font-bold ${
                        acc.status === 'active'
                          ? 'bg-green-500/15 text-green-400 border-green-500/30'
                          : 'bg-amber-500/15 text-amber-400 border-amber-500/30'
                      }`}>{acc.status === 'active' ? '可用' : '未完整'}</span>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-dark-muted mt-0.5">
                      <span>{formatDate(acc.created_at)}</span>
                      {acc.cookie_masked && <span className="font-mono text-dark-subtle">Cookie {acc.cookie_masked}</span>}
                    </div>
                    <div className="flex items-center gap-2 mt-1">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-lg border text-[11px] font-bold ${
                        (acc.daily_video_remaining ?? 6) > 0
                          ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/25'
                          : 'bg-red-500/10 text-red-300 border-red-500/25'
                      }`}>
                        <Coins className="w-3 h-3" /> 今日额度 {acc.daily_video_remaining ?? 6}/{acc.daily_video_quota ?? 6}
                      </span>
                      <span className="text-[10px] text-dark-subtle">
                        5s 扣 1，15s 扣 3 · {acc.daily_video_date || '今日'}
                      </span>
                    </div>
                    <div className="mt-1 text-[11px] text-dark-subtle truncate max-w-[560px]" title={acc.env_file || ''}>
                      {acc.env_file || '未记录 env 文件'}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <button
                    onClick={() => handleDolaOpenBrowser(acc.id)}
                    disabled={dolaOpeningId === acc.id}
                    className="px-1.5 py-1 rounded-lg text-dark-muted hover:text-sky-400 hover:bg-sky-500/10 disabled:opacity-40 transition-colors flex items-center gap-1 text-xs"
                    title="打开该账号窗口"
                  >
                    {dolaOpeningId === acc.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ExternalLink className="w-3.5 h-3.5" />} 打开
                  </button>
                  <button
                    onClick={() => copyText(acc.env_file || '', '登录态路径')}
                    disabled={!acc.env_file}
                    className="px-1.5 py-1 rounded-lg text-dark-muted hover:text-brand hover:bg-brand/10 disabled:opacity-40 transition-colors flex items-center gap-1 text-xs"
                    title="复制登录态路径"
                  >
                    <Copy className="w-3.5 h-3.5" /> 路径
                  </button>
                  <button
                    onClick={() => handleDolaDelete(acc.id)}
                    className="p-1.5 rounded-lg text-dark-muted hover:text-red-400 hover:bg-red-500/10 transition-colors"
                    title="删除"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
