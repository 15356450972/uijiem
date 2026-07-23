import React, { useState, useEffect, useRef } from 'react';
import {
  KeyRound,
  Trash2,
  RefreshCw,
  Loader2,
  AlertCircle,
  XCircle,
  Coins,
  ExternalLink,
  Copy,
  User,
  CheckCircle2,
  Zap,
  Sparkles,
  BarChart3,
  SlidersHorizontal,
  Mail,
  Download,
  Square,
  RotateCcw,
  Calendar,
} from 'lucide-react';
import { WIZSTAR_API as API_BASE } from '../config';

/** Normalize account created_at / updated_at into local YYYY-MM-DD. */
function accountDateKey(value) {
  if (value == null || value === '') return '';
  let date;
  if (typeof value === 'number') {
    date = new Date(value < 1e12 ? value * 1000 : value);
  } else if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const num = Number(value);
    date = new Date(num < 1e12 ? num * 1000 : num);
  } else {
    date = new Date(value);
  }
  if (Number.isNaN(date.getTime())) return '';
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export default function WizstarAccounts({ onOpenGoogleLogin }) {
  const [activePool, setActivePool] = useState('wizstar'); // 'wizstar' | 'quickframe' | 'oiioii' | 'dola' | 'lovart' | 'oreateai' | 'framia' | 'tensorart' | 'happyhorse' | 'insmind'
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshingId, setRefreshingId] = useState(null);
  const [batchRefreshing, setBatchRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
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
  const [dolaImportMsToken, setDolaImportMsToken] = useState('');
  const [dolaImportEnvFile, setDolaImportEnvFile] = useState('');
  const [dolaImportProfileDir, setDolaImportProfileDir] = useState('');
  const [dolaImportNote, setDolaImportNote] = useState('');

  // ---- Dola Google 批量登录 ----
  const [showDolaBatchLogin, setShowDolaBatchLogin] = useState(false);
  const [dolaBatchText, setDolaBatchText] = useState('');
  const [dolaBatchConcurrency, setDolaBatchConcurrency] = useState(2);
  const [dolaPoolCount, setDolaPoolCount] = useState(1);
  const [dolaBatchStep, setDolaBatchStep] = useState('idle');
  const [dolaBatchResults, setDolaBatchResults] = useState({});
  const [dolaBatchSummary, setDolaBatchSummary] = useState(null);

  // ---- Lovart 渠道七账号池状态 ----
  const [lovartAccounts, setLovartAccounts] = useState([]);
  const [lovartLoading, setLovartLoading] = useState(false);
  const [lovartDeletingAll, setLovartDeletingAll] = useState(false);
  const [showLovartBatchLogin, setShowLovartBatchLogin] = useState(false);
  const [lovartBatchText, setLovartBatchText] = useState('');
  const [lovartBatchConcurrency, setLovartBatchConcurrency] = useState(1);
  const [lovartPoolCount, setLovartPoolCount] = useState(1);
  const [lovartBatchVisible, setLovartBatchVisible] = useState(true);
  const [lovartBatchStep, setLovartBatchStep] = useState('idle');
  const [lovartBatchResults, setLovartBatchResults] = useState({});
  const [lovartBatchSummary, setLovartBatchSummary] = useState(null);

  // ---- OreateAI 渠道八账号池状态 ----
  const [oreateaiAccounts, setOreateaiAccounts] = useState([]);
  const [oreateaiLoading, setOreateaiLoading] = useState(false);
  const [oreateaiRegistering, setOreateaiRegistering] = useState(false);
  const [oreateaiProgress, setOreateaiProgress] = useState('');
  const [showOreateaiRegister, setShowOreateaiRegister] = useState(false);
  const [oreateaiRegCount, setOreateaiRegCount] = useState(1);
  const [oreateaiRegConcurrency, setOreateaiRegConcurrency] = useState(1);
  const [oreateaiCaptureOpeningId, setOreateaiCaptureOpeningId] = useState(null);
  const [oreateaiCredits, setOreateaiCredits] = useState({});
  const [oreateaiClaimingAll, setOreateaiClaimingAll] = useState(false);
  const [oreateaiClaimAllProgress, setOreateaiClaimAllProgress] = useState('');

  // ---- Framia 渠道九账号池状态 ----
  const [framiaAccounts, setFramiaAccounts] = useState([]);
  const [framiaLoading, setFramiaLoading] = useState(false);
  const [framiaRefreshingId, setFramiaRefreshingId] = useState(null);
  const [showFramiaBatchLogin, setShowFramiaBatchLogin] = useState(false);
  const [framiaBatchText, setFramiaBatchText] = useState('');
  const [framiaBatchVisible, setFramiaBatchVisible] = useState(true);
  const [framiaBatchConcurrency, setFramiaBatchConcurrency] = useState(1);
  const [framiaPoolCount, setFramiaPoolCount] = useState(1);
  const [framiaBatchStep, setFramiaBatchStep] = useState('idle');
  const [framiaBatchResults, setFramiaBatchResults] = useState({});
  const [framiaBatchSummary, setFramiaBatchSummary] = useState(null);

  // ---- Tensor.Art 渠道十账号池状态 ----
  const [tensorartAccounts, setTensorartAccounts] = useState([]);
  const [tensorartLoading, setTensorartLoading] = useState(false);
  const [tensorartRegistering, setTensorartRegistering] = useState(false);
  const [tensorartRefreshingId, setTensorartRefreshingId] = useState(null);
  const [showTensorartRegister, setShowTensorartRegister] = useState(false);
  const [tensorartRegCount, setTensorartRegCount] = useState(1);
  const [tensorartRegConcurrency, setTensorartRegConcurrency] = useState(1);

  // ---- HappyHorse 渠道十一账号池状态 ----
  const [happyhorseAccounts, setHappyhorseAccounts] = useState([]);
  const [happyhorseLoading, setHappyhorseLoading] = useState(false);
  const [happyhorseRefreshingId, setHappyhorseRefreshingId] = useState(null);
  const [happyhorseSigningId, setHappyhorseSigningId] = useState(null);
  const [showHappyhorseBatchLogin, setShowHappyhorseBatchLogin] = useState(false);
  const [happyhorseBatchText, setHappyhorseBatchText] = useState('');
  const [happyhorseBatchVisible, setHappyhorseBatchVisible] = useState(true);
  const [happyhorseBatchConcurrency, setHappyhorseBatchConcurrency] = useState(1);
  const [happyhorsePoolCount, setHappyhorsePoolCount] = useState(1);
  const [happyhorseBatchStep, setHappyhorseBatchStep] = useState('idle');
  const [happyhorseBatchResults, setHappyhorseBatchResults] = useState({});
  const [happyhorseBatchSummary, setHappyhorseBatchSummary] = useState(null);
  const [happyhorseBatchMode, setHappyhorseBatchMode] = useState('text'); // 'text' | 'pool'
  const [happyhorseCancelling, setHappyhorseCancelling] = useState(false);
  const [happyhorseBatchProgress, setHappyhorseBatchProgress] = useState(null);
  // { total, done, succeeded, failed, skipped, cancelled, currentEmail }
  const [happyhorseSelectedIds, setHappyhorseSelectedIds] = useState([]);
  const [happyhorseExporting, setHappyhorseExporting] = useState(false);
  // 按添加账号日期筛选，格式 YYYY-MM-DD；空字符串表示不过滤
  const [happyhorseCreatedDateFilter, setHappyhorseCreatedDateFilter] = useState('');
  const happyhorseDateFilterRef = useRef(null);
  const happyhorseBatchCancelRef = useRef(false);
  const happyhorseBatchAccountsRef = useRef([]); // [{email,password,mailbox_id?}]

  const happyhorseFilteredAccounts = happyhorseCreatedDateFilter
    ? happyhorseAccounts.filter((acc) => accountDateKey(acc.created_at || acc.updated_at) === happyhorseCreatedDateFilter)
    : happyhorseAccounts;

  // ---- insMind 渠道十二账号池状态 ----
  const [insmindAccounts, setInsmindAccounts] = useState([]);
  const [insmindLoading, setInsmindLoading] = useState(false);
  const [insmindRegistering, setInsmindRegistering] = useState(false);
  const [showInsmindRegister, setShowInsmindRegister] = useState(false);
  const [insmindRegCount, setInsmindRegCount] = useState(1);
  const [insmindRegConcurrency, setInsmindRegConcurrency] = useState(1);
  const [insmindSelectedIds, setInsmindSelectedIds] = useState([]);
  const [insmindExporting, setInsmindExporting] = useState(false);
  const [insmindDeleting, setInsmindDeleting] = useState(false);
  // { total, done, succeeded, failed, currentEmail, use_proxy }
  const [insmindRegProgress, setInsmindRegProgress] = useState(null);

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
    const ms_token = dolaImportMsToken.trim();
    const env_file = dolaImportEnvFile.trim();
    const profile_dir = dolaImportProfileDir.trim();
    const note = dolaImportNote.trim();
    if (!ms_token) {
      setError('请填写用户显式提供的 DOLA_MS_TOKEN；不能仅凭 Cookie 导入渠道六账号。');
      return;
    }
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
        body: JSON.stringify({ name, cookie, ms_token, env_file, profile_dir, note }),
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
      setDolaImportMsToken('');
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

  const handleDolaBatchLogin = async (useMailboxPool = false) => {
    const lines = dolaBatchText.trim().split('\n').filter(l => l.trim());
    const accounts = lines.map(line => {
      const [email, password] = line.trim().split('|');
      return { email: (email || '').trim(), password: (password || '').trim() };
    }).filter(a => a.email && a.password);
    if (!useMailboxPool && accounts.length === 0) {
      setError('请输入有效的账号密码，每行一个，格式: email|password');
      return;
    }
    const requestedCount = useMailboxPool
      ? Math.max(1, Math.min(parseInt(dolaPoolCount, 10) || 1, 100))
      : accounts.length;
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
        useMailboxPool,
        count: requestedCount,
        concurrency: dolaBatchConcurrency,
      });
      if (result?.ok) {
        setDolaBatchSummary({ succeeded: result.succeeded, failed: result.failed, total: result.results?.length || requestedCount });
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

  const fetchLovartAccounts = async () => {
    try {
      setLovartLoading(true);
      const res = await fetch(`${API_BASE}/lovart/accounts`);
      const data = await res.json();
      setLovartAccounts(data.data || []);
      setError('');
    } catch (e) {
      setError('无法连接到渠道七服务，请确认 Python 服务已启动');
    } finally {
      setLovartLoading(false);
    }
  };

  const handleLovartDeleteAll = async () => {
    if (lovartAccounts.length === 0) return;
    if (!confirm(`确定删除全部 ${lovartAccounts.length} 个渠道七 Lovart 账号？`)) return;
    setLovartDeletingAll(true);
    setError('');
    setSuccessMsg('');
    try {
      const res = await fetch(`${API_BASE}/lovart/accounts`, { method: 'DELETE' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || '清空失败');
      }
      const result = await res.json();
      const deleted = result.data?.deleted ?? lovartAccounts.length;
      setSuccessMsg(`已删除 ${deleted} 个渠道七账号`);
      fetchLovartAccounts();
    } catch (e) {
      setError(e.message || '清空失败');
    } finally {
      setLovartDeletingAll(false);
    }
  };

  const handleLovartDelete = async (id) => {
    if (!confirm('确定删除该渠道七 Lovart 账号？')) return;
    try {
      const res = await fetch(`${API_BASE}/lovart/accounts/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || '删除失败');
      }
      setSuccessMsg('渠道七账号已删除');
      fetchLovartAccounts();
    } catch (e) {
      setError(e.message || '删除失败');
    }
  };

  useEffect(() => {
    if (!window.electronAPI?.onLovartBatchProgress) return;
    const unsubscribe = window.electronAPI.onLovartBatchProgress((data) => {
      if (data?.step === 'batch_complete') {
        setLovartBatchSummary(data.data);
        setLovartBatchStep('done');
        fetchLovartAccounts();
        return;
      }
      if (data?.index !== undefined) {
        setLovartBatchResults(prev => ({
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

  const handleLovartBatchLogin = async (useMailboxPool = false) => {
    const lines = lovartBatchText.trim().split('\n').filter(l => l.trim());
    const accounts = lines.map(line => {
      const [email, password] = line.trim().split('|');
      return { email: (email || '').trim(), password: (password || '').trim() };
    }).filter(a => a.email && a.password);
    if (!useMailboxPool && accounts.length === 0) {
      setError('请输入有效的 Lovart Google 账号密码，每行一个，格式: email|password');
      return;
    }
    const requestedCount = useMailboxPool
      ? Math.max(1, Math.min(parseInt(lovartPoolCount, 10) || 1, 100))
      : accounts.length;
    setLovartBatchStep('running');
    setLovartBatchResults({});
    setLovartBatchSummary(null);
    setError('');
    setSuccessMsg('');
    try {
      if (!window.electronAPI?.lovartBatchLogin) {
        throw new Error('Electron 环境不可用，请确保在 Electron 应用中运行，并重启应用以加载新的 preload。');
      }
      const result = await window.electronAPI.lovartBatchLogin({
        accounts,
        useMailboxPool,
        count: requestedCount,
        concurrency: lovartBatchConcurrency,
        visible: lovartBatchVisible,
      });
      if (result?.ok) {
        setLovartBatchSummary({ succeeded: result.succeeded, failed: result.failed, total: result.results?.length || requestedCount });
        setLovartBatchStep('done');
        setSuccessMsg(`渠道七 Lovart 批量登录完成：成功 ${result.succeeded}，失败 ${result.failed}`);
        fetchLovartAccounts();
      } else {
        setLovartBatchStep('idle');
        setError(result?.error || '渠道七 Lovart 批量登录失败');
      }
    } catch (e) {
      setLovartBatchStep('idle');
      setError(e.message || String(e));
    }
  };

  const fetchOreateaiAccounts = async () => {
    try {
      setOreateaiLoading(true);
      const res = await fetch(`${API_BASE}/oreateai/accounts`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setOreateaiAccounts(data.data || []);
      setError('');
    } catch (e) {
      setError(e.message || '无法连接到渠道八服务，请确认 Python 服务已启动');
    } finally {
      setOreateaiLoading(false);
    }
  };

  const handleOreateaiRegister = async (event) => {
    event?.preventDefault();
    if (!window.electronAPI?.oreateaiRegisterLogin) {
      setError('请在 Electron 桌面端中使用渠道八注册');
      return;
    }
    setOreateaiRegistering(true);
    setOreateaiProgress('正在准备注册...');
    setError('');
    setSuccessMsg('');
    try {
      const count = Math.max(1, Math.min(parseInt(oreateaiRegCount, 10) || 1, 50));
      const concurrency = Math.max(1, Math.min(parseInt(oreateaiRegConcurrency, 10) || 1, 5, count));
      const result = await window.electronAPI.oreateaiRegisterLogin({
        visible: true,
        keepOpen: false,
        count,
        concurrency,
      });
      if (!result?.ok) throw new Error(result?.error || '渠道八注册登录失败');
      if (count === 1) {
        const single = result.results?.[0] || result;
        if (!single?.ok) throw new Error(single?.error || '渠道八注册登录失败');
        setSuccessMsg(`渠道八注册成功：${single.email}，已保存 ${single.cookieCount} 个 Cookie`);
      } else {
        setSuccessMsg(`渠道八批量注册完成：成功 ${result.succeeded || 0} 个，失败 ${result.failed || 0} 个`);
        const failures = (result.results || []).filter(item => !item?.ok);
        if (failures.length > 0) {
          setError(failures.map(item => `${item.email || `#${(item.index ?? 0) + 1}`}: ${item.error || '注册失败'}`).join('\n'));
        }
      }
      setShowOreateaiRegister(false);
      await fetchOreateaiAccounts();
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setOreateaiRegistering(false);
      setOreateaiProgress('');
    }
  };

  useEffect(() => {
    if (!window.electronAPI?.onOreateaiLoginProgress) return undefined;
    const labels = {
      mailbox_connecting: '正在连接小苹果邮件 API...',
      browser_opening: '正在启动真实浏览器...',
      ticket_request: '正在获取注册票据...',
      risk_request: '正在生成风控凭证...',
      signup_submit: '正在提交注册...',
      email_wait: '正在等待验证邮件...',
      email_verify: '正在验证邮箱...',
      login_check: '正在确认登录状态...',
      complete: '登录成功，正在保存账号...',
    };
    return window.electronAPI.onOreateaiLoginProgress(({ step, index, total, completed, succeeded, failed }) => {
      if (step === 'batch_progress' || step === 'batch_complete') {
        setOreateaiProgress(`已完成 ${completed || 0}/${total || 0}，成功 ${succeeded || 0}，失败 ${failed || 0}`);
        return;
      }
      const prefix = Number.isInteger(index) && total > 1 ? `[任务 ${index + 1}/${total}] ` : '';
      setOreateaiProgress(`${prefix}${labels[step] || step || ''}`);
    });
  }, []);

  const handleOreateaiCapture = async (accountId) => {
    if (!window.electronAPI?.oreateaiOpenCapture) {
      setError('Electron 录制入口不可用，请重启桌面应用');
      return;
    }
    setOreateaiCaptureOpeningId(accountId);
    setError('');
    setSuccessMsg('');
    try {
      const result = await window.electronAPI.oreateaiOpenCapture(accountId);
      if (!result?.ok) throw new Error(result?.error || '打开渠道八操作记录窗口失败');
      setSuccessMsg('操作记录窗口已打开。请在新窗口中完成一次视频生成，操作结束后直接关闭该窗口。');
    } catch (captureError) {
      setError(captureError.message || String(captureError));
    } finally {
      setOreateaiCaptureOpeningId(null);
    }
  };

  const requestOreateaiCredits = async (accountId, claim = false, { silent = false } = {}) => {
    const flag = claim ? 'claiming' : 'loading';
    setOreateaiCredits((current) => ({
      ...current,
      [accountId]: { ...current[accountId], [flag]: true, error: '' },
    }));
    if (!silent) {
      setError('');
      if (claim) setSuccessMsg('');
    }
    try {
      const res = await fetch(
        `${API_BASE}/oreateai/accounts/${accountId}/credits${claim ? '/claim' : ''}`,
        { method: claim ? 'POST' : 'GET' },
      );
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.detail || `${claim ? '领取' : '查询'}积分失败`);
      const data = payload.data || {};
      setOreateaiCredits((current) => ({
        ...current,
        [accountId]: {
          ...current[accountId],
          ...data,
          loading: false,
          claiming: Boolean(claim && data.pending),
          error: '',
        },
      }));
      if (!claim) return { status: 'queried', ...data };
      if (data.claimed) {
        if (!silent) setSuccessMsg(`渠道八领取成功：+${data.claimed_points || 0} 积分，当前 ${data.rest_points || 0} 积分`);
        return { status: 'claimed', ...data };
      }
      if (!data.pending) {
        if (!silent) setSuccessMsg(`该渠道八账号当前没有待领取积分，当前 ${data.rest_points || 0} 积分`);
        return { status: 'already_claimed', ...data };
      }

      const beforePoints = Number(data.before_points || data.rest_points || 0);
      if (!silent) setSuccessMsg('领取请求已提交，OreateAI 正在异步入账...');
      for (let attempt = 0; attempt < 12; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        try {
          const checkRes = await fetch(`${API_BASE}/oreateai/accounts/${accountId}/credits`);
          const checkPayload = await checkRes.json().catch(() => ({}));
          if (!checkRes.ok) continue;
          const latest = checkPayload.data || {};
          const claimedPoints = Math.max(0, Number(latest.rest_points || 0) - beforePoints);
          setOreateaiCredits((current) => ({
            ...current,
            [accountId]: {
              ...current[accountId],
              ...latest,
              claiming: claimedPoints === 0,
              error: '',
            },
          }));
          if (claimedPoints > 0) {
            if (!silent) setSuccessMsg(`渠道八领取成功：+${claimedPoints} 积分，当前 ${latest.rest_points || 0} 积分`);
            return { status: 'claimed', claimed_points: claimedPoints, ...latest };
          }
        } catch {
          // 远端偶发超时，下一轮继续查询入账结果。
        }
      }
      setOreateaiCredits((current) => ({
        ...current,
        [accountId]: { ...current[accountId], claiming: false },
      }));
      if (!silent) setSuccessMsg('领取请求已提交，但积分到账较慢；稍后点击「查询积分」确认。');
      return { status: 'pending', ...data };
    } catch (requestError) {
      const message = requestError.message || String(requestError);
      setOreateaiCredits((current) => ({
        ...current,
        [accountId]: {
          ...current[accountId],
          loading: false,
          claiming: false,
          error: message,
        },
      }));
      if (!silent) setError(message);
      return { status: 'failed', error: message };
    }
  };

  const handleOreateaiClaimAll = async () => {
    const accountsToClaim = oreateaiAccounts.filter(
      (account) => account.configured && account.status !== 'disabled',
    );
    if (accountsToClaim.length === 0) {
      setError('没有可领取积分的渠道八账号');
      return;
    }
    setOreateaiClaimingAll(true);
    setOreateaiClaimAllProgress(`0/${accountsToClaim.length}`);
    setError('');
    setSuccessMsg('');
    const results = new Array(accountsToClaim.length);
    let cursor = 0;
    let completed = 0;
    try {
      const worker = async () => {
        while (cursor < accountsToClaim.length) {
          const index = cursor;
          cursor += 1;
          const account = accountsToClaim[index];
          results[index] = {
            account,
            result: await requestOreateaiCredits(account.id, true, { silent: true }),
          };
          completed += 1;
          setOreateaiClaimAllProgress(`${completed}/${accountsToClaim.length}`);
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(2, accountsToClaim.length) }, () => worker()),
      );
      const claimed = results.filter((item) => item?.result?.status === 'claimed').length;
      const alreadyClaimed = results.filter((item) => item?.result?.status === 'already_claimed').length;
      const pending = results.filter((item) => item?.result?.status === 'pending').length;
      const failed = results.filter((item) => item?.result?.status === 'failed');
      setSuccessMsg(
        `渠道八一键领取完成：到账 ${claimed}，已领取 ${alreadyClaimed}，待到账 ${pending}，失败 ${failed.length}`,
      );
      if (failed.length > 0) {
        setError(failed.map(({ account, result }) => `${account.email || account.id}: ${result.error}`).join('\n'));
      }
    } finally {
      setOreateaiClaimingAll(false);
      setOreateaiClaimAllProgress('');
    }
  };

  useEffect(() => {
    if (!window.electronAPI?.onOreateaiCaptureProgress) return undefined;
    return window.electronAPI.onOreateaiCaptureProgress(({ step, data = {} }) => {
      if (step === 'capture_finished') {
        setSuccessMsg(`渠道八操作记录完成：共捕获 ${data.requestCount || 0} 个接口请求。记录文件：${data.networkPath || ''}`);
      } else if (step === 'capture_failed') {
        setError(data.error || '渠道八操作记录失败');
      }
    });
  }, []);

  const handleOreateaiDelete = async (id) => {
    if (!confirm('确定删除该渠道八 OreateAI 账号？')) return;
    setError('');
    setSuccessMsg('');
    try {
      const res = await fetch(`${API_BASE}/oreateai/accounts/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || '删除失败');
      }
      setSuccessMsg('渠道八账号已删除');
      fetchOreateaiAccounts();
    } catch (e) {
      setError(e.message || '删除失败');
    }
  };

  const fetchFramiaAccounts = async () => {
    try {
      setFramiaLoading(true);
      const res = await fetch(`${API_BASE}/framia/accounts`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setFramiaAccounts(data.data || []);
      setError('');
    } catch (e) {
      setError(e.message || '无法连接到渠道九服务，请确认 Python 服务已启动');
    } finally {
      setFramiaLoading(false);
    }
  };

  const handleFramiaDelete = async (id) => {
    if (!confirm('确定删除该渠道九 Framia 账号？')) return;
    setError('');
    setSuccessMsg('');
    try {
      const res = await fetch(`${API_BASE}/framia/accounts/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || '删除失败');
      }
      setSuccessMsg('渠道九账号已删除');
      fetchFramiaAccounts();
    } catch (e) {
      setError(e.message || '删除失败');
    }
  };

  const handleFramiaRefreshCredits = async (id) => {
    setFramiaRefreshingId(id);
    setError('');
    setSuccessMsg('');
    try {
      const res = await fetch(`${API_BASE}/framia/credits?account_id=${id}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || '查询积分失败');
      }
      const data = await res.json();
      const credits = data.data || {};
      setFramiaAccounts(prev => prev.map(a => a.id === id ? { ...a, credits_balance: credits.credits_balance } : a));
      setSuccessMsg(`渠道九积分：${credits.credits_balance ?? '-'}`);
    } catch (e) {
      setError(e.message || '查询积分失败');
    } finally {
      setFramiaRefreshingId(null);
    }
  };

  const handleFramiaBatchLogin = async () => {
    const lines = framiaBatchText.trim().split('\n').filter(l => l.trim());
    const accounts = lines.map(line => {
      const [email, password] = line.trim().split('|');
      return { email: (email || '').trim(), password: (password || '').trim() };
    }).filter(a => a.email && a.password);
    if (accounts.length === 0) {
      setError('请输入有效的 Framia Google 账号密码，每行一个，格式: email|password');
      return;
    }
    const concurrency = Math.max(1, Math.min(parseInt(framiaBatchConcurrency, 10) || 1, 5, accounts.length));
    setFramiaBatchStep('running');
    setFramiaBatchResults({});
    setFramiaBatchSummary(null);
    setError('');
    setSuccessMsg('');
    let succeeded = 0;
    let failed = 0;
    let cursor = 0;
    const runOne = async (i) => {
      const { email, password } = accounts[i];
      setFramiaBatchResults(prev => ({ ...prev, [i]: { email, ok: null, step: 'starting' } }));
      try {
        const res = await fetch(`${API_BASE}/framia/accounts/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password, visible: framiaBatchVisible, keep_open: false }),
        });
        const responseText = await res.text();
        let data = {};
        try {
          data = responseText ? JSON.parse(responseText) : {};
        } catch {
          data = { detail: responseText };
        }
        if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
        succeeded++;
        setFramiaBatchResults(prev => ({ ...prev, [i]: { email, ok: true, step: 'saved_to_db' } }));
      } catch (e) {
        failed++;
        setFramiaBatchResults(prev => ({ ...prev, [i]: { email, ok: false, step: 'error', error: e.message } }));
      }
    };
    const workers = Array.from({ length: concurrency }, async () => {
      while (true) {
        const i = cursor++;
        if (i >= accounts.length) break;
        await runOne(i);
      }
    });
    await Promise.all(workers);
    setFramiaBatchSummary({ succeeded, failed, total: accounts.length });
    setFramiaBatchStep('done');
    if (succeeded > 0) {
      setSuccessMsg(`渠道九 Framia 批量登录完成：成功 ${succeeded}，失败 ${failed}`);
      fetchFramiaAccounts();
    } else {
      setError('渠道九 Framia 批量登录全部失败，请查看下方每个账号的失败原因。');
    }
  };

  const handleFramiaPoolLogin = async () => {
    const count = Math.max(1, Math.min(parseInt(framiaPoolCount, 10) || 1, 100));
    const concurrency = Math.max(1, Math.min(parseInt(framiaBatchConcurrency, 10) || 1, 5, count));
    setFramiaBatchStep('running');
    setFramiaBatchResults({});
    setFramiaBatchSummary(null);
    setError('');
    setSuccessMsg('');
    try {
      const res = await fetch(`${API_BASE}/framia/accounts/login-pool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          count,
          concurrency,
          visible: framiaBatchVisible,
          keep_open: false,
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.detail || `HTTP ${res.status}`);
      const result = payload.data || {};
      const items = Array.isArray(result.results) ? result.results : [];
      setFramiaBatchResults(Object.fromEntries(items.map((item, index) => [
        index,
        {
          email: item.email,
          ok: Boolean(item.ok),
          step: item.ok ? 'saved_to_db' : 'error',
          error: item.error || '',
        },
      ])));
      setFramiaBatchSummary({
        succeeded: result.succeeded || 0,
        failed: result.failed || 0,
        total: result.total || items.length,
      });
      setFramiaBatchStep('done');
      if (result.succeeded > 0) {
        setSuccessMsg(`渠道九从邮箱库登录完成：成功 ${result.succeeded}，失败 ${result.failed || 0}`);
        fetchFramiaAccounts();
      } else {
        setError('渠道九邮箱库账号登录全部失败，请查看失败原因。');
      }
    } catch (e) {
      setFramiaBatchStep('idle');
      setError(e.message || String(e));
    }
  };

  const fetchHappyhorseAccounts = async () => {
    try {
      setHappyhorseLoading(true);
      const res = await fetch(`${API_BASE}/happyhorse/accounts`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP ${res.status}`);
      }
      const data = await res.json();
      const nextAccounts = data.data || [];
      setHappyhorseAccounts(nextAccounts);
      setHappyhorseSelectedIds(prev => prev.filter(id => nextAccounts.some(acc => acc.id === id)));
      setError('');
    } catch (e) {
      setError(e.message || '无法连接到渠道十一服务，请确认 Python 服务已启动');
    } finally {
      setHappyhorseLoading(false);
    }
  };

  const toggleHappyhorseSelection = (id) => {
    const accountId = Number(id);
    if (!accountId) return;
    setHappyhorseSelectedIds(prev => (
      prev.includes(accountId)
        ? prev.filter(item => item !== accountId)
        : [...prev, accountId]
    ));
  };

  const toggleHappyhorseSelectAll = () => {
    const visibleIds = happyhorseFilteredAccounts.map(acc => Number(acc.id)).filter(Boolean);
    const allVisibleSelected = visibleIds.length > 0 && visibleIds.every(id => happyhorseSelectedIds.includes(id));
    if (allVisibleSelected) {
      setHappyhorseSelectedIds(prev => prev.filter(id => !visibleIds.includes(id)));
      return;
    }
    setHappyhorseSelectedIds(prev => Array.from(new Set([...prev, ...visibleIds])));
  };

  const handleHappyhorseExportSelected = async () => {
    if (!happyhorseSelectedIds.length) {
      setError('请先勾选要导出的渠道十一账号');
      return;
    }
    setHappyhorseExporting(true);
    setError('');
    setSuccessMsg('');
    try {
      const res = await fetch(`${API_BASE}/happyhorse/accounts/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_ids: happyhorseSelectedIds }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.detail || '导出失败');
      const accounts = payload.data || [];
      if (!accounts.length) throw new Error('未找到可导出的账号');

      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const jsonBlob = new Blob([JSON.stringify(accounts, null, 2)], { type: 'application/json;charset=utf-8' });
      const jsonUrl = URL.createObjectURL(jsonBlob);
      const jsonLink = document.createElement('a');
      jsonLink.href = jsonUrl;
      jsonLink.download = `happyhorse-accounts-${stamp}.json`;
      document.body.appendChild(jsonLink);
      jsonLink.click();
      jsonLink.remove();
      URL.revokeObjectURL(jsonUrl);

      const txtLines = accounts.flatMap((acc) => ([
        `=== id=${acc.id} | ${acc.email || ''} | ${acc.status || ''} ===`,
        `cookie: ${acc.cookie || ''}`,
        `access_token: ${acc.access_token || ''}`,
        `refresh_token: ${acc.refresh_token || ''}`,
        `device_id: ${acc.device_id || ''}`,
        `user_agent: ${acc.user_agent || ''}`,
        `password: ${acc.password || ''}`,
        '',
      ]));
      const txtBlob = new Blob([txtLines.join('\n')], { type: 'text/plain;charset=utf-8' });
      const txtUrl = URL.createObjectURL(txtBlob);
      const txtLink = document.createElement('a');
      txtLink.href = txtUrl;
      txtLink.download = `happyhorse-accounts-${stamp}.txt`;
      document.body.appendChild(txtLink);
      txtLink.click();
      txtLink.remove();
      URL.revokeObjectURL(txtUrl);

      setSuccessMsg(`已导出 ${accounts.length} 个渠道十一账号（JSON + TXT）`);
    } catch (e) {
      setError(e.message || '导出失败');
    } finally {
      setHappyhorseExporting(false);
    }
  };

  const handleHappyhorseDelete = async (id) => {
    if (!confirm('确定删除该渠道十一 HappyHorse 账号？')) return;
    setError('');
    setSuccessMsg('');
    try {
      const res = await fetch(`${API_BASE}/happyhorse/accounts/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || '删除失败');
      }
      setHappyhorseSelectedIds(prev => prev.filter(item => item !== Number(id)));
      setSuccessMsg('渠道十一账号已删除');
      fetchHappyhorseAccounts();
    } catch (e) {
      setError(e.message || '删除失败');
    }
  };

  const handleHappyhorseRefreshCredits = async (id) => {
    setHappyhorseRefreshingId(id);
    setError('');
    setSuccessMsg('');
    try {
      const res = await fetch(`${API_BASE}/happyhorse/credits?account_id=${id}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || '查询积分失败');
      }
      const data = await res.json();
      const credits = data.data || {};
      const balance = credits.credits_balance ?? credits.available_count ?? null;
      setHappyhorseAccounts(prev => prev.map(a => a.id === id ? {
        ...a,
        credits_balance: balance,
        play_code_details: credits.play_code_details || [],
      } : a));
      setSuccessMsg(`渠道十一可用积分：${balance ?? '-'}`);
    } catch (e) {
      setError(e.message || '查询积分失败');
    } finally {
      setHappyhorseRefreshingId(null);
    }
  };

  const handleHappyhorseDailySignin = async (id) => {
    setHappyhorseSigningId(id);
    setError('');
    setSuccessMsg('');
    try {
      const res = await fetch(`${API_BASE}/happyhorse/credits/daily-signin?account_id=${id}`, { method: 'POST' });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.detail || '每日签到失败');
      const result = payload.data || {};
      const balance = result.credits_balance ?? result.available_count ?? null;
      setHappyhorseAccounts(prev => prev.map(a => a.id === id ? {
        ...a,
        credits_balance: balance,
        play_code_details: result.play_code_details || a.play_code_details || [],
      } : a));
      setSuccessMsg(`签到成功：+${result.grant_points ?? 0}，当前可用 ${balance ?? '-'}`);
    } catch (e) {
      setError(e.message || '每日签到失败');
    } finally {
      setHappyhorseSigningId(null);
    }
  };

  const handleHappyhorseBatchCredits = async () => {
    if (!happyhorseFilteredAccounts.length) return;
    setError('');
    setSuccessMsg('');
    let ok = 0;
    let fail = 0;
    for (const acc of happyhorseFilteredAccounts) {
      try {
        setHappyhorseRefreshingId(acc.id);
        const res = await fetch(`${API_BASE}/happyhorse/credits?account_id=${acc.id}`);
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(payload.detail || `HTTP ${res.status}`);
        const credits = payload.data || {};
        const balance = credits.credits_balance ?? credits.available_count ?? null;
        setHappyhorseAccounts(prev => prev.map(a => a.id === acc.id ? {
          ...a,
          credits_balance: balance,
          play_code_details: credits.play_code_details || [],
        } : a));
        ok += 1;
      } catch (_) {
        fail += 1;
      }
    }
    setHappyhorseRefreshingId(null);
    setSuccessMsg(`渠道十一积分查询完成：成功 ${ok}，失败 ${fail}`);
  };

  const handleHappyhorseBatchDailySignin = async () => {
    if (!happyhorseFilteredAccounts.length) return;
    setError('');
    setSuccessMsg('');
    let ok = 0;
    let fail = 0;
    let gained = 0;
    for (const acc of happyhorseFilteredAccounts) {
      try {
        setHappyhorseSigningId(acc.id);
        const res = await fetch(`${API_BASE}/happyhorse/credits/daily-signin?account_id=${acc.id}`, { method: 'POST' });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(payload.detail || `HTTP ${res.status}`);
        const result = payload.data || {};
        const balance = result.credits_balance ?? result.available_count ?? null;
        gained += Number(result.grant_points || 0);
        setHappyhorseAccounts(prev => prev.map(a => a.id === acc.id ? {
          ...a,
          credits_balance: balance,
          play_code_details: result.play_code_details || a.play_code_details || [],
        } : a));
        ok += 1;
      } catch (_) {
        fail += 1;
      }
    }
    setHappyhorseSigningId(null);
    setSuccessMsg(`渠道十一每日签到完成：成功 ${ok}，失败 ${fail}，共领取 +${gained}`);
  };

  const cancelHappyhorseBatchLogin = async () => {
    if (happyhorseBatchStep !== 'running' || happyhorseCancelling) return;
    setHappyhorseCancelling(true);
    happyhorseBatchCancelRef.current = true;
    try {
      await fetch(`${API_BASE}/happyhorse/accounts/login/cancel`, { method: 'POST' });
      setSuccessMsg('已请求取消渠道十一登录任务，正在停止进行中的浏览器登录...');
    } catch (e) {
      setError(e.message || '取消请求失败');
    } finally {
      setHappyhorseCancelling(false);
    }
  };

  const runHappyhorseTextBatchLogin = async (accountsInput, { isRetry = false } = {}) => {
    const accounts = (accountsInput || []).filter((a) => a?.email && a?.password);
    if (accounts.length === 0) {
      setError(isRetry ? '没有可重试的失败账号' : '请输入有效的 HappyHorse Google 账号密码，每行一个，格式: email|password');
      return;
    }
    const existingEmails = new Set(
      happyhorseAccounts
        .filter((acc) => acc?.has_token || acc?.configured)
        .map((acc) => String(acc.email || '').trim().toLowerCase())
        .filter(Boolean)
    );
    const toLogin = [];
    const skippedAccounts = [];
    for (const account of accounts) {
      if (!isRetry && existingEmails.has(account.email.toLowerCase())) {
        skippedAccounts.push(account);
      } else {
        toLogin.push(account);
      }
    }
    happyhorseBatchCancelRef.current = false;
    happyhorseBatchAccountsRef.current = accounts;
    setHappyhorseBatchMode('text');
    const concurrency = Math.max(1, Math.min(parseInt(happyhorseBatchConcurrency, 10) || 1, 5, Math.max(toLogin.length, 1)));
    setHappyhorseBatchStep('running');
    setHappyhorseBatchResults({});
    setHappyhorseBatchSummary(null);
    setHappyhorseBatchProgress({
      total: accounts.length,
      done: skippedAccounts.length,
      succeeded: 0,
      failed: 0,
      skipped: skippedAccounts.length,
      cancelled: 0,
      currentEmail: toLogin[0]?.email || '',
    });
    setError('');
    setSuccessMsg('');
    try {
      await fetch(`${API_BASE}/happyhorse/accounts/login/begin`, { method: 'POST' });
    } catch (_) { /* ignore */ }
    const initialResults = {};
    skippedAccounts.forEach((account, index) => {
      initialResults[`skip-${index}`] = {
        email: account.email,
        password: account.password,
        ok: true,
        step: 'skipped',
        error: '已登录过，已跳过',
      };
    });
    setHappyhorseBatchResults(initialResults);
    if (toLogin.length === 0) {
      setHappyhorseBatchSummary({
        succeeded: 0,
        failed: 0,
        skipped: skippedAccounts.length,
        cancelled: 0,
        total: accounts.length,
      });
      setHappyhorseBatchProgress({
        total: accounts.length,
        done: accounts.length,
        succeeded: 0,
        failed: 0,
        skipped: skippedAccounts.length,
        cancelled: 0,
        currentEmail: '',
      });
      setHappyhorseBatchStep('done');
      setSuccessMsg(`渠道十一批量登录：全部 ${skippedAccounts.length} 个账号此前已登录，已跳过`);
      return;
    }
    let succeeded = 0;
    let failed = 0;
    let skipped = skippedAccounts.length;
    let cancelled = 0;
    let done = skippedAccounts.length;
    let cursor = 0;
    const started = new Set();
    const bumpProgress = (currentEmail = '') => {
      setHappyhorseBatchProgress({
        total: accounts.length,
        done,
        succeeded,
        failed,
        skipped,
        cancelled,
        currentEmail,
      });
    };
    const runOne = async (i) => {
      const { email, password } = toLogin[i];
      started.add(i);
      if (happyhorseBatchCancelRef.current) {
        cancelled++;
        done++;
        setHappyhorseBatchResults((prev) => ({
          ...prev,
          [i]: { email, password, ok: false, step: 'cancelled', error: '已取消' },
        }));
        bumpProgress(email);
        return;
      }
      setHappyhorseBatchResults((prev) => ({
        ...prev,
        [i]: { email, password, ok: null, step: 'starting' },
      }));
      bumpProgress(email);
      try {
        const res = await fetch(`${API_BASE}/happyhorse/accounts/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email,
            password,
            visible: happyhorseBatchVisible,
            keep_open: false,
            part_of_batch: true,
          }),
        });
        const responseText = await res.text();
        let data = {};
        try {
          data = responseText ? JSON.parse(responseText) : {};
        } catch {
          data = { detail: responseText };
        }
        if (happyhorseBatchCancelRef.current || res.status === 409) {
          cancelled++;
          done++;
          setHappyhorseBatchResults((prev) => ({
            ...prev,
            [i]: { email, password, ok: false, step: 'cancelled', error: data.detail || '已取消' },
          }));
          bumpProgress(email);
          return;
        }
        if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
        if (data?.data?.skipped) {
          skipped++;
          done++;
          setHappyhorseBatchResults((prev) => ({
            ...prev,
            [i]: { email, password, ok: true, step: 'skipped', error: '已登录过，已跳过' },
          }));
        } else {
          succeeded++;
          done++;
          setHappyhorseBatchResults((prev) => ({
            ...prev,
            [i]: { email, password, ok: true, step: 'saved_to_db' },
          }));
        }
        bumpProgress(email);
      } catch (e) {
        if (happyhorseBatchCancelRef.current) {
          cancelled++;
          done++;
          setHappyhorseBatchResults((prev) => ({
            ...prev,
            [i]: { email, password, ok: false, step: 'cancelled', error: '已取消' },
          }));
        } else {
          failed++;
          done++;
          setHappyhorseBatchResults((prev) => ({
            ...prev,
            [i]: { email, password, ok: false, step: 'error', error: e.message },
          }));
        }
        bumpProgress(email);
      }
    };
    const workers = Array.from({ length: concurrency }, async () => {
      while (true) {
        if (happyhorseBatchCancelRef.current) break;
        const i = cursor++;
        if (i >= toLogin.length) break;
        await runOne(i);
      }
    });
    await Promise.all(workers);
    // 取消后尚未启动的账号标记为已取消
    if (happyhorseBatchCancelRef.current) {
      const pending = {};
      for (let i = 0; i < toLogin.length; i++) {
        if (started.has(i)) continue;
        cancelled++;
        done++;
        pending[i] = {
          email: toLogin[i].email,
          password: toLogin[i].password,
          ok: false,
          step: 'cancelled',
          error: '已取消',
        };
      }
      if (Object.keys(pending).length) {
        setHappyhorseBatchResults((prev) => ({ ...prev, ...pending }));
      }
    }
    bumpProgress('');
    setHappyhorseBatchSummary({
      succeeded,
      failed,
      skipped,
      cancelled,
      total: accounts.length,
    });
    setHappyhorseBatchStep('done');
    if (cancelled > 0) {
      setSuccessMsg(
        `渠道十一登录已取消：成功 ${succeeded}，跳过 ${skipped}，失败 ${failed}，取消 ${cancelled}`
      );
      if (succeeded > 0) fetchHappyhorseAccounts();
    } else if (succeeded > 0 || skipped > 0) {
      setSuccessMsg(
        `渠道十一 HappyHorse 批量登录完成：成功 ${succeeded}，跳过已登录 ${skipped}，失败 ${failed}`
      );
      fetchHappyhorseAccounts();
    } else {
      setError('渠道十一 HappyHorse 批量登录全部失败，请查看下方每个账号的失败原因。');
    }
  };

  const handleHappyhorseBatchLogin = async () => {
    const lines = happyhorseBatchText.trim().split('\n').filter((l) => l.trim());
    const accounts = lines.map((line) => {
      const [email, password] = line.trim().split('|');
      return { email: (email || '').trim(), password: (password || '').trim() };
    }).filter((a) => a.email && a.password);
    await runHappyhorseTextBatchLogin(accounts);
  };

  const runHappyhorsePoolLogin = async ({ count, mailboxIds = [] } = {}) => {
    const resolvedCount = mailboxIds.length
      ? mailboxIds.length
      : Math.max(1, Math.min(parseInt(count ?? happyhorsePoolCount, 10) || 1, 100));
    const concurrency = Math.max(
      1,
      Math.min(parseInt(happyhorseBatchConcurrency, 10) || 1, 5, resolvedCount)
    );
    happyhorseBatchCancelRef.current = false;
    setHappyhorseBatchMode('pool');
    setHappyhorseBatchStep('running');
    setHappyhorseBatchResults({});
    setHappyhorseBatchSummary(null);
    setHappyhorseBatchProgress({
      total: resolvedCount,
      done: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      cancelled: 0,
      currentEmail: '正在领取邮箱...',
    });
    setError('');
    setSuccessMsg('');
    try {
      const body = {
        count: resolvedCount,
        concurrency,
        visible: happyhorseBatchVisible,
        keep_open: false,
      };
      if (mailboxIds.length) body.mailbox_ids = mailboxIds;
      const res = await fetch(`${API_BASE}/happyhorse/accounts/login-pool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.detail || `HTTP ${res.status}`);
      }

      const items = [];
      let succeeded = 0;
      let failed = 0;
      let skipped = 0;
      let cancelled = 0;
      let total = resolvedCount;
      let done = 0;
      let finalSummary = null;

      const applyItem = (item, index) => {
        items[index] = item;
        setHappyhorseBatchResults((prev) => ({
          ...prev,
          [index]: {
            email: item.email,
            mailbox_id: item.mailbox_id,
            ok: Boolean(item.ok),
            step: item.ok
              ? (item.skipped ? 'skipped' : 'saved_to_db')
              : (item.cancelled ? 'cancelled' : 'error'),
            error: item.skipped
              ? '已登录过，已跳过'
              : (item.error || ''),
          },
        }));
      };

      if (!res.body || !res.body.getReader) {
        // 兼容非流式回退
        const payload = await res.json().catch(() => ({}));
        const result = payload.data || {};
        const list = Array.isArray(result.results) ? result.results : [];
        list.forEach((item, index) => applyItem(item, index));
        finalSummary = result;
      } else {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const { value, done: streamDone } = await reader.read();
          if (streamDone) break;
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
            if (event.event === 'start') {
              total = Number(event.total) || total;
              const emails = Array.isArray(event.emails) ? event.emails : [];
              const pending = {};
              emails.forEach((email, index) => {
                pending[index] = {
                  email,
                  ok: null,
                  step: 'queued',
                  error: '',
                };
              });
              setHappyhorseBatchResults(pending);
              setHappyhorseBatchProgress({
                total,
                done: 0,
                succeeded: 0,
                failed: 0,
                skipped: 0,
                cancelled: 0,
                currentEmail: emails[0] || '准备登录...',
              });
            } else if (event.event === 'item') {
              const item = event.result || {};
              const index = Math.max(0, Number(event.index || items.length + 1) - 1);
              applyItem(item, index);
              done = Number(event.done) || (done + 1);
              if (item.ok && item.skipped) skipped += 1;
              else if (item.ok) succeeded += 1;
              else if (item.cancelled) cancelled += 1;
              else failed += 1;
              setHappyhorseBatchProgress({
                total,
                done,
                succeeded,
                failed,
                skipped,
                cancelled,
                currentEmail: item.email || '',
              });
            } else if (event.event === 'done') {
              finalSummary = event;
            } else if (event.event === 'error') {
              throw new Error(event.error || '邮箱库登录失败');
            }
          }
        }
      }

      const result = finalSummary || {
        results: items,
        succeeded,
        failed: failed + cancelled,
        cancelled,
        total,
      };
      const resultItems = Array.isArray(result.results) ? result.results : items;
      happyhorseBatchAccountsRef.current = resultItems.map((item) => ({
        email: item.email,
        mailbox_id: item.mailbox_id,
        password: '',
      }));
      const skippedCount = resultItems.filter((item) => item.ok && item.skipped).length;
      const cancelledCount = Number(result.cancelled) || resultItems.filter((item) => item.cancelled).length;
      const succeededCount = Math.max(0, (result.succeeded || 0) - skippedCount);
      const failedCount = Math.max(0, (result.failed || 0) - cancelledCount);
      setHappyhorseBatchProgress({
        total: result.total || total,
        done: result.total || total,
        succeeded: succeededCount,
        failed: failedCount,
        skipped: skippedCount,
        cancelled: cancelledCount,
        currentEmail: '',
      });
      setHappyhorseBatchSummary({
        succeeded: succeededCount,
        failed: failedCount,
        skipped: skippedCount,
        cancelled: cancelledCount,
        total: result.total || resultItems.length,
      });
      setHappyhorseBatchStep('done');
      if (cancelledCount > 0) {
        setSuccessMsg(
          `渠道十一邮箱库登录已取消：成功 ${succeededCount}，跳过 ${skippedCount}，失败 ${failedCount}，取消 ${cancelledCount}`
        );
        if (succeededCount > 0) fetchHappyhorseAccounts();
      } else if ((result.succeeded || 0) > 0) {
        setSuccessMsg(
          `渠道十一从邮箱库登录完成：成功 ${succeededCount}，跳过已登录 ${skippedCount}，失败 ${failedCount}`
        );
        fetchHappyhorseAccounts();
      } else {
        setError('渠道十一邮箱库账号登录全部失败，请查看失败原因。');
      }
    } catch (e) {
      setHappyhorseBatchStep(happyhorseBatchCancelRef.current ? 'done' : 'idle');
      setError(e.message || String(e));
    }
  };

  const handleHappyhorsePoolLogin = async () => {
    await runHappyhorsePoolLogin({ count: happyhorsePoolCount });
  };

  const retryHappyhorseFailedLogins = async () => {
    const failedItems = Object.values(happyhorseBatchResults || {}).filter(
      (item) => item && item.ok === false && item.step !== 'cancelled'
    );
    if (!failedItems.length) {
      setError('没有可重试的失败账号');
      return;
    }
    if (happyhorseBatchMode === 'pool') {
      const mailboxIds = failedItems
        .map((item) => Number(item.mailbox_id))
        .filter((id) => id > 0);
      if (!mailboxIds.length) {
        setError('失败账号缺少邮箱库 ID，无法重试，请重新领取');
        return;
      }
      await runHappyhorsePoolLogin({ mailboxIds });
      return;
    }
    const accounts = failedItems
      .map((item) => ({
        email: String(item.email || '').trim(),
        password: String(item.password || '').trim(),
      }))
      .filter((item) => item.email && item.password);
    if (!accounts.length) {
      // 从原始文本里按邮箱找回密码
      const passwordByEmail = new Map(
        happyhorseBatchText
          .trim()
          .split('\n')
          .map((line) => {
            const [email, password] = line.trim().split('|');
            return [(email || '').trim().toLowerCase(), (password || '').trim()];
          })
          .filter(([email, password]) => email && password)
      );
      const recovered = failedItems
        .map((item) => {
          const email = String(item.email || '').trim();
          return { email, password: passwordByEmail.get(email.toLowerCase()) || '' };
        })
        .filter((item) => item.email && item.password);
      if (!recovered.length) {
        setError('失败账号缺少密码，无法重试');
        return;
      }
      await runHappyhorseTextBatchLogin(recovered, { isRetry: true });
      return;
    }
    await runHappyhorseTextBatchLogin(accounts, { isRetry: true });
  };

  const fetchTensorartAccounts = async () => {
    try {
      setTensorartLoading(true);
      const res = await fetch(`${API_BASE}/tensorart/accounts`);
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.detail || `HTTP ${res.status}`);
      setTensorartAccounts(payload.data || []);
      setError('');
    } catch (e) {
      setError(e.message || '无法连接到渠道十服务，请确认 Python 服务已启动');
    } finally {
      setTensorartLoading(false);
    }
  };

  const handleTensorartRegister = async () => {
    setTensorartRegistering(true);
    setError('');
    setSuccessMsg('');
    try {
      const res = await fetch(`${API_BASE}/tensorart/accounts/register-pool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          count: Math.max(1, Math.min(parseInt(tensorartRegCount, 10) || 1, 100)),
          concurrency: Math.max(1, Math.min(parseInt(tensorartRegConcurrency, 10) || 1, 3)),
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.detail || `HTTP ${res.status}`);
      const result = payload.data || {};
      if (!result.succeeded) {
        const firstError = (result.results || []).find(item => !item.ok)?.error;
        throw new Error(firstError || '渠道十注册失败');
      }
      setSuccessMsg(`渠道十注册完成：成功 ${result.succeeded}，失败 ${result.failed || 0}`);
      setShowTensorartRegister(false);
      await fetchTensorartAccounts();
    } catch (e) {
      setError(e.message || '渠道十注册失败');
    } finally {
      setTensorartRegistering(false);
    }
  };

  const handleTensorartDelete = async (id) => {
    if (!confirm('确定删除该渠道十 Tensor.Art 账号？')) return;
    setError('');
    setSuccessMsg('');
    try {
      const res = await fetch(`${API_BASE}/tensorart/accounts/${id}`, { method: 'DELETE' });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.detail || '删除失败');
      setSuccessMsg('渠道十账号已删除');
      await fetchTensorartAccounts();
    } catch (e) {
      setError(e.message || '删除失败');
    }
  };

  const handleTensorartRefreshEnergy = async (id) => {
    setTensorartRefreshingId(id);
    setError('');
    try {
      const res = await fetch(`${API_BASE}/tensorart/energy?account_id=${id}`);
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.detail || '查询能量失败');
      const energy = payload.data || {};
      setTensorartAccounts(prev => prev.map(account => (
        account.id === id
          ? { ...account, total_balance: energy.total_balance }
          : account
      )));
      setSuccessMsg(`渠道十能量：${energy.total_balance ?? '-'}`);
    } catch (e) {
      setError(e.message || '查询能量失败');
    } finally {
      setTensorartRefreshingId(null);
    }
  };

  const fetchInsmindAccounts = async () => {
    try {
      setInsmindLoading(true);
      const res = await fetch(`${API_BASE}/insmind/accounts`);
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        const detail = typeof payload.detail === 'string' ? payload.detail : `HTTP ${res.status}`;
        if (res.status === 404) {
          throw new Error('渠道十二接口未找到，请重启本地 Python 后端后再试');
        }
        throw new Error(detail || `HTTP ${res.status}`);
      }
      setInsmindAccounts(payload.data || []);
      setError('');
    } catch (e) {
      setError(e.message || '无法连接到渠道十二服务，请确认 Python 服务已启动');
    } finally {
      setInsmindLoading(false);
    }
  };

  const handleInsmindRegister = async () => {
    const total = Math.max(1, Math.min(parseInt(insmindRegCount, 10) || 1, 999));
    const concurrency = Math.max(1, Math.min(parseInt(insmindRegConcurrency, 10) || 1, 999));
    setInsmindRegistering(true);
    setError('');
    setSuccessMsg('');
    setInsmindRegProgress({
      total,
      done: 0,
      succeeded: 0,
      failed: 0,
      currentEmail: '准备注册...',
      use_proxy: null,
    });
    try {
      const res = await fetch(`${API_BASE}/insmind/accounts/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson, application/json' },
        body: JSON.stringify({ count: total, concurrency }),
      });
      if (!res.ok) {
        if (res.status === 404) {
          throw new Error('渠道十二注册接口未找到，请重启本地 Python 后端后再试');
        }
        const payload = await res.json().catch(() => ({}));
        const detail = typeof payload.detail === 'string'
          ? payload.detail
          : (Array.isArray(payload.detail) ? payload.detail.map((d) => d.msg || JSON.stringify(d)).join('; ') : `HTTP ${res.status}`);
        throw new Error(detail || `HTTP ${res.status}`);
      }

      let succeeded = 0;
      let failed = 0;
      let done = 0;
      let finalSummary = null;
      const failSamples = [];

      const contentType = String(res.headers.get('content-type') || '');
      if (!res.body || !res.body.getReader || contentType.includes('application/json')) {
        // 兼容旧后端非流式 JSON
        const payload = await res.json().catch(() => ({}));
        const result = payload.data || {};
        finalSummary = result;
        succeeded = Number(result.succeeded) || 0;
        failed = Number(result.failed) || 0;
        done = Number(result.total) || (succeeded + failed);
        setInsmindRegProgress({
          total: done || total,
          done: done || total,
          succeeded,
          failed,
          currentEmail: '',
          use_proxy: result.use_proxy,
        });
      } else {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const { value, done: streamDone } = await reader.read();
          if (streamDone) break;
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
            if (event.event === 'start') {
              setInsmindRegProgress({
                total: Number(event.total) || total,
                done: 0,
                succeeded: 0,
                failed: 0,
                currentEmail: event.use_proxy
                  ? `动态代理 ${event.proxy_host || ''} · 开始注册...`
                  : '直连注册（易限流）...',
                use_proxy: event.use_proxy,
              });
            } else if (event.event === 'item') {
              const item = event.result || {};
              done = Number(event.done) || (done + 1);
              if (item.ok) succeeded += 1;
              else {
                failed += 1;
                if (item.error && failSamples.length < 5) failSamples.push(item.error);
              }
              setInsmindRegProgress({
                total: Number(event.total) || total,
                done,
                succeeded,
                failed,
                currentEmail: item.ok
                  ? (item.email || `第 ${item.index || done} 个成功`)
                  : (item.error || `第 ${item.index || done} 个失败`),
                use_proxy: null,
              });
              // 成功入库后偶尔刷新列表，避免最后才看到账号
              if (item.ok && (done === 1 || done % 3 === 0)) {
                fetchInsmindAccounts();
              }
            } else if (event.event === 'done') {
              finalSummary = event;
            } else if (event.event === 'error') {
              throw new Error(event.error || '渠道十二注册失败');
            }
          }
        }
      }

      const result = finalSummary || { succeeded, failed, total: done || total };
      const okCount = Number(result.succeeded) || succeeded;
      const failCount = Number(result.failed) || failed;
      const totalCount = Number(result.total) || (okCount + failCount) || total;
      setInsmindRegProgress({
        total: totalCount,
        done: totalCount,
        succeeded: okCount,
        failed: failCount,
        currentEmail: '',
        use_proxy: result.use_proxy,
      });

      if (!okCount) {
        throw new Error(failSamples[0] || '渠道十二注册全部失败');
      }
      setSuccessMsg(`渠道十二注册完成：成功 ${okCount}，失败 ${failCount}`);
      if (failCount > 0 && failSamples.length) {
        setError(failSamples.map((msg, i) => `#${i + 1}: ${msg}`).join('\n'));
      }
      await fetchInsmindAccounts();
    } catch (e) {
      setError(e.message || '渠道十二注册失败');
    } finally {
      setInsmindRegistering(false);
    }
  };

  const handleInsmindDelete = async (id) => {
    if (!confirm('确定删除该渠道十二 insMind 账号？')) return;
    setError('');
    setSuccessMsg('');
    try {
      const res = await fetch(`${API_BASE}/insmind/accounts/${id}`, { method: 'DELETE' });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.detail || '删除失败');
      setSuccessMsg('渠道十二账号已删除');
      setInsmindSelectedIds((prev) => prev.filter((item) => item !== Number(id)));
      await fetchInsmindAccounts();
    } catch (e) {
      setError(e.message || '删除失败');
    }
  };

  const handleInsmindDeleteSelected = async () => {
    const accountIds = insmindSelectedIds.map((id) => Number(id)).filter(Boolean);
    if (!accountIds.length) {
      setError('请先勾选要删除的渠道十二账号');
      return;
    }
    if (!confirm(`确定删除选中的 ${accountIds.length} 个渠道十二账号？此操作不可恢复。`)) return;
    setInsmindDeleting(true);
    setError('');
    setSuccessMsg('');
    try {
      const res = await fetch(`${API_BASE}/insmind/accounts/batch-delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_ids: accountIds }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.detail || '批量删除失败');
      const deleted = Number(payload?.data?.deleted || 0);
      setInsmindSelectedIds([]);
      setSuccessMsg(`已删除 ${deleted || accountIds.length} 个渠道十二账号`);
      await fetchInsmindAccounts();
    } catch (e) {
      setError(e.message || '批量删除失败');
    } finally {
      setInsmindDeleting(false);
    }
  };

  const toggleInsmindSelect = (accountId) => {
    setInsmindSelectedIds((prev) => (
      prev.includes(accountId)
        ? prev.filter((item) => item !== accountId)
        : [...prev, accountId]
    ));
  };

  const toggleInsmindSelectAll = () => {
    const visibleIds = insmindAccounts.map((acc) => Number(acc.id)).filter(Boolean);
    const allSelected = visibleIds.length > 0 && visibleIds.every((id) => insmindSelectedIds.includes(id));
    if (allSelected) {
      setInsmindSelectedIds([]);
      return;
    }
    setInsmindSelectedIds(visibleIds);
  };

  const handleInsmindExport = async ({ all = false } = {}) => {
    const accountIds = all ? [] : insmindSelectedIds;
    if (!all && !accountIds.length) {
      setError('请先勾选要导出的渠道十二账号，或点「导出全部」');
      return;
    }
    if (all && !insmindAccounts.length) {
      setError('暂无渠道十二账号可导出');
      return;
    }
    setInsmindExporting(true);
    setError('');
    setSuccessMsg('');
    try {
      const res = await fetch(`${API_BASE}/insmind/accounts/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_ids: accountIds }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.detail || '导出失败');
      const accounts = payload.data || [];
      if (!accounts.length) throw new Error('未找到可导出的账号');

      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const jsonBlob = new Blob([JSON.stringify(accounts, null, 2)], { type: 'application/json;charset=utf-8' });
      const jsonUrl = URL.createObjectURL(jsonBlob);
      const jsonLink = document.createElement('a');
      jsonLink.href = jsonUrl;
      jsonLink.download = `insmind-accounts-${stamp}.json`;
      document.body.appendChild(jsonLink);
      jsonLink.click();
      jsonLink.remove();
      URL.revokeObjectURL(jsonUrl);

      const txtLines = accounts.flatMap((acc) => ([
        `=== id=${acc.id} | ${acc.email || ''} | ${acc.status || ''} ===`,
        `access_token: ${acc.access_token || ''}`,
        `refresh_token: ${acc.refresh_token || ''}`,
        `cookie: ${acc.cookie || ''}`,
        `user_id: ${acc.user_id || ''}`,
        `org_id: ${acc.org_id || ''}`,
        `expires_at: ${acc.expires_at || ''}`,
        `note: ${acc.note || ''}`,
        '',
      ]));
      const txtBlob = new Blob([txtLines.join('\n')], { type: 'text/plain;charset=utf-8' });
      const txtUrl = URL.createObjectURL(txtBlob);
      const txtLink = document.createElement('a');
      txtLink.href = txtUrl;
      txtLink.download = `insmind-accounts-${stamp}.txt`;
      document.body.appendChild(txtLink);
      txtLink.click();
      txtLink.remove();
      URL.revokeObjectURL(txtUrl);

      setSuccessMsg(`已导出 ${accounts.length} 个渠道十二账号（JSON + TXT）`);
    } catch (e) {
      setError(e.message || '导出失败');
    } finally {
      setInsmindExporting(false);
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
    if (activePool === 'lovart') {
      fetchLovartAccounts();
    }
    if (activePool === 'oreateai') {
      fetchOreateaiAccounts();
    }
    if (activePool === 'framia') {
      fetchFramiaAccounts();
    }
    if (activePool === 'tensorart') {
      fetchTensorartAccounts();
    }
    if (activePool === 'happyhorse') {
      fetchHappyhorseAccounts();
    }
    if (activePool === 'insmind') {
      fetchInsmindAccounts();
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
      const expired = failed.filter((item) => item.status === 'auth_expired').length;
      const forbidden = failed.filter((item) => item.status === 'forbidden').length;
      const suffix = [
        expired ? `${expired} 个登录失效` : '',
        forbidden ? `${forbidden} 个账号受限` : '',
      ].filter(Boolean).join('，');
      setSuccessMsg(`积分刷新完成：成功 ${success.length} 个，失败 ${failed.length} 个${suffix ? `（${suffix}）` : ''}`);
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
    setError('');
    try {
      const res = await fetch(`${API_BASE}/accounts/${id}/refresh`, { method: 'POST' });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        const detail = payload.detail;
        const message = typeof detail === 'object' ? detail?.message : detail;
        const status = typeof detail === 'object' ? detail?.status : '';
        if (status === 'auth_expired') {
          throw new Error('登录态已失效，请到邮箱库点击“重新登录”');
        }
        if (status === 'forbidden') {
          throw new Error('该账号已被渠道一限制，请更换账号或稍后重试');
        }
        throw new Error(message || '刷新失败');
      }
      setSuccessMsg('登录态有效，积分已更新');
    } catch (e) {
      setError(e.message);
    } finally {
      await fetchAccounts();
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
            <button
              onClick={() => setActivePool('lovart')}
              className={`px-3 py-1 text-xs font-medium transition-all ${activePool === 'lovart' ? 'bg-brand text-black' : 'text-dark-muted hover:text-white'}`}
            >
              渠道七
            </button>
            <button
              onClick={() => setActivePool('oreateai')}
              className={`px-3 py-1 text-xs font-medium transition-all ${activePool === 'oreateai' ? 'bg-brand text-black' : 'text-dark-muted hover:text-white'}`}
            >
              渠道八
            </button>
            <button
              onClick={() => setActivePool('framia')}
              className={`px-3 py-1 text-xs font-medium transition-all ${activePool === 'framia' ? 'bg-brand text-black' : 'text-dark-muted hover:text-white'}`}
            >
              渠道九
            </button>
            <button
              onClick={() => setActivePool('tensorart')}
              className={`px-3 py-1 text-xs font-medium transition-all ${activePool === 'tensorart' ? 'bg-brand text-black' : 'text-dark-muted hover:text-white'}`}
            >
              渠道十
            </button>
            <button
              onClick={() => setActivePool('happyhorse')}
              className={`px-3 py-1 text-xs font-medium transition-all ${activePool === 'happyhorse' ? 'bg-brand text-black' : 'text-dark-muted hover:text-white'}`}
            >
              渠道十一
            </button>
            <button
              onClick={() => setActivePool('insmind')}
              className={`px-3 py-1 text-xs font-medium transition-all ${activePool === 'insmind' ? 'bg-brand text-black' : 'text-dark-muted hover:text-white'}`}
            >
              渠道十二
            </button>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {activePool === 'wizstar' ? (
            <>
              <button
                onClick={onOpenGoogleLogin}
                disabled={!onOpenGoogleLogin}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-500/10 text-blue-300 text-sm font-medium hover:bg-blue-500/20 disabled:opacity-50 transition-colors"
                title="添加账号或重新获取 Google 登录态"
              >
                <Mail className="w-4 h-4" />
                Google 登录
              </button>
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
          ) : activePool === 'dola' ? (
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
          ) : activePool === 'lovart' ? (
            <>
              <button
                onClick={() => setShowLovartBatchLogin(prev => !prev)}
                disabled={lovartDeletingAll || lovartBatchStep === 'running'}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-500/10 text-blue-300 text-sm font-medium hover:bg-blue-500/20 disabled:opacity-50 transition-colors"
              >
                {lovartBatchStep === 'running' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />}
                Google 批量登录
              </button>
              <button
                onClick={handleLovartDeleteAll}
                disabled={lovartDeletingAll || lovartAccounts.length === 0 || lovartBatchStep === 'running'}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-500/10 text-red-300 text-sm font-medium hover:bg-red-500/20 disabled:opacity-50 transition-colors"
              >
                {lovartDeletingAll ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                一键清空
              </button>
              <button
                onClick={fetchLovartAccounts}
                className="p-2 rounded-lg text-dark-muted hover:text-white hover:bg-dark-card/50 transition-colors"
                title="刷新"
              >
                <RefreshCw className="w-4 h-4" />
              </button>
            </>
          ) : activePool === 'framia' ? (
            <>
              <button
                onClick={() => setShowFramiaBatchLogin(prev => !prev)}
                disabled={framiaBatchStep === 'running'}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-purple-500/10 text-purple-300 text-sm font-medium hover:bg-purple-500/20 disabled:opacity-50 transition-colors"
              >
                {framiaBatchStep === 'running' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />}
                Google 批量登录
              </button>
              <button
                onClick={fetchFramiaAccounts}
                disabled={framiaLoading || framiaBatchStep === 'running'}
                className="p-2 rounded-lg text-dark-muted hover:text-white hover:bg-dark-card/50 disabled:opacity-50 transition-colors"
                title="刷新渠道九账号"
              >
                <RefreshCw className={`w-4 h-4 ${framiaLoading ? 'animate-spin' : ''}`} />
              </button>
            </>
          ) : activePool === 'tensorart' ? (
            <>
              <button
                onClick={() => setShowTensorartRegister(prev => !prev)}
                disabled={tensorartRegistering}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-violet-500/10 text-violet-300 text-sm font-medium hover:bg-violet-500/20 disabled:opacity-50 transition-colors"
              >
                {tensorartRegistering ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                {tensorartRegistering ? '注册中' : '邮箱库注册'}
              </button>
              <button
                onClick={fetchTensorartAccounts}
                disabled={tensorartLoading || tensorartRegistering}
                className="p-2 rounded-lg text-dark-muted hover:text-white hover:bg-dark-card/50 disabled:opacity-50 transition-colors"
                title="刷新渠道十账号"
              >
                <RefreshCw className={`w-4 h-4 ${tensorartLoading ? 'animate-spin' : ''}`} />
              </button>
            </>
          ) : activePool === 'happyhorse' ? (
            <>
              <button
                onClick={() => setShowHappyhorseBatchLogin(prev => !prev)}
                disabled={happyhorseBatchStep === 'running'}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/10 text-emerald-300 text-sm font-medium hover:bg-emerald-500/20 disabled:opacity-50 transition-colors"
              >
                {happyhorseBatchStep === 'running' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />}
                Google 批量登录
              </button>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    const input = happyhorseDateFilterRef.current;
                    if (!input) return;
                    if (typeof input.showPicker === 'function') {
                      try { input.showPicker(); return; } catch (_) { /* fall through */ }
                    }
                    input.focus();
                    input.click();
                  }}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                    happyhorseCreatedDateFilter
                      ? 'bg-sky-500/20 text-sky-300 hover:bg-sky-500/30'
                      : 'bg-dark-card text-dark-muted hover:text-white hover:bg-dark-card/80 border border-dark-border'
                  }`}
                  title="按添加账号日期筛选"
                >
                  <Calendar className="w-4 h-4" />
                  {happyhorseCreatedDateFilter ? `添加日期 ${happyhorseCreatedDateFilter}` : '筛选添加日期'}
                </button>
                <input
                  ref={happyhorseDateFilterRef}
                  type="date"
                  value={happyhorseCreatedDateFilter}
                  onChange={(e) => setHappyhorseCreatedDateFilter(e.target.value || '')}
                  className="sr-only"
                  tabIndex={-1}
                  aria-label="筛选添加账号日期"
                />
                {happyhorseCreatedDateFilter && (
                  <button
                    type="button"
                    onClick={() => setHappyhorseCreatedDateFilter('')}
                    className="px-2 py-1.5 rounded-lg text-xs text-dark-muted hover:text-white hover:bg-dark-card/50 transition-colors"
                    title="清除日期筛选"
                  >
                    清除
                  </button>
                )}
              </div>
              <button
                onClick={handleHappyhorseBatchCredits}
                disabled={happyhorseLoading || happyhorseBatchStep === 'running' || !!happyhorseRefreshingId || !!happyhorseSigningId || happyhorseFilteredAccounts.length === 0}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-yellow-500/10 text-yellow-400 text-sm font-medium hover:bg-yellow-500/20 disabled:opacity-50 transition-colors"
              >
                {happyhorseRefreshingId ? <Loader2 className="w-4 h-4 animate-spin" /> : <Coins className="w-4 h-4" />}
                查询积分
              </button>
              <button
                onClick={handleHappyhorseBatchDailySignin}
                disabled={happyhorseLoading || happyhorseBatchStep === 'running' || !!happyhorseRefreshingId || !!happyhorseSigningId || happyhorseFilteredAccounts.length === 0}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/10 text-emerald-300 text-sm font-medium hover:bg-emerald-500/20 disabled:opacity-50 transition-colors"
                title="批量每日签到领取 DAILY_SIGNIN"
              >
                {happyhorseSigningId ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                每日签到
              </button>
              <button
                onClick={handleHappyhorseExportSelected}
                disabled={happyhorseExporting || happyhorseSelectedIds.length === 0 || happyhorseBatchStep === 'running'}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-sky-500/10 text-sky-300 text-sm font-medium hover:bg-sky-500/20 disabled:opacity-50 transition-colors"
                title="导出勾选账号的 cookie / accessToken"
              >
                {happyhorseExporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                导出选中{happyhorseSelectedIds.length ? ` (${happyhorseSelectedIds.length})` : ''}
              </button>
              <button
                onClick={fetchHappyhorseAccounts}
                disabled={happyhorseLoading || happyhorseBatchStep === 'running'}
                className="p-2 rounded-lg text-dark-muted hover:text-white hover:bg-dark-card/50 disabled:opacity-50 transition-colors"
                title="刷新渠道十一账号"
              >
                <RefreshCw className={`w-4 h-4 ${happyhorseLoading ? 'animate-spin' : ''}`} />
              </button>
            </>
          ) : activePool === 'insmind' ? (
            <>
              <button
                onClick={() => setShowInsmindRegister((prev) => !prev)}
                disabled={insmindRegistering}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-sky-500/10 text-sky-300 text-sm font-medium hover:bg-sky-500/20 disabled:opacity-50 transition-colors"
              >
                {insmindRegistering ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                {insmindRegistering ? '注册中' : 'GPTMail 注册'}
              </button>
              <button
                onClick={() => handleInsmindExport({ all: false })}
                disabled={insmindExporting || insmindDeleting || insmindRegistering || insmindSelectedIds.length === 0}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-sky-500/10 text-sky-300 text-sm font-medium hover:bg-sky-500/20 disabled:opacity-50 transition-colors"
                title="导出勾选账号的 access_token / cookie"
              >
                {insmindExporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                导出选中{insmindSelectedIds.length ? ` (${insmindSelectedIds.length})` : ''}
              </button>
              <button
                onClick={handleInsmindDeleteSelected}
                disabled={insmindDeleting || insmindExporting || insmindRegistering || insmindSelectedIds.length === 0}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-500/10 text-red-300 text-sm font-medium hover:bg-red-500/20 disabled:opacity-50 transition-colors"
                title="删除勾选的渠道十二账号"
              >
                {insmindDeleting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                删除选中{insmindSelectedIds.length ? ` (${insmindSelectedIds.length})` : ''}
              </button>
              <button
                onClick={() => handleInsmindExport({ all: true })}
                disabled={insmindExporting || insmindDeleting || insmindRegistering || insmindAccounts.length === 0}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/10 text-emerald-300 text-sm font-medium hover:bg-emerald-500/20 disabled:opacity-50 transition-colors"
                title="导出全部渠道十二账号"
              >
                {insmindExporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                导出全部
              </button>
              <button
                onClick={fetchInsmindAccounts}
                disabled={insmindLoading || insmindRegistering || insmindDeleting}
                className="p-2 rounded-lg text-dark-muted hover:text-white hover:bg-dark-card/50 disabled:opacity-50 transition-colors"
                title="刷新渠道十二账号"
              >
                <RefreshCw className={`w-4 h-4 ${insmindLoading ? 'animate-spin' : ''}`} />
              </button>
            </>
          ) : (
            <>
              <button
                onClick={handleOreateaiClaimAll}
                disabled={oreateaiClaimingAll || oreateaiRegistering || oreateaiAccounts.length === 0}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500/10 text-amber-300 text-sm font-medium hover:bg-amber-500/20 disabled:opacity-50 transition-colors"
                title="并发两个账号领取积分，并等待异步到账"
              >
                {oreateaiClaimingAll ? <Loader2 className="w-4 h-4 animate-spin" /> : <Coins className="w-4 h-4" />}
                {oreateaiClaimingAll ? `领取中 ${oreateaiClaimAllProgress}` : '一键领取积分'}
              </button>
              <button
                onClick={() => setShowOreateaiRegister(prev => !prev)}
                disabled={oreateaiRegistering || oreateaiClaimingAll}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-green-500/10 text-green-400 text-sm font-medium hover:bg-green-500/20 disabled:opacity-50 transition-colors"
                title="使用真实 Chromium 注册渠道八账号"
              >
                {oreateaiRegistering ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                {oreateaiRegistering ? (oreateaiProgress || '注册中...') : '注册账号'}
              </button>
              <button
                onClick={fetchOreateaiAccounts}
                disabled={oreateaiLoading || oreateaiRegistering || oreateaiClaimingAll}
                className="p-2 rounded-lg text-dark-muted hover:text-white hover:bg-dark-card/50 disabled:opacity-50 transition-colors"
                title="刷新渠道八账号"
              >
                <RefreshCw className={`w-4 h-4 ${oreateaiLoading ? 'animate-spin' : ''}`} />
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

        {activePool === 'oreateai' && showOreateaiRegister && (
          <div className="p-4 rounded-xl bg-dark-card border border-green-500/20 space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-medium text-white">批量注册渠道八账号</h3>
                <p className="text-xs text-dark-muted mt-1">
                  按邮箱库顺序使用尚未注册的 Microsoft OAuth 邮箱，通过小苹果取件 API 接收验证邮件。每个任务使用独立 Chromium，会自动跳过已注册邮箱。
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowOreateaiRegister(false)}
                disabled={oreateaiRegistering}
                className="p-1.5 rounded-lg text-dark-muted hover:text-white hover:bg-dark-bg disabled:opacity-50 transition-colors"
              >
                <XCircle className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleOreateaiRegister} className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label className="space-y-1">
                  <span className="text-xs text-dark-muted">使用邮箱数</span>
                  <input
                    type="number"
                    min="1"
                    max="50"
                    value={oreateaiRegCount}
                    disabled={oreateaiRegistering}
                    onChange={(event) => {
                      const count = Math.max(1, Math.min(Number(event.target.value) || 1, 50));
                      setOreateaiRegCount(count);
                      setOreateaiRegConcurrency(current => Math.min(Number(current) || 1, count));
                    }}
                    className="w-full px-3 py-2 rounded-lg bg-dark-bg border border-dark-border text-sm text-white focus:outline-none focus:border-green-500/50 disabled:opacity-50"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-xs text-dark-muted">并发数</span>
                  <input
                    type="number"
                    min="1"
                    max={Math.min(5, Number(oreateaiRegCount) || 1)}
                    value={oreateaiRegConcurrency}
                    disabled={oreateaiRegistering}
                    onChange={(event) => setOreateaiRegConcurrency(
                      Math.max(1, Math.min(Number(event.target.value) || 1, 5, Number(oreateaiRegCount) || 1)),
                    )}
                    className="w-full px-3 py-2 rounded-lg bg-dark-bg border border-dark-border text-sm text-white focus:outline-none focus:border-green-500/50 disabled:opacity-50"
                  />
                </label>
              </div>
              {oreateaiRegistering && (
                <div className="flex items-center gap-2 text-xs text-green-300">
                  <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                  <span>{oreateaiProgress || '正在准备批量注册...'}</span>
                </div>
              )}
              <button
                type="submit"
                disabled={oreateaiRegistering}
                className="flex items-center justify-center gap-2 w-full px-4 py-2 rounded-lg bg-green-500/15 text-green-300 text-sm font-medium hover:bg-green-500/25 disabled:opacity-50 transition-colors"
              >
                {oreateaiRegistering ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                {oreateaiRegistering
                  ? '注册任务执行中'
                  : `使用 ${oreateaiRegCount} 个邮箱注册（并发 ${oreateaiRegConcurrency}）`}
              </button>
            </form>
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
                    placeholder="ttwid=...; odin_tt=...; sid_guard=..."
                    rows={4}
                    className="w-full px-3 py-2 rounded-lg bg-dark-bg border border-dark-border text-sm text-white placeholder:text-dark-muted/50 focus:outline-none focus:border-brand/50 resize-y font-mono text-xs"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-xs text-dark-muted">DOLA_MS_TOKEN（必填）</span>
                  <input
                    type="text"
                    value={dolaImportMsToken}
                    onChange={e => setDolaImportMsToken(e.target.value)}
                    placeholder="粘贴用户显式提供的 msToken"
                    className="w-full px-3 py-2 rounded-lg bg-dark-bg border border-dark-border text-sm text-white placeholder:text-dark-muted/50 focus:outline-none focus:border-brand/50 font-mono text-xs"
                  />
                  <span className="block text-[10px] text-dark-subtle">
                    只接受用户授权请求中真实捕获或手动提供的 msToken；不会从 Cookie 推导、刷新或生成替代值。
                  </span>
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
                必须填写用户显式提供的 DOLA_MS_TOKEN；Cookie、登录态文件、profile 目录至少填写一项。系统不会从 Cookie 推导、刷新或生成 Token。
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
                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-brand/20 bg-brand/5 p-3">
                  <span className="text-xs text-brand">从全局邮箱库领取</span>
                  <input
                    type="number"
                    min="1"
                    max="100"
                    value={dolaPoolCount}
                    onChange={(e) => setDolaPoolCount(Math.max(1, Math.min(100, parseInt(e.target.value, 10) || 1)))}
                    className="w-16 bg-dark-input text-sm border border-dark-border focus:border-brand focus:outline-none rounded-lg p-2 text-white text-center"
                  />
                  <span className="text-xs text-dark-muted">个尚未用于渠道六的 Google 密码账号</span>
                  <button
                    type="button"
                    onClick={() => handleDolaBatchLogin(true)}
                    className="ml-auto flex items-center gap-1.5 px-3 py-2 rounded-lg bg-brand/15 text-brand text-sm font-medium hover:bg-brand/25 transition-colors"
                  >
                    <Mail className="w-4 h-4" />
                    领取并登录
                  </button>
                </div>
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
                    onClick={() => handleDolaBatchLogin(false)}
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

        {activePool === 'lovart' && showLovartBatchLogin && (
          <div className="p-4 rounded-xl bg-dark-card border border-blue-500/20 space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-medium text-white">渠道七 Lovart · Google 批量登录</h3>
                <p className="text-xs text-dark-muted mt-1">
                  每行一个账号，格式: 邮箱|密码。系统会打开独立 Chrome profile 完成 Lovart → Google OAuth，并把登录态保存到渠道七账号池。
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  if (lovartBatchStep !== 'running') setShowLovartBatchLogin(false);
                }}
                disabled={lovartBatchStep === 'running'}
                className="p-1.5 rounded-lg text-dark-muted hover:text-white hover:bg-dark-bg disabled:opacity-50 transition-colors"
              >
                <XCircle className="w-4 h-4" />
              </button>
            </div>

            {lovartBatchStep === 'idle' && (
              <div className="space-y-3">
                <textarea
                  placeholder="email1@ffcfd.cfd|password1&#10;email2@ffcfd.cfd|password2"
                  value={lovartBatchText}
                  onChange={(e) => setLovartBatchText(e.target.value)}
                  rows={8}
                  className="w-full bg-dark-input text-sm border border-dark-border focus:border-blue-500 focus:outline-none rounded-lg p-3 text-white placeholder-dark-subtle font-mono resize-none"
                />
                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-brand/20 bg-brand/5 p-3">
                  <span className="text-xs text-brand">从全局邮箱库领取</span>
                  <input
                    type="number"
                    min="1"
                    max="100"
                    value={lovartPoolCount}
                    onChange={(e) => setLovartPoolCount(Math.max(1, Math.min(100, parseInt(e.target.value, 10) || 1)))}
                    className="w-16 bg-dark-input text-sm border border-dark-border focus:border-brand focus:outline-none rounded-lg p-2 text-white text-center"
                  />
                  <span className="text-xs text-dark-muted">个尚未用于渠道七的 Google 密码账号</span>
                  <button
                    type="button"
                    onClick={() => handleLovartBatchLogin(true)}
                    className="ml-auto flex items-center gap-1.5 px-3 py-2 rounded-lg bg-brand/15 text-brand text-sm font-medium hover:bg-brand/25 transition-colors"
                  >
                    <Mail className="w-4 h-4" />
                    领取并登录
                  </button>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <label className="text-xs text-dark-muted">并发数</label>
                  <input
                    type="number"
                    min="1"
                    max="3"
                    value={lovartBatchConcurrency}
                    onChange={(e) => setLovartBatchConcurrency(Math.max(1, Math.min(3, parseInt(e.target.value) || 1)))}
                    className="w-16 bg-dark-input text-sm border border-dark-border focus:border-blue-500 focus:outline-none rounded-lg p-2 text-white text-center"
                  />
                  <span className="text-xs text-dark-muted">Lovart/Google 风控更敏感，建议 1</span>
                  <label className="flex items-center gap-2 text-xs text-dark-muted">
                    <input
                      type="checkbox"
                      checked={lovartBatchVisible}
                      onChange={(e) => setLovartBatchVisible(e.target.checked)}
                      className="accent-brand"
                    />
                    可见浏览器
                  </label>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => handleLovartBatchLogin(false)}
                    disabled={!lovartBatchText.trim()}
                    className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-500/15 text-blue-300 text-sm font-medium hover:bg-blue-500/25 disabled:opacity-50 transition-colors"
                  >
                    <Mail className="w-4 h-4" />
                    开始登录（{lovartBatchText.trim().split('\n').filter(l => l.trim() && l.includes('|')).length} 个账号）
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowLovartBatchLogin(false)}
                    className="px-4 py-2 rounded-lg text-dark-muted text-sm hover:text-white hover:bg-dark-card/80 transition-colors"
                  >
                    取消
                  </button>
                </div>
              </div>
            )}

            {lovartBatchStep === 'running' && (
              <div className="space-y-2">
                <div className="flex items-center gap-2 py-1">
                  <Loader2 className="w-4 h-4 text-blue-400 animate-spin" />
                  <span className="text-sm text-white">Lovart 批量登录进行中...</span>
                </div>
                <div className="space-y-1.5 max-h-72 overflow-y-auto">
                  {Object.entries(lovartBatchResults)
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
                           info.step?.includes('captcha') ? '需要人工验证' :
                           info.step?.includes('deleted') ? '账号异常' :
                           info.step?.includes('redirect') ? '跳转中' :
                           info.step || '处理中'}
                        </span>
                      </div>
                    ))}
                </div>
              </div>
            )}

            {lovartBatchStep === 'done' && lovartBatchSummary && (
              <div className="space-y-3">
                <div className="flex items-center gap-3 py-2">
                  {lovartBatchSummary.failed === 0 ? (
                    <CheckCircle2 className="w-5 h-5 text-green-400" />
                  ) : (
                    <AlertCircle className="w-5 h-5 text-orange-400" />
                  )}
                  <span className="text-sm text-white">
                    批量登录完成：成功 <span className="text-green-400 font-bold">{lovartBatchSummary.succeeded}</span>，
                    失败 <span className="text-red-400 font-bold">{lovartBatchSummary.failed}</span>，共 {lovartBatchSummary.total} 个账号
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setShowLovartBatchLogin(false);
                    setLovartBatchStep('idle');
                    setLovartBatchText('');
                    setLovartBatchResults({});
                    setLovartBatchSummary(null);
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
                <p className="text-xs text-dark-muted mt-1">设置数量后，系统从全局邮箱库领取尚未用于渠道四的 Microsoft OAuth 邮箱，用它接收验证码并自动注册。</p>
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
                    : acc.status === 'auth_expired'
                      ? 'bg-amber-950/20 border-amber-500/30'
                      : acc.status === 'error'
                        ? 'bg-orange-950/15 border-orange-500/25'
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
                        <span className="px-1.5 py-0.5 rounded bg-red-500/15 text-red-400 border border-red-500/30 text-[10px] font-bold">账号受限</span>
                      )}
                      {acc.status === 'auth_expired' && (
                        <span className="px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 border border-amber-500/30 text-[10px] font-bold">登录失效</span>
                      )}
                      {acc.status === 'error' && (
                        <span className="px-1.5 py-0.5 rounded bg-orange-500/15 text-orange-400 border border-orange-500/30 text-[10px] font-bold">校验异常</span>
                      )}
                      {acc.status === 'daily_limit' && (
                        <span className="px-1.5 py-0.5 rounded bg-yellow-500/15 text-yellow-400 border border-yellow-500/30 text-[10px] font-bold">今日额度已用完</span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 text-xs text-dark-muted">
                      <span>UID: {acc.uid || '-'}</span>
                      <span>{acc.display_name || ''}</span>
                      <span>{formatDate(acc.created_at)}</span>
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-[11px] text-dark-muted">
                      <span>
                        最近校验：{acc.last_verified_at ? formatDate(acc.last_verified_at) : '尚未校验'}
                      </span>
                      <button
                        onClick={() => copyText(acc.email, '邮箱')}
                        className="px-1.5 py-0.5 rounded text-dark-muted hover:text-brand hover:bg-brand/10 transition-colors flex items-center gap-1"
                        title="复制邮箱"
                      >
                        <Copy className="w-3 h-3" /> 邮箱
                      </button>
                    </div>
                    {acc.status === 'auth_expired' && (
                      <div className="mt-1 text-[11px] text-amber-400">
                        凭证已失效，请到邮箱库重新登录；系统不会尝试伪造或自动刷新 Token。
                      </div>
                    )}
                    {acc.status === 'error' && (
                      <div className="mt-1 text-[11px] text-orange-400">
                        会话校验异常，可先重试查询积分；持续失败时请重新登录。
                      </div>
                    )}
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
                  {acc.status === 'auth_expired' && (
                    <button
                      onClick={onOpenGoogleLogin}
                      disabled={!onOpenGoogleLogin}
                      className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs text-amber-300 bg-amber-500/10 hover:bg-amber-500/20 disabled:opacity-50 transition-colors"
                      title="前往 Google 登录页重新获取登录态"
                    >
                      <Mail className="w-3.5 h-3.5" />
                      重新登录
                    </button>
                  )}
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
              从全局邮箱库领取 Microsoft OAuth 邮箱并通过小苹果 API 收取验证码。注册依赖设置中已填写的验证码 Key
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

        {activePool === 'oreateai' && (oreateaiLoading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-6 h-6 text-brand animate-spin" />
          </div>
        ) : oreateaiAccounts.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-dark-muted">
            <KeyRound className="w-12 h-12 mb-3 opacity-30" />
            <p className="text-sm">暂无渠道八 OreateAI 账号</p>
            <p className="text-xs text-dark-subtle mt-2">先在邮箱库导入 Microsoft OAuth 邮箱，再点击右上角「注册账号」</p>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center justify-between rounded-xl border border-dark-border bg-dark-card/60 px-4 py-3 text-xs text-dark-muted">
              <span>当前共 {oreateaiAccounts.length} 个渠道八 OreateAI 账号。前端只展示登录态摘要，不显示密码和 Cookie 原文。</span>
              <span>账号由真实浏览器注册流程写入。</span>
            </div>
            {oreateaiAccounts.map((acc) => (
              <div
                key={acc.id}
                className={`flex items-center justify-between p-4 rounded-xl border transition-colors ${
                  acc.configured && acc.status === 'active'
                    ? 'bg-dark-card border-dark-border hover:border-dark-border/80'
                    : 'bg-amber-950/20 border-amber-500/30'
                }`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-9 h-9 rounded-lg bg-cyan-500/10 flex items-center justify-center shrink-0">
                    <Sparkles className="w-4 h-4 text-cyan-300" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-white truncate flex items-center gap-2">
                      <span>{acc.email || '未知 OreateAI 账号'}</span>
                      <span className={`px-1.5 py-0.5 rounded border text-[10px] font-bold ${
                        acc.configured
                          ? 'bg-green-500/15 text-green-400 border-green-500/30'
                          : 'bg-amber-500/15 text-amber-400 border-amber-500/30'
                      }`}>
                        {acc.configured ? '已保存登录态' : '登录态不完整'}
                      </span>
                      {acc.status && (
                        <span className="px-1.5 py-0.5 rounded bg-dark-muted/15 text-dark-muted border border-dark-border text-[10px] font-bold">
                          {acc.status}
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-dark-muted mt-1">
                      <span>{formatDate(acc.updated_at || acc.created_at)}</span>
                      {acc.cookie_masked && <span className="font-mono text-dark-subtle">Cookie {acc.cookie_masked}</span>}
                      {acc.location && <span className="text-dark-subtle truncate max-w-[300px]" title={acc.location}>{acc.location}</span>}
                    </div>
                    <div className="flex flex-wrap items-center gap-2 mt-2">
                      <span className="px-2 py-0.5 rounded-lg bg-cyan-500/10 text-cyan-300 border border-cyan-500/20 text-[11px] font-bold">
                        Cookie {acc.cookie_count ?? 0}
                      </span>
                      {Number.isFinite(Number(oreateaiCredits[acc.id]?.rest_points)) && (
                        <span className="px-2 py-0.5 rounded-lg bg-amber-500/10 text-amber-300 border border-amber-500/20 text-[11px] font-bold">
                          积分 {oreateaiCredits[acc.id].rest_points}
                        </span>
                      )}
                      {oreateaiCredits[acc.id]?.detail?.daily && (
                        <span className="text-[11px] text-dark-subtle">
                          每日 {oreateaiCredits[acc.id].detail.daily.amount}
                        </span>
                      )}
                      {oreateaiCredits[acc.id]?.detail?.bonus && (
                        <span className="text-[11px] text-dark-subtle">
                          奖励 {oreateaiCredits[acc.id].detail.bonus.amount}
                        </span>
                      )}
                      {acc.note && (
                        <span className="text-[11px] text-dark-subtle truncate max-w-[420px]" title={acc.note}>{acc.note}</span>
                      )}
                    </div>
                    {acc.user_agent && (
                      <div className="mt-1 text-[11px] text-dark-subtle truncate max-w-[620px]" title={acc.user_agent}>
                        {acc.user_agent}
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <button
                    onClick={() => requestOreateaiCredits(acc.id, false)}
                    disabled={oreateaiClaimingAll || !acc.configured || oreateaiCredits[acc.id]?.loading || oreateaiCredits[acc.id]?.claiming}
                    className="px-1.5 py-1 rounded-lg text-dark-muted hover:text-amber-300 hover:bg-amber-500/10 disabled:opacity-40 transition-colors flex items-center gap-1 text-xs"
                    title="实时查询渠道八剩余积分和积分明细"
                  >
                    {oreateaiCredits[acc.id]?.loading
                      ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      : <RefreshCw className="w-3.5 h-3.5" />}
                    查询积分
                  </button>
                  <button
                    onClick={() => requestOreateaiCredits(acc.id, true)}
                    disabled={oreateaiClaimingAll || !acc.configured || oreateaiCredits[acc.id]?.loading || oreateaiCredits[acc.id]?.claiming}
                    className="px-1.5 py-1 rounded-lg text-dark-muted hover:text-green-300 hover:bg-green-500/10 disabled:opacity-40 transition-colors flex items-center gap-1 text-xs"
                    title="调用 OreateAI 领取接口；同一天重复调用不会重复增加积分"
                  >
                    {oreateaiCredits[acc.id]?.claiming
                      ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      : <Coins className="w-3.5 h-3.5" />}
                    领取积分
                  </button>
                  <button
                    onClick={() => handleOreateaiCapture(acc.id)}
                    disabled={!acc.configured || oreateaiCaptureOpeningId !== null}
                    className="px-1.5 py-1 rounded-lg text-dark-muted hover:text-cyan-300 hover:bg-cyan-500/10 disabled:opacity-40 transition-colors flex items-center gap-1 text-xs"
                    title="注入该账号 Cookie，并记录你在 OreateAI 窗口中的接口操作"
                  >
                    {oreateaiCaptureOpeningId === acc.id
                      ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      : <ExternalLink className="w-3.5 h-3.5" />}
                    记录操作
                  </button>
                  <button
                    onClick={() => copyText(acc.email || '', '邮箱')}
                    disabled={!acc.email}
                    className="px-1.5 py-1 rounded-lg text-dark-muted hover:text-brand hover:bg-brand/10 disabled:opacity-40 transition-colors flex items-center gap-1 text-xs"
                    title="复制邮箱"
                  >
                    <Copy className="w-3.5 h-3.5" /> 邮箱
                  </button>
                  <button
                    onClick={() => handleOreateaiDelete(acc.id)}
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

        {activePool === 'tensorart' && showTensorartRegister && (
          <div className="p-4 rounded-xl bg-dark-card border border-violet-500/20 space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-medium text-white">渠道十 Tensor.Art · 邮箱库注册</h3>
                <p className="text-xs text-dark-muted mt-1">
                  从全局 Microsoft OAuth 邮箱库领取尚未用于渠道十的邮箱，自动发送 magic-link、读取邮件并保存登录 token。Turnstile 使用设置中已有的 YesCaptcha Key。
                </p>
              </div>
              <button
                type="button"
                onClick={() => !tensorartRegistering && setShowTensorartRegister(false)}
                disabled={tensorartRegistering}
                className="p-1.5 rounded-lg text-dark-muted hover:text-white hover:bg-dark-bg disabled:opacity-50 transition-colors"
              >
                <XCircle className="w-4 h-4" />
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <label className="text-xs text-dark-muted">注册数量</label>
              <input
                type="number"
                min="1"
                max="100"
                value={tensorartRegCount}
                onChange={(e) => setTensorartRegCount(Math.max(1, Math.min(100, parseInt(e.target.value, 10) || 1)))}
                className="w-20 bg-dark-input text-sm border border-dark-border focus:border-violet-500 focus:outline-none rounded-lg p-2 text-white text-center"
              />
              <label className="text-xs text-dark-muted">并发数</label>
              <input
                type="number"
                min="1"
                max="3"
                value={tensorartRegConcurrency}
                onChange={(e) => setTensorartRegConcurrency(Math.max(1, Math.min(3, parseInt(e.target.value, 10) || 1)))}
                className="w-20 bg-dark-input text-sm border border-dark-border focus:border-violet-500 focus:outline-none rounded-lg p-2 text-white text-center"
              />
              <span className="text-xs text-dark-muted">建议并发 1，避免邮件和验证码风控。</span>
              <button
                type="button"
                onClick={handleTensorartRegister}
                disabled={tensorartRegistering}
                className="ml-auto flex items-center gap-1.5 px-4 py-2 rounded-lg bg-violet-500/15 text-violet-300 text-sm font-medium hover:bg-violet-500/25 disabled:opacity-50 transition-colors"
              >
                {tensorartRegistering ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                {tensorartRegistering ? '注册并等待邮件...' : '领取并注册'}
              </button>
            </div>
          </div>
        )}

        {activePool === 'tensorart' && (tensorartLoading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-6 h-6 text-brand animate-spin" />
          </div>
        ) : tensorartAccounts.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-dark-muted">
            <Sparkles className="w-12 h-12 mb-3 opacity-30" />
            <p className="text-sm">暂无渠道十 Tensor.Art 账号，点击右上角「邮箱库注册」开始</p>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center justify-between rounded-xl border border-dark-border bg-dark-card/60 px-4 py-3 text-xs text-dark-muted">
              <span>当前共 {tensorartAccounts.length} 个渠道十账号；前端只展示脱敏 token。</span>
              <span>图生视频完成后直接下载 downloadUrl。</span>
            </div>
            {tensorartAccounts.map((acc) => (
              <div
                key={acc.id}
                className={`flex items-center justify-between p-4 rounded-xl border transition-colors ${
                  acc.configured
                    ? 'bg-dark-card border-dark-border hover:border-dark-border/80'
                    : 'bg-amber-950/20 border-amber-500/30'
                }`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-9 h-9 rounded-lg bg-violet-500/10 flex items-center justify-center shrink-0">
                    <Sparkles className="w-4 h-4 text-violet-300" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-white truncate flex items-center gap-2">
                      <span>{acc.email || '未知 Tensor.Art 账号'}</span>
                      <span className={`px-1.5 py-0.5 rounded border text-[10px] font-bold ${
                        acc.configured
                          ? 'bg-green-500/15 text-green-400 border-green-500/30'
                          : 'bg-amber-500/15 text-amber-400 border-amber-500/30'
                      }`}>
                        {acc.configured ? '登录态有效' : acc.token_expired ? 'Token 已过期' : 'Token 缺失'}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-dark-muted mt-1">
                      <span>{formatDate(acc.updated_at || acc.created_at)}</span>
                      {acc.user_id && <span className="text-dark-subtle">UID: {acc.user_id}</span>}
                      {acc.token_masked && <span className="font-mono text-dark-subtle">Token {acc.token_masked}</span>}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <button
                    onClick={() => handleTensorartRefreshEnergy(acc.id)}
                    disabled={!acc.configured || tensorartRefreshingId === acc.id}
                    className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-yellow-500/10 text-yellow-400 text-xs font-bold hover:bg-yellow-500/20 disabled:opacity-50 transition-colors"
                    title="查询 Tensor.Art 能量"
                  >
                    {tensorartRefreshingId === acc.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Coins className="w-3.5 h-3.5" />}
                    {acc.total_balance != null ? `${acc.total_balance} 能量` : '查询能量'}
                  </button>
                  <button
                    onClick={() => copyText(acc.email || '', '邮箱')}
                    disabled={!acc.email}
                    className="px-1.5 py-1 rounded-lg text-dark-muted hover:text-brand hover:bg-brand/10 disabled:opacity-40 transition-colors flex items-center gap-1 text-xs"
                    title="复制邮箱"
                  >
                    <Copy className="w-3.5 h-3.5" /> 邮箱
                  </button>
                  <button
                    onClick={() => handleTensorartDelete(acc.id)}
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

        {activePool === 'framia' && showFramiaBatchLogin && (
          <div className="p-4 rounded-xl bg-dark-card border border-purple-500/20 space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-medium text-white">渠道九 Framia · Google 批量登录</h3>
                <p className="text-xs text-dark-muted mt-1">
                  每行一个账号，格式: 邮箱|密码。系统会打开 Chrome 完成 Framia → Google OAuth，并把 accessToken 保存到渠道九账号池。
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  if (framiaBatchStep !== 'running') setShowFramiaBatchLogin(false);
                }}
                disabled={framiaBatchStep === 'running'}
                className="p-1.5 rounded-lg text-dark-muted hover:text-white hover:bg-dark-bg disabled:opacity-50 transition-colors"
              >
                <XCircle className="w-4 h-4" />
              </button>
            </div>

            {framiaBatchStep === 'idle' && (
              <div className="space-y-3">
                <textarea
                  placeholder="email1@gmaii.lol|password1&#10;email2@gmaii.lol|password2"
                  value={framiaBatchText}
                  onChange={(e) => setFramiaBatchText(e.target.value)}
                  rows={8}
                  className="w-full bg-dark-input text-sm border border-dark-border focus:border-purple-500 focus:outline-none rounded-lg p-3 text-white placeholder-dark-subtle font-mono resize-none"
                />
                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-brand/20 bg-brand/5 p-3">
                  <span className="text-xs text-brand">从全局邮箱库领取</span>
                  <input
                    type="number"
                    min="1"
                    max="100"
                    value={framiaPoolCount}
                    onChange={(e) => setFramiaPoolCount(Math.max(1, Math.min(100, parseInt(e.target.value, 10) || 1)))}
                    className="w-16 bg-dark-input text-sm border border-dark-border focus:border-brand focus:outline-none rounded-lg p-2 text-white text-center"
                  />
                  <span className="text-xs text-dark-muted">个尚未用于渠道九的 Google 密码账号</span>
                  <button
                    type="button"
                    onClick={handleFramiaPoolLogin}
                    className="ml-auto flex items-center gap-1.5 px-3 py-2 rounded-lg bg-brand/15 text-brand text-sm font-medium hover:bg-brand/25 transition-colors"
                  >
                    <Mail className="w-4 h-4" />
                    领取并登录
                  </button>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <label className="text-xs text-dark-muted">并发数</label>
                  <input
                    type="number"
                    min="1"
                    max="5"
                    value={framiaBatchConcurrency}
                    onChange={(e) => setFramiaBatchConcurrency(Math.max(1, Math.min(5, parseInt(e.target.value) || 1)))}
                    className="w-16 bg-dark-input text-sm border border-dark-border focus:border-purple-500 focus:outline-none rounded-lg p-2 text-white text-center"
                  />
                  <span className="text-xs text-dark-muted">Framia/Google 风控较敏感，建议 1–2</span>
                  <label className="flex items-center gap-2 text-xs text-dark-muted">
                    <input
                      type="checkbox"
                      checked={framiaBatchVisible}
                      onChange={(e) => setFramiaBatchVisible(e.target.checked)}
                      className="accent-brand"
                    />
                    可见浏览器
                  </label>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleFramiaBatchLogin}
                    disabled={!framiaBatchText.trim()}
                    className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-purple-500/15 text-purple-300 text-sm font-medium hover:bg-purple-500/25 disabled:opacity-50 transition-colors"
                  >
                    <Mail className="w-4 h-4" />
                    开始登录（{framiaBatchText.trim().split('\n').filter(l => l.trim() && l.includes('|')).length} 个账号）
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowFramiaBatchLogin(false)}
                    className="px-4 py-2 rounded-lg text-dark-muted text-sm hover:text-white hover:bg-dark-card/80 transition-colors"
                  >
                    取消
                  </button>
                </div>
              </div>
            )}

            {framiaBatchStep === 'running' && (
              <div className="space-y-2">
                <div className="flex items-center gap-2 py-1">
                  <Loader2 className="w-4 h-4 text-purple-400 animate-spin" />
                  <span className="text-sm text-white">Framia 批量登录进行中...</span>
                </div>
                <div className="space-y-1.5 max-h-72 overflow-y-auto">
                  {Object.entries(framiaBatchResults)
                    .sort(([a], [b]) => parseInt(a) - parseInt(b))
                    .map(([idx, info]) => (
                      <div key={idx} className="flex items-center justify-between bg-dark-input/50 border border-dark-border/40 rounded-lg px-3 py-2">
                        <div className="flex items-center gap-2 min-w-0">
                          {info.ok === true ? (
                            <CheckCircle2 className="w-3.5 h-3.5 text-green-400 shrink-0" />
                          ) : info.ok === false ? (
                            <AlertCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />
                          ) : (
                            <Loader2 className="w-3.5 h-3.5 text-purple-400 animate-spin shrink-0" />
                          )}
                          <span className="text-xs text-white truncate">{info.email}</span>
                        </div>
                        <span className="text-[10px] text-dark-muted shrink-0 ml-2">
                          {info.step === 'starting' ? '启动中' :
                           info.step === 'saved_to_db' ? '已保存' :
                           info.step === 'error' ? (info.error || '失败') :
                           info.step || '处理中'}
                        </span>
                      </div>
                    ))}
                </div>
              </div>
            )}

            {framiaBatchStep === 'done' && framiaBatchSummary && (
              <div className="space-y-3">
                <div className="flex items-center gap-3 py-2">
                  {framiaBatchSummary.failed === 0 ? (
                    <CheckCircle2 className="w-5 h-5 text-green-400" />
                  ) : (
                    <AlertCircle className="w-5 h-5 text-orange-400" />
                  )}
                  <span className="text-sm text-white">
                    批量登录完成：成功 <span className="text-green-400 font-bold">{framiaBatchSummary.succeeded}</span>，
                    失败 <span className="text-red-400 font-bold">{framiaBatchSummary.failed}</span>，共 {framiaBatchSummary.total} 个账号
                  </span>
                </div>
                {framiaBatchSummary.failed > 0 && (
                  <div className="space-y-1.5 max-h-48 overflow-y-auto">
                    {Object.entries(framiaBatchResults)
                      .filter(([, info]) => info.ok === false)
                      .sort(([a], [b]) => parseInt(a) - parseInt(b))
                      .map(([idx, info]) => (
                        <div key={idx} className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs">
                          <div className="flex items-center gap-2 text-red-300">
                            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                            <span className="truncate">{info.email}</span>
                          </div>
                          <div className="mt-1 whitespace-pre-wrap break-words text-red-200/80">{info.error || '未返回具体错误信息'}</div>
                        </div>
                      ))}
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setShowFramiaBatchLogin(false);
                    setFramiaBatchStep('idle');
                    setFramiaBatchText('');
                    setFramiaBatchResults({});
                    setFramiaBatchSummary(null);
                  }}
                  className="px-4 py-2 rounded-lg text-dark-muted text-sm hover:text-white hover:bg-dark-card/80 transition-colors"
                >
                  完成
                </button>
              </div>
            )}
          </div>
        )}

        {activePool === 'framia' && (framiaLoading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-6 h-6 text-brand animate-spin" />
          </div>
        ) : framiaAccounts.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-dark-muted">
            <Sparkles className="w-12 h-12 mb-3 opacity-30" />
            <p className="text-sm">暂无渠道九 Framia 账号，点击右上角「Google 批量登录」开始</p>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center justify-between rounded-xl border border-dark-border bg-dark-card/60 px-4 py-3 text-xs text-dark-muted">
              <span>当前共 {framiaAccounts.length} 个渠道九 Framia 账号。通过 Google OAuth 登录采集 accessToken。</span>
              <span>账号可在内容创作中用于视频生成。</span>
            </div>
            {framiaAccounts.map((acc) => (
              <div
                key={acc.id}
                className={`flex items-center justify-between p-4 rounded-xl border transition-colors ${
                  acc.access_token
                    ? 'bg-dark-card border-dark-border hover:border-dark-border/80'
                    : 'bg-amber-950/20 border-amber-500/30'
                }`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-9 h-9 rounded-lg bg-purple-500/10 flex items-center justify-center shrink-0">
                    <Sparkles className="w-4 h-4 text-purple-300" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-white truncate flex items-center gap-2">
                      <span>{acc.email || '未知 Framia 账号'}</span>
                      <span className={`px-1.5 py-0.5 rounded border text-[10px] font-bold ${
                        acc.access_token
                          ? 'bg-green-500/15 text-green-400 border-green-500/30'
                          : 'bg-amber-500/15 text-amber-400 border-amber-500/30'
                      }`}>
                        {acc.access_token ? '已采集' : 'Token 缺失'}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-dark-muted mt-1">
                      <span>{formatDate(acc.updated_at || acc.created_at)}</span>
                      {acc.user_id && <span className="text-dark-subtle">UID: {acc.user_id}</span>}
                    </div>
                    {acc.user_agent && (
                      <div className="mt-1 text-[11px] text-dark-subtle truncate max-w-[620px]" title={acc.user_agent}>
                        {acc.user_agent}
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <button
                    onClick={() => handleFramiaRefreshCredits(acc.id)}
                    disabled={framiaRefreshingId === acc.id}
                    className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-yellow-500/10 text-yellow-400 text-xs font-bold hover:bg-yellow-500/20 disabled:opacity-50 transition-colors"
                    title="查询积分"
                  >
                    {framiaRefreshingId === acc.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Coins className="w-3.5 h-3.5" />}
                    {acc.credits_balance != null ? `${acc.credits_balance} 积分` : '查询积分'}
                  </button>
                  <button
                    onClick={() => copyText(acc.email || '', '邮箱')}
                    disabled={!acc.email}
                    className="px-1.5 py-1 rounded-lg text-dark-muted hover:text-brand hover:bg-brand/10 disabled:opacity-40 transition-colors flex items-center gap-1 text-xs"
                    title="复制邮箱"
                  >
                    <Copy className="w-3.5 h-3.5" /> 邮箱
                  </button>
                  <button
                    onClick={() => handleFramiaDelete(acc.id)}
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

        {activePool === 'happyhorse' && showHappyhorseBatchLogin && (
          <div className="p-4 rounded-xl bg-dark-card border border-emerald-500/20 space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-medium text-white">渠道十一 HappyHorse · Google 批量登录</h3>
                <p className="text-xs text-dark-muted mt-1">
                  每行一个账号，格式: 邮箱|密码。系统会打开 Chrome 完成 HappyHorse → Google OAuth，并把 accessToken 保存到渠道十一账号池。
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  if (happyhorseBatchStep !== 'running') setShowHappyhorseBatchLogin(false);
                }}
                disabled={happyhorseBatchStep === 'running'}
                className="p-1.5 rounded-lg text-dark-muted hover:text-white hover:bg-dark-bg disabled:opacity-50 transition-colors"
              >
                <XCircle className="w-4 h-4" />
              </button>
            </div>

            {happyhorseBatchStep === 'idle' && (
              <div className="space-y-3">
                <textarea
                  placeholder="email1@gmaii.lol|password1&#10;email2@gmaii.lol|password2"
                  value={happyhorseBatchText}
                  onChange={(e) => setHappyhorseBatchText(e.target.value)}
                  rows={8}
                  className="w-full bg-dark-input text-sm border border-dark-border focus:border-emerald-500 focus:outline-none rounded-lg p-3 text-white placeholder-dark-subtle font-mono resize-none"
                />
                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-brand/20 bg-brand/5 p-3">
                  <span className="text-xs text-brand">从全局邮箱库领取</span>
                  <input
                    type="number"
                    min="1"
                    max="100"
                    value={happyhorsePoolCount}
                    onChange={(e) => setHappyhorsePoolCount(Math.max(1, Math.min(100, parseInt(e.target.value, 10) || 1)))}
                    className="w-16 bg-dark-input text-sm border border-dark-border focus:border-brand focus:outline-none rounded-lg p-2 text-white text-center"
                  />
                  <span className="text-xs text-dark-muted">个尚未用于渠道十一的 Google 密码账号</span>
                  <button
                    type="button"
                    onClick={handleHappyhorsePoolLogin}
                    className="ml-auto flex items-center gap-1.5 px-3 py-2 rounded-lg bg-brand/15 text-brand text-sm font-medium hover:bg-brand/25 transition-colors"
                  >
                    <Mail className="w-4 h-4" />
                    领取并登录
                  </button>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <label className="text-xs text-dark-muted">并发数</label>
                  <input
                    type="number"
                    min="1"
                    max="5"
                    value={happyhorseBatchConcurrency}
                    onChange={(e) => setHappyhorseBatchConcurrency(Math.max(1, Math.min(5, parseInt(e.target.value) || 1)))}
                    className="w-16 bg-dark-input text-sm border border-dark-border focus:border-emerald-500 focus:outline-none rounded-lg p-2 text-white text-center"
                  />
                  <span className="text-xs text-dark-muted">Google 风控较敏感，建议 1–2</span>
                  <label className="flex items-center gap-2 text-xs text-dark-muted">
                    <input
                      type="checkbox"
                      checked={happyhorseBatchVisible}
                      onChange={(e) => setHappyhorseBatchVisible(e.target.checked)}
                      className="accent-brand"
                    />
                    可见浏览器
                  </label>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleHappyhorseBatchLogin}
                    disabled={!happyhorseBatchText.trim()}
                    className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-500/15 text-emerald-300 text-sm font-medium hover:bg-emerald-500/25 disabled:opacity-50 transition-colors"
                  >
                    <Mail className="w-4 h-4" />
                    开始登录（{happyhorseBatchText.trim().split('\n').filter(l => l.trim() && l.includes('|')).length} 个账号）
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowHappyhorseBatchLogin(false)}
                    className="px-4 py-2 rounded-lg text-dark-muted text-sm hover:text-white hover:bg-dark-card/80 transition-colors"
                  >
                    取消
                  </button>
                </div>
              </div>
            )}

            {happyhorseBatchStep === 'running' && (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3 py-1">
                  <div className="flex items-center gap-2 min-w-0">
                    <Loader2 className="w-4 h-4 text-emerald-400 animate-spin shrink-0" />
                    <span className="text-sm text-white truncate">
                      {happyhorseCancelling
                        ? '正在取消渠道十一登录...'
                        : happyhorseBatchProgress
                          ? `进度 ${happyhorseBatchProgress.done}/${happyhorseBatchProgress.total}`
                          : 'HappyHorse 批量登录进行中...'}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={cancelHappyhorseBatchLogin}
                    disabled={happyhorseCancelling}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-500/15 text-red-300 text-xs font-medium hover:bg-red-500/25 disabled:opacity-50 transition-colors shrink-0"
                  >
                    {happyhorseCancelling ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Square className="w-3.5 h-3.5" />}
                    取消任务
                  </button>
                </div>
                {happyhorseBatchProgress && (
                  <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 space-y-2">
                    <div className="flex items-center justify-between gap-3 text-[11px]">
                      <span className="text-emerald-200/90 truncate">
                        {happyhorseBatchProgress.currentEmail
                          ? `当前：${happyhorseBatchProgress.currentEmail}`
                          : '处理中...'}
                      </span>
                      <span className="text-white font-medium shrink-0">
                        {happyhorseBatchProgress.total
                          ? `${Math.min(100, Math.round((happyhorseBatchProgress.done / happyhorseBatchProgress.total) * 100))}%`
                          : '0%'}
                      </span>
                    </div>
                    <div className="h-1.5 rounded-full bg-dark-border/60 overflow-hidden">
                      <div
                        className="h-full rounded-full bg-emerald-400 transition-all duration-300"
                        style={{
                          width: `${happyhorseBatchProgress.total
                            ? Math.min(100, Math.round((happyhorseBatchProgress.done / happyhorseBatchProgress.total) * 100))
                            : 0}%`,
                        }}
                      />
                    </div>
                    <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-dark-muted">
                      <span>成功 <span className="text-green-400">{happyhorseBatchProgress.succeeded}</span></span>
                      <span>跳过 <span className="text-amber-300">{happyhorseBatchProgress.skipped}</span></span>
                      <span>失败 <span className="text-red-400">{happyhorseBatchProgress.failed}</span></span>
                      {(happyhorseBatchProgress.cancelled || 0) > 0 && (
                        <span>取消 <span className="text-amber-200">{happyhorseBatchProgress.cancelled}</span></span>
                      )}
                      <span className="ml-auto text-dark-subtle">
                        已完成 {happyhorseBatchProgress.done}/{happyhorseBatchProgress.total}
                      </span>
                    </div>
                  </div>
                )}
                <div className="space-y-1.5 max-h-72 overflow-y-auto">
                  {Object.entries(happyhorseBatchResults)
                    .sort(([a], [b]) => {
                      const na = Number.parseInt(a, 10);
                      const nb = Number.parseInt(b, 10);
                      if (Number.isNaN(na) || Number.isNaN(nb)) return String(a).localeCompare(String(b));
                      return na - nb;
                    })
                    .map(([idx, info]) => (
                      <div key={idx} className="flex items-center justify-between bg-dark-input/50 border border-dark-border/40 rounded-lg px-3 py-2">
                        <div className="flex items-center gap-2 min-w-0">
                          {info.ok === true ? (
                            <CheckCircle2 className="w-3.5 h-3.5 text-green-400 shrink-0" />
                          ) : info.ok === false ? (
                            <AlertCircle className={`w-3.5 h-3.5 shrink-0 ${info.step === 'cancelled' ? 'text-amber-300' : 'text-red-400'}`} />
                          ) : info.step === 'queued' ? (
                            <div className="w-3.5 h-3.5 rounded-full border border-dark-muted/50 shrink-0" />
                          ) : (
                            <Loader2 className="w-3.5 h-3.5 text-emerald-400 animate-spin shrink-0" />
                          )}
                          <span className="text-xs text-white truncate">{info.email}</span>
                        </div>
                        <span className="text-[10px] text-dark-muted shrink-0 ml-2">
                          {info.step === 'queued' ? '排队中' :
                           info.step === 'starting' ? '启动中' :
                           info.step === 'saved_to_db' ? '已保存' :
                           info.step === 'skipped' ? '已跳过（已登录）' :
                           info.step === 'cancelled' ? '已取消' :
                           info.step === 'error' ? (info.error || '失败') :
                           info.step || '处理中'}
                        </span>
                      </div>
                    ))}
                </div>
              </div>
            )}

            {happyhorseBatchStep === 'done' && happyhorseBatchSummary && (
              <div className="space-y-3">
                <div className="flex items-center gap-3 py-2">
                  {happyhorseBatchSummary.failed === 0 && !(happyhorseBatchSummary.cancelled > 0) ? (
                    <CheckCircle2 className="w-5 h-5 text-green-400" />
                  ) : (
                    <AlertCircle className="w-5 h-5 text-orange-400" />
                  )}
                  <span className="text-sm text-white">
                    批量登录完成：成功 <span className="text-green-400 font-bold">{happyhorseBatchSummary.succeeded}</span>，
                    跳过 <span className="text-amber-300 font-bold">{happyhorseBatchSummary.skipped || 0}</span>，
                    失败 <span className="text-red-400 font-bold">{happyhorseBatchSummary.failed}</span>
                    {(happyhorseBatchSummary.cancelled || 0) > 0 && (
                      <>
                        ，取消 <span className="text-amber-200 font-bold">{happyhorseBatchSummary.cancelled}</span>
                      </>
                    )}
                    ，共 {happyhorseBatchSummary.total} 个账号
                  </span>
                </div>
                {happyhorseBatchSummary.failed > 0 && (
                  <div className="space-y-1.5 max-h-48 overflow-y-auto">
                    {Object.entries(happyhorseBatchResults)
                      .filter(([, info]) => info.ok === false && info.step !== 'cancelled')
                      .sort(([a], [b]) => parseInt(a) - parseInt(b))
                      .map(([idx, info]) => (
                        <div key={idx} className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs">
                          <div className="flex items-center gap-2 text-red-300">
                            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                            <span className="truncate">{info.email}</span>
                          </div>
                          <div className="mt-1 whitespace-pre-wrap break-words text-red-200/80">{info.error || '未返回具体错误信息'}</div>
                        </div>
                      ))}
                  </div>
                )}
                <div className="flex items-center gap-2">
                  {happyhorseBatchSummary.failed > 0 && (
                    <button
                      type="button"
                      onClick={retryHappyhorseFailedLogins}
                      className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-amber-500/15 text-amber-200 text-sm font-medium hover:bg-amber-500/25 transition-colors"
                    >
                      <RotateCcw className="w-4 h-4" />
                      重试失败（{happyhorseBatchSummary.failed}）
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setShowHappyhorseBatchLogin(false);
                      setHappyhorseBatchStep('idle');
                      setHappyhorseBatchText('');
                      setHappyhorseBatchResults({});
                      setHappyhorseBatchSummary(null);
                      happyhorseBatchAccountsRef.current = [];
                    }}
                    className="px-4 py-2 rounded-lg text-dark-muted text-sm hover:text-white hover:bg-dark-card/80 transition-colors"
                  >
                    完成
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {activePool === 'happyhorse' && (happyhorseLoading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-6 h-6 text-brand animate-spin" />
          </div>
        ) : happyhorseAccounts.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-dark-muted">
            <Sparkles className="w-12 h-12 mb-3 opacity-30" />
            <p className="text-sm">暂无渠道十一 HappyHorse 账号，点击右上角「Google 批量登录」开始</p>
          </div>
        ) : happyhorseFilteredAccounts.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-dark-muted">
            <Calendar className="w-12 h-12 mb-3 opacity-30" />
            <p className="text-sm">没有添加日期为 {happyhorseCreatedDateFilter} 的账号</p>
            <button
              type="button"
              onClick={() => setHappyhorseCreatedDateFilter('')}
              className="mt-3 px-3 py-1.5 rounded-lg bg-sky-500/10 text-sky-300 text-xs font-medium hover:bg-sky-500/20 transition-colors"
            >
              清除日期筛选
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center justify-between rounded-xl border border-dark-border bg-dark-card/60 px-4 py-3 text-xs text-dark-muted">
              <div className="flex items-center gap-3 min-w-0">
                <label className="flex items-center gap-2 cursor-pointer select-none shrink-0">
                  <input
                    type="checkbox"
                    checked={
                      happyhorseFilteredAccounts.length > 0
                      && happyhorseFilteredAccounts.every(acc => happyhorseSelectedIds.includes(Number(acc.id)))
                    }
                    onChange={toggleHappyhorseSelectAll}
                    className="rounded border-dark-border text-brand focus:ring-brand/50"
                  />
                  <span className="text-white">
                    {happyhorseFilteredAccounts.length > 0
                      && happyhorseFilteredAccounts.every(acc => happyhorseSelectedIds.includes(Number(acc.id)))
                      ? '取消全选'
                      : '全选'}
                  </span>
                </label>
                <label className="flex items-center gap-1.5 shrink-0 cursor-pointer" title="按添加账号日期筛选">
                  <Calendar className="w-3.5 h-3.5 text-sky-300" />
                  <input
                    type="date"
                    value={happyhorseCreatedDateFilter}
                    onChange={(e) => setHappyhorseCreatedDateFilter(e.target.value || '')}
                    className="bg-dark-input border border-dark-border rounded-lg px-2 py-1 text-[11px] text-white focus:outline-none focus:border-sky-400/50"
                  />
                </label>
                {happyhorseCreatedDateFilter && (
                  <button
                    type="button"
                    onClick={() => setHappyhorseCreatedDateFilter('')}
                    className="px-2 py-1 rounded-lg text-[11px] text-dark-muted hover:text-white hover:bg-dark-card transition-colors shrink-0"
                  >
                    清除
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleHappyhorseExportSelected}
                  disabled={happyhorseExporting || happyhorseSelectedIds.length === 0 || happyhorseBatchStep === 'running'}
                  className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-sky-500/10 text-sky-300 text-[11px] font-bold hover:bg-sky-500/20 disabled:opacity-50 transition-colors shrink-0"
                  title="导出勾选账号的 cookie / accessToken"
                >
                  {happyhorseExporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                  导出选中{happyhorseSelectedIds.length ? ` (${happyhorseSelectedIds.length})` : ''}
                </button>
                <span className="truncate">
                  {happyhorseCreatedDateFilter
                    ? `筛选 ${happyhorseCreatedDateFilter}：${happyhorseFilteredAccounts.length} / 共 ${happyhorseAccounts.length} 个`
                    : `当前共 ${happyhorseAccounts.length} 个渠道十一账号`}
                  {happyhorseSelectedIds.length > 0 ? `，已选 ${happyhorseSelectedIds.length} 个` : ''}。
                  勾选后可导出 cookie / accessToken。
                </span>
              </div>
              <span className="shrink-0">账号可在内容创作中用于图生视频。</span>
            </div>
            {happyhorseFilteredAccounts.map((acc) => (
              <div
                key={acc.id}
                className={`flex items-center justify-between p-4 rounded-xl border transition-colors ${
                  happyhorseSelectedIds.includes(Number(acc.id))
                    ? 'bg-sky-950/20 border-sky-500/40'
                    : acc.has_token || acc.configured
                      ? 'bg-dark-card border-dark-border hover:border-dark-border/80'
                      : 'bg-amber-950/20 border-amber-500/30'
                }`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <input
                    type="checkbox"
                    checked={happyhorseSelectedIds.includes(Number(acc.id))}
                    onChange={() => toggleHappyhorseSelection(acc.id)}
                    className="rounded border-dark-border text-brand focus:ring-brand/50 shrink-0"
                    title="选中后导出"
                  />
                  <div className="w-9 h-9 rounded-lg bg-emerald-500/10 flex items-center justify-center shrink-0">
                    <Sparkles className="w-4 h-4 text-emerald-300" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-white truncate flex items-center gap-2">
                      <span>{acc.email || '未知 HappyHorse 账号'}</span>
                      <span className={`px-1.5 py-0.5 rounded border text-[10px] font-bold ${
                        acc.has_token || acc.configured
                          ? 'bg-green-500/15 text-green-400 border-green-500/30'
                          : 'bg-amber-500/15 text-amber-400 border-amber-500/30'
                      }`}>
                        {acc.has_token || acc.configured ? '已采集' : 'Token 缺失'}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-dark-muted mt-1">
                      <span>{formatDate(acc.updated_at || acc.created_at)}</span>
                      {acc.user_id && <span className="text-dark-subtle">UID: {acc.user_id}</span>}
                      {acc.device_id && <span className="text-dark-subtle truncate max-w-[180px]" title={acc.device_id}>device: {acc.device_id}</span>}
                    </div>
                    {acc.user_agent && (
                      <div className="mt-1 text-[11px] text-dark-subtle truncate max-w-[620px]" title={acc.user_agent}>
                        {acc.user_agent}
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <button
                    onClick={() => handleHappyhorseRefreshCredits(acc.id)}
                    disabled={happyhorseRefreshingId === acc.id || happyhorseSigningId === acc.id}
                    className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-yellow-500/10 text-yellow-400 text-xs font-bold hover:bg-yellow-500/20 disabled:opacity-50 transition-colors"
                    title="查询积分 availableCount"
                  >
                    {happyhorseRefreshingId === acc.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Coins className="w-3.5 h-3.5" />}
                    {acc.credits_balance != null ? `${acc.credits_balance} 积分` : '查询积分'}
                  </button>
                  <button
                    onClick={() => handleHappyhorseDailySignin(acc.id)}
                    disabled={happyhorseSigningId === acc.id || happyhorseRefreshingId === acc.id || !(acc.has_token || acc.configured)}
                    className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-500/10 text-emerald-300 text-xs font-bold hover:bg-emerald-500/20 disabled:opacity-50 transition-colors"
                    title="每日签到领取 DAILY_SIGNIN"
                  >
                    {happyhorseSigningId === acc.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                    每日签到
                  </button>
                  <button
                    onClick={() => copyText(acc.email || '', '邮箱')}
                    disabled={!acc.email}
                    className="px-1.5 py-1 rounded-lg text-dark-muted hover:text-brand hover:bg-brand/10 disabled:opacity-40 transition-colors flex items-center gap-1 text-xs"
                    title="复制邮箱"
                  >
                    <Copy className="w-3.5 h-3.5" /> 邮箱
                  </button>
                  <button
                    onClick={() => handleHappyhorseDelete(acc.id)}
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

        {activePool === 'insmind' && showInsmindRegister && (
          <div className="p-4 rounded-xl bg-dark-card border border-sky-500/20 space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-medium text-white">渠道十二 insMind · GPTMail 注册</h3>
                <p className="text-xs text-dark-muted mt-1">
                  使用 GPTMail 临时邮箱 + 图形验证码完成 UMS 注册并绑定个人租户。需配置 YesCaptcha Key（与渠道三共用）。注册默认走设置里的动态代理（ipwo），可缓解发码 IP 限流。
                </p>
              </div>
              <button
                type="button"
                onClick={() => !insmindRegistering && setShowInsmindRegister(false)}
                disabled={insmindRegistering}
                className="p-1.5 rounded-lg text-dark-muted hover:text-white hover:bg-dark-bg disabled:opacity-50 transition-colors"
              >
                <XCircle className="w-4 h-4" />
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <label className="text-xs text-dark-muted">注册数量</label>
              <input
                type="number"
                min="1"
                max="999"
                value={insmindRegCount}
                onChange={(e) => setInsmindRegCount(Math.max(1, Math.min(999, parseInt(e.target.value, 10) || 1)))}
                className="w-24 bg-dark-input text-sm border border-dark-border focus:border-sky-500 focus:outline-none rounded-lg p-2 text-white text-center"
              />
              <label className="text-xs text-dark-muted">并发数</label>
              <input
                type="number"
                min="1"
                max="999"
                value={insmindRegConcurrency}
                onChange={(e) => setInsmindRegConcurrency(Math.max(1, Math.min(999, parseInt(e.target.value, 10) || 1)))}
                className="w-24 bg-dark-input text-sm border border-dark-border focus:border-sky-500 focus:outline-none rounded-lg p-2 text-white text-center"
              />
              <span className="text-xs text-dark-muted">数量/并发 1–999；过高并发可能触发验证码风控。</span>
              <button
                type="button"
                onClick={handleInsmindRegister}
                disabled={insmindRegistering}
                className="ml-auto flex items-center gap-1.5 px-4 py-2 rounded-lg bg-sky-500/15 text-sky-300 text-sm font-medium hover:bg-sky-500/25 disabled:opacity-50 transition-colors"
              >
                {insmindRegistering ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                {insmindRegistering
                  ? (insmindRegProgress
                    ? `注册中 ${insmindRegProgress.done}/${insmindRegProgress.total}`
                    : '注册中...')
                  : '开始注册'}
              </button>
            </div>
            {insmindRegProgress && (insmindRegistering || insmindRegProgress.done > 0) && (
              <div className="rounded-lg border border-sky-500/20 bg-sky-500/5 px-3 py-2 space-y-2">
                <div className="flex items-center justify-between gap-3 text-[11px]">
                  <span className="text-sky-200/90 truncate">
                    {insmindRegistering
                      ? (insmindRegProgress.currentEmail || '处理中...')
                      : '本轮注册已结束'}
                  </span>
                  <span className="text-white font-medium shrink-0">
                    {insmindRegProgress.total
                      ? `${Math.min(100, Math.round((insmindRegProgress.done / insmindRegProgress.total) * 100))}%`
                      : '0%'}
                  </span>
                </div>
                <div className="h-1.5 rounded-full bg-dark-border/60 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-sky-400 transition-all duration-300"
                    style={{
                      width: `${insmindRegProgress.total
                        ? Math.min(100, Math.round((insmindRegProgress.done / insmindRegProgress.total) * 100))
                        : 0}%`,
                    }}
                  />
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-dark-muted">
                  <span>成功 <span className="text-green-400">{insmindRegProgress.succeeded}</span></span>
                  <span>失败 <span className="text-red-400">{insmindRegProgress.failed}</span></span>
                  <span className="ml-auto text-dark-subtle">
                    已完成 {insmindRegProgress.done}/{insmindRegProgress.total}
                  </span>
                </div>
              </div>
            )}
          </div>
        )}

        {activePool === 'insmind' && (insmindLoading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-6 h-6 text-brand animate-spin" />
          </div>
        ) : insmindAccounts.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-dark-muted">
            <Sparkles className="w-12 h-12 mb-3 opacity-30" />
            <p className="text-sm">暂无渠道十二 insMind 账号，点击右上角「GPTMail 注册」或在设置页导入 token</p>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center justify-between rounded-xl border border-dark-border bg-dark-card/60 px-4 py-3 text-xs text-dark-muted">
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-1.5 cursor-pointer select-none text-white">
                  <input
                    type="checkbox"
                    checked={insmindAccounts.length > 0 && insmindAccounts.every((acc) => insmindSelectedIds.includes(Number(acc.id)))}
                    onChange={toggleInsmindSelectAll}
                    className="rounded border-dark-border"
                  />
                  全选
                </label>
                <span>
                  当前共 {insmindAccounts.length} 个渠道十二账号；前端只展示脱敏 token。
                  {insmindSelectedIds.length > 0 ? `，已选 ${insmindSelectedIds.length} 个` : ''}
                </span>
              </div>
              <span>图生视频 · Seedance 2.0 Mini · 5/10/15s · 480P/720P</span>
            </div>
            {insmindAccounts.map((acc) => (
              <div
                key={acc.id}
                className={`flex items-center justify-between p-4 rounded-xl border transition-colors ${
                  acc.configured
                    ? 'bg-dark-card border-dark-border hover:border-dark-border/80'
                    : 'bg-amber-950/20 border-amber-500/30'
                }`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <input
                    type="checkbox"
                    checked={insmindSelectedIds.includes(Number(acc.id))}
                    onChange={() => toggleInsmindSelect(Number(acc.id))}
                    className="rounded border-dark-border shrink-0"
                    title="勾选导出"
                  />
                  <div className="w-9 h-9 rounded-lg bg-sky-500/10 flex items-center justify-center shrink-0">
                    <Sparkles className="w-4 h-4 text-sky-300" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-white truncate flex items-center gap-2">
                      <span>{acc.email || '未知 insMind 账号'}</span>
                      <span className={`px-1.5 py-0.5 rounded border text-[10px] font-bold ${
                        acc.configured
                          ? 'bg-green-500/15 text-green-400 border-green-500/30'
                          : 'bg-amber-500/15 text-amber-400 border-amber-500/30'
                      }`}>
                        {acc.configured ? '登录态有效' : acc.token_expired ? 'Token 已过期' : 'Token 缺失'}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-dark-muted mt-1">
                      <span>{formatDate(acc.updated_at || acc.created_at)}</span>
                      {acc.user_id && <span className="text-dark-subtle">UID: {acc.user_id}</span>}
                      {acc.org_id && <span className="text-dark-subtle">org: {acc.org_id}</span>}
                      {acc.token_masked && <span className="font-mono text-dark-subtle">Token {acc.token_masked}</span>}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <button
                    onClick={() => copyText(acc.email || '', '邮箱')}
                    disabled={!acc.email}
                    className="px-1.5 py-1 rounded-lg text-dark-muted hover:text-brand hover:bg-brand/10 disabled:opacity-40 transition-colors flex items-center gap-1 text-xs"
                    title="复制邮箱"
                  >
                    <Copy className="w-3.5 h-3.5" /> 邮箱
                  </button>
                  <button
                    onClick={() => handleInsmindDelete(acc.id)}
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

        {activePool === 'lovart' && (lovartLoading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-6 h-6 text-brand animate-spin" />
          </div>
        ) : lovartAccounts.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-dark-muted">
            <Sparkles className="w-12 h-12 mb-3 opacity-30" />
            <p className="text-sm">暂无渠道七 Lovart 账号，点击右上角「Google 批量登录」开始</p>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center justify-between rounded-xl border border-dark-border bg-dark-card/60 px-4 py-3 text-xs text-dark-muted">
              <span>当前共 {lovartAccounts.length} 个渠道七 Lovart 账号。前端只展示登录态摘要，不显示 Cookie 原文。</span>
              <span>账号池已接入；生图提交协议待抓包接入。</span>
            </div>
            {lovartAccounts.map((acc) => (
              <div
                key={acc.id}
                className={`flex items-center justify-between p-4 rounded-xl border transition-colors ${
                  acc.configured
                    ? 'bg-dark-card border-dark-border hover:border-dark-border/80'
                    : 'bg-amber-950/20 border-amber-500/30'
                }`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-9 h-9 rounded-lg bg-blue-500/10 flex items-center justify-center shrink-0">
                    <Sparkles className="w-4 h-4 text-blue-300" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-white truncate flex items-center gap-2">
                      <span>{acc.email || '未知 Lovart 账号'}</span>
                      <span className={`px-1.5 py-0.5 rounded border text-[10px] font-bold ${
                        acc.configured
                          ? 'bg-green-500/15 text-green-400 border-green-500/30'
                          : 'bg-amber-500/15 text-amber-400 border-amber-500/30'
                      }`}>{acc.configured ? '已保存登录态' : '登录态不完整'}</span>
                      {acc.status && (
                        <span className="px-1.5 py-0.5 rounded bg-dark-muted/15 text-dark-muted border border-dark-border text-[10px] font-bold">
                          {acc.status}
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-dark-muted mt-1">
                      <span>{formatDate(acc.updated_at || acc.created_at)}</span>
                      {acc.cookie_masked && <span className="font-mono text-dark-subtle">Cookie {acc.cookie_masked}</span>}
                      {acc.location && <span className="text-dark-subtle truncate max-w-[260px]" title={acc.location}>{acc.location}</span>}
                    </div>
                    <div className="flex flex-wrap items-center gap-2 mt-2">
                      <span className="px-2 py-0.5 rounded-lg bg-blue-500/10 text-blue-300 border border-blue-500/20 text-[11px] font-bold">
                        Cookie {acc.cookie_count ?? 0}
                      </span>
                      <span className="px-2 py-0.5 rounded-lg bg-emerald-500/10 text-emerald-300 border border-emerald-500/20 text-[11px] font-bold">
                        localStorage {acc.local_storage_count ?? 0}
                      </span>
                      <span className="px-2 py-0.5 rounded-lg bg-purple-500/10 text-purple-300 border border-purple-500/20 text-[11px] font-bold">
                        sessionStorage {acc.session_storage_count ?? 0}
                      </span>
                      <span className="px-2 py-0.5 rounded-lg bg-orange-500/10 text-orange-300 border border-orange-500/20 text-[11px] font-bold">
                        IndexedDB {acc.indexed_db_count ?? 0}
                      </span>
                    </div>
                    {acc.user_agent && (
                      <div className="mt-1 text-[11px] text-dark-subtle truncate max-w-[620px]" title={acc.user_agent}>
                        {acc.user_agent}
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <button
                    onClick={() => copyText(acc.email || '', '邮箱')}
                    disabled={!acc.email}
                    className="px-1.5 py-1 rounded-lg text-dark-muted hover:text-brand hover:bg-brand/10 disabled:opacity-40 transition-colors flex items-center gap-1 text-xs"
                    title="复制邮箱"
                  >
                    <Copy className="w-3.5 h-3.5" /> 邮箱
                  </button>
                  <button
                    onClick={() => handleLovartDelete(acc.id)}
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
