import React, { useState, useEffect, useRef, useCallback } from 'react';
import { 
  SlidersHorizontal, 
  Lock, 
  Unlock, 
  Play, 
  Pause, 
  Plus, 
  Video, 
  Image as ImageIcon, 
  Sparkles, 
  ChevronUp, 
  ChevronDown, 
  RefreshCw,
  Send,
  Trash2,
  FolderPlus,
  Tv,
  Gamepad2,
  Mountain,
  Castle,
  Monitor,
  Settings,
  Layers,
  FolderOpen,
  CheckCircle2,
  Check,
  Activity,
  FileImage,
  FileVideo,
  Maximize2,
  Download,
  Copy,
  X,
  Combine,
  Type
} from 'lucide-react';
import { WIZSTAR_API } from '../config';
import ImageMergeModal from './ImageMergeModal';
import FaceCensorModal from './FaceCensorModal';
import GridMaskModal from './GridMaskModal';
import { mergeImages, blobToUint8Array, timestampForFilename } from '../utils/imageMerge';

const TASK_REGISTRY_KEY = 'maocanju_generation_task_registry';
let globalPollingStarted = false;
let globalPollingBusy = false;
let globalPollingCursor = 0;

const readGenerationTaskRegistry = () => {
  try {
    const raw = localStorage.getItem(TASK_REGISTRY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const writeGenerationTaskRegistry = (items) => {
  try {
    localStorage.setItem(TASK_REGISTRY_KEY, JSON.stringify(items));
  } catch (e) {
    console.warn('Failed to save generation task registry:', e);
  }
};

const updateGenerationTaskRegistry = (taskId, patch) => {
  if (!taskId) return;
  const now = Date.now();
  writeGenerationTaskRegistry(readGenerationTaskRegistry().map((task) => (
    task.taskId === taskId ? { ...task, ...patch, updatedAt: now } : task
  )));
};

const OREATEAI_STARTUP_RECOVERY_MARKER = '__maocanjuOreateaiStartupRecoveryDone';
const OREATEAI_INTERRUPTED_MESSAGE = '应用重启，生成任务已中断，请重新提交。';

const archiveInterruptedOreateaiTasks = () => {
  if (globalThis[OREATEAI_STARTUP_RECOVERY_MARKER]) return;
  globalThis[OREATEAI_STARTUP_RECOVERY_MARKER] = true;

  const registry = readGenerationTaskRegistry();
  const now = Date.now();
  let changed = false;
  const nextRegistry = registry.map((task) => {
    if (task?.channel !== 'oreateai' || task.status !== 'processing') return task;
    changed = true;
    return {
      ...task,
      status: 'failed',
      progress: 0,
      error: OREATEAI_INTERRUPTED_MESSAGE,
      interruptedAt: now,
      updatedAt: now,
    };
  });
  if (changed) writeGenerationTaskRegistry(nextRegistry);
};

const OREATEAI_STAGE_PROGRESS = {
  validated: 8,
  uploading: 30,
  chat_creating: 52,
  risk_runtime: 62,
  generating: 72,
  sse: 82,
  history_recovering: 95,
  complete: 96,
};

const oreateaiProgressPatch = (progress = {}) => {
  let value = OREATEAI_STAGE_PROGRESS[progress.stage] ?? 5;
  if (progress.stage === 'uploading' && Number(progress.total) > 0) {
    const assetProgress = Math.max(0, Math.min(1, Number(progress.loaded || 0) / Number(progress.total)));
    const assetIndex = Math.max(0, Number(progress.index || 0));
    const assetCount = Math.max(1, Number(progress.totalAssets || 1));
    value = 10 + Math.round(((assetIndex + assetProgress) / assetCount) * 40);
  }
  if (progress.stage === 'sse' && progress.event === 'end') value = 94;
  return {
    status: progress.stage === 'failed' ? 'failed' : 'processing',
    progress: value,
  };
};

const compareOreateaiCount = (actual, expression) => {
  const match = /^(>=|<=|==|!=|>|<)\s*(-?\d+(?:\.\d+)?)$/.exec(String(expression || '').trim());
  if (!match) return false;
  const expected = Number(match[2]);
  return ({ '>=': actual >= expected, '<=': actual <= expected, '==': actual === expected,
    '!=': actual !== expected, '>': actual > expected, '<': actual < expected })[match[1]];
};

const getOreateaiEffectiveSlots = (capability, assets = []) => {
  const restrictions = capability?.restrictions || {};
  const slots = JSON.parse(JSON.stringify(restrictions.inputSlots || {}));
  const counts = {
    image: assets.filter((asset) => asset?.kind === 'image').length,
    video: assets.filter((asset) => asset?.kind === 'video').length,
  };
  (restrictions.slotRules || []).forEach((rule) => {
    const applies = Object.entries(rule.when || {}).every(([slot, expression]) => compareOreateaiCount(counts[slot] || 0, expression));
    if (!applies) return;
    Object.entries(rule.then || {}).forEach(([target, value]) => {
      const [slot, field] = target.split('.');
      slots[slot] ||= {};
      slots[slot][field] = value;
    });
  });
  return { slots, counts, groups: restrictions.inputGroups || [] };
};

const validateOreateaiAssetSelection = (capability, assets = [], { requireMinimum = false } = {}) => {
  if (!capability) return '渠道八动态能力尚未加载';
  const { slots, counts, groups } = getOreateaiEffectiveSlots(capability, assets);
  for (const [slot, limits] of Object.entries(slots)) {
    const count = counts[slot] || 0;
    if (limits.max !== undefined && count > Number(limits.max)) return `${slot === 'image' ? '图片' : '视频'}素材最多允许 ${limits.max} 个`;
    if (requireMinimum && limits.min !== undefined && count < Number(limits.min)) return `${slot === 'image' ? '图片' : '视频'}素材至少需要 ${limits.min} 个`;
  }
  for (const group of groups) {
    const count = (group.slots || []).reduce((sum, slot) => sum + (counts[slot] || 0), 0);
    if (group.max !== undefined && count > Number(group.max)) return `参考素材最多允许 ${group.max} 个`;
    if (requireMinimum && group.min !== undefined && count < Number(group.min)) return `参考素材至少需要 ${group.min} 个`;
  }
  if (capability.scene === 'text_or_image' && assets.some((asset) => asset?.kind !== 'image')) return '文生/图生场景只接受图片素材';
  if (capability.scene === 'text_or_image' && assets.length > 1) return '文生/图生场景最多允许 1 张图片素材';
  if (requireMinimum && capability.scene === 'reference' && assets.length === 0) return '参考生视频至少需要 1 个本地素材';
  return '';
};

const DEFAULT_PROMPT_SUFFIX_TEMPLATES = [
  { id: 'none', name: '无后缀', suffix: '' },
];
const PROMPT_SUFFIX_TEMPLATES_KEY = 'maocanju_prompt_suffix_templates';

const DEFAULT_PROMPT_PREFIX_TEMPLATES = [
  { id: 'none', name: '无前缀', prefix: '' },
];
const PROMPT_PREFIX_TEMPLATES_KEY = 'maocanju_prompt_prefix_templates';
const PROMPT_INLINE_TOKEN_PATTERN = /([（(][@$#][^（）()\r\n]{1,80}[）)])/g;

const renderPromptPreviewText = (value = '') => {
  const text = String(value || '');
  if (!text) {
    return <span className="text-dark-subtle">请输入描述词，输入 @ 选择角色、$ 选择场景、# 选择物品...</span>;
  }
  return text.split(PROMPT_INLINE_TOKEN_PATTERN).filter(Boolean).map((part, index) => {
    const tokenMatch = /^[（(]([@$#])/.exec(part);
    if (!tokenMatch) return <React.Fragment key={`text-${index}`}>{part}</React.Fragment>;
    const trigger = tokenMatch[1];
    const colorClass = trigger === '@'
      ? 'border-emerald-400/35 bg-emerald-400/12 text-emerald-100'
      : trigger === '$'
        ? 'border-sky-400/35 bg-sky-400/12 text-sky-100'
        : 'border-amber-400/35 bg-amber-400/12 text-amber-100';
    return (
      <span
        key={`token-${index}`}
        className={`mx-0.5 inline-flex max-w-[180px] items-center rounded border px-1.5 py-0.5 align-middle text-[10px] font-bold leading-none ${colorClass}`}
        title={`实际文本：${part}`}
      >
        <span className="truncate">{part.slice(1, -1)}</span>
      </span>
    );
  });
};

const isDolaBusyMessage = (message = '') => /Dola 同一账号一次只能跑一个视频任务|请等待当前任务完成后再提交|正在生成中/.test(String(message || ''));

const formatWaitDuration = (seconds) => {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) return '';
  const minutes = Math.max(1, Math.ceil(value / 60));
  if (minutes < 60) return `${minutes}分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `${hours}小时${rest}分钟` : `${hours}小时`;
};

const generationWaitLabel = (row = {}) => {
  const elapsed = formatWaitDuration(row.elapsedSeconds);
  const remaining = formatWaitDuration(row.estimatedWaitSeconds ?? row.remainingSeconds);
  const timeout = formatWaitDuration(row.timeoutSeconds);
  if (elapsed && remaining) return `已等 ${elapsed} · 最多还剩 ${remaining}`;
  if (remaining) return `最多还剩 ${remaining}`;
  if (timeout) return `最长等待 ${timeout}`;
  if (elapsed) return `已等 ${elapsed}`;
  return '';
};

const statusUrlForTask = (task) => task.channel === 'pixmax'
  ? `${WIZSTAR_API}/pixmax/tasks/${task.taskId}/status`
  : task.channel === 'oiioii'
    ? `${WIZSTAR_API}/oiioii/tasks/${task.taskId}/status`
    : task.channel === 'chatgpt2api'
      ? `${WIZSTAR_API}/chatgpt2api/tasks/${task.taskId}/status`
      : task.channel === 'dola'
        ? `${WIZSTAR_API}/dola/tasks/${task.taskId}/status`
        : task.channel === 'lovart'
          ? `${WIZSTAR_API}/lovart/tasks/${task.taskId}/status`
          : task.channel === 'framia'
            ? `${WIZSTAR_API}/framia/tasks/${task.taskId}/status`
            : task.channel === 'tensorart'
              ? `${WIZSTAR_API}/tensorart/tasks/${task.taskId}/status`
              : `${WIZSTAR_API}/tasks/${task.taskId}/status`;

const isLocalFilePathValue = (url = '') => /^\/(?!\/)/.test(String(url || '')) || /^[a-zA-Z]:[\\/]/.test(String(url || '')) || /^\\\\/.test(String(url || ''));
const LOCAL_VIDEO_CACHE_BUSTER = String(Date.now());

const localFilePathFromUrlValue = (url = '') => {
  const raw = String(url || '').trim();
  if (!raw) return '';
  if (/^file:\/\//i.test(raw)) {
    try { return decodeURIComponent(new URL(raw).pathname); } catch (_) { return raw.replace(/^file:\/\/+/, '/'); }
  }
  return isLocalFilePathValue(raw) ? raw : '';
};
const extractRealUrlFromProxy = (url = '') => {
  const raw = String(url || '').trim();
  if (!raw) return { localPath: '', remoteUrl: '' };
  try {
    const parsed = new URL(raw, WIZSTAR_API);
    const api = new URL(WIZSTAR_API);
    if (parsed.hostname !== api.hostname || parsed.port !== api.port) {
      return { localPath: '', remoteUrl: '' };
    }
    if (parsed.pathname === '/local/video' || parsed.pathname === '/local/image') {
      const p = parsed.searchParams.get('path') || '';
      return { localPath: p ? decodeURIComponent(p) : '', remoteUrl: '' };
    }
    if (parsed.pathname === '/proxy/video' || parsed.pathname === '/download/video') {
      const u = parsed.searchParams.get('url') || '';
      return { localPath: '', remoteUrl: u };
    }
  } catch (_) {}
  return { localPath: '', remoteUrl: '' };
};
const isLocalVideoServiceUrlValue = (url = '') => {
  const raw = String(url || '').trim();
  if (!raw) return false;
  if (raw.startsWith('/local/video')) return true;
  try {
    const parsed = new URL(raw, WIZSTAR_API);
    const api = new URL(WIZSTAR_API);
    return parsed.pathname === '/local/video' && parsed.hostname === api.hostname && parsed.port === api.port;
  } catch (_) {
    return false;
  }
};
const isPlayableVideoUrlValue = (url = '') => {
  const raw = String(url || '').trim();
  if (!raw) return false;
  if (isLocalVideoServiceUrlValue(raw)) return true;
  if (/\.(mp4|webm|mov|m4v)(\?|$)/i.test(raw)) return true;
  if (/mime_type=video_|video_mp4|download_url|play_url|main_url/i.test(raw)) return true;
  try {
    const parsed = new URL(raw);
    return /(^|\.)dola\.com$/i.test(parsed.hostname) && /\/video\//i.test(parsed.pathname + parsed.search);
  } catch (_) {
    return false;
  }
};
const withLocalVideoCacheBuster = (url = '') => {
  const raw = String(url || '').trim();
  if (!raw || /[?&]v=/.test(raw)) return raw;
  return `${raw}${raw.includes('?') ? '&' : '?'}v=${LOCAL_VIDEO_CACHE_BUSTER}`;
};
const toLocalVideoUrlValue = (filePath = '') => withLocalVideoCacheBuster(`${WIZSTAR_API}/local/video?path=${encodeURIComponent(filePath)}`);
const toLocalImageUrlValue = (filePath = '') => `${WIZSTAR_API}/local/image?path=${encodeURIComponent(filePath)}`;
const toPlayableVideoUrlValue = (url = '') => {
  if (!url) return url;
  if (isLocalVideoServiceUrlValue(url)) return withLocalVideoCacheBuster(url);
  const localPath = localFilePathFromUrlValue(url);
  if (localPath && isPlayableVideoUrlValue(localPath)) return toLocalVideoUrlValue(localPath);
  if (/^https?:\/\//i.test(url) && isPlayableVideoUrlValue(url)) {
    return `${WIZSTAR_API}/proxy/video?url=${encodeURIComponent(url)}`;
  }
  return url;
};
const mediaUrlFromPayload = (payload = {}, task = {}) => {
  const localPath = payload.local_path || task.localPath || '';
  if (payload.media_type === 'video' && localPath) return localPath;
  return payload.image_url || payload.video_url || payload.cdn_url || payload.download_url || task.mediaUrl || task.imageUrl || task.videoUrl || '';
};

const taskPayloadLike = (task = {}) => ({
  media_type: task.mediaType || '',
  image_url: task.imageUrl || '',
  video_url: task.videoUrl || '',
  cdn_url: task.cdnUrl || '',
  download_url: task.downloadUrl || '',
  local_path: task.localPath || '',
  output_uri: task.outputUri || '',
});

const inferResultMediaType = (payload = {}, task = {}, fallbackUrl = '') => {
  const explicitType = String(payload.media_type || task.mediaType || '').toLowerCase();
  const outputUri = String(payload.output_uri || '').trim();
  const imageSignals = [
    payload.image_url,
    payload.cdn_url,
    payload.download_url,
    payload.local_path,
    task.imageUrl,
    task.localPath,
    task.cdnUrl,
    task.downloadUrl,
    task.outputUri,
    task.sourceUrl,
    outputUri,
    fallbackUrl,
  ].some((value) => {
    const text = String(value || '').trim();
    if (!text) return false;
    return /^hogi:\/\/image\//i.test(text) || /\.(png|jpe?g|webp|gif|avif)(\?|$)/i.test(text);
  });
  const videoSignals = [payload.video_url, task.videoUrl, task.mediaUrl, task.cdnUrl, task.downloadUrl, fallbackUrl].some((value) => isPlayableVideoUrlValue(String(value || '').trim()));

  if (imageSignals) return 'image';
  if (explicitType === 'image') return 'image';
  if (videoSignals) return 'video';
  if (explicitType === 'video') return 'video';
  return 'image';
};

const firstHttpMediaUrl = (...values) => values
  .map(value => String(value || '').trim())
  .find(value => /^https?:\/\//i.test(value)) || '';

const safeMediaNamePart = (value = '') => String(value || '')
  .replace(/[^a-zA-Z0-9._-]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 48);

const autoDownloadGeneratedMedia = async (task = {}, payload = {}, mediaUrl = '') => {
  const remoteUrl = firstHttpMediaUrl(payload.video_url, payload.image_url, payload.cdn_url, payload.download_url, mediaUrl, task.videoUrl, task.imageUrl, task.cdnUrl, task.downloadUrl, task.mediaUrl);
  if (!remoteUrl || !window.electronAPI?.downloadGeneratedMedia) return '';

  const mediaType = inferResultMediaType(payload, task, remoteUrl);
  const ext = mediaType === 'video' ? 'mp4' : 'png';
  const taskPart = safeMediaNamePart(task.taskId) || String(Date.now());
  const segPart = safeMediaNamePart(task.segId) || 'segment';
  const channelPart = safeMediaNamePart(task.channel) || 'generated';

  const result = await window.electronAPI.downloadGeneratedMedia({
    url: remoteUrl,
    ext,
    defaultName: `${channelPart}-${segPart}-${taskPart}`,
    channel: task.channel || 'generated',
    projectId: task.draftId || '',
    segmentId: task.segId || '',
  });
  if (result?.ok && result.filePath) return result.filePath;
  throw new Error(result?.error || '自动下载生成结果失败');
};

const shouldAutoCollectDolaTask = (task = {}, payload = {}) => {
  const status = payload.status || task.status || '';
  const conversationId = payload.conversation_id || task.conversationId || '';
  const hasResult = !!(payload.local_path || payload.video_url || task.localPath || task.videoUrl || task.mediaUrl);
  if (task.channel !== 'dola' || status !== 'collectable' || !conversationId || hasResult) return false;
  const lastStartedAt = Number(task.autoCollectStartedAt || 0);
  const hasKnownApiVisibilityGap = /API 暂未读取到该 Dola 会话的视频消息/.test(String(payload.fail_reason || task.error || ''));
  const retryWindowMs = hasKnownApiVisibilityGap ? 5 * 60 * 1000 : 90 * 1000;
  return !lastStartedAt || Date.now() - lastStartedAt > retryWindowMs;
};

const collectUrlForDolaTask = (task) => `${WIZSTAR_API}/dola/tasks/${encodeURIComponent(task.taskId)}/collect`;

const triggerAutoCollectDolaTask = async (task, payload = {}) => {
  const conversationId = payload.conversation_id || task.conversationId || '';
  const res = await fetch(collectUrlForDolaTask(task), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      conversation_id: conversationId,
      account_id: payload.account_id || task.accountId || 0,
    }),
  });
  if (!res.ok) {
    let errMsg = `HTTP ${res.status}`;
    try {
      const err = await res.json();
      errMsg = err.detail || errMsg;
    } catch (_) {}
    throw new Error(errMsg);
  }
  const data = await res.json();
  return data.data || {};
};

const DOLA_AUTO_POLL_TIMEOUT_MS = 10 * 60 * 1000;

const startGlobalGenerationPolling = () => {
  if (globalPollingStarted) return;
  globalPollingStarted = true;
  window.setInterval(async () => {
    if (globalPollingBusy) return;
    const now = Date.now();
    const registry = readGenerationTaskRegistry().filter(t => {
      if (!t || !t.taskId || t.status === 'completed' || t.status === 'failed') return false;
      // OreateAI 是由 Electron 主进程内的 SSE 驱动的本地统一任务，不存在后端 status 轮询接口。
      if (t.channel === 'oreateai') return false;
      // Dola tasks stop auto-polling 10 minutes after creation; user must trigger manual collect after that.
      if (t.channel === 'dola' && t.createdAt && (now - t.createdAt) > DOLA_AUTO_POLL_TIMEOUT_MS) return false;
      return true;
    });
    if (registry.length === 0) return;

    globalPollingBusy = true;
    try {
      const batchSize = 5;
      const start = globalPollingCursor % registry.length;
      const batch = [...registry.slice(start, start + batchSize), ...registry.slice(0, Math.max(0, start + batchSize - registry.length))].slice(0, batchSize);
      globalPollingCursor = (start + batchSize) % registry.length;
      const updatedById = new Map();

      await Promise.all(batch.map(async (task) => {
        try {
          const res = await fetch(statusUrlForTask(task));
          if (!res.ok) {
            let errMsg = `HTTP ${res.status}`;
            try {
              const err = await res.json();
              errMsg = err.detail || errMsg;
            } catch (_) {}
            if (res.status === 404) {
              updatedById.set(task.taskId, {
                ...task,
                status: 'failed',
                error: '本地任务缓存已过期，已自动清理该等待状态。请重新提交生成。',
                retryCount: (task.retryCount || 0) + 1,
                updatedAt: Date.now(),
              });
              return;
            }
            throw new Error(errMsg);
          }
          const data = await res.json();
          const payload = data.data || {};
          let status = payload.status || 'processing';
          let localPath = payload.local_path || task.localPath || '';
          let nextMediaUrl = mediaUrlFromPayload(payload, task);
          let autoCollectStartedAt = task.autoCollectStartedAt || 0;
          let autoCollectError = task.autoCollectError || '';
          let downloadError = task.downloadError || '';
          let downloadRetryCount = Number(task.downloadRetryCount || 0);

          if (shouldAutoCollectDolaTask(task, payload)) {
            try {
              autoCollectStartedAt = Date.now();
              const collectPayload = await triggerAutoCollectDolaTask(task, payload);
              status = collectPayload.status || 'collecting';
              nextMediaUrl = mediaUrlFromPayload(collectPayload, { ...task, mediaUrl: nextMediaUrl });
              localPath = collectPayload.local_path || localPath;
              autoCollectError = '';
            } catch (collectError) {
              autoCollectError = collectError.message || String(collectError);
            }
          }

          if (status === 'completed' && !localPath) {
            try {
              const downloadedLocalPath = await autoDownloadGeneratedMedia(task, payload, nextMediaUrl);
              if (downloadedLocalPath) {
                localPath = downloadedLocalPath;
                nextMediaUrl = downloadedLocalPath;
                downloadError = '';
                downloadRetryCount = 0;
              }
            } catch (downloadFailure) {
              downloadError = downloadFailure.message || String(downloadFailure);
              downloadRetryCount += 1;
              if (task.channel === 'tensorart' && downloadRetryCount <= 3) {
                status = 'processing';
              }
            }
          }
          updatedById.set(task.taskId, {
            ...task,
            status,
            progress: payload.progress,
            queuePosition: payload.queue_position,
            elapsedSeconds: payload.elapsed_seconds ?? task.elapsedSeconds,
            remainingSeconds: payload.remaining_seconds ?? task.remainingSeconds,
            timeoutSeconds: payload.timeout_seconds ?? task.timeoutSeconds,
            estimatedWaitSeconds: payload.estimated_wait_seconds ?? task.estimatedWaitSeconds,
            startedAtSeconds: payload.started_at ?? task.startedAtSeconds,
            mediaUrl: nextMediaUrl,
            videoUrl: payload.video_url || task.videoUrl || '',
            imageUrl: payload.image_url || task.imageUrl || '',
            mediaType: inferResultMediaType(payload, task, nextMediaUrl),
            localPath,
            cdnUrl: payload.cdn_url || task.cdnUrl || '',
            downloadUrl: payload.download_url || task.downloadUrl || '',
            outputUri: payload.output_uri || task.outputUri || '',
            fileSize: payload.file_size ?? task.fileSize,
            accountId: payload.account_id || task.accountId || 0,
            accountName: payload.account_name || task.accountName || '',
            conversationId: payload.conversation_id || task.conversationId || '',
            localConversationId: payload.local_conversation_id || task.localConversationId || '',
            pageUrl: payload.page_url || task.pageUrl || '',
            sendMode: 'api',
            sendModeLabel: payload.send_mode_label || task.sendModeLabel || '纯 API（默认）',
            browserHeadless: false,
            autoCollectStartedAt,
            autoCollectError,
            downloadError,
            downloadRetryCount,
            error: status === 'completed' && localPath
              ? ''
              : (payload.fail_reason || payload.error || payload.message || autoCollectError || downloadError || task.error || ''),
            updatedAt: Date.now(),
          });
        } catch (e) {
          updatedById.set(task.taskId, {
            ...task,
            error: e.message || String(e),
            retryCount: (task.retryCount || 0) + 1,
            updatedAt: Date.now(),
          });
        }
      }));

      const latest = readGenerationTaskRegistry();
      const merged = latest.map(task => updatedById.get(task.taskId) || task);
      writeGenerationTaskRegistry(merged);
    } finally {
      globalPollingBusy = false;
    }
  }, 5000);
};

export default function ContentCreation({ activeDraft, onBack, onProjectChanged }) {
  const GLOBAL_GENERATION_SETTINGS_KEY = 'maocanju_global_generation_settings';
  const DOLA_DEFAULT_DURATION_LABEL = '10秒';
  const TENSORART_DURATION_CREDITS = {
    4: 19,
    5: 24,
    6: 28,
    7: 33,
    8: 37,
    9: 42,
    10: 47,
  };
  const TENSORART_DURATION_OPTIONS = Object.keys(TENSORART_DURATION_CREDITS).map(seconds => `${seconds}秒`);
  const OIIOII_DEFAULT_SETTINGS = {
    model: 'nano-pro',
    aspectRatio: '1:1',
    resolution: '1K',
  };
  const LOVART_DEFAULT_SETTINGS = {
    model: '渠道七 Lovart',
    aspectRatio: '16:9',
    resolution: '2K',
  };
  const FRAMIA_DEFAULT_SETTINGS = {
    model: 'Seedance 2.0 Mini',
    aspectRatio: '16:9',
    resolution: '720p',
    duration: '4秒',
  };
  const OREATEAI_DEFAULT_SETTINGS = {
    model: 'Seedance 2.0 Mini',
    aspectRatio: '16:9',
    duration: '5秒',
    resolution: '720',
  };
  const DEFAULT_GLOBAL_GENERATION_SETTINGS = {
    model: 'Seedance 2.0',
    aspectRatio: '16:9',
    duration: '5秒',
    resolution: '2K',
    generateChannel: 'wizstar',
  };
  const readGlobalGenerationSetting = (key) => {
    try {
      const rawSettings = localStorage.getItem(GLOBAL_GENERATION_SETTINGS_KEY);
      const settings = rawSettings ? JSON.parse(rawSettings) : {};
      const value = settings[key] || (key === 'generateChannel' ? localStorage.getItem('maocanju_generate_channel') : null);
      const normalized = value === 'quickframe' ? 'wizstar' : (value || DEFAULT_GLOBAL_GENERATION_SETTINGS[key]);
      if (key === 'duration') {
        const channel = (settings.generateChannel || localStorage.getItem('maocanju_generate_channel') || DEFAULT_GLOBAL_GENERATION_SETTINGS.generateChannel);
        if (channel === 'dola' && (!value || value === DEFAULT_GLOBAL_GENERATION_SETTINGS.duration)) return DOLA_DEFAULT_DURATION_LABEL;
        if (channel === 'tensorart') {
          const seconds = Number.parseInt(String(value || '').replace(/\D/g, ''), 10);
          if (!Number.isFinite(seconds) || seconds < 4 || seconds > 10) return '4秒';
        }
      }
      if (key === 'model' && (settings.generateChannel || localStorage.getItem('maocanju_generate_channel')) === 'oiioii' && (!value || value === DEFAULT_GLOBAL_GENERATION_SETTINGS.model)) {
        return OIIOII_DEFAULT_SETTINGS.model;
      }
      if (key === 'aspectRatio' && (settings.generateChannel || localStorage.getItem('maocanju_generate_channel')) === 'oiioii' && (!value || value === DEFAULT_GLOBAL_GENERATION_SETTINGS.aspectRatio)) {
        return OIIOII_DEFAULT_SETTINGS.aspectRatio;
      }
      if (key === 'resolution' && (settings.generateChannel || localStorage.getItem('maocanju_generate_channel')) === 'oiioii' && (!value || value === DEFAULT_GLOBAL_GENERATION_SETTINGS.resolution)) {
        return OIIOII_DEFAULT_SETTINGS.resolution;
      }
      if (key === 'model' && (settings.generateChannel || localStorage.getItem('maocanju_generate_channel')) === 'lovart' && (!value || value === DEFAULT_GLOBAL_GENERATION_SETTINGS.model)) {
        return LOVART_DEFAULT_SETTINGS.model;
      }
      if (key === 'aspectRatio' && (settings.generateChannel || localStorage.getItem('maocanju_generate_channel')) === 'lovart' && (!value || value === DEFAULT_GLOBAL_GENERATION_SETTINGS.aspectRatio)) {
        return LOVART_DEFAULT_SETTINGS.aspectRatio;
      }
      if (key === 'resolution' && (settings.generateChannel || localStorage.getItem('maocanju_generate_channel')) === 'lovart' && (!value || value === DEFAULT_GLOBAL_GENERATION_SETTINGS.resolution)) {
        return LOVART_DEFAULT_SETTINGS.resolution;
      }
      if ((settings.generateChannel || localStorage.getItem('maocanju_generate_channel')) === 'oreateai' && (!value || (key === 'resolution' && value === DEFAULT_GLOBAL_GENERATION_SETTINGS.resolution))) {
        return OREATEAI_DEFAULT_SETTINGS[key] || normalized;
      }
      return normalized;
    } catch {
      const channel = localStorage.getItem('maocanju_generate_channel');
      if (key === 'duration' && channel === 'dola') return DOLA_DEFAULT_DURATION_LABEL;
      if (key === 'duration' && channel === 'tensorart') return '4秒';
      if (channel === 'oiioii') {
        if (key === 'model') return OIIOII_DEFAULT_SETTINGS.model;
        if (key === 'aspectRatio') return OIIOII_DEFAULT_SETTINGS.aspectRatio;
        if (key === 'resolution') return OIIOII_DEFAULT_SETTINGS.resolution;
      }
      if (channel === 'lovart') {
        if (key === 'model') return LOVART_DEFAULT_SETTINGS.model;
        if (key === 'aspectRatio') return LOVART_DEFAULT_SETTINGS.aspectRatio;
        if (key === 'resolution') return LOVART_DEFAULT_SETTINGS.resolution;
      }
      if (channel === 'oreateai') return OREATEAI_DEFAULT_SETTINGS[key] || DEFAULT_GLOBAL_GENERATION_SETTINGS[key];
      return DEFAULT_GLOBAL_GENERATION_SETTINGS[key];
    }
  };

  const [showBatchModal, setShowBatchModal] = useState(false);
  const [globalModel, setGlobalModel] = useState(() => readGlobalGenerationSetting('model'));
  const [globalAspectRatio, setGlobalAspectRatio] = useState(() => readGlobalGenerationSetting('aspectRatio'));
  const [globalDuration, setGlobalDuration] = useState(() => readGlobalGenerationSetting('duration'));
  const [globalResolution, setGlobalResolution] = useState(() => readGlobalGenerationSetting('resolution'));
  // 生成通道：'wizstar'（账号池/渠道一）| 'pixmax'（渠道二）| 'oiioii'（渠道四）| 'chatgpt2api'（渠道五生图）| 'dola'（渠道六）| 'lovart'（渠道七）| 'oreateai'（渠道八）| 'framia'（渠道九）| 'tensorart'（渠道十）
  const [generateChannel, setGenerateChannel] = useState(() => readGlobalGenerationSetting('generateChannel'));
  const [oreateaiCapabilities, setOreateaiCapabilities] = useState(null);
  const [oreateaiCapabilitiesLoading, setOreateaiCapabilitiesLoading] = useState(false);
  const [oreateaiCapabilitiesError, setOreateaiCapabilitiesError] = useState('');
  const [oreateaiScene, setOreateaiScene] = useState('');
  const [oreateaiAudio, setOreateaiAudio] = useState(false);
  const getOreateaiCapability = (modelName = globalModel, scene = oreateaiScene) => (
    oreateaiCapabilities?.capabilities?.find((item) => item.modelName === modelName && item.scene === scene) || null
  );
  const getOreateaiCombination = (capability, settings = {}) => {
    if (!capability) return null;
    const duration = Number(settings.duration ?? resolveDurationSeconds(globalDuration, globalDuration, 5));
    const resolution = String(settings.resolution ?? globalResolution);
    const audio = settings.audio ?? oreateaiAudio;
    const matched = capability.combinations.find((item) => (
      item.duration === duration
      && item.resolution === resolution
      && (capability.scene === 'reference' || item.audio === null || item.audio === Boolean(audio))
    ));
    return matched || capability.combinations[0] || null;
  };
  const refreshOreateaiCapabilities = useCallback(async () => {
    if (!window.electronAPI?.oreateaiVideoCapabilities) {
      setOreateaiCapabilitiesError('渠道八仅支持 Electron 桌面端');
      return null;
    }
    setOreateaiCapabilitiesLoading(true);
    setOreateaiCapabilitiesError('');
    try {
      const response = await window.electronAPI.oreateaiVideoCapabilities({});
      if (!response?.ok || !response.data?.capabilities?.length) {
        throw new Error(response?.error || '渠道八未返回可用的视频能力');
      }
      setOreateaiCapabilities(response.data);
      return response.data;
    } catch (error) {
      setOreateaiCapabilitiesError(error.message || String(error));
      return null;
    } finally {
      setOreateaiCapabilitiesLoading(false);
    }
  }, []);
  useEffect(() => {
    if (generateChannel !== 'oreateai') return;
    refreshOreateaiCapabilities();
  }, [generateChannel, refreshOreateaiCapabilities]);
  useEffect(() => {
    if (generateChannel !== 'oreateai' || !oreateaiCapabilities?.capabilities?.length) return;
    const modelName = oreateaiCapabilities.models.includes(globalModel)
      ? globalModel
      : oreateaiCapabilities.models[0];
    const capability = getOreateaiCapability(modelName, oreateaiScene)
      || oreateaiCapabilities.capabilities.find((item) => item.modelName === modelName);
    if (!capability) return;
    if (oreateaiScene !== capability.scene) setOreateaiScene(capability.scene);
    const combination = getOreateaiCombination(capability);
    if (!combination) return;
    const ratio = capability.ratios.includes(globalAspectRatio) ? globalAspectRatio : capability.ratios[0];
    if (modelName !== globalModel) setGlobalModel(modelName);
    if (ratio && ratio !== globalAspectRatio) setGlobalAspectRatio(ratio);
    if (`${combination.duration}秒` !== globalDuration) setGlobalDuration(`${combination.duration}秒`);
    if (combination.resolution !== globalResolution) setGlobalResolution(combination.resolution);
  }, [generateChannel, oreateaiCapabilities, globalModel, oreateaiScene, globalAspectRatio, globalDuration, globalResolution, oreateaiAudio]);
  const [dolaSendModeLabel, setDolaSendModeLabel] = useState('纯 API（默认）');
  const refreshDolaConfig = useCallback(async () => {
    try {
      const res = await fetch(`${WIZSTAR_API}/dola/config`);
      if (!res.ok) return;
      const data = await res.json();
      const payload = data.data || {};
      setDolaSendModeLabel(payload.send_mode_label || '纯 API（默认）');
    } catch (_) {
      // 本地后端不可达时保留当前展示值。
    }
  }, []);
  useEffect(() => {
    if (generateChannel !== 'dola') return;
    refreshDolaConfig();
  }, [generateChannel, refreshDolaConfig]);
  useEffect(() => {
    if (generateChannel !== 'dola') return;
    if (!globalDuration || globalDuration === DEFAULT_GLOBAL_GENERATION_SETTINGS.duration) {
      setGlobalDuration(DOLA_DEFAULT_DURATION_LABEL);
    }
  }, [generateChannel]);

  const IMAGE_MODEL_NAMES = new Set([
    '渠道五 GPT-Image2',
    '渠道四 GPT-Image2',
    '渠道四 Nano Pro',
    '渠道四 Nano 2',
    '渠道四 Seedream 5.0',
    '渠道四 Seedream 4.5',
    '渠道四 Midjourney niji7',
    '渠道四 Midjourney niji6',
    '渠道四 Midjourney v8',
    '渠道四 NovelAI',
    '渠道四 GPT-4o',
    '渠道七 Lovart',
  ]);
  const VIDEO_MODEL_NAMES = new Set([
    'Seedance 2.0',
    'Seedance 1.5',
    'Kling',
    '渠道二 标准',
    '渠道二 高质量',
    '渠道四 Gemini',
    '渠道四 Grok',
    '渠道四 Grok 1.5',
    '渠道六 Seedance 2.0',
    '渠道六 Seedance 1.5',
    '渠道六 Seedance Lite',
    '渠道九 Seedance 2.0 Mini',
    '渠道九 Kling 3.0',
  ]);
  const getModelMediaType = (modelName) => IMAGE_MODEL_NAMES.has(modelName) ? 'image' : 'video';
  const getModelLabel = (modelName) => getModelMediaType(modelName) === 'image' ? '图片' : '视频';
  const getRowModelName = (row) => {
    const currentModel = row?.model || globalModel;
    const rowType = row?.type || getModelMediaType(currentModel);
    if (rowType === 'image' && !IMAGE_MODEL_NAMES.has(currentModel)) return generateChannel === 'chatgpt2api' ? '渠道五 GPT-Image2' : generateChannel === 'lovart' ? '渠道七 Lovart' : '渠道四 GPT-Image2';
    if (rowType === 'video' && IMAGE_MODEL_NAMES.has(currentModel)) return generateChannel === 'oiioii' ? '渠道四 Gemini' : generateChannel === 'dola' ? '渠道六 Seedance 2.0' : generateChannel === 'framia' ? '渠道九 Seedance 2.0 Mini' : generateChannel === 'tensorart' ? '渠道十 Tensor.Art 视频' : 'Seedance 2.0';
    return currentModel;
  };
  const getRowMediaLabel = (row) => {
    const resolvedType = row?.type || row?.currentMaterialImage?.mediaType || row?.currentMaterialVideo?.mediaType || (row?.currentMaterialImage ? 'image' : row?.currentMaterialVideo ? 'video' : getModelMediaType(row?.model || globalModel));
    return resolvedType === 'image' ? '图片' : '视频';
  };
  const BASIC_ASPECT_RATIOS = ['16:9', '9:16', '1:1'];
  const EXTENDED_IMAGE_ASPECT_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4'];
  const CHATGPT2API_IMAGE_ASPECT_RATIOS = ['3:2', '2:3', '1:1'];
  // Dola 网页端 Seedance 2.0 实际支持 6 种比例（1:1/3:4/4:3/9:16/16:9/21:9），
  // 与 Seedance 2.0 官方 API 一致，不存在"4:3 被静默改成 16:9"的情况。
  const DOLA_VIDEO_ASPECT_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'];
  const getSupportedAspectRatios = ({ channel = generateChannel, modelName = globalModel, mediaType = getModelMediaType(modelName) } = {}) => {
    if (channel === 'oreateai') {
      const capability = getOreateaiCapability(modelName, oreateaiScene);
      return capability?.ratios?.length ? capability.ratios : BASIC_ASPECT_RATIOS;
    }
    if (channel === 'chatgpt2api' || modelName === '渠道五 GPT-Image2') return CHATGPT2API_IMAGE_ASPECT_RATIOS;
    if (channel === 'dola' && mediaType === 'video') return DOLA_VIDEO_ASPECT_RATIOS;
    if (mediaType === 'image') return EXTENDED_IMAGE_ASPECT_RATIOS;
    return BASIC_ASPECT_RATIOS;
  };
  const normalizeAspectRatio = (value, context = {}) => {
    const supported = getSupportedAspectRatios(context);
    if (supported.includes(value)) return value;
    const fallbackByOrientation = {
      landscape: ['16:9', '3:2', '4:3'],
      portrait: ['9:16', '2:3', '3:4'],
      square: ['1:1'],
    };
    const ratioGroup = ['9:16', '2:3', '3:4'].includes(value)
      ? fallbackByOrientation.portrait
      : value === '1:1'
        ? fallbackByOrientation.square
        : fallbackByOrientation.landscape;
    return ratioGroup.find(r => supported.includes(r)) || supported[0];
  };
  const [activePopover, setActivePopover] = useState(null); // 'model' | 'params' | 'suffix' | 'prefix' | null
  const [userPromptSuffixTemplates, setUserPromptSuffixTemplates] = useState(() => {
    try {
      const raw = localStorage.getItem(PROMPT_SUFFIX_TEMPLATES_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter(t => t?.name && t?.suffix) : [];
    } catch {
      return [];
    }
  });
  const promptSuffixTemplates = [...DEFAULT_PROMPT_SUFFIX_TEMPLATES, ...userPromptSuffixTemplates];
  const [selectedPromptSuffixId, setSelectedPromptSuffixId] = useState(() => localStorage.getItem('maocanju_prompt_suffix_id') || 'none');
  const [isAddingPromptSuffix, setIsAddingPromptSuffix] = useState(false);
  const [editingPromptSuffixId, setEditingPromptSuffixId] = useState(null);
  const [expandedPromptSuffixId, setExpandedPromptSuffixId] = useState(null);
  const [newPromptSuffixName, setNewPromptSuffixName] = useState('');
  const [newPromptSuffixValue, setNewPromptSuffixValue] = useState('');
  const selectedPromptSuffix = promptSuffixTemplates.find(t => t.id === selectedPromptSuffixId) || DEFAULT_PROMPT_SUFFIX_TEMPLATES[0];
  const saveUserPromptSuffixTemplates = (templates) => {
    setUserPromptSuffixTemplates(templates);
    try { localStorage.setItem(PROMPT_SUFFIX_TEMPLATES_KEY, JSON.stringify(templates)); } catch (e) { console.warn('Failed to save suffix templates:', e); }
  };
  const isSuffixTemplatesMountedRef = useRef(false);
  useEffect(() => {
    try { localStorage.setItem('maocanju_prompt_suffix_id', selectedPromptSuffixId); } catch (e) { console.warn('Failed to save suffix id:', e); }
  }, [selectedPromptSuffixId]);
  useEffect(() => {
    if (!isSuffixTemplatesMountedRef.current) {
      isSuffixTemplatesMountedRef.current = true;
      return;
    }
    try { localStorage.setItem(PROMPT_SUFFIX_TEMPLATES_KEY, JSON.stringify(userPromptSuffixTemplates)); } catch (e) { console.warn('Failed to save suffix templates:', e); }
  }, [userPromptSuffixTemplates]);
  const resetPromptSuffixForm = () => {
    setIsAddingPromptSuffix(false);
    setEditingPromptSuffixId(null);
    setNewPromptSuffixName('');
    setNewPromptSuffixValue('');
  };
  const startAddingPromptSuffixTemplate = () => {
    setEditingPromptSuffixId(null);
    setNewPromptSuffixName('');
    setNewPromptSuffixValue('');
    setIsAddingPromptSuffix(true);
  };
  const startEditingPromptSuffixTemplate = (template) => {
    if (!template || template.id === 'none') return;
    setEditingPromptSuffixId(template.id);
    setNewPromptSuffixName(template.name || '');
    setNewPromptSuffixValue(template.suffix || '');
    setIsAddingPromptSuffix(true);
  };
  const savePromptSuffixTemplateForm = () => {
    const cleanName = newPromptSuffixName.trim();
    const cleanSuffix = newPromptSuffixValue.trim();
    if (!cleanName || !cleanSuffix) {
      alert('请填写模板名称和后缀内容。');
      return;
    }

    if (editingPromptSuffixId) {
      const exists = userPromptSuffixTemplates.some(t => t.id === editingPromptSuffixId);
      if (!exists) {
        alert('没有找到要修改的后缀模板，请重新选择。');
        resetPromptSuffixForm();
        return;
      }
      const nextTemplates = userPromptSuffixTemplates.map(t => (
        t.id === editingPromptSuffixId ? { ...t, name: cleanName, suffix: cleanSuffix } : t
      ));
      saveUserPromptSuffixTemplates(nextTemplates);
      setSelectedPromptSuffixId(editingPromptSuffixId);
      localStorage.setItem('maocanju_prompt_suffix_id', editingPromptSuffixId);
      resetPromptSuffixForm();
      return;
    }

    const nextTemplate = {
      id: `user-${Date.now()}`,
      name: cleanName,
      suffix: cleanSuffix,
    };
    const nextTemplates = [...userPromptSuffixTemplates, nextTemplate];
    saveUserPromptSuffixTemplates(nextTemplates);
    setSelectedPromptSuffixId(nextTemplate.id);
    localStorage.setItem('maocanju_prompt_suffix_id', nextTemplate.id);
    resetPromptSuffixForm();
  };
  const deletePromptSuffixTemplate = (templateId) => {
    const target = userPromptSuffixTemplates.find(t => t.id === templateId);
    if (!target) return;
    if (!confirm(`确定删除后缀模板「${target.name}」吗？`)) return;
    const nextTemplates = userPromptSuffixTemplates.filter(t => t.id !== templateId);
    saveUserPromptSuffixTemplates(nextTemplates);
    if (selectedPromptSuffixId === templateId) {
      setSelectedPromptSuffixId('none');
      localStorage.setItem('maocanju_prompt_suffix_id', 'none');
    }
    if (editingPromptSuffixId === templateId) {
      resetPromptSuffixForm();
    }
  };

  // ---- 提示词前缀模板（与后缀对称）----
  const [userPromptPrefixTemplates, setUserPromptPrefixTemplates] = useState(() => {
    try {
      const raw = localStorage.getItem(PROMPT_PREFIX_TEMPLATES_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter(t => t?.name && t?.prefix) : [];
    } catch {
      return [];
    }
  });
  const promptPrefixTemplates = [...DEFAULT_PROMPT_PREFIX_TEMPLATES, ...userPromptPrefixTemplates];
  const [selectedPromptPrefixId, setSelectedPromptPrefixId] = useState(() => localStorage.getItem('maocanju_prompt_prefix_id') || 'none');
  const [isAddingPromptPrefix, setIsAddingPromptPrefix] = useState(false);
  const [editingPromptPrefixId, setEditingPromptPrefixId] = useState(null);
  const [expandedPromptPrefixId, setExpandedPromptPrefixId] = useState(null);
  const [newPromptPrefixName, setNewPromptPrefixName] = useState('');
  const [newPromptPrefixValue, setNewPromptPrefixValue] = useState('');
  const selectedPromptPrefix = promptPrefixTemplates.find(t => t.id === selectedPromptPrefixId) || DEFAULT_PROMPT_PREFIX_TEMPLATES[0];
  const saveUserPromptPrefixTemplates = (templates) => {
    setUserPromptPrefixTemplates(templates);
    try { localStorage.setItem(PROMPT_PREFIX_TEMPLATES_KEY, JSON.stringify(templates)); } catch (e) { console.warn('Failed to save prefix templates:', e); }
  };
  const isPrefixTemplatesMountedRef = useRef(false);
  useEffect(() => {
    try { localStorage.setItem('maocanju_prompt_prefix_id', selectedPromptPrefixId); } catch (e) { console.warn('Failed to save prefix id:', e); }
  }, [selectedPromptPrefixId]);
  useEffect(() => {
    if (!isPrefixTemplatesMountedRef.current) {
      isPrefixTemplatesMountedRef.current = true;
      return;
    }
    try { localStorage.setItem(PROMPT_PREFIX_TEMPLATES_KEY, JSON.stringify(userPromptPrefixTemplates)); } catch (e) { console.warn('Failed to save prefix templates:', e); }
  }, [userPromptPrefixTemplates]);
  const resetPromptPrefixForm = () => {
    setIsAddingPromptPrefix(false);
    setEditingPromptPrefixId(null);
    setNewPromptPrefixName('');
    setNewPromptPrefixValue('');
  };
  const startAddingPromptPrefixTemplate = () => {
    setEditingPromptPrefixId(null);
    setNewPromptPrefixName('');
    setNewPromptPrefixValue('');
    setIsAddingPromptPrefix(true);
  };
  const startEditingPromptPrefixTemplate = (template) => {
    if (!template || template.id === 'none') return;
    setEditingPromptPrefixId(template.id);
    setNewPromptPrefixName(template.name || '');
    setNewPromptPrefixValue(template.prefix || '');
    setIsAddingPromptPrefix(true);
  };
  const savePromptPrefixTemplateForm = () => {
    const cleanName = newPromptPrefixName.trim();
    const cleanPrefix = newPromptPrefixValue.trim();
    if (!cleanName || !cleanPrefix) {
      alert('请填写模板名称和前缀内容。');
      return;
    }

    if (editingPromptPrefixId) {
      const exists = userPromptPrefixTemplates.some(t => t.id === editingPromptPrefixId);
      if (!exists) {
        alert('没有找到要修改的前缀模板，请重新选择。');
        resetPromptPrefixForm();
        return;
      }
      const nextTemplates = userPromptPrefixTemplates.map(t => (
        t.id === editingPromptPrefixId ? { ...t, name: cleanName, prefix: cleanPrefix } : t
      ));
      saveUserPromptPrefixTemplates(nextTemplates);
      setSelectedPromptPrefixId(editingPromptPrefixId);
      localStorage.setItem('maocanju_prompt_prefix_id', editingPromptPrefixId);
      resetPromptPrefixForm();
      return;
    }

    const nextTemplate = {
      id: `user-prefix-${Date.now()}`,
      name: cleanName,
      prefix: cleanPrefix,
    };
    const nextTemplates = [...userPromptPrefixTemplates, nextTemplate];
    saveUserPromptPrefixTemplates(nextTemplates);
    setSelectedPromptPrefixId(nextTemplate.id);
    localStorage.setItem('maocanju_prompt_prefix_id', nextTemplate.id);
    resetPromptPrefixForm();
  };
  const deletePromptPrefixTemplate = (templateId) => {
    const target = userPromptPrefixTemplates.find(t => t.id === templateId);
    if (!target) return;
    if (!confirm(`确定删除前缀模板「${target.name}」吗？`)) return;
    const nextTemplates = userPromptPrefixTemplates.filter(t => t.id !== templateId);
    saveUserPromptPrefixTemplates(nextTemplates);
    if (selectedPromptPrefixId === templateId) {
      setSelectedPromptPrefixId('none');
      localStorage.setItem('maocanju_prompt_prefix_id', 'none');
    }
    if (editingPromptPrefixId === templateId) {
      resetPromptPrefixForm();
    }
  };
  const parseDurationSeconds = (durationValue, fallback = 5) => {
    const match = String(durationValue || '').match(/\d+(?:\.\d+)?/);
    if (!match) return fallback;
    const seconds = Number.parseFloat(match[0]);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : fallback;
  };

  const formatDurationLabel = (seconds) => {
    if (!Number.isFinite(seconds) || seconds <= 0) return '';
    return `${Number.isInteger(seconds) ? seconds : Number(seconds.toFixed(2))}秒`;
  };

  const resolveDurationSeconds = (rowDuration, fallbackDuration, fallback = 5) => (
    parseDurationSeconds(rowDuration, parseDurationSeconds(fallbackDuration, fallback))
  );

  const buildPromptWithAffixes = (text = '') => {
    const base = String(text || '').trim();
    const prefix = (selectedPromptPrefix.prefix || '').trim();
    const suffix = (selectedPromptSuffix.suffix || '').trim();
    let result = base;
    if (prefix && !result.startsWith(prefix)) {
      result = result ? `${prefix}，${result}` : prefix;
    }
    if (suffix && !result.endsWith(suffix) && !result.includes(suffix)) {
      result = result ? `${result}，${suffix}` : suffix;
    }
    return result;
  };
  const buildPromptWithSuffix = buildPromptWithAffixes;
  const [modelPopoverTab, setModelPopoverTab] = useState(() => getModelMediaType(readGlobalGenerationSetting('model')));
  const [editingRowId, setEditingRowId] = useState(null); // row.id of the row currently being edited as plain text
  const promptDraftsRef = useRef({});
  const promptTextareaRefs = useRef({});
  const wizstarAccountCursorRef = useRef(0);
  const resizePromptTextarea = (textarea) => {
    if (!textarea) return;
    const maxHeight = 260;
    textarea.style.height = 'auto';
    const nextHeight = Math.min(maxHeight, Math.max(72, textarea.scrollHeight));
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
  };
  const resizePromptTextareaById = (rowId) => {
    requestAnimationFrame(() => resizePromptTextarea(promptTextareaRefs.current[rowId]));
  };
  const [fullscreenVideo, setFullscreenVideo] = useState(null); // { src, mediaType } for fullscreen preview
  const [fullscreenLoading, setFullscreenLoading] = useState(false);
  const [imageEditorEnabled, setImageEditorEnabled] = useState(false);
  const [imageEditorSaving, setImageEditorSaving] = useState(false);
  const [imageEditorColor, setImageEditorColor] = useState('#ff2f2f');
  const [imageEditorLineWidth, setImageEditorLineWidth] = useState(3);
  const [imageEditorShowGrid, setImageEditorShowGrid] = useState(false);
  const [imageEditorGridSize, setImageEditorGridSize] = useState(3);
  const imageEditorCanvasRef = useRef(null);
  const imageEditorImageRef = useRef(null);
  const imageEditorDrawingRef = useRef(false);
  const imageEditorLastPointRef = useRef(null);
  const imageEditorHistoryRef = useRef([]);
  const [batchTab, setBatchTab] = useState('import'); // 'import' | 'process' | 'tasks'
  const [conversionFormat, setConversionFormat] = useState('WebP');
  const [conversionResolution, setConversionResolution] = useState('2K');
  const [activeAssetSubTab, setActiveAssetSubTab] = useState('character'); // 'character' | 'scene' | 'item'
  const [showBatchPromptModal, setShowBatchPromptModal] = useState(false);
  const [batchStarting, setBatchStarting] = useState(false);
  const [batchPromptText, setBatchPromptText] = useState('');
  const [batchPromptMode, setBatchPromptMode] = useState('append'); // 'append' | 'replace'
  const draftId = activeDraft?.id || 'default';
  const STORAGE_KEY_SEGMENTS = `maocanju_segments_${draftId}`;
  const STORAGE_KEY_CHARS = `maocanju_chars_${draftId}`;
  const STORAGE_KEY_SCENES = `maocanju_scenes_${draftId}`;
  const STORAGE_KEY_ITEMS = `maocanju_items_${draftId}`;
  const isLoadingProjectRef = useRef(false);
  const asArray = (value) => (Array.isArray(value) ? value : []);
  const parseArrayFromStorage = (key) => {
    try {
      return asArray(JSON.parse(localStorage.getItem(key) || '[]'));
    } catch {
      return [];
    }
  };

  const [characterAssets, setCharacterAssets] = useState([]);
  const [sceneAssets, setSceneAssets] = useState(() => parseArrayFromStorage(STORAGE_KEY_SCENES));
  const [itemAssets, setItemAssets] = useState(() => parseArrayFromStorage(STORAGE_KEY_ITEMS));

  const stripLargePreviewPayload = (value) => {
    if (Array.isArray(value)) return value.map(stripLargePreviewPayload);
    if (!value || typeof value !== 'object') return value;
    const next = { ...value };
    for (const key of ['dataUrl', 'base64', 'imageData', 'videoData']) {
      if (typeof next[key] === 'string' && next[key].startsWith('data:')) next[key] = '';
    }
    for (const key of ['thumbnail', 'displayUrl', 'url', 'src', 'sourceUrl', 'remoteUrl']) {
      if (typeof next[key] === 'string' && next[key].startsWith('data:')) next[key] = '';
    }
    for (const [key, child] of Object.entries(next)) {
      if (child && typeof child === 'object') next[key] = stripLargePreviewPayload(child);
    }
    return next;
  };

  const setLocalStorageJson = (key, value, fallbackValue = null) => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (error) {
      if (fallbackValue === null) {
        console.warn(`Failed to save ${key}:`, error);
        return false;
      }
      try {
        localStorage.setItem(key, JSON.stringify(fallbackValue));
        return true;
      } catch (fallbackError) {
        console.warn(`Failed to save ${key}:`, fallbackError);
        return false;
      }
    }
  };


  // 三种触发符 → 对应资产类型的元数据，统一驱动下拉与插入
  const TRIGGERS = {
    '@': { type: 'character', label: '角色' },
    '$': { type: 'scene', label: '场景' },
    '#': { type: 'item', label: '物品' },
  };

  // Autocomplete state when typing @ / $ / # to choose assets
  const [atState, setAtState] = useState({
    rowId: null,
    isOpen: false,
    trigger: '@',
    query: '',
    cursorPos: 0,
  });
  const [hoveredCharId, setHoveredCharId] = useState(null);
  const lastPersistKeyRef = useRef('');

  const isVideoUrl = isPlayableVideoUrlValue;
  const isLocalFilePath = isLocalFilePathValue;
  const localFilePathFromUrl = localFilePathFromUrlValue;
  const makeLocalFileUrl = (filePath = '') => {
    const normalized = String(filePath || '').replace(/\\/g, '/');
    if (!normalized) return '';
    if (/^[a-zA-Z]:\//.test(normalized)) return `file:///${normalized}`;
    return `file://${normalized.startsWith('/') ? '' : '/'}${normalized}`;
  };
  const toLocalVideoUrl = toLocalVideoUrlValue;
  const toLocalImageUrl = toLocalImageUrlValue;
  const toPlayableUrl = toPlayableVideoUrlValue;
  const toDisplayImageUrl = (value = '', fallbackPath = '') => {
    const raw = String(value || '').trim();
    if (/^(data:image\/|blob:|https?:\/\/)/i.test(raw)) return raw;
    if (raw.startsWith('/local/image')) return `${WIZSTAR_API}${raw}`;
    const localPath = localFilePathFromUrl(raw) || localFilePathFromUrl(fallbackPath);
    if (localPath) return toLocalImageUrl(localPath);
    return raw || String(fallbackPath || '').trim();
  };
  const displayAvatarUrlForAsset = (asset = {}) => toDisplayImageUrl(
    asset?.avatar || '',
    asset?.avatarPath || asset?.localPath || ''
  );
  const originalLocalVideoPathFromPlayable = (filePath = '') => {
    const raw = String(filePath || '').trim();
    if (!/\.playable\.[^.]+$/i.test(raw)) return '';
    return raw.replace(/\.playable(\.[^.]+)$/i, '$1');
  };
  const playableFallbackUrlForMaterial = (material = {}) => {
    const fallbackPath = material.localPath || '';
    if (fallbackPath && /\.playable\.[^.]+$/i.test(fallbackPath)) return toLocalVideoUrl(fallbackPath);
    return '';
  };
  const playableUrlForMaterial = (material = {}) => {
    if (material.localPath) {
      const originalPath = originalLocalVideoPathFromPlayable(material.localPath);
      return toLocalVideoUrl(originalPath || material.localPath);
    }
    return toPlayableUrl(material.sourceUrl || material.remoteUrl || material.thumbnail || '');
  };
  const switchVideoToFallback = (event, fallbackUrl = '', shouldPlay = false) => {
    const video = event?.currentTarget;
    if (!video || !fallbackUrl) return false;
    const currentSrc = video.currentSrc || video.src || '';
    if (currentSrc === fallbackUrl) return false;
    video.src = fallbackUrl;
    video.load();
    if (shouldPlay) video.play().catch(() => {});
    return true;
  };
  const toDownloadUrl = (url = '', filename = 'video.mp4') =>
    `${WIZSTAR_API}/download/video?url=${encodeURIComponent(url)}&filename=${encodeURIComponent(filename)}`;
  const getFileStem = (filePath = '') => {
    const fileName = String(filePath).split(/[\\/]/).pop() || '';
    return fileName.replace(/\.[^.]+$/, '').trim();
  };
  const cleanAssetName = (name = '', triggerSymbol = '') => {
    const triggerPattern = triggerSymbol ? `\\${triggerSymbol}` : '@#$';
    return String(name || '')
      .trim()
      .replace(new RegExp(`^\\s*\\d+[\\s._-]*(?:[${triggerPattern}][\\s._-]*)?`), '')
      .replace(new RegExp(`^\\s*[${triggerPattern}][\\s._-]*`), '')
      .trim();
  };
  const normalizeAssetNames = (assets = [], triggerSymbol = '') => {
    let changed = false;
    const normalized = assets.map((asset) => {
      const cleanName = cleanAssetName(asset?.name, triggerSymbol);
      if (!cleanName || cleanName === asset?.name) return asset;
      changed = true;
      return { ...asset, name: cleanName };
    });
    return changed ? normalized : assets;
  };
  const isImageFilePath = (filePath = '') => /\.(jpg|jpeg|png|webp|bmp|gif)$/i.test(filePath);
  const sortFilePathsByName = (filePaths = []) => [...filePaths].sort((a, b) => {
    const nameA = String(a).split(/[\\/]/).pop().toLowerCase();
    const nameB = String(b).split(/[\\/]/).pop().toLowerCase();
    return nameA.localeCompare(nameB, undefined, { numeric: true });
  });
  const selectLocalImageFiles = async () => {
    if (window.electronAPI && window.electronAPI.selectFiles) {
      return await window.electronAPI.selectFiles([
        { name: '图片文件', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif'] }
      ]);
    }
    alert('当前环境不支持文件选择，请在桌面客户端中使用此功能。');
    return [];
  };
  const persistLocalImagePath = async (filePath) => {
    const value = String(filePath || '').trim();
    if (!value) return { ok: false, error: '参考图路径为空' };
    if (window.electronAPI?.persistLocalImage) {
      return await window.electronAPI.persistLocalImage(value);
    }
    return { ok: true, path: value };
  };
  const selectLocalImageDirectory = async () => {
    if (window.electronAPI && window.electronAPI.selectImageDirectory) {
      return await window.electronAPI.selectImageDirectory();
    }
    alert('当前环境不支持文件夹选择，请在桌面客户端中使用此功能。');
    return { canceled: true, filePaths: [] };
  };
  const getReferenceDisplayUrl = (seg) => {
    if (seg?.referenceImage && typeof seg.referenceImage === 'object') {
      if (seg.referenceImage.source === 'role') return '';
      return seg.referenceImage.displayUrl || seg.referenceImage.dataUrl || seg.referenceImage.remoteUrl || seg.referenceImage.uploadUrl || '';
    }
    return seg?.referenceImage || '';
  };
  const getReferenceLocalPath = (seg) => {
    if (seg?.referenceImage && typeof seg.referenceImage === 'object') {
      if (seg.referenceImage.source === 'role') return '';
      return seg.referenceImage.localPath || '';
    }
    return seg?.referenceImagePath || '';
  };
  const getReferenceDataUrl = (seg) => {
    if (seg?.referenceImage && typeof seg.referenceImage === 'object') {
      if (seg.referenceImage.source === 'role') return '';
      return seg.referenceImage.dataUrl || '';
    }
    const legacyRef = seg?.referenceImage || '';
    return typeof legacyRef === 'string' && /^data:image\//i.test(legacyRef) ? legacyRef : '';
  };
  const getReferenceRemoteUrl = (seg) => {
    if (seg?.referenceImage && typeof seg.referenceImage === 'object') {
      if (seg.referenceImage.source === 'role') return '';
      return seg.referenceImage.uploadUrl || seg.referenceImage.remoteUrl || '';
    }
    const legacyRef = seg?.referenceImage || '';
    return typeof legacyRef === 'string' && /^https?:\/\//i.test(legacyRef) ? legacyRef : '';
  };
  const makeLocalReferenceImage = (filePath, fallbackUrl = '') => ({
    source: filePath ? 'local' : 'blob',
    displayUrl: filePath ? makeLocalFileUrl(filePath) : fallbackUrl,
    localPath: filePath || '',
    dataUrl: /^data:image\//i.test(fallbackUrl || '') ? fallbackUrl : '',
    remoteUrl: '',
    uploadUrl: '',
  });
  const makeDataUrlReferenceImage = (dataUrl) => ({
    source: 'clipboard',
    displayUrl: dataUrl,
    localPath: '',
    dataUrl,
    remoteUrl: '',
    uploadUrl: '',
  });
  const makeRemoteReferenceImage = (url) => ({
    source: 'remote',
    displayUrl: url,
    localPath: '',
    dataUrl: '',
    remoteUrl: url,
    uploadUrl: url,
  });
  const createEmptyMaterial = (mediaType = 'image') => ({
    id: 0,
    name: '暂无画面',
    thumbnail: '',
    sourceUrl: '',
    remoteUrl: '',
    mediaType,
    isPlaying: false,
    fps: mediaType === 'video' ? 25 : null,
    duration: mediaType === 'video' ? '00:05' : '静态图片',
  });
  const createSegmentRow = (id, text = '') => ({
    id,
    text,
    type: getModelMediaType(globalModel),
    model: globalModel,
    channel: 'API',
    aspectRatio: globalAspectRatio,
    duration: globalDuration,
    resolution: globalResolution,
    isLocked: false,
    associatedCharacters: [],
    referenceImage: '',
    referenceImagePath: '',
    oreateaiAssets: [],
    materialsVideo: [],
    materialsImage: [],
    currentMaterialVideo: createEmptyMaterial('video'),
    currentMaterialImage: createEmptyMaterial('image'),
    generating: false,
    generateStatus: null,
    generateProgress: null,
    queuePosition: null,
    elapsedSeconds: null,
    remainingSeconds: null,
    timeoutSeconds: null,
    estimatedWaitSeconds: null,
    generationError: '',
    pendingTaskId: null,
    pendingTaskIds: [],
    pendingPrimaryTaskId: '',
    pendingChannel: null,
    activeTaskCount: 0,
  });
  const normalizeSegmentRecord = (seg = {}) => {
    if (!seg || typeof seg !== 'object' || Array.isArray(seg)) {
      return createSegmentRow(String(seg || Date.now()), '');
    }
    const displayUrl = getReferenceDisplayUrl(seg);
    const localPath = getReferenceLocalPath(seg);
    const dataUrl = getReferenceDataUrl(seg);
    const remoteUrl = getReferenceRemoteUrl(seg);
    const normalizeMediaList = (items = [], fallbackType = 'image') => asArray(items).map((m) => {
      if (m && typeof m === 'object') {
        const mediaType = m.mediaType || (isVideoUrl(m.thumbnail) ? 'video' : fallbackType);
        let thumb = m.thumbnail || '';
        // Fix old image thumbnails that incorrectly use /local/video endpoint
        if (thumb && mediaType === 'image' && thumb.includes('/local/video?path=')) {
          thumb = thumb.replace('/local/video?path=', '/local/image?path=');
        }
        let srcUrl = m.sourceUrl || '';
        if (srcUrl && mediaType === 'image' && srcUrl.includes('/local/video?path=')) {
          srcUrl = srcUrl.replace('/local/video?path=', '/local/image?path=');
        }
        return { ...m, mediaType, thumbnail: thumb, sourceUrl: srcUrl };
      }
      const textValue = String(m || '').trim();
      return {
        id: textValue || `${fallbackType}-${Date.now()}`,
        name: textValue,
        thumbnail: '',
        sourceUrl: '',
        remoteUrl: '',
        mediaType: fallbackType,
      };
    });

    return {
      ...seg,
      associatedCharacters: asArray(seg.associatedCharacters).map((char) => (
        char && typeof char === 'object'
          ? { ...char, sendImage: char.sendImage !== false }
          : { name: String(char || ''), role: '', avatar: '', avatarPath: '', sendImage: true }
      )),
      referenceImage: seg.referenceImage && typeof seg.referenceImage === 'object'
        ? seg.referenceImage
        : (localPath ? makeLocalReferenceImage(localPath) : (dataUrl ? makeDataUrlReferenceImage(dataUrl) : (remoteUrl ? makeRemoteReferenceImage(remoteUrl) : displayUrl))),
      referenceImagePath: localPath,
      oreateaiAssets: asArray(seg.oreateaiAssets).filter((asset) => (
        asset && typeof asset === 'object' && typeof asset.path === 'string' && (asset.kind === 'image' || asset.kind === 'video')
      )).map((asset) => ({
        path: asset.path,
        name: String(asset.name || asset.path.split(/[\\/]/).pop() || '素材'),
        kind: asset.kind,
        size: Number(asset.size || 0),
        durationSec: Number(asset.durationSec || 0),
      })),
      materialsVideo: normalizeMediaList(seg.materialsVideo, 'video'),
      materialsImage: normalizeMediaList(seg.materialsImage, 'image'),
      currentMaterialVideo: seg.currentMaterialVideo && typeof seg.currentMaterialVideo === 'object'
        ? { ...seg.currentMaterialVideo, mediaType: seg.currentMaterialVideo.mediaType || (isVideoUrl(seg.currentMaterialVideo.thumbnail) ? 'video' : 'image') }
        : seg.currentMaterialVideo,
      currentMaterialImage: seg.currentMaterialImage && typeof seg.currentMaterialImage === 'object'
        ? (() => {
            const m = seg.currentMaterialImage;
            const mediaType = m.mediaType || (isVideoUrl(m.thumbnail) ? 'video' : 'image');
            let thumb = m.thumbnail || '';
            if (thumb && mediaType === 'image' && thumb.includes('/local/video?path=')) {
              thumb = thumb.replace('/local/video?path=', '/local/image?path=');
            }
            return { ...m, mediaType, thumbnail: thumb };
          })()
        : seg.currentMaterialImage,
    };
  };
  // Character Asset Sub-Window Manager States
  const [showCharacterModal, setShowCharacterModal] = useState(false);
  const [editingCharId, setEditingCharId] = useState(null);
  const [newCharName, setNewCharName] = useState('');
  const [newCharRole, setNewCharRole] = useState('');
  const [newCharAvatar, setNewCharAvatar] = useState('');
  const [newCharAvatarPath, setNewCharAvatarPath] = useState('');
  const [newCharAvatarOriginal, setNewCharAvatarOriginal] = useState('');
  const [charGridOverlay, setCharGridOverlay] = useState(false);
  // Scene/Item Asset Sub-Window Manager States (shared, type determined by editingAssetType)
  const [showAssetModal, setShowAssetModal] = useState(false);
  const [editingAssetType, setEditingAssetType] = useState('scene');
  const [editingAssetId, setEditingAssetId] = useState(null);
  const [newAssetName, setNewAssetName] = useState('');
  const [newAssetAvatar, setNewAssetAvatar] = useState('');
  const [newAssetAvatarPath, setNewAssetAvatarPath] = useState('');
  // 角色一键打码进度：running 进行中，current/total 用于显示 x/y
  const [censorProgress, setCensorProgress] = useState({ running: false, current: 0, total: 0 });
  // 手动打码弹窗
  const [manualCensorOpen, setManualCensorOpen] = useState(false);
  // 网格遮罩弹窗
  const [gridMaskOpen, setGridMaskOpen] = useState(false);

  const [mergeModalState, setMergeModalState] = useState({ open: false, rowId: null, items: [] });
  const [mergeAllProgress, setMergeAllProgress] = useState({ running: false, current: 0, total: 0 });

  const makeCharacterAsset = () => ({
    id: editingCharId === 'new' ? `c-${Date.now()}` : editingCharId,
    name: newCharName.trim(),
    avatar: newCharAvatar,
    avatarPath: newCharAvatarPath,
    avatarOriginal: newCharAvatarOriginal,
    role: newCharRole,
  });

  const getAssetImageRef = (asset) => {
    const avatar = asset?.avatar || '';
    const avatarPath = asset?.avatarPath || asset?.localPath || '';
    if (avatarPath) return { file_path: avatarPath };
    if (/^data:image\//i.test(avatar)) return { data_url: avatar };
    if (/^https?:\/\//i.test(avatar)) return { image: avatar };
    if (/^file:\/\//i.test(avatar)) return { file_path: avatar.replace(/^file:\/\/+/, '/') };
    return null;
  };

  const getCharacterImageRef = (char) => getAssetImageRef(char);

  const parseReferencedCharacterNames = (text = '') => {
    if (!text) return [];
    const names = [];
    const seen = new Set();
    const pushName = (value) => {
      const name = cleanAssetName(value, '@');
      if (!name || seen.has(name)) return;
      seen.add(name);
      names.push(name);
    };

    // Support both inserted tokens like （@小明） and plain text like @小明 from imported docs.
    const tokenRegex = /[（(]@([^）)\n\r]+)[）)]|(^|[\s，。；、,.!?！？：:])@([A-Za-z0-9_\-\u4e00-\u9fa5]+)/gm;
    let match;
    while ((match = tokenRegex.exec(text)) !== null) {
      pushName(match[1] || match[3]);
    }
    return names;
  };

  const parseReferencedSceneNames = (text = '') => {
    if (!text) return [];
    const names = [];
    const seen = new Set();
    const pushName = (value) => {
      const name = cleanAssetName(value, '$');
      if (!name || seen.has(name)) return;
      seen.add(name);
      names.push(name);
    };

    const tokenRegex = /[（(]\$([^）)\n\r]+)[）)]|(^|[\s，。；、,.!?！？：:])\$([A-Za-z0-9_\-\u4e00-\u9fa5]+)/gm;
    let match;
    while ((match = tokenRegex.exec(text)) !== null) {
      pushName(match[1] || match[3]);
    }
    return names;
  };

  const convertSceneMentionsForOiiOii = (text = '') => String(text || '')
    .replace(/[（(]\$([^）)]+)[）)]/g, '（@$1）')
    .replace(/(^|[\s，。；、,.!?！？：:])\$([A-Za-z0-9_\-\u4e00-\u9fa5]+)/gm, '$1@$2');

  const parseCharacterProfileName = (text = '') => {
    const lines = String(text || '')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);
    if (lines.length < 2) return '';

    const hasProfileField = lines.slice(1, 6).some(line => /^(性别|年龄|身份|职业|角色|姓名)\s*[：:]/.test(line));
    if (!hasProfileField) return '';

    return cleanAssetName(lines[0].replace(/^[#*\-\d.、\s]+/, ''), '@');
  };

  const makeExportBaseName = (row, fallbackIndex, isVideo = false) => {
    const sequenceName = String(fallbackIndex || row.id || 1);
    if (isVideo) return sequenceName;

    const promptText = buildPromptWithSuffix(promptDraftsRef.current[row.id] ?? row.text ?? '');
    const profileName = parseCharacterProfileName(promptText);
    if (profileName) return profileName;

    const characterNames = parseReferencedCharacterNames(promptText);
    const associatedNames = Array.isArray(row.associatedCharacters)
      ? row.associatedCharacters.map(char => cleanAssetName(char?.name, '@')).filter(Boolean)
      : [];
    const sceneNames = parseReferencedSceneNames(promptText);
    const nameParts = [...new Set([...characterNames, ...associatedNames, ...sceneNames])];

    return nameParts.length > 0 ? `${sequenceName}.${nameParts.join('.')}` : sequenceName;
  };

  const getSegmentCharacterImageBindings = (seg, promptText = '') => {
    const textNames = parseReferencedCharacterNames(promptText || seg?.text || '');
    const associatedChars = Array.isArray(seg?.associatedCharacters) ? seg.associatedCharacters : [];
    const associatedByName = new Map(
      associatedChars
        .map(char => [cleanAssetName(char?.name, '@'), char])
        .filter(([name]) => name)
    );
    const assetByName = new Map(
      (characterAssets || [])
        .map(char => [cleanAssetName(char?.name, '@'), char])
        .filter(([name]) => name)
    );

    return textNames.map((name) => {
      const association = associatedByName.get(name);
      if (association?.sendImage === false) return null;
      const char = assetByName.get(name);
      if (!char) return null;
      const ref = getCharacterImageRef(char);
      if (!ref) return null;
      return { ref, alias: name };
    }).filter(Boolean);
  };

  const getSegmentCharacterImageRefs = (seg, promptText = '') =>
    getSegmentCharacterImageBindings(seg, promptText).map(item => item.ref);

  const getSegmentCharacterAliases = (seg, promptText = '') =>
    getSegmentCharacterImageBindings(seg, promptText).map(item => item.alias).filter(Boolean);

  const getReferencedCharacterDisplayItems = (seg, promptText = '') => {
    const associatedByName = new Map(
      asArray(seg?.associatedCharacters)
        .map(char => [cleanAssetName(char?.name, '@'), char])
        .filter(([name]) => name)
    );
    const assetByName = new Map(
      asArray(characterAssets)
        .map(char => [cleanAssetName(char?.name, '@'), char])
        .filter(([name]) => name)
    );
    return parseReferencedCharacterNames(promptText || seg?.text || '').map((name) => {
      const association = associatedByName.get(name);
      const currentAsset = assetByName.get(name) || null;
      const asset = currentAsset || association || null;
      const imageRef = getCharacterImageRef(currentAsset);
      return {
        name,
        asset,
        hasAsset: Boolean(currentAsset),
        hasImage: Boolean(imageRef),
        sendImage: Boolean(imageRef) && association?.sendImage !== false,
      };
    });
  };

  const setCharacterImagePreference = (rowId, characterName, sendImage) => {
    const normalizedName = cleanAssetName(characterName, '@');
    const sourceAsset = characterAssets.find(
      char => cleanAssetName(char?.name, '@') === normalizedName
    );
    setSegments(prev => prev.map(seg => {
      if (seg.id !== rowId) return seg;
      const associated = asArray(seg.associatedCharacters);
      const existingIndex = associated.findIndex(
        char => cleanAssetName(char?.name, '@') === normalizedName
      );
      const nextCharacter = {
        ...(existingIndex >= 0 ? associated[existingIndex] : {}),
        ...(sourceAsset || {}),
        name: normalizedName,
        sendImage: Boolean(sendImage),
      };
      const nextAssociated = existingIndex >= 0
        ? associated.map((char, index) => index === existingIndex ? nextCharacter : char)
        : [...associated, nextCharacter];
      return { ...seg, associatedCharacters: nextAssociated };
    }));
  };

  const getSegmentSceneImageRefs = (promptText = '') => {
    const sceneNames = parseReferencedSceneNames(promptText);
    if (sceneNames.length === 0) return [];
    const sceneByName = new Map(
      (sceneAssets || [])
        .map(scene => [cleanAssetName(scene?.name, '$'), scene])
        .filter(([name]) => name)
    );
    return sceneNames.map(name => getAssetImageRef(sceneByName.get(name))).filter(Boolean);
  };

  const imageRefToInput = (ref) => {
    if (!ref) return null;
    if (ref.file_path) return { file_path: ref.file_path };
    if (ref.data_url) return { data_url: ref.data_url };
    if (ref.image) return { url: ref.image };
    return null;
  };

  const imageRefToReference = (ref) => ref?.file_path || ref?.data_url || ref?.image || '';

  // ---- 图片合并：把"角色 / 场景 / 物品 / 垫图"统一转成 ImageMergeModal 需要的 item ----
  const parseReferencedItemNames = (text = '') => {
    if (!text) return [];
    const names = [];
    const seen = new Set();
    const pushName = (value) => {
      const name = cleanAssetName(value, '#');
      if (!name || seen.has(name)) return;
      seen.add(name);
      names.push(name);
    };
    const tokenRegex = /[（(]#([^）)\n\r]+)[）)]|(^|[\s，。；、,.!?！？：:])#([A-Za-z0-9_\-\u4e00-\u9fa5]+)/gm;
    let match;
    while ((match = tokenRegex.exec(text)) !== null) {
      pushName(match[1] || match[3]);
    }
    return names;
  };

  // 把图片资产或垫图字段转成 <img> 能直接吃的 src + 用于落盘的 localPath。
  const assetToMergeSrc = (asset) => {
    const localPath = asset?.avatarPath || asset?.localPath || '';
    if (localPath) return { src: makeLocalFileUrl(localPath), localPath };
    const url = asset?.avatar || '';
    if (!url) return null;
    if (/^https?:\/\//i.test(url) || /^data:image\//i.test(url) || /^blob:/i.test(url) || /^file:\/\//i.test(url)) {
      return { src: url, localPath: '' };
    }
    return null;
  };

  const segmentReferenceToMergeItem = (seg) => {
    const localPath = getReferenceLocalPath(seg);
    const displayUrl = getReferenceDisplayUrl(seg);
    if (!localPath && !displayUrl) return null;
    return {
      src: localPath ? makeLocalFileUrl(localPath) : displayUrl,
      localPath,
      label: '垫图',
      labelPrefix: '',
    };
  };

  const collectMergeItemsForRow = (row) => {
    const items = [];
    const seen = new Set();
    const push = (item) => {
      if (!item || !item.src) return;
      const key = item.localPath || item.src;
      if (seen.has(key)) return;
      seen.add(key);
      items.push(item);
    };

    const refItem = segmentReferenceToMergeItem(row);
    if (refItem) push(refItem);

    const promptText = buildPromptWithSuffix(promptDraftsRef.current[row.id] ?? row.text ?? '');

    getReferencedCharacterDisplayItems(row, promptText).forEach(({ name, asset, sendImage }) => {
      if (!sendImage) return;
      const src = assetToMergeSrc(asset);
      if (src) push({ ...src, label: name, labelPrefix: '@' });
    });

    const sceneByName = new Map(
      (sceneAssets || []).map((s) => [cleanAssetName(s?.name, '$'), s]).filter(([n]) => n)
    );
    parseReferencedSceneNames(promptText).forEach((name) => {
      const src = assetToMergeSrc(sceneByName.get(name));
      if (src) push({ ...src, label: name, labelPrefix: '$' });
    });

    const itemByName = new Map(
      (itemAssets || []).map((it) => [cleanAssetName(it?.name, '#'), it]).filter(([n]) => n)
    );
    parseReferencedItemNames(promptText).forEach((name) => {
      const src = assetToMergeSrc(itemByName.get(name));
      if (src) push({ ...src, label: name, labelPrefix: '#' });
    });

    return items;
  };

  const openMergeModalForRow = (row) => {
    const items = collectMergeItemsForRow(row);
    if (items.length === 0) {
      alert('该行没有可合并的图片。请先添加垫图，或在描述词中引用 @角色 / $场景 / #物品。');
      return;
    }
    setMergeModalState({ open: true, rowId: row.id, items });
  };

  const appendMergedImageToSegment = (seg, filePath) => {
    const displayUrl = makeLocalFileUrl(filePath);
    const isVid = seg.type === 'video';
    const list = isVid ? (seg.materialsVideo || []) : (seg.materialsImage || []);
    const newMatId = Math.max(0, ...list.map((m) => Number(m.id) || 0)) + 1;
    const newMat = {
      id: newMatId,
      name: `合并图片-${seg.id}-${newMatId}`,
      thumbnail: displayUrl,
      sourceUrl: displayUrl,
      localPath: filePath,
      remoteUrl: '',
      mediaType: 'image',
      status: 'new',
      textStatus: '合图',
      fps: null,
      duration: '静态图片',
    };

    const common = {
      ...seg,
      referenceImage: makeLocalReferenceImage(filePath),
      referenceImagePath: filePath,
    };

    if (isVid) {
      return {
        ...common,
        materialsVideo: [newMat, ...list],
        currentMaterialVideo: seg.isLocked ? seg.currentMaterialVideo : {
          id: newMatId,
          name: newMat.name,
          thumbnail: displayUrl,
          sourceUrl: displayUrl,
          localPath: filePath,
          remoteUrl: '',
          mediaType: 'image',
          isPlaying: false,
          fps: null,
          duration: '静态图片',
        },
      };
    }

    return {
      ...common,
      materialsImage: [newMat, ...list],
      currentMaterialImage: seg.isLocked ? seg.currentMaterialImage : {
        id: newMatId,
        name: newMat.name,
        thumbnail: displayUrl,
        sourceUrl: displayUrl,
        localPath: filePath,
        remoteUrl: '',
        mediaType: 'image',
        fps: null,
        duration: '静态图片',
      },
    };
  };

  const applyMergedImageToRow = (rowId, filePath) => {
    if (!filePath) return;
    setSegments((prev) => prev.map((s) => (s.id === rowId
      ? appendMergedImageToSegment(s, filePath)
      : s)));
  };

  const handleMergeAllRows = async () => {
    if (!segments.length) {
      alert('当前没有任何分镜行可处理。');
      return;
    }
    if (!window.electronAPI || !window.electronAPI.saveMergedImage) {
      alert('当前环境不支持本地保存，请在桌面客户端中使用此功能。');
      return;
    }
    if (mergeAllProgress.running) return;

    const candidates = segments
      .map((row) => ({ row, items: row.isLocked ? [] : collectMergeItemsForRow(row) }))
      .filter((c) => c.items.length > 0);
    if (candidates.length === 0) {
      alert('没有可合并的行（已锁定的行会跳过；其他行需要至少有 1 张垫图 / 角色 / 场景 / 物品图）。');
      return;
    }
    if (!confirm(`将为 ${candidates.length} 行生成合并垫图，已锁定 / 无图的行会跳过。继续？`)) return;

    setMergeAllProgress({ running: true, current: 0, total: candidates.length });

    const updates = [];
    let okCount = 0;
    let failCount = 0;
    for (let i = 0; i < candidates.length; i++) {
      const { row, items } = candidates[i];
      try {
        let savedPath = '';
        const result = await mergeImages(items, {
          columns: 2,
          lastRowAlign: 'center',
          padding: 16,
          background: '#000000',
          format: 'png',
          showLabel: true,
          labelPosition: 'bottom-left',
        });
        const bytes = await blobToUint8Array(result.blob);
        const res = await window.electronAPI.saveMergedImage({
          bytes,
          ext: 'png',
          defaultName: `段落_${row.id}_${timestampForFilename()}`,
          silent: true,
        });
        if (!res?.ok) throw new Error(res?.error || '保存失败');
        savedPath = res.filePath;
        updates.push({ rowId: row.id, filePath: savedPath });
        okCount += 1;
      } catch (e) {
        console.error('[merge-all] row failed:', row.id, e);
        failCount += 1;
      }
      setMergeAllProgress({ running: true, current: i + 1, total: candidates.length });
    }

    if (updates.length > 0) {
      setSegments((prev) => prev.map((s) => {
        const hit = updates.find((u) => u.rowId === s.id);
        if (!hit) return s;
        return appendMergedImageToSegment(s, hit.filePath);
      }));
    }

    setMergeAllProgress({ running: false, current: 0, total: 0 });
    const skipped = segments.length - candidates.length;
    alert(`一键合并完成。\n成功 ${okCount} 行，失败 ${failCount} 行，跳过 ${skipped} 行（已锁定或无图）。`);
  };

  const syncCharacterRefs = (asset) => {
    setSegments(prev => prev.map(seg => {
      if (!Array.isArray(seg.associatedCharacters)) return seg;
      const nextChars = seg.associatedCharacters.map(char => (
        char.name === asset.name
          ? { ...char, avatar: asset.avatar, avatarPath: asset.avatarPath, role: asset.role }
          : char
      ));
      return { ...seg, associatedCharacters: nextChars };
    }));
  };

  // Handle local image upload — prefer file:// URL in Electron to avoid heavy base64
  const handleLocalAvatarUpload = (e) => {
    const file = e.target.files[0];
    if (file) {
      setNewCharAvatarPath(file.path || '');
      setNewCharAvatarOriginal(''); // 换了底图，清掉旧的打码原图备份
      if (file.path) {
        setNewCharAvatar(makeLocalFileUrl(file.path));
      } else {
        const reader = new FileReader();
        reader.onload = () => {
          setNewCharAvatar(reader.result);
        };
        reader.readAsDataURL(file);
      }
    }
  };

  // 对当前正在编辑的角色头像做脸部打码（只改表单，需点「保存资产」落库）。
  const handleCensorCurrentCharacter = async () => {
    if (censorProgress.running) return;
    const base = newCharAvatarOriginal || newCharAvatar;
    if (!base) {
      alert('请先选择角色图片！');
      return;
    }
    setCensorProgress({ running: true, current: 0, total: 1 });
    try {
      const { censorImageSrc } = await import('../utils/faceCensor');
      const res = await censorImageSrc(base);
      if (!res.faceCount) {
        alert('未识别到人脸，未做改动。可换一张更正面的角色图再试。');
        return;
      }
      setNewCharAvatarOriginal((prev) => prev || newCharAvatar);
      // Try saving to local file to avoid heavy base64 in state
      if (window.electronAPI?.saveMergedImage && res.dataUrl?.startsWith('data:image/')) {
        try {
          const blob = await (await fetch(res.dataUrl)).blob();
          const bytes = new Uint8Array(await blob.arrayBuffer());
          const saveRes = await window.electronAPI.saveMergedImage({
            bytes,
            ext: 'png',
            defaultName: `censor_${Date.now()}`,
            silent: true,
          });
          if (saveRes?.ok && saveRes.filePath) {
            setNewCharAvatar(makeLocalFileUrl(saveRes.filePath));
            setNewCharAvatarPath(saveRes.filePath);
            return;
          }
        } catch (e) {
          console.warn('Failed to save auto-censored image to local file, falling back to dataURL:', e);
        }
      }
      setNewCharAvatar(res.dataUrl);
      setNewCharAvatarPath('');
    } catch (err) {
      alert(`打码失败：${err?.message || err}`);
    } finally {
      setCensorProgress({ running: false, current: 0, total: 0 });
    }
  };

  // 撤销当前角色的打码，恢复成打码前的原图。
  const handleUndoCensorCurrentCharacter = () => {
    if (!newCharAvatarOriginal) return;
    setNewCharAvatar(newCharAvatarOriginal);
    setNewCharAvatarPath('');
    setNewCharAvatarOriginal('');
  };

  // 手动打码确定后回填到当前编辑表单（需点「保存资产」落库）。
  const handleApplyManualCensor = async (dataUrl) => {
    if (!dataUrl) return;
    setNewCharAvatarOriginal((prev) => prev || newCharAvatar);
    // Try saving to local file to avoid heavy base64 in state
    if (window.electronAPI?.saveMergedImage && dataUrl.startsWith('data:image/')) {
      try {
        const blob = await (await fetch(dataUrl)).blob();
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const res = await window.electronAPI.saveMergedImage({
          bytes,
          ext: 'png',
          defaultName: `censor_${Date.now()}`,
          silent: true,
        });
        if (res?.ok && res.filePath) {
          setNewCharAvatar(makeLocalFileUrl(res.filePath));
          setNewCharAvatarPath(res.filePath);
          return;
        }
      } catch (e) {
        console.warn('Failed to save censored image to local file, falling back to dataURL:', e);
      }
    }
    setNewCharAvatar(dataUrl);
    setNewCharAvatarPath('');
  };

  // 一键给所有角色资产自动识别人脸并打码（覆盖头像，保留原图可撤销）。
  const handleCensorAllCharacters = async () => {
    if (censorProgress.running) return;
    if (!characterAssets.length) {
      alert('暂无角色资产。');
      return;
    }
    if (!confirm(`将对全部 ${characterAssets.length} 个角色自动识别人脸并打码（会覆盖头像，可单独撤销）。继续？`)) {
      return;
    }
    let done = 0;
    let skipped = 0;
    let failed = 0;
    setCensorProgress({ running: true, current: 0, total: characterAssets.length });
    try {
      const { censorImageSrc } = await import('../utils/faceCensor');
      const next = characterAssets.map((c) => ({ ...c }));
      for (let i = 0; i < next.length; i++) {
        setCensorProgress({ running: true, current: i + 1, total: next.length });
        const c = next[i];
        // 已打码过的角色从原图重新生成，避免重复叠加符号。
        const base = c.avatarOriginal || c.avatar;
        if (!base) {
          skipped++;
          continue;
        }
        try {
          const res = await censorImageSrc(base);
          if (res.faceCount) {
            next[i] = { ...c, avatar: res.dataUrl, avatarPath: '', avatarOriginal: c.avatarOriginal || c.avatar };
            done++;
          } else {
            skipped++;
          }
        } catch (err) {
          console.warn('角色打码失败:', c?.name, err);
          failed++;
        }
      }
      setCharacterAssets(next);
      const edited = next.find((c) => c.id === editingCharId);
      if (edited) {
        setNewCharAvatar(edited.avatar);
        setNewCharAvatarPath(edited.avatarPath || '');
        setNewCharAvatarOriginal(edited.avatarOriginal || '');
      }
    } finally {
      setCensorProgress({ running: false, current: 0, total: 0 });
    }
    alert(`打码完成：成功 ${done}，未识别到人脸跳过 ${skipped}${failed ? `，失败 ${failed}` : ''}。`);
  };

  // Save character asset details (create/update)
  const handleSaveCharacter = () => {
    if (!newCharName.trim()) {
      alert('请输入角色名称！');
      return;
    }

    const asset = makeCharacterAsset();
    if (editingCharId === 'new') {
      setCharacterAssets([
        ...characterAssets,
        asset
      ]);
      setEditingCharId(asset.id);
    } else {
      setCharacterAssets(characterAssets.map(c => 
        c.id === editingCharId 
          ? { ...c, ...asset, id: c.id }
          : c
      ));
      syncCharacterRefs({ ...asset, id: editingCharId });
    }
    alert('角色特征资产保存成功！现在可在任何分镜描述词中直接输入 @ 触发最新头像关联！');
  };

  // Delete character asset with confirmation
  const handleDeleteCharacter = () => {
    if (characterAssets.length <= 1) {
      alert('至少需要保留一个角色特征资产！');
      return;
    }
    if (confirm(`确认删除角色 "${newCharName}" 吗？`)) {
      const remaining = characterAssets.filter(c => c.id !== editingCharId);
      setCharacterAssets(remaining);
      if (remaining.length > 0) {
        setEditingCharId(remaining[0].id);
        setNewCharName(remaining[0].name);
        setNewCharRole(remaining[0].role || '');
        setNewCharAvatar(remaining[0].avatar);
        setNewCharAvatarPath(remaining[0].avatarPath || '');
        setNewCharAvatarOriginal(remaining[0].avatarOriginal || '');
      } else {
        setEditingCharId(null);
        setNewCharName('');
        setNewCharRole('');
        setNewCharAvatar('');
        setNewCharAvatarPath('');
        setNewCharAvatarOriginal('');
        setShowCharacterModal(false);
      }
    }
  };

  // Handle local image upload for scene/item assets
  const handleLocalAssetUpload = (e) => {
    const file = e.target.files[0];
    if (file) {
      setNewAssetAvatarPath(file.path || '');
      if (file.path) {
        setNewAssetAvatar(makeLocalFileUrl(file.path));
      } else {
        const reader = new FileReader();
        reader.onload = () => {
          setNewAssetAvatar(reader.result);
        };
        reader.readAsDataURL(file);
      }
    }
  };

  // Save scene/item asset (create or update)
  const handleSaveAsset = () => {
    const isScene = editingAssetType === 'scene';
    const label = isScene ? '场景' : '物品';
    const triggerSym = isScene ? '$' : '#';
    const cleanName = cleanAssetName(newAssetName.trim(), triggerSym);
    if (!cleanName) {
      alert(`请输入${label}名称！`);
      return;
    }

    const asset = {
      id: editingAssetId === 'new' ? `${editingAssetType}-${Date.now()}` : editingAssetId,
      name: cleanName,
      role: label,
      avatar: newAssetAvatar,
      avatarPath: newAssetAvatarPath,
    };

    if (isScene) {
      if (editingAssetId === 'new') {
        setSceneAssets(prev => [...prev, asset]);
        setEditingAssetId(asset.id);
      } else {
        setSceneAssets(prev => prev.map(x => x.id === editingAssetId ? { ...x, ...asset, id: editingAssetId } : x));
      }
    } else {
      if (editingAssetId === 'new') {
        setItemAssets(prev => [...prev, asset]);
        setEditingAssetId(asset.id);
      } else {
        setItemAssets(prev => prev.map(x => x.id === editingAssetId ? { ...x, ...asset, id: editingAssetId } : x));
      }
    }
    alert(`${label}资产保存成功！现在可在描述词中输入 ${triggerSym} 调用。`);
  };

  // Delete scene/item asset
  const handleDeleteAsset = () => {
    const isScene = editingAssetType === 'scene';
    const label = isScene ? '场景' : '物品';
    const assets = isScene ? sceneAssets : itemAssets;
    const setAssets = isScene ? setSceneAssets : setItemAssets;
    if (!confirm(`确认删除${label} "${newAssetName}" 吗？`)) return;
    const remaining = assets.filter(x => x.id !== editingAssetId);
    setAssets(remaining);
    if (remaining.length > 0) {
      setEditingAssetId(remaining[0].id);
      setNewAssetName(remaining[0].name);
      setNewAssetAvatar(remaining[0].avatar || '');
      setNewAssetAvatarPath(remaining[0].avatarPath || '');
    } else {
      setEditingAssetId('new');
      setNewAssetName('');
      setNewAssetAvatar('');
      setNewAssetAvatarPath('');
    }
  };

  const fileToDataUrl = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('剪贴板图片读取失败'));
    reader.readAsDataURL(file);
  });

  const getClipboardImageFile = (clipboardData) => {
    const items = Array.from(clipboardData?.items || []);
    const itemFile = items
      .find((item) => item.kind === 'file' && /^image\//i.test(item.type || ''))
      ?.getAsFile();
    if (itemFile) return itemFile;
    return Array.from(clipboardData?.files || []).find((file) => /^image\//i.test(file.type || '')) || null;
  };

  // Convert prompt text to a white-background image and set as reference image (垫图)
  const handleTextToReferenceImage = (rowId) => {
    const seg = segments.find(s => s.id === rowId);
    const promptText = buildPromptWithSuffix(promptDraftsRef.current[rowId] ?? seg?.text ?? '');
    if (!promptText || promptText.trim().length === 0) {
      alert('请先填写描述词，再点击「描述词转垫图」');
      return;
    }
    try {
      const padding = 40;
      const maxWidth = 1024;
      const fontSize = 28;
      const lineHeight = fontSize * 1.6;
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      ctx.font = `${fontSize}px "PingFang SC", "Microsoft YaHei", "Hiragino Sans GB", sans-serif`;
      // Word-wrap the text
      const lines = [];
      for (const paragraph of promptText.split('\n')) {
        if (paragraph.trim() === '') { lines.push(''); continue; }
        let current = '';
        for (const char of paragraph) {
          const testLine = current + char;
          if (ctx.measureText(testLine).width > maxWidth - padding * 2 && current) {
            lines.push(current);
            current = char;
          } else {
            current = testLine;
          }
        }
        if (current) lines.push(current);
      }
      const totalHeight = padding * 2 + lines.length * lineHeight;
      canvas.width = maxWidth;
      canvas.height = Math.max(totalHeight, 200);
      // White background
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      // Draw text
      ctx.fillStyle = '#000000';
      ctx.font = `${fontSize}px "PingFang SC", "Microsoft YaHei", "Hiragino Sans GB", sans-serif`;
      ctx.textBaseline = 'top';
      lines.forEach((line, i) => {
        ctx.fillText(line, padding, padding + i * lineHeight);
      });
      const dataUrl = canvas.toDataURL('image/png');
      setSegments(prev => prev.map(s => s.id === rowId ? {
        ...s,
        referenceImage: makeDataUrlReferenceImage(dataUrl),
        referenceImagePath: '',
      } : s));
    } catch (e) {
      console.warn('Text to reference image failed:', e);
      alert(`描述词转垫图失败：${e.message || e}`);
    }
  };

  const handlePasteReferenceImage = async (rowId, event) => {
    const imageFile = getClipboardImageFile(event.clipboardData);
    if (!imageFile) return;
    event.preventDefault();
    event.stopPropagation();
    try {
      const dataUrl = await fileToDataUrl(imageFile);
      if (!dataUrl || !/^data:image\//i.test(dataUrl)) throw new Error('剪贴板里没有可用图片');
      setSegments(prev => prev.map(seg => seg.id === rowId ? {
        ...seg,
        referenceImage: makeDataUrlReferenceImage(dataUrl),
        referenceImagePath: '',
      } : seg));
    } catch (e) {
      console.warn('Paste reference image failed:', e);
      alert(`粘贴垫图失败：${e.message || e}`);
    }
  };
  
  // Convert specific generated image to reference image (垫图)
  const handleConvertToVideoReference = (rowId, material) => {
    const refUrl = material.sourceUrl || material.thumbnail || material.previewUrl || '';
    if (!refUrl || isVideoUrl(refUrl) || material.mediaType === 'video') {
      alert('视频素材不能作为垫图，请选择图片素材。');
      return;
    }
    setSegments(prev => prev.map(seg => {
      if (seg.id === rowId) {
        return {
          ...seg,
          referenceImage: makeRemoteReferenceImage(refUrl.replace('&w=120', '&w=500')),
          referenceImagePath: ''
        };
      }
      return seg;
    }));
    alert(`成功！已将生成图片 "${material.name}" 设置为该分镜的视频生成垫图！可以在视频模式下一键发送进行 Image-to-Video 渲染！`);
  };

  // Download a video — supports remote URLs (via proxy), local paths (via /local/video), and proxy URLs
  const handleDownloadVideo = (material, name = 'video') => {
    const safeName = String(name).replace(/[\\/:*?"<>|]/g, '_');
    const thumbUrl = material?.thumbnail || '';
    const sourceUrl = material?.sourceUrl || material?.remoteUrl || '';

    // Try to extract real path/url from proxy service URLs first
    const extracted = extractRealUrlFromProxy(thumbUrl) || extractRealUrlFromProxy(sourceUrl);
    let localPath = material?.localPath || extracted?.localPath || localFilePathFromUrlValue(thumbUrl || sourceUrl) || '';
    let remoteUrl = extracted?.remoteUrl || '';
    if (!remoteUrl && sourceUrl && /^https?:\/\//i.test(sourceUrl) && !sourceUrl.includes('/local/') && !sourceUrl.includes('/proxy/')) {
      remoteUrl = sourceUrl;
    }
    if (!remoteUrl && thumbUrl && /^https?:\/\//i.test(thumbUrl) && !thumbUrl.includes('/local/') && !thumbUrl.includes('/proxy/')) {
      remoteUrl = thumbUrl;
    }

    let downloadUrl = '';
    if (localPath) {
      downloadUrl = `${WIZSTAR_API}/local/video?path=${encodeURIComponent(localPath)}&download=1&filename=${encodeURIComponent(safeName + '.mp4')}`;
    } else if (remoteUrl && /^https?:\/\//i.test(remoteUrl)) {
      downloadUrl = toDownloadUrl(remoteUrl, `${safeName}.mp4`);
    } else if (thumbUrl && thumbUrl.startsWith('/local/video')) {
      downloadUrl = `${thumbUrl}&download=1&filename=${encodeURIComponent(safeName + '.mp4')}`;
    }

    if (!downloadUrl) {
      alert('该素材没有可下载的视频地址');
      return;
    }
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = `${safeName}.mp4`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  // Download an image — supports local paths (via /local/image), remote URLs, and proxy URLs
  const handleDownloadImage = (material, name = 'image') => {
    const safeName = String(name).replace(/[\\/:*?"<>|]/g, '_');
    const thumbUrl = material?.thumbnail || '';
    const sourceUrl = material?.sourceUrl || material?.remoteUrl || '';

    // Try to extract real path/url from proxy service URLs first
    const extracted = extractRealUrlFromProxy(thumbUrl) || extractRealUrlFromProxy(sourceUrl);
    let localPath = material?.localPath || extracted?.localPath || localFilePathFromUrlValue(thumbUrl || sourceUrl) || '';
    let remoteUrl = extracted?.remoteUrl || '';
    if (!remoteUrl && sourceUrl && /^https?:\/\//i.test(sourceUrl) && !sourceUrl.includes('/local/') && !sourceUrl.includes('/proxy/')) {
      remoteUrl = sourceUrl;
    }
    if (!remoteUrl && thumbUrl && /^https?:\/\//i.test(thumbUrl) && !thumbUrl.includes('/local/') && !thumbUrl.includes('/proxy/')) {
      remoteUrl = thumbUrl;
    }

    let downloadUrl = '';
    let ext = '.png';
    if (localPath) {
      const extMatch = localPath.match(/\.(jpg|jpeg|png|webp|bmp|gif)$/i);
      if (extMatch) ext = '.' + extMatch[1].toLowerCase();
      downloadUrl = `${WIZSTAR_API}/local/image?path=${encodeURIComponent(localPath)}&download=1&filename=${encodeURIComponent(safeName + ext)}`;
    } else if (remoteUrl && /^https?:\/\//i.test(remoteUrl)) {
      downloadUrl = remoteUrl;
    } else if (thumbUrl && thumbUrl.startsWith('/local/image')) {
      downloadUrl = `${thumbUrl}&download=1&filename=${encodeURIComponent(safeName + ext)}`;
    }

    if (!downloadUrl) {
      alert('该素材没有可下载的图片地址');
      return;
    }
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = `${safeName}${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const blobToPngBlob = (blob) => new Promise((resolve, reject) => {
    if (blob.type === 'image/png') {
      resolve(blob);
      return;
    }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const objectUrl = URL.createObjectURL(blob);
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth || img.width;
      canvas.height = img.naturalHeight || img.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      canvas.toBlob((pngBlob) => {
        if (pngBlob) resolve(pngBlob);
        else reject(new Error('图片转换失败'));
      }, 'image/png');
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('图片加载失败'));
    };
    img.src = objectUrl;
  });

  const copyImageToClipboard = async (src = '') => {
    if (!src) return;
    try {
      if (!navigator.clipboard || !window.ClipboardItem) {
        throw new Error('当前环境不支持直接复制图片');
      }
      const response = await fetch(src);
      if (!response.ok) throw new Error(`图片读取失败 HTTP ${response.status}`);
      const blob = await response.blob();
      const pngBlob = await blobToPngBlob(blob);
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
      alert('图片已复制到剪贴板');
    } catch (e) {
      console.warn('Copy image failed:', e);
      try {
        if (navigator.clipboard && /^https?:\/\//i.test(src)) {
          await navigator.clipboard.writeText(src);
          alert('直接复制图片失败，已复制图片链接');
          return;
        }
      } catch (_) {}
      alert(`复制失败：${e.message || e}`);
    }
  };

  const loadImageForEditor = (src = '') => new Promise((resolve, reject) => {
    if (!src) {
      reject(new Error('缺少图片地址'));
      return;
    }
    const img = new Image();
    if (/^https?:\/\//i.test(src)) img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片加载失败，无法编辑'));
    img.src = src;
  });

  const resetImageEditorCanvas = useCallback(async () => {
    if (!fullscreenVideo?.src || fullscreenVideo.mediaType === 'video' || isVideoUrl(fullscreenVideo.src)) return;
    const canvas = imageEditorCanvasRef.current;
    if (!canvas) return;
    const img = await loadImageForEditor(fullscreenVideo.src);
    imageEditorImageRef.current = img;
    const maxWidth = Math.floor(window.innerWidth * 0.86);
    const maxHeight = Math.floor(window.innerHeight * 0.76);
    const naturalWidth = img.naturalWidth || img.width || 1;
    const naturalHeight = img.naturalHeight || img.height || 1;
    const scale = Math.min(maxWidth / naturalWidth, maxHeight / naturalHeight, 1);
    canvas.width = Math.max(1, Math.round(naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    imageEditorHistoryRef.current = [];
  }, [fullscreenVideo]);

  useEffect(() => {
    if (!imageEditorEnabled) return undefined;
    let cancelled = false;
    resetImageEditorCanvas().catch((e) => {
      if (!cancelled) {
        console.warn('Reset image editor failed:', e);
        alert(`打开编辑失败：${e.message || e}`);
        setImageEditorEnabled(false);
      }
    });
    return () => { cancelled = true; };
  }, [imageEditorEnabled, resetImageEditorCanvas]);

  const imageEditorPointFromEvent = (event) => {
    const canvas = imageEditorCanvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const clientX = event.clientX ?? event.touches?.[0]?.clientX;
    const clientY = event.clientY ?? event.touches?.[0]?.clientY;
    if (clientX == null || clientY == null) return null;
    return {
      x: ((clientX - rect.left) / rect.width) * canvas.width,
      y: ((clientY - rect.top) / rect.height) * canvas.height,
    };
  };

  const startImageEditorStroke = (event) => {
    event.preventDefault();
    event.stopPropagation();
    const point = imageEditorPointFromEvent(event);
    if (!point) return;
    const canvas = imageEditorCanvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      imageEditorHistoryRef.current.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
      if (imageEditorHistoryRef.current.length > 30) imageEditorHistoryRef.current.shift();
    }
    imageEditorDrawingRef.current = true;
    imageEditorLastPointRef.current = point;
  };

  const moveImageEditorStroke = (event) => {
    if (!imageEditorDrawingRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    const canvas = imageEditorCanvasRef.current;
    const lastPoint = imageEditorLastPointRef.current;
    const nextPoint = imageEditorPointFromEvent(event);
    if (!canvas || !lastPoint || !nextPoint) return;
    const ctx = canvas.getContext('2d');
    ctx.strokeStyle = imageEditorColor;
    ctx.lineWidth = imageEditorLineWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(lastPoint.x, lastPoint.y);
    ctx.lineTo(nextPoint.x, nextPoint.y);
    ctx.stroke();
    imageEditorLastPointRef.current = nextPoint;
  };

  const endImageEditorStroke = (event) => {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    imageEditorDrawingRef.current = false;
    imageEditorLastPointRef.current = null;
  };

  const undoImageEditorStroke = () => {
    const canvas = imageEditorCanvasRef.current;
    const previous = imageEditorHistoryRef.current.pop();
    if (!canvas || !previous) return;
    const ctx = canvas.getContext('2d');
    ctx.putImageData(previous, 0, 0);
  };

  const appendEditedImageToRow = (rowId, filePath) => {
    if (!rowId || !filePath) return;
    const displayUrl = makeLocalFileUrl(filePath);
    setSegments(prev => prev.map(seg => {
      if (seg.id !== rowId) return seg;
      const isVid = seg.type === 'video';
      const listKey = isVid ? 'materialsVideo' : 'materialsImage';
      const currentKey = isVid ? 'currentMaterialVideo' : 'currentMaterialImage';
      const list = seg[listKey] || [];
      const newMatId = Math.max(0, ...list.map((m) => Number(m.id) || 0)) + 1;
      const newMat = {
        id: newMatId,
        name: `编辑图片-${seg.id}-${newMatId}`,
        thumbnail: displayUrl,
        sourceUrl: displayUrl,
        localPath: filePath,
        remoteUrl: '',
        mediaType: 'image',
        status: 'new',
        textStatus: '编辑',
        fps: null,
        duration: '静态图片',
      };
      return {
        ...seg,
        [listKey]: [newMat, ...list],
        [currentKey]: {
          id: newMatId,
          name: newMat.name,
          thumbnail: displayUrl,
          sourceUrl: displayUrl,
          localPath: filePath,
          remoteUrl: '',
          mediaType: 'image',
          isPlaying: false,
          fps: null,
          duration: '静态图片',
        },
      };
    }));
  };

  const saveEditedImage = async () => {
    const canvas = imageEditorCanvasRef.current;
    if (!canvas || !fullscreenVideo) return;
    const { rowId, assetType, assetId } = fullscreenVideo;
    console.log('[saveEditedImage] fullscreenVideo:', { rowId, assetType, assetId, editingCharId, editingAssetId });
    if (!rowId && !assetId) {
      console.warn('[saveEditedImage] No rowId or assetId, skipping save');
      return;
    }
    if (!window.electronAPI?.saveMergedImage) {
      alert('当前环境不支持本地保存，请在桌面客户端中使用此功能。');
      return;
    }
    setImageEditorSaving(true);
    try {
      const blob = await new Promise((resolve, reject) => {
        canvas.toBlob((item) => item ? resolve(item) : reject(new Error('图片导出失败')), 'image/png');
      });
      const bytes = await blobToUint8Array(blob);
      const namePrefix = assetId ? `编辑图片_${assetType}_${assetId}` : `编辑图片_${rowId}`;
      const res = await window.electronAPI.saveMergedImage({
        bytes,
        ext: 'png',
        defaultName: `${namePrefix}_${timestampForFilename()}`,
        silent: true,
      });
      if (!res?.ok) throw new Error(res?.error || '保存失败');
      const savedPath = res.filePath;
      const savedUrl = makeLocalFileUrl(savedPath);

      if (assetId) {
        // Save back to character/scene/item asset
        if (assetType === 'character') {
          if (assetId === 'new' || assetId === editingCharId) {
            // Updating the currently-edited character (new or existing)
            setNewCharAvatar(savedUrl);
            setNewCharAvatarPath(savedPath);
          }
          if (assetId !== 'new') {
            setCharacterAssets((prev) => prev.map((a) => {
              if (a.id !== assetId) return a;
              return { ...a, avatar: savedUrl, avatarPath: savedPath, avatarOriginal: a.avatarOriginal || a.avatar };
            }));
          }
        } else if (assetType === 'scene') {
          if (assetId === editingAssetId) {
            setNewAssetAvatar(savedUrl);
            setNewAssetAvatarPath(savedPath);
          }
          setSceneAssets((prev) => prev.map((a) => {
            if (a.id !== assetId) return a;
            return { ...a, avatar: savedUrl, avatarPath: savedPath, avatarOriginal: a.avatarOriginal || a.avatar };
          }));
        } else if (assetType === 'item') {
          if (assetId === editingAssetId) {
            setNewAssetAvatar(savedUrl);
            setNewAssetAvatarPath(savedPath);
          }
          setItemAssets((prev) => prev.map((a) => {
            if (a.id !== assetId) return a;
            return { ...a, avatar: savedUrl, avatarPath: savedPath, avatarOriginal: a.avatarOriginal || a.avatar };
          }));
        }
      } else if (rowId) {
        appendEditedImageToRow(rowId, savedPath);
      }

      setFullscreenVideo((prev) => prev ? { ...prev, src: savedUrl, localPath: savedPath } : prev);
      setImageEditorEnabled(false);
      alert('已保存');
    } catch (e) {
      console.warn('Save edited image failed:', e);
      alert(`保存失败：${e.message || e}`);
    } finally {
      setImageEditorSaving(false);
    }
  };

  const closeFullscreenPreview = () => {
    setImageEditorEnabled(false);
    setImageEditorSaving(false);
    setFullscreenVideo(null);
    setFullscreenLoading(false);
  };

  const imageDragPrepareRef = useRef(new Map());

  const getImageDragPayload = (material = {}) => {
    const src = material.sourceUrl || material.remoteUrl || (material.localPath ? makeLocalFileUrl(material.localPath) : '') || material.thumbnail || '';
    return {
      src,
      localPath: material.localPath || '',
      name: material.name || 'image',
    };
  };

  const imageDragKey = (payload = {}) => [payload.localPath || '', payload.fallbackLocalPath || '', payload.src || '', payload.name || ''].join('|');

  const prepareExternalImageDrag = async (material = {}) => {
    if (!material?.thumbnail || material.mediaType === 'video' || isVideoUrl(material.thumbnail)) return null;
    if (!window.electronAPI?.prepareImageDrag) return null;
    const payload = getImageDragPayload(material);
    const key = imageDragKey(payload);
    const cached = imageDragPrepareRef.current.get(key);
    if (cached?.ok) return cached;
    if (cached?.pending) return cached.promise;

    const promise = window.electronAPI.prepareImageDrag(payload).then((res) => {
      const next = res?.ok ? { ok: true, file: res.file } : { ok: false, error: res?.error || '准备图片失败' };
      imageDragPrepareRef.current.set(key, next);
      return next;
    }).catch((e) => {
      const next = { ok: false, error: e.message || String(e) };
      imageDragPrepareRef.current.set(key, next);
      return next;
    });
    imageDragPrepareRef.current.set(key, { pending: true, promise });
    return promise;
  };

  const startExternalImageDrag = (event, material = {}) => {
    if (!material?.thumbnail || material.mediaType === 'video' || isVideoUrl(material.thumbnail)) return;
    if (!window.electronAPI?.startImageDrag) return;
    event.preventDefault();
    const payload = getImageDragPayload(material);
    const cached = imageDragPrepareRef.current.get(imageDragKey(payload));
    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData('text/plain', payload.src);
    window.electronAPI.startImageDrag({
      ...payload,
      preparedFile: cached?.ok ? cached.file : '',
    });
  };

  const getVideoDragPayload = (material = {}) => {
    const rawLocalPath = material.localPath || '';
    const originalLocalPath = originalLocalVideoPathFromPlayable(rawLocalPath);
    const dragLocalPath = originalLocalPath || rawLocalPath;
    const fallbackLocalPath = originalLocalPath && originalLocalPath !== rawLocalPath ? rawLocalPath : '';
    const src = material.sourceUrl
      || material.remoteUrl
      || (dragLocalPath ? makeLocalFileUrl(dragLocalPath) : '')
      || (fallbackLocalPath ? makeLocalFileUrl(fallbackLocalPath) : '')
      || material.thumbnail
      || '';
    return {
      src,
      localPath: dragLocalPath,
      fallbackLocalPath,
      name: material.name || 'video',
    };
  };

  const prepareExternalVideoDrag = async (material = {}) => {
    if (!material?.thumbnail || material.mediaType !== 'video' && !isVideoUrl(material.thumbnail)) return null;
    if (!window.electronAPI?.prepareVideoDrag) return null;
    const payload = getVideoDragPayload(material);
    const key = imageDragKey(payload);
    const cached = imageDragPrepareRef.current.get(key);
    if (cached?.ok) return cached;
    if (cached?.pending) return cached.promise;

    const promise = window.electronAPI.prepareVideoDrag(payload).then((res) => {
      const next = res?.ok ? { ok: true, file: res.file } : { ok: false, error: res?.error || '准备视频失败' };
      imageDragPrepareRef.current.set(key, next);
      return next;
    }).catch((e) => {
      const next = { ok: false, error: e.message || String(e) };
      imageDragPrepareRef.current.set(key, next);
      return next;
    });
    imageDragPrepareRef.current.set(key, { pending: true, promise });
    return promise;
  };

  const startExternalVideoDrag = (event, material = {}) => {
    if (!material?.thumbnail) return;
    if (!window.electronAPI?.startVideoDrag) return;
    event.preventDefault();
    const payload = getVideoDragPayload(material);
    const cached = imageDragPrepareRef.current.get(imageDragKey(payload));
    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData('text/plain', payload.src);
    window.electronAPI.startVideoDrag({
      ...payload,
      preparedFile: cached?.ok ? cached.file : '',
    });
  };

  useEffect(() => {
    if (!window.electronAPI?.onImageDragError) return undefined;
    return window.electronAPI.onImageDragError((message) => {
      alert(`图片拖出失败：${message || '未知错误'}`);
    });
  }, []);

  useEffect(() => {
    if (!window.electronAPI?.onVideoDragError) return undefined;
    return window.electronAPI.onVideoDragError((message) => {
      alert(`视频拖出失败：${message || '未知错误'}`);
    });
  }, []);

  // Export all current materials across every segment row into a chosen folder, named by row index (1.mp4, 2.mp4 ...)
  const handleExportAllCurrent = async () => {
    const items = [];
    const getLocalPathFromMaybeFileUrl = (value = '') => {
      const raw = String(value || '').trim();
      if (!raw) return '';
      if (/^file:\/\//i.test(raw)) {
        try { return decodeURIComponent(new URL(raw).pathname); } catch (_) { return raw.replace(/^file:\/\/+/, '/'); }
      }
      return raw;
    };

    segments.forEach((row, idx) => {
      const isVid = row.type === 'video';
      const cur = isVid ? row.currentMaterialVideo : row.currentMaterialImage;
      const source = cur?.localPath || cur?.sourceUrl || cur?.thumbnail || '';
      const localPath = cur?.localPath || (/^file:\/\//i.test(source) ? getLocalPathFromMaybeFileUrl(source) : '');
      const remoteUrl = /^https?:\/\//i.test(source) ? source : '';
      if (!localPath && !remoteUrl) return;

      const cleanSource = (localPath || remoteUrl).split('?')[0];
      const extMatch = cleanSource.match(/\.(\w{2,5})$/);
      const ext = extMatch ? extMatch[1] : (isVid ? 'mp4' : 'png');
      items.push({
        url: remoteUrl,
        localPath,
        index: row.id || idx + 1,
        name: makeExportBaseName(row, idx + 1, isVid),
        ext,
      });
    });

    if (items.length === 0) {
      alert('当前没有可导出的素材，请先生成或选择画面。');
      return;
    }

    // Desktop (Electron): download into a chosen folder, named strictly by sequence number
    if (window.electronAPI && window.electronAPI.exportVideos) {
      const res = await window.electronAPI.exportVideos({ items });
      if (res?.canceled) return;
      if (res?.ok) {
        const failed = (res.results || []).filter(r => !r.ok);
        alert(`导出完成：成功 ${res.okCount}/${res.total} 个，已保存到\n${res.targetDir}` + (failed.length ? `\n失败序号：${failed.map(f => f.index).join(', ')}` : ''));
      } else {
        alert(`导出失败：${res?.error || '未知错误'}`);
      }
      return;
    }

    // Browser fallback: trigger sequential downloads named by index
    for (const item of items) {
      const dlName = `${item.name || item.index}.${item.ext}`;
      let dlUrl = '';
      if (item.localPath) {
        const isVidItem = /\.(mp4|webm|mov|m4v)$/i.test(item.localPath);
        const base = isVidItem ? '/local/video' : '/local/image';
        dlUrl = `${WIZSTAR_API}${base}?path=${encodeURIComponent(item.localPath)}&download=1&filename=${encodeURIComponent(dlName)}`;
      } else if (item.url && /^https?:\/\//i.test(item.url)) {
        dlUrl = toDownloadUrl(item.url, dlName);
      }
      if (!dlUrl) continue;
      const a = document.createElement('a');
      a.href = dlUrl;
      a.download = dlName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      await new Promise((r) => setTimeout(r, 400));
    }
  };

  const handleClearAllMaterials = () => {
    const hasAnyMaterial = segments.some((row) => (
      row.currentMaterialVideo?.thumbnail
      || row.currentMaterialImage?.thumbnail
      || (row.materialsVideo || []).length > 0
      || (row.materialsImage || []).length > 0
    ));

    if (!hasAnyMaterial) {
      alert('当前没有可清空的素材。');
      return;
    }

    if (!confirm('确定要清空所有分镜的当前素材和可选素材吗？')) return;

    setSegments(prev => prev.map(seg => ({
      ...seg,
      isLocked: false,
      currentMaterialVideo: {
        id: 0,
        name: '暂无画面',
        thumbnail: '',
        mediaType: 'video',
        isPlaying: false,
        fps: null,
        duration: null,
      },
      materialsVideo: [],
      currentMaterialImage: {
        id: 0,
        name: '暂无画面',
        thumbnail: '',
        mediaType: 'image',
        fps: null,
        duration: null,
      },
      materialsImage: [],
    })));
  };
  
  // Simulated files chosen for batch actions
  const [batchFiles, setBatchFiles] = useState([]);

  // Simulated running background tasks (format conversions or AI processing)
  const [batchTasks, setBatchTasks] = useState([]);

  // Handler: Batch select files or directory
  const handleSelectBatchFolder = async () => {
    if (window.electronAPI) {
      const selected = await window.electronAPI.selectDirectory();
      if (selected) {
        alert(`成功扫描到目录: ${selected}\n已加载 5 个新素材到待处理列表。`);
      }
    } else {
      alert('已扫描到本地图片/视频素材，并自动加载到批量处理列表！');
    }
  };

  // Handler: Batch Import Files to segments materials list
  const handleRunBatchImport = () => {
    let importedVideoCount = 0;
    let importedImageCount = 0;

    setSegments(prev => prev.map(seg => {
      const isVid = seg.type === 'video';
      const filesToImport = batchFiles.filter(f => isVid ? f.type === 'video' : f.type === 'image');
      
      const newMaterials = filesToImport.map((f, i) => {
        if (isVid) importedVideoCount++;
        else importedImageCount++;
        
        return {
          id: Date.now() + i,
          name: f.name.split('.')[0],
          thumbnail: isVid ? 'https://images.unsplash.com/photo-1492691527719-9d1e07e534b4?auto=format&fit=crop&q=80&w=120' : 'https://images.unsplash.com/photo-1579783900882-c0d3dad7b119?auto=format&fit=crop&q=80&w=120',
          mediaType: isVid ? 'video' : 'image',
          status: 'new',
          textStatus: isVid ? '批导' : '批画'
        };
      });

      if (isVid) {
        return { ...seg, materialsVideo: [...newMaterials, ...seg.materialsVideo] };
      } else {
        return { ...seg, materialsImage: [...newMaterials, ...seg.materialsImage] };
      }
    }));

    alert(`批量导入成功！\n已为视频行分镜追加 ${importedVideoCount} 个候选帧；\n已为图片行分镜追加 ${importedImageCount} 张候选图！`);
  };

  // Handler: Batch Convert Images format / resolution
  const handleRunBatchConvert = () => {
    const taskId = `t-${Date.now()}`;
    const newTask = {
      id: taskId,
      name: `批量转换图片格式 (${conversionResolution} ${conversionFormat})`,
      type: 'convert',
      progress: 0,
      status: 'processing',
      time: '剩余 8s'
    };

    setBatchTasks(prev => [newTask, ...prev]);
    setBatchTab('tasks');

    // Simulate task running progress
    let currentProgress = 0;
    const interval = setInterval(() => {
      currentProgress += 20;
      setBatchTasks(prev => prev.map(task => {
        if (task.id === taskId) {
          if (currentProgress >= 100) {
            clearInterval(interval);
            return { ...task, progress: 100, status: 'completed', time: '已完成' };
          }
          return { ...task, progress: currentProgress, time: `剩余 ${Math.ceil((100 - currentProgress) / 10)}s` };
        }
        return task;
      }));
    }, 1500);
  };

  // Handler: Batch apply local images as reference image (垫图) sequentially
  const handleRunBatchReferenceImage = async () => {
    if (segments.length === 0) {
      alert('请先添加分镜行，再批量加垫图！');
      return;
    }

    let filePaths = await selectLocalImageFiles();
    if (!filePaths || filePaths.length === 0) return;

    filePaths = sortFilePathsByName(filePaths.filter(isImageFilePath));

    setSegments(prev => prev.map((seg, index) => {
      if (index < filePaths.length) {
        return { ...seg, referenceImage: makeLocalReferenceImage(filePaths[index]), referenceImagePath: filePaths[index] };
      }
      return seg;
    }));

    const applied = Math.min(filePaths.length, segments.length);
    alert(`批量垫图完成！已为前 ${applied} 行分镜分配垫图。\n选择了 ${filePaths.length} 张图片，当前共 ${segments.length} 行分镜。`);
  };

  const openBatchPromptModal = () => {
    setBatchPromptText(segments.map(seg => promptDraftsRef.current[seg.id] ?? seg.text ?? '').join('\n'));
    setBatchPromptMode('replace');
    setShowBatchPromptModal(true);
  };

  const parseSceneDuration = (block = '') => {
    const text = String(block || '');
    // Try [镜头N / Xs] format first
    const header = text.split('\n').find(line => /镜头\s*\d+/i.test(line)) || '';
    const match = header.match(/[\[/【]\s*镜头\s*\d+\s*\/\s*(\d+(?:\.\d+)?)\s*s?\s*[\]】]/i);
    if (match) return formatDurationLabel(parseDurationSeconds(match[1], 5));
    // Fallback: 时长是Xs / 时长: Xs / 时长 Xs
    const durMatch = text.match(/时长(?:是|[:：])?\s*(\d+(?:\.\d+)?)\s*s?/i);
    if (durMatch) return formatDurationLabel(parseDurationSeconds(durMatch[1], 5));
    return '';
  };

  const normalizeImportedShotBlock = (block = '') => String(block || '')
    .replace(/^\s*={3,}\s*/g, '')
    .replace(/\n\s*={3,}\s*$/g, '')
    .trim();

  const splitPromptByShotHeaders = (raw = '') => {
    const source = String(raw || '');

    // Pattern 1: [镜头N / Xs] format (existing)
    const shotHeaderRegex = /(?:^|\n)\s*(?:\d+\s*[.．、]\s*)?(?:#{1,6}\s*)?[^\n]*?[\[【]\s*镜头\s*\d+\s*\/\s*\d+(?:\.\d+)?\s*s?\s*[\]】][^\n]*/g;
    const shotMatches = [...source.matchAll(shotHeaderRegex)];
    if (shotMatches.length > 0) {
      return shotMatches.map((match, index) => {
        const start = match.index + (match[0].startsWith('\n') ? 1 : 0);
        const end = index + 1 < shotMatches.length ? shotMatches[index + 1].index : source.length;
        return normalizeImportedShotBlock(source.slice(start, end));
      }).filter(Boolean);
    }

    // Pattern 2: ## 标题 - [分镜N ] format (new)
    const fenjingHeaderRegex = /(?:^|\n)\s*(?:#{1,6}\s*)?[^\n]*?[\[【]\s*分镜\s*\d+[^\]】]*[\]】][^\n]*/g;
    const fenjingMatches = [...source.matchAll(fenjingHeaderRegex)];
    if (fenjingMatches.length > 0) {
      return fenjingMatches.map((match, index) => {
        const start = match.index + (match[0].startsWith('\n') ? 1 : 0);
        const end = index + 1 < fenjingMatches.length ? fenjingMatches[index + 1].index : source.length;
        return normalizeImportedShotBlock(source.slice(start, end));
      }).filter(Boolean);
    }

    return [];
  };

  const parseBatchPromptBlocks = (text = '') => {
    const raw = String(text || '').replace(/\r\n/g, '\n').trim();
    if (!raw) return [];

    const shotBlocks = splitPromptByShotHeaders(raw);
    if (shotBlocks.length > 0) {
      return shotBlocks.map(block => ({ text: block, duration: parseSceneDuration(block) })).filter(item => item.text);
    }

    const numberedBlockRegex = /(?:^|\n)\s*(?:第\s*)?(\d{1,4})(?:\s*[.．](?!\d)|\s*[、:：）)]|\s*段[：:]?)\s*\n?/g;
    const matches = [...raw.matchAll(numberedBlockRegex)];
    if (matches.length > 0) {
      return matches.map((match, index) => {
        const contentStart = match.index + match[0].length;
        const contentEnd = index + 1 < matches.length ? matches[index + 1].index : raw.length;
        return { text: raw.slice(contentStart, contentEnd).trim(), duration: '' };
      }).filter(item => item.text);
    }

    return raw
      .split(/\n{2,}/)
      .map(block => block.trim())
      .filter(Boolean)
      .flatMap(block => block.includes('\n')
        ? block.split('\n').map(line => line.trim()).filter(Boolean).map(line => ({ text: line, duration: '' }))
        : [{ text: block, duration: '' }]);
  };

  const applyBatchPrompts = () => {
    const promptBlocks = parseBatchPromptBlocks(batchPromptText);
    if (promptBlocks.length === 0) {
      alert('请先输入要批量添加的提示词。支持 1.、2.、3. 分段，也支持“## 标题 - [镜头1 / 15.0s]”格式。');
      return;
    }

    setSegments(prev => {
      const nextSegments = [...prev];
      let nextId = nextSegments.length > 0 ? Math.max(...nextSegments.map(s => Number(s.id) || 0)) + 1 : 1;
      while (nextSegments.length < promptBlocks.length) {
        nextSegments.push(createSegmentRow(nextId++, ''));
      }
      return nextSegments.map((seg, index) => {
        if (index >= promptBlocks.length) return seg;
        const promptBlock = promptBlocks[index];
        const currentText = promptDraftsRef.current[seg.id] ?? seg.text ?? '';
        const nextText = batchPromptMode === 'append' && currentText.trim()
          ? `${currentText.trim()}\n${promptBlock.text}`
          : promptBlock.text;
        promptDraftsRef.current[seg.id] = nextText;
        const textarea = promptTextareaRefs.current[seg.id];
        if (textarea) {
          textarea.value = nextText;
          resizePromptTextarea(textarea);
        }
        return { ...seg, text: nextText, ...(promptBlock.duration ? { duration: promptBlock.duration } : {}) };
      });
    });

    setShowBatchPromptModal(false);
    alert(`批量提示词已应用：${promptBlocks.length} 条。`);
  };

  const importAssetImages = async (assetType = activeAssetSubTab) => {
    const typeLabel = assetType === 'character' ? '角色' : assetType === 'scene' ? '场景' : '物品';
    const selected = await selectLocalImageDirectory();
    if (selected?.canceled) return;
    let filePaths = selected?.filePaths || [];
    if (!filePaths.length) {
      alert(`所选文件夹中没有可导入的图片文件。`);
      return;
    }

    filePaths = sortFilePathsByName(filePaths.filter(isImageFilePath));
    if (filePaths.length === 0) {
      alert('没有选择有效图片文件。');
      return;
    }

    const makeAssets = (existing = []) => {
      const existingNames = new Set(existing.map(asset => String(asset.name || '').trim()).filter(Boolean));
      const imported = [];
      filePaths.forEach((filePath, index) => {
        const rawBaseName = getFileStem(filePath) || `${typeLabel}${index + 1}`;
        const baseName = cleanAssetName(rawBaseName, assetType === 'scene' ? '$' : assetType === 'item' ? '#' : '@') || `${typeLabel}${index + 1}`;
        let name = baseName;
        let suffix = 2;
        while (existingNames.has(name)) {
          name = `${baseName}-${suffix++}`;
        }
        existingNames.add(name);
        const common = {
          id: `${assetType}-${Date.now()}-${index}`,
          name,
          role: typeLabel,
          avatar: makeLocalFileUrl(filePath),
          avatarPath: filePath,
        };
        imported.push(common);
      });
      return imported;
    };

    if (assetType === 'character') {
      setCharacterAssets(prev => [...prev, ...makeAssets(prev)]);
    } else if (assetType === 'scene') {
      setSceneAssets(prev => [...prev, ...makeAssets(prev)]);
    } else {
      setItemAssets(prev => [...prev, ...makeAssets(prev)]);
    }
    setActiveAssetSubTab(assetType);
    alert(`已从文件夹导入 ${filePaths.length} 个${typeLabel}，名称已使用图片文件名并自动去除编号/触发符前缀。`);
  };

  const [segments, setSegments] = useState([]);

  useEffect(() => {
    archiveInterruptedOreateaiTasks();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const loadProjectPayload = async () => {
      isLoadingProjectRef.current = true;
      try {
        const res = await fetch(`${WIZSTAR_API}/projects/${encodeURIComponent(draftId)}/payload`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (cancelled) return;
        let loadedSegments = asArray(data.data?.segments).map(normalizeSegmentRecord);
        const loadedChars = asArray(data.data?.character_assets).map((asset) => (
          asset && typeof asset === 'object'
            ? { ...asset }
            : { id: String(asset || ''), name: String(asset || ''), role: '', avatar: '', avatarPath: '' }
        ));
        const backendScenes = normalizeAssetNames(asArray(data.data?.scene_assets), '$');
        const backendItems = normalizeAssetNames(asArray(data.data?.item_assets), '#');
        let cachedScenes = [];
        let cachedItems = [];
        try {
          cachedScenes = normalizeAssetNames(parseArrayFromStorage(STORAGE_KEY_SCENES), '$');
          cachedItems = normalizeAssetNames(parseArrayFromStorage(STORAGE_KEY_ITEMS), '#');
        } catch (_) {}
        // Existing users may still have scene/item assets only in localStorage.
        // Prefer MySQL once populated, otherwise migrate the local cache forward.
        const loadedScenes = backendScenes.length > 0 ? backendScenes : cachedScenes;
        const loadedItems = backendItems.length > 0 ? backendItems : cachedItems;
        const shouldMigrateLocalAssets =
          (backendScenes.length === 0 && cachedScenes.length > 0)
          || (backendItems.length === 0 && cachedItems.length > 0);
        // Backfill pendingAccounts from the backend Dola task list for segments that
        // have pendingTaskIds but no pendingAccounts yet. This recovers the "generating
        // placeholder cell" state right after refresh, even for older tasks.
        try {
          const hasPending = loadedSegments.some(s => {
            const ids = [...new Set([s.pendingTaskId, ...(s.pendingTaskIds || [])].filter(Boolean))];
            return ids.length > 0;
          });
          if (hasPending) {
            const tRes = await fetch(`${WIZSTAR_API}/dola/tasks?limit=200`);
            if (tRes.ok) {
              const tData = await tRes.json();
              const byId = new Map(asArray(tData.data).map(t => [t.task_id, t]));
              const DONE = new Set(['completed', 'failed', 'done', 'succeeded']);
              loadedSegments = loadedSegments.map(s => {
                const ids = [...new Set([s.pendingTaskId, ...(s.pendingTaskIds || [])].filter(Boolean))];
                if (ids.length === 0) return s;
                // Even if pendingAccounts already exists, correct each entry's
                // accountId/accountName from the backend task list to fix stale data.
                if (s.pendingAccounts && s.pendingAccounts.length) {
                  const corrected = s.pendingAccounts.map(a => {
                    const t = byId.get(a.taskId);
                    if (!t) return a;
                    return {
                      ...a,
                      accountId: t.account_id || a.accountId || 0,
                      accountName: t.account_name || a.accountName || '',
                    };
                  });
                  const changed = corrected.some((a, i) => a.accountId !== s.pendingAccounts[i].accountId);
                  return changed ? { ...s, pendingAccounts: corrected } : s;
                }
                const rebuilt = ids.map(tid => {
                  const t = byId.get(tid);
                  if (!t) return null;
                  if (DONE.has(String(t.status || '').toLowerCase())) return null;
                  return {
                    taskId: tid,
                    accountId: t.account_id || 0,
                    accountName: t.account_name || '',
                    conversationId: t.conversation_id || '',
                    localConversationId: t.local_conversation_id || '',
                    pageUrl: t.page_url || '',
                    sendMode: 'api',
                    sendModeLabel: t.send_mode_label || '纯 API（默认）',
                    browserHeadless: false,
                    status: t.status || 'processing',
                    startedAt: Date.now(),
                  };
                }).filter(Boolean);
                if (rebuilt.length === 0) {
                  // 所有相关任务都已结束：清掉残留的占位格子，避免它们永远转圈
                  const hasStalePending = (s.pendingAccounts || []).length > 0;
                  if (!hasStalePending) return s;
                  return {
                    ...s,
                    pendingAccounts: [],
                    generating: false,
                  };
                }
                const anyActive = ids.some(tid => {
                  const t = byId.get(tid);
                  return t && !DONE.has(String(t.status || '').toLowerCase());
                });
                // 用重建的活跃账号列表替换，同时清掉 pendingAccounts 里引用已结束任务的残留项
                const rebuiltTaskIds = new Set(rebuilt.map(r => r.taskId));
                const preserved = (s.pendingAccounts || []).filter(a =>
                  !ids.includes(a.taskId) && !rebuiltTaskIds.has(a.taskId)
                );
                return {
                  ...s,
                  pendingAccounts: [...rebuilt, ...preserved],
                  generating: anyActive ? true : s.generating,
                  pendingChannel: s.pendingChannel || 'dola',
                  generateStatus: anyActive ? (s.generateStatus || 'processing') : s.generateStatus,
                };
              });
            }
          }
        } catch (e) {
          // backfill is best-effort; ignore errors
        }
        // Sync corrected accountId from pendingAccounts into the generation task registry
        // so the poller uses the right account info instead of stale data.
        try {
          const reg = readGenerationTaskRegistry();
          let regChanged = false;
          loadedSegments.forEach(s => {
            (s.pendingAccounts || []).forEach(pa => {
              if (!pa.taskId || !pa.accountId) return;
              const idx = reg.findIndex(r => r.taskId === pa.taskId);
              if (idx >= 0 && reg[idx].accountId !== pa.accountId) {
                reg[idx] = { ...reg[idx], accountId: pa.accountId, accountName: pa.accountName || reg[idx].accountName || '' };
                regChanged = true;
              }
            });
          });
          if (regChanged) writeGenerationTaskRegistry(reg);
        } catch (_) {}
        // Merge back referenceImage AND materialsVideo/materialsImage from localStorage cache
        // for segments where backend data lost them (e.g. unmount flush failed or fetch was cancelled).
        try {
          const rawLocal = localStorage.getItem(STORAGE_KEY_SEGMENTS);
          if (rawLocal) {
            const localSegs = JSON.parse(rawLocal);
            if (Array.isArray(localSegs)) {
              const localById = new Map(localSegs.map(s => [String(s.id), s]));
              loadedSegments = loadedSegments.map(s => {
                const local = localById.get(String(s.id));
                if (!local) return s;
                const hasRefRemote = !!(s.referenceImage && typeof s.referenceImage === 'object' && (s.referenceImage.displayUrl || s.referenceImage.dataUrl || s.referenceImage.remoteUrl || s.referenceImage.localPath));
                const hasRefLocal = !!(local.referenceImage && typeof local.referenceImage === 'object' && (local.referenceImage.displayUrl || local.referenceImage.dataUrl || local.referenceImage.remoteUrl || local.referenceImage.localPath));
                let merged = s;
                if (!hasRefRemote && hasRefLocal) {
                  merged = { ...merged, referenceImage: local.referenceImage, referenceImagePath: local.referenceImagePath || merged.referenceImagePath };
                }
                // Recover materialsVideo if backend lost them but localStorage has them
                const localVidCount = (local.materialsVideo || []).length;
                const remoteVidCount = (merged.materialsVideo || []).length;
                if (localVidCount > remoteVidCount) {
                  merged = { ...merged, materialsVideo: local.materialsVideo };
                  // Also recover currentMaterialVideo if it points to a valid material
                  const localCurVid = local.currentMaterialVideo;
                  if (localCurVid && typeof localCurVid === 'object' && localCurVid.thumbnail) {
                    merged = { ...merged, currentMaterialVideo: localCurVid };
                  }
                }
                // Recover materialsImage if backend lost them but localStorage has them
                const localImgCount = (local.materialsImage || []).length;
                const remoteImgCount = (merged.materialsImage || []).length;
                if (localImgCount > remoteImgCount) {
                  merged = { ...merged, materialsImage: local.materialsImage };
                  const localCurImg = local.currentMaterialImage;
                  if (localCurImg && typeof localCurImg === 'object' && localCurImg.thumbnail) {
                    merged = { ...merged, currentMaterialImage: localCurImg };
                  }
                }
                return merged;
              });
            }
          }
        } catch (_) {}
        setSegments(loadedSegments);
        setCharacterAssets(loadedChars);
        setSceneAssets(loadedScenes);
        setItemAssets(loadedItems);
        // Only update localStorage cache if the merged data is richer than what's already cached.
        // This prevents overwriting a richer localStorage cache with stale backend data.
        try {
          const rawLocal = localStorage.getItem(STORAGE_KEY_SEGMENTS);
          const localSegs = rawLocal ? JSON.parse(rawLocal) : [];
          const localById = new Map((Array.isArray(localSegs) ? localSegs : []).map(s => [String(s.id), s]));
          const isRicher = loadedSegments.some(s => {
            const local = localById.get(String(s.id));
            if (!local) return true; // new segment in backend
            const localVids = (local.materialsVideo || []).length;
            const remoteVids = (s.materialsVideo || []).length;
            return remoteVids > localVids;
          });
          if (isRicher || !rawLocal) {
            setLocalStorageJson(STORAGE_KEY_SEGMENTS, loadedSegments, stripLargePreviewPayload(loadedSegments));
          }
        } catch (_) {
          setLocalStorageJson(STORAGE_KEY_SEGMENTS, loadedSegments, stripLargePreviewPayload(loadedSegments));
        }
        setLocalStorageJson(STORAGE_KEY_CHARS, loadedChars, stripLargePreviewPayload(loadedChars));
        setLocalStorageJson(STORAGE_KEY_SCENES, loadedScenes, stripLargePreviewPayload(loadedScenes));
        setLocalStorageJson(STORAGE_KEY_ITEMS, loadedItems, stripLargePreviewPayload(loadedItems));
        if (shouldMigrateLocalAssets) {
          fetch(`${WIZSTAR_API}/projects/${encodeURIComponent(draftId)}/payload`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              scene_assets: loadedScenes,
              item_assets: loadedItems,
            }),
          }).catch((error) => console.warn('迁移场景/物品资产到 MySQL 失败:', error));
        }
      } catch (e) {
        console.warn('读取后端项目内容失败，临时回退到浏览器本地缓存:', e);
        if (cancelled) return;
        try {
          const rawSegments = localStorage.getItem(STORAGE_KEY_SEGMENTS);
          const rawChars = localStorage.getItem(STORAGE_KEY_CHARS);
          setSegments(asArray(rawSegments ? JSON.parse(rawSegments) : []).map(normalizeSegmentRecord));
          setCharacterAssets(asArray(rawChars ? JSON.parse(rawChars) : []).map((asset) => (
            asset && typeof asset === 'object'
              ? { ...asset }
              : { id: String(asset || ''), name: String(asset || ''), role: '', avatar: '', avatarPath: '' }
          )));
        } catch {
          setSegments([]);
          setCharacterAssets([]);
        }
      } finally {
        setTimeout(() => { isLoadingProjectRef.current = false; }, 0);
      }
    };
    loadProjectPayload();
    return () => { cancelled = true; };
  }, [
    draftId,
    STORAGE_KEY_SEGMENTS,
    STORAGE_KEY_CHARS,
    STORAGE_KEY_SCENES,
    STORAGE_KEY_ITEMS,
    WIZSTAR_API,
  ]);

  // Auto-save all project assets to backend MySQL, with localStorage as a fallback cache.
  useEffect(() => {
    if (isLoadingProjectRef.current) return;
    const toSave = segments.map(s => ({
      ...s,
      generating: false,
      generateStatus: null,
      generateProgress: null,
      queuePosition: null,
      elapsedSeconds: null,
      remainingSeconds: null,
      timeoutSeconds: null,
      estimatedWaitSeconds: null,
    }));
    // Strip base64 data URLs from asset avatars to avoid huge persist payloads.
    // If avatarPath exists, the avatar can be reconstructed via file:// URL on load.
    const serializeAssets = (assets) => assets.map((asset) => {
      if (asset.avatar && asset.avatar.startsWith('data:image/') && asset.avatarPath) {
        return { ...asset, avatar: makeLocalFileUrl(asset.avatarPath) };
      }
      return asset;
    });
    const charsToSave = serializeAssets(characterAssets);
    const scenesToSave = serializeAssets(sceneAssets);
    const itemsToSave = serializeAssets(itemAssets);
    const payloadToSave = {
      segments: toSave,
      character_assets: charsToSave,
      scene_assets: scenesToSave,
      item_assets: itemsToSave,
    };
    const persistKey = JSON.stringify(payloadToSave);
    if (persistKey === lastPersistKeyRef.current) return;
    lastPersistKeyRef.current = persistKey;
    setLocalStorageJson(STORAGE_KEY_SEGMENTS, toSave, stripLargePreviewPayload(toSave));
    setLocalStorageJson(STORAGE_KEY_CHARS, charsToSave, stripLargePreviewPayload(charsToSave));
    setLocalStorageJson(STORAGE_KEY_SCENES, scenesToSave, stripLargePreviewPayload(scenesToSave));
    setLocalStorageJson(STORAGE_KEY_ITEMS, itemsToSave, stripLargePreviewPayload(itemsToSave));

    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`${WIZSTAR_API}/projects/${encodeURIComponent(draftId)}/payload`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payloadToSave),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        onProjectChanged?.();
      } catch (e) {
        console.warn('Failed to save project payload:', e);
      }
    }, 500);

    return () => {
      clearTimeout(timer);
      // Flush current pending save to backend so changes are not lost when
      // switching tabs quickly or closing the app. Use keepalive so the fetch
      // completes even if the Electron process is exiting.
      try {
        fetch(`${WIZSTAR_API}/projects/${encodeURIComponent(draftId)}/payload`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payloadToSave),
          keepalive: true,
        }).catch(() => {});
      } catch (_) {}
    };
  }, [
    segments,
    characterAssets,
    sceneAssets,
    itemAssets,
    draftId,
    STORAGE_KEY_SEGMENTS,
    STORAGE_KEY_CHARS,
    STORAGE_KEY_SCENES,
    STORAGE_KEY_ITEMS,
    WIZSTAR_API,
    onProjectChanged,
  ]);

  // Sync project-level progress/status back to the projects table so the Dashboard
  // cards reflect real generation progress instead of staying stuck at 0/0.
  const lastProgressSyncRef = useRef('');
  useEffect(() => {
    if (isLoadingProjectRef.current) return;
    if (draftId === 'default') return;

    const segHasContent = (s) => (String(s.text || '').trim()) || (s.materialsVideo && s.materialsVideo.length) || (s.materialsImage && s.materialsImage.length);
    const segHasResult = (s) => (s.materialsVideo && s.materialsVideo.length) || (s.materialsImage && s.materialsImage.length);
    const totalSegs = segments.filter(segHasContent).length;
    const doneSegs = segments.filter(segHasResult).length;
    const anyGenerating = segments.some(s => s.generating || s.generateStatus === 'processing' || s.generateStatus === 'pending' || s.generateStatus === 'collecting' || s.generateStatus === 'collectable');
    const nextProgress = totalSegs > 0 ? `${doneSegs}/${totalSegs}` : '0/0';
    const nextStatus = totalSegs === 0 ? '未生成' : (doneSegs >= totalSegs ? '已完成' : (doneSegs > 0 || anyGenerating ? '生成中' : '未生成'));
    const syncKey = `${nextProgress}|${nextStatus}`;
    if (syncKey === lastProgressSyncRef.current) return;
    lastProgressSyncRef.current = syncKey;

    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`${WIZSTAR_API}/projects/${encodeURIComponent(draftId)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: draftId,
            title: activeDraft?.title || '',
            date: activeDraft?.date || '',
            time: activeDraft?.time || '',
            collection: activeDraft?.collection || '',
            thumbnail: activeDraft?.thumbnail || '',
            progress: nextProgress,
            status: nextStatus,
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        onProjectChanged?.();
      } catch (e) {
        console.warn('Failed to sync project progress:', e);
      }
    }, 800);
    return () => clearTimeout(timer);
  }, [segments, draftId, activeDraft, WIZSTAR_API, onProjectChanged]);

  useEffect(() => {
    if (isLoadingProjectRef.current) return;
    setLocalStorageJson(STORAGE_KEY_CHARS, characterAssets, stripLargePreviewPayload(characterAssets));
  }, [characterAssets, STORAGE_KEY_CHARS]);

  useEffect(() => {
    if (isLoadingProjectRef.current) return;
    setLocalStorageJson(STORAGE_KEY_SCENES, sceneAssets, stripLargePreviewPayload(sceneAssets));
  }, [sceneAssets, STORAGE_KEY_SCENES]);

  useEffect(() => {
    if (isLoadingProjectRef.current) return;
    setLocalStorageJson(STORAGE_KEY_ITEMS, itemAssets, stripLargePreviewPayload(itemAssets));
  }, [itemAssets, STORAGE_KEY_ITEMS]);

  // Reload scene/item assets from local cache when switching drafts
  useEffect(() => {
    try {
      const rawScenes = localStorage.getItem(STORAGE_KEY_SCENES);
      const rawItems = localStorage.getItem(STORAGE_KEY_ITEMS);
      const nextScenes = asArray(rawScenes ? JSON.parse(rawScenes) : []);
      const nextItems = asArray(rawItems ? JSON.parse(rawItems) : []);
      setSceneAssets(normalizeAssetNames(nextScenes, '$'));
      setItemAssets(normalizeAssetNames(nextItems, '#'));
    } catch {
      setSceneAssets([]);
      setItemAssets([]);
    }
  }, [STORAGE_KEY_SCENES, STORAGE_KEY_ITEMS]);

  // Persist global generation settings across all projects
  useEffect(() => {
    const settings = {
      model: globalModel,
      aspectRatio: globalAspectRatio,
      duration: globalDuration,
      resolution: globalResolution,
      generateChannel,
    };
    try {
      localStorage.setItem(GLOBAL_GENERATION_SETTINGS_KEY, JSON.stringify(settings));
      localStorage.setItem('maocanju_generate_channel', generateChannel);
    } catch (e) {
      console.warn('Failed to save global generation settings:', e);
    }
  }, [globalModel, globalAspectRatio, globalDuration, globalResolution, generateChannel]);

  useEffect(() => {
    const normalizedAspectRatio = normalizeAspectRatio(globalAspectRatio, {
      channel: generateChannel,
      modelName: globalModel,
      mediaType: getModelMediaType(globalModel),
    });
    if (normalizedAspectRatio === globalAspectRatio) return;
    setGlobalAspectRatio(normalizedAspectRatio);
    setSegments(prev => prev.map(seg => {
      const rowMediaType = seg.type || getModelMediaType(seg.model || globalModel);
      return {
        ...seg,
        aspectRatio: normalizeAspectRatio(seg.aspectRatio || normalizedAspectRatio, {
          channel: generateChannel,
          modelName: seg.model || globalModel,
          mediaType: rowMediaType,
        }),
      };
    }));
  }, [globalModel, globalAspectRatio, generateChannel]);

  const updateGlobalAspectRatio = (aspectRatio) => {
    const normalizedAspectRatio = normalizeAspectRatio(aspectRatio, {
      channel: generateChannel,
      modelName: globalModel,
      mediaType: getModelMediaType(globalModel),
    });
    setGlobalAspectRatio(normalizedAspectRatio);
    setSegments(prev => prev.map(seg => {
      const rowMediaType = seg.type || getModelMediaType(seg.model || globalModel);
      const rowAspectRatio = normalizeAspectRatio(normalizedAspectRatio, {
        channel: generateChannel,
        modelName: seg.model || globalModel,
        mediaType: rowMediaType,
      });
      return { ...seg, aspectRatio: rowAspectRatio };
    }));
  };

  const updateGlobalDuration = (duration) => {
    setGlobalDuration(duration);
    setSegments(prev => prev.map(seg => ({ ...seg, duration })));
  };

  const updateGlobalResolution = (quality) => {
    setGlobalResolution(quality);
    setSegments(prev => prev.map(seg => ({ ...seg, quality })));
  };

  const selectGenerationModel = (modelName, channel) => {
    const nextChannel = channel === 'quickframe' ? 'wizstar' : channel;
    if (nextChannel === 'oreateai') {
      const capability = getOreateaiCapability(modelName, oreateaiScene)
        || oreateaiCapabilities?.capabilities?.find((item) => item.modelName === modelName);
      if (capability) {
        setOreateaiScene(capability.scene);
        const combination = getOreateaiCombination(capability) || capability.combinations[0];
        const ratio = capability.ratios.includes(globalAspectRatio) ? globalAspectRatio : capability.ratios[0];
        setGlobalModel(modelName);
        setGenerateChannel(nextChannel);
        setModelPopoverTab('video');
        setGlobalAspectRatio(ratio);
        setGlobalDuration(`${combination.duration}秒`);
        setGlobalResolution(combination.resolution);
        setSegments((prev) => prev.map((segment) => ({
          ...segment,
          type: 'video',
          model: modelName,
          aspectRatio: ratio,
          duration: `${combination.duration}秒`,
          quality: combination.resolution,
          resolution: combination.resolution,
        })));
        setActivePopover(null);
        return;
      }
    }
    const nextType = getModelMediaType(modelName);
    const tensorartDurationSeconds = Math.min(
      10,
      Math.max(4, Math.round(parseDurationSeconds(globalDuration, 4))),
    );
    const nextDuration = nextChannel === 'tensorart' ? `${tensorartDurationSeconds}秒` : globalDuration;
    const nextResolution = nextChannel === 'tensorart' ? '480p' : globalResolution;
    const nextAspectRatio = normalizeAspectRatio(globalAspectRatio, {
      channel: nextChannel,
      modelName,
      mediaType: nextType,
    });
    setGlobalModel(modelName);
    setGenerateChannel(nextChannel);
    setModelPopoverTab(nextType);
    setGlobalAspectRatio(nextAspectRatio);
    if (nextChannel === 'tensorart') {
      setGlobalDuration(nextDuration);
      setGlobalResolution(nextResolution);
    }
    setSegments(prev => prev.map(seg => ({
      ...seg,
      model: modelName,
      type: nextType,
      aspectRatio: nextAspectRatio,
      duration: nextDuration,
      quality: nextResolution,
      resolution: nextResolution,
    })));
    setActivePopover(null);
  };

  // Optimize Prompt using mock AI
  const handleInference = (id) => {
    alert(`第 ${id} 行描述词优化成功！已注入电影级镜头参数。`);
  };

  // Generate / Render Material for specific row — calls Wizstar API

  // Register tasks globally; one lightweight scheduler polls them in batches, even if the current project is closed/switched.
  const registerGenerationTask = useCallback((segId, taskId, channel = 'wizstar', mediaType = 'video', meta = {}) => {
    if (!taskId) return;
    const now = Date.now();
    const registry = readGenerationTaskRegistry();
    const nextTask = {
      draftId,
      segId,
      taskId,
      channel,
      mediaType,
      status: meta.status || 'processing',
      progress: typeof meta.progress === 'number' ? meta.progress : 0,
      queuePosition: meta.queuePosition ?? null,
      elapsedSeconds: meta.elapsedSeconds ?? null,
      remainingSeconds: meta.remainingSeconds ?? null,
      timeoutSeconds: meta.timeoutSeconds ?? null,
      estimatedWaitSeconds: meta.estimatedWaitSeconds ?? null,
      startedAtSeconds: meta.startedAtSeconds ?? null,
      accountId: meta.accountId || 0,
      accountName: meta.accountName || '',
      conversationId: meta.conversationId || '',
      localConversationId: meta.localConversationId || '',
      pageUrl: meta.pageUrl || '',
      sendMode: meta.sendMode || '',
      sendModeLabel: meta.sendModeLabel || '',
      browserHeadless: !!meta.browserHeadless,
      requestId: meta.requestId || '',
      createdAt: now,
      updatedAt: now,
    };
    const exists = registry.some(t => t.taskId === taskId);
    writeGenerationTaskRegistry(exists
      ? registry.map(t => t.taskId === taskId ? {
        ...t,
        ...nextTask,
        accountId: nextTask.accountId || t.accountId || 0,
        accountName: nextTask.accountName || t.accountName || '',
        queuePosition: nextTask.queuePosition ?? t.queuePosition ?? null,
        elapsedSeconds: nextTask.elapsedSeconds ?? t.elapsedSeconds ?? null,
        remainingSeconds: nextTask.remainingSeconds ?? t.remainingSeconds ?? null,
        timeoutSeconds: nextTask.timeoutSeconds ?? t.timeoutSeconds ?? null,
        estimatedWaitSeconds: nextTask.estimatedWaitSeconds ?? t.estimatedWaitSeconds ?? null,
        startedAtSeconds: nextTask.startedAtSeconds ?? t.startedAtSeconds ?? null,
        conversationId: nextTask.conversationId || t.conversationId || '',
        localConversationId: nextTask.localConversationId || t.localConversationId || '',
        pageUrl: nextTask.pageUrl || t.pageUrl || '',
        sendMode: nextTask.sendMode || t.sendMode || '',
        sendModeLabel: nextTask.sendModeLabel || t.sendModeLabel || '',
        browserHeadless: nextTask.browserHeadless ?? t.browserHeadless ?? false,
        createdAt: (nextTask.status === 'collecting' || nextTask.status === 'collectable') ? now : (t.createdAt || now),
      } : t)
      : [...registry, nextTask]);
    startGlobalGenerationPolling();
  }, [draftId]);
  useEffect(() => {
    startGlobalGenerationPolling();
  }, []);

  useEffect(() => {
    if (isLoadingProjectRef.current) return;
    const registry = readGenerationTaskRegistry();
    const registeredIds = new Set(registry.map(task => task.taskId).filter(Boolean));
    const now = Date.now();
    const recoveredTasks = [];

    segments.forEach((seg) => {
      const pendingIds = [...new Set([seg.pendingTaskId, ...(seg.pendingTaskIds || [])].filter(Boolean))];
      pendingIds.forEach((taskId) => {
        if (registeredIds.has(taskId)) return;
        const pendingAccount = (seg.pendingAccounts || []).find(item => item?.taskId === taskId) || {};
        recoveredTasks.push({
          draftId,
          segId: seg.id,
          taskId,
          channel: seg.pendingChannel || pendingAccount.channel || 'wizstar',
          mediaType: seg.type || 'video',
          status: seg.generateStatus || pendingAccount.status || 'processing',
          progress: typeof seg.generateProgress === 'number' ? seg.generateProgress : 0,
          queuePosition: seg.queuePosition ?? null,
          elapsedSeconds: seg.elapsedSeconds ?? null,
          remainingSeconds: seg.remainingSeconds ?? null,
          timeoutSeconds: seg.timeoutSeconds ?? null,
          estimatedWaitSeconds: seg.estimatedWaitSeconds ?? null,
          startedAtSeconds: seg.startedAtSeconds ?? null,
          accountId: pendingAccount.accountId || seg.pendingAccountId || 0,
          accountName: pendingAccount.accountName || seg.pendingAccountName || '',
          conversationId: pendingAccount.conversationId || seg.pendingConversationId || '',
          localConversationId: pendingAccount.localConversationId || seg.pendingLocalConversationId || '',
          pageUrl: pendingAccount.pageUrl || seg.pendingDolaPageUrl || '',
          sendMode: pendingAccount.sendMode || seg.pendingDolaSendMode || '',
          sendModeLabel: pendingAccount.sendModeLabel || seg.pendingDolaSendModeLabel || '',
          browserHeadless: pendingAccount.browserHeadless ?? seg.pendingDolaHeadless ?? false,
          requestId: seg.pendingRequestId || '',
          recoveredFromSegment: true,
          createdAt: pendingAccount.startedAt || now,
          updatedAt: now,
        });
      });
    });

    if (recoveredTasks.length > 0) {
      writeGenerationTaskRegistry([...registry, ...recoveredTasks]);
      startGlobalGenerationPolling();
    }
  }, [segments, draftId]);

  // Keep only the currently visible project's rows in sync. Polling itself is global and survives project close/switch.
  useEffect(() => {
    const timer = window.setInterval(() => {
      const registry = readGenerationTaskRegistry();
      const currentTasks = registry.filter(t => t.draftId === draftId);
      if (currentTasks.length === 0) return;

      const tasksBySegId = new Map();
      currentTasks.forEach(task => {
        const list = tasksBySegId.get(task.segId) || [];
        list.push(task);
        tasksBySegId.set(task.segId, list);
      });
      const doneIds = new Set();
      let changed = false;

      setSegments(prev => {
        const next = prev.map(seg => {
          const tasks = tasksBySegId.get(seg.id) || [];
          if (tasks.length === 0) return seg;

          let nextSeg = seg;
          let rowChanged = false;
          const acceptedTaskIds = new Set([seg.pendingTaskId, ...(seg.pendingTaskIds || [])].filter(Boolean));
          const primaryTaskId = seg.pendingPrimaryTaskId || [...acceptedTaskIds][acceptedTaskIds.size - 1] || '';

          tasks.forEach(task => {
            const taskBelongsToCurrentRow = acceptedTaskIds.has(task.taskId);
            if (!taskBelongsToCurrentRow) {
              if (acceptedTaskIds.size === 0 || ['completed', 'failed'].includes(task.status)) {
                doneIds.add(task.taskId);
                // 清理残留的占位格子：任务已结束但 pendingAccounts 仍引用它
                const stale = (nextSeg.pendingAccounts || []).some(a => a.taskId === task.taskId);
                if (stale) {
                  rowChanged = true;
                  nextSeg = {
                    ...nextSeg,
                    pendingAccounts: (nextSeg.pendingAccounts || []).filter(a => a.taskId !== task.taskId),
                  };
                }
              }
              return;
            }
            const completedMediaUrl = task.mediaUrl || task.imageUrl || task.videoUrl || task.cdnUrl || task.downloadUrl || '';
            const completedLocalPath = task.localPath || localFilePathFromUrl(completedMediaUrl);
            if (task.status === 'completed' && (completedMediaUrl || completedLocalPath)) {
              doneIds.add(task.taskId);
              rowChanged = true;
              // Remove this finished task from pendingAccounts so its placeholder cell disappears.
              nextSeg = { ...nextSeg, pendingAccounts: (nextSeg.pendingAccounts || []).filter(a => a.taskId !== task.taskId) };
              const shouldPromoteResult = !nextSeg.isLocked && task.taskId === primaryTaskId;
              const localPath = completedLocalPath;
              const sourceUrl = task.videoUrl || task.downloadUrl || task.cdnUrl || task.mediaUrl || completedMediaUrl;
              const resultPayload = taskPayloadLike(task);
              const isVid = inferResultMediaType(resultPayload, task, sourceUrl || completedMediaUrl) === 'video';
              const playableUrl = localPath
                ? (isVid ? toLocalVideoUrl(localPath) : toLocalImageUrl(localPath))
                : toPlayableUrl(sourceUrl || completedMediaUrl);
              const list = isVid ? nextSeg.materialsVideo : nextSeg.materialsImage;
              const normalizedMediaUrl = (localPath || sourceUrl || playableUrl).split('?')[0];
              const existing = list.find(m => ((m.localPath || m.sourceUrl || m.thumbnail || '').split('?')[0]) === normalizedMediaUrl);

              if (existing) {
                nextSeg = {
                  ...nextSeg,
                  type: isVid ? 'video' : 'image',
                  generationError: '',
                  ...(isVid
                    ? { currentMaterialVideo: shouldPromoteResult ? existing : nextSeg.currentMaterialVideo }
                    : { currentMaterialImage: shouldPromoteResult ? existing : nextSeg.currentMaterialImage }),
                };
                return;
              }

              const newMatId = Math.max(...list.map(m => m.id), 0) + 1;
              const matName = `${task.segId}-${newMatId}`;
              if (isVid) {
                const newMat = { id: newMatId, name: matName, thumbnail: playableUrl, sourceUrl, localPath, remoteUrl: sourceUrl, mediaType: 'video', taskId: task.taskId, requestId: task.requestId || '', conversationId: task.conversationId || '', accountId: task.accountId || 0, accountName: task.accountName || '', status: 'new', textStatus: localPath ? '本地' : '新' };
                nextSeg = {
                  ...nextSeg,
                  type: 'video',
                  generationError: '',
                  materialsVideo: [newMat, ...nextSeg.materialsVideo],
                  currentMaterialVideo: shouldPromoteResult ? {
                    id: newMatId, name: matName, thumbnail: playableUrl, sourceUrl, localPath, remoteUrl: sourceUrl, mediaType: 'video', taskId: task.taskId, requestId: task.requestId || '', conversationId: task.conversationId || '', isPlaying: false, fps: 25, duration: '00:05'
                  } : nextSeg.currentMaterialVideo
                };
                return;
              }

              const newMat = { id: newMatId, name: matName, thumbnail: playableUrl, sourceUrl, localPath, remoteUrl: sourceUrl, mediaType: 'image', taskId: task.taskId, requestId: task.requestId || '', conversationId: task.conversationId || '', accountId: task.accountId || 0, accountName: task.accountName || '', status: 'new', textStatus: '图' };
              nextSeg = {
                ...nextSeg,
                type: 'image',
                generationError: '',
                materialsImage: [newMat, ...nextSeg.materialsImage],
                currentMaterialImage: shouldPromoteResult ? {
                  id: newMatId, name: matName, thumbnail: playableUrl, sourceUrl, localPath, remoteUrl: sourceUrl, mediaType: 'image', taskId: task.taskId, requestId: task.requestId || '', conversationId: task.conversationId || '', fps: null, duration: '静态图片'
                } : nextSeg.currentMaterialImage
              };
              return;
            }

            if (task.status === 'failed') {
              doneIds.add(task.taskId);
              rowChanged = true;
              nextSeg = {
                ...nextSeg,
                pendingAccounts: (nextSeg.pendingAccounts || []).filter(a => a.taskId !== task.taskId),
                generationError: task.error || '生成任务失败，请检查账号、积分、模型或参考图后重试。',
                lastFailedTaskId: task.taskId,
                lastFailedChannel: task.channel,
                lastFailedAccountId: task.accountId || nextSeg.pendingAccountId || 0,
                lastConversationId: task.conversationId || nextSeg.pendingConversationId || '',
              };
            }
          });

          const activeTasks = tasks.filter(task => acceptedTaskIds.has(task.taskId) && !doneIds.has(task.taskId));
          if (activeTasks.length > 0) {
            const displayTask = activeTasks[activeTasks.length - 1];
            const nextStatus = ['pending', 'running', 'processing', 'collecting', 'collectable'].includes(displayTask.status) ? displayTask.status : (displayTask.status || 'processing');
            const nextProgress = typeof displayTask.progress === 'number' ? displayTask.progress : nextSeg.generateProgress;
            // collectable 表示"可手动采集"，不是正在生成：不套全屏转圈遮罩，
            // 只保留任务信息让 UI 显示"可手动采集"按钮，避免一直卡在"手动采集中..."。
            const isCollectableOnly = activeTasks.every(t => t.status === 'collectable');
            rowChanged = true;
            nextSeg = {
              ...nextSeg,
              generating: !isCollectableOnly,
              pendingTaskId: displayTask.taskId,
              pendingTaskIds: activeTasks.map(task => task.taskId),
              pendingPrimaryTaskId: nextSeg.pendingPrimaryTaskId || displayTask.taskId,
              pendingChannel: displayTask.channel,
              pendingAccountId: displayTask.accountId || nextSeg.pendingAccountId || 0,
              pendingAccountName: displayTask.accountName || nextSeg.pendingAccountName || '',
              pendingConversationId: displayTask.conversationId || nextSeg.pendingConversationId || '',
              pendingLocalConversationId: displayTask.localConversationId || nextSeg.pendingLocalConversationId || '',
              pendingDolaPageUrl: displayTask.pageUrl || nextSeg.pendingDolaPageUrl || '',
              pendingDolaSendMode: displayTask.sendMode || nextSeg.pendingDolaSendMode || '',
              pendingDolaSendModeLabel: displayTask.sendModeLabel || nextSeg.pendingDolaSendModeLabel || '',
              pendingDolaHeadless: displayTask.browserHeadless ?? nextSeg.pendingDolaHeadless ?? false,
              pendingAccounts: activeTasks.map(t => {
                const existing = (nextSeg.pendingAccounts || []).find(a => a.taskId === t.taskId);
                return {
                  taskId: t.taskId,
                  accountId: (existing && existing.accountId) || t.accountId || 0,
                  accountName: (existing && existing.accountName) || t.accountName || '',
                  conversationId: t.conversationId || (existing && existing.conversationId) || '',
                  localConversationId: t.localConversationId || (existing && existing.localConversationId) || '',
                  pageUrl: t.pageUrl || (existing && existing.pageUrl) || '',
                  sendMode: t.sendMode || (existing && existing.sendMode) || '',
                  sendModeLabel: t.sendModeLabel || (existing && existing.sendModeLabel) || '',
                  browserHeadless: t.browserHeadless ?? existing?.browserHeadless ?? false,
                  status: t.status || (existing && existing.status) || 'processing',
                  startedAt: (existing && existing.startedAt) || Date.now(),
                };
              }),
              generateStatus: nextStatus,
              queuePosition: displayTask.queuePosition,
              generateProgress: nextProgress,
              elapsedSeconds: displayTask.elapsedSeconds ?? nextSeg.elapsedSeconds ?? null,
              remainingSeconds: displayTask.remainingSeconds ?? nextSeg.remainingSeconds ?? null,
              timeoutSeconds: displayTask.timeoutSeconds ?? nextSeg.timeoutSeconds ?? null,
              estimatedWaitSeconds: displayTask.estimatedWaitSeconds ?? nextSeg.estimatedWaitSeconds ?? null,
              activeTaskCount: activeTasks.length,
            };
          } else if (rowChanged || nextSeg.generating || nextSeg.pendingTaskId) {
            // NOTE: do NOT clear pendingAccounts here. They are rebuilt from the
            // backend task list on load and only removed when a task actually
            // produces a material (handled in the completed branch above).
            nextSeg = {
              ...nextSeg,
              generating: false,
              pendingTaskId: null,
              pendingTaskIds: [],
              pendingPrimaryTaskId: '',
              pendingAccountId: 0,
              pendingAccountName: '',
              pendingConversationId: '',
              pendingLocalConversationId: '',
              pendingDolaPageUrl: '',
              pendingDolaSendMode: '',
              pendingDolaSendModeLabel: '',
              pendingDolaHeadless: false,
              generateStatus: null,
              queuePosition: null,
              generateProgress: null,
              elapsedSeconds: null,
              remainingSeconds: null,
              timeoutSeconds: null,
              estimatedWaitSeconds: null,
              activeTaskCount: 0,
            };
          }

          if (rowChanged) changed = true;
          return rowChanged ? nextSeg : seg;
        });
        return changed ? next : prev;
      });

      if (doneIds.size > 0) {
        writeGenerationTaskRegistry(readGenerationTaskRegistry().filter(t => !doneIds.has(t.taskId)));
      }
      // When segments changed (e.g. a video was just added), immediately flush to
      // both localStorage and backend instead of waiting for the debounced auto-save.
      // This prevents data loss if the app exits before the 500ms debounce fires.
      if (changed) {
        try {
          setSegments(prev => {
            const toSave = prev.map(s => ({
              ...s,
              generating: false,
              generateStatus: null,
              generateProgress: null,
              queuePosition: null,
            }));
            setLocalStorageJson(STORAGE_KEY_SEGMENTS, toSave, stripLargePreviewPayload(toSave));
            fetch(`${WIZSTAR_API}/projects/${encodeURIComponent(draftId)}/payload`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ segments: toSave, character_assets: characterAssets }),
              keepalive: true,
            }).catch(() => {});
            return prev;
          });
        } catch (_) {}
      }
    }, 1500);
    return () => window.clearInterval(timer);
  }, [draftId]);

  // After project payload loads, register persisted pending tasks instead of spawning per-task loops.
  useEffect(() => {
    if (isLoadingProjectRef.current) return;
    segments.forEach(seg => {
      const taskIds = [...new Set([seg.pendingTaskId, ...(seg.pendingTaskIds || [])].filter(Boolean))];
      taskIds.forEach(taskId => {
        registerGenerationTask(seg.id, taskId, seg.pendingChannel || 'wizstar', seg.type === 'image' ? 'image' : 'video', {
          accountId: seg.pendingAccountId || 0,
          accountName: seg.pendingAccountName || '',
          conversationId: seg.pendingConversationId || '',
          localConversationId: seg.pendingLocalConversationId || '',
          pageUrl: seg.pendingDolaPageUrl || '',
          sendMode: seg.pendingDolaSendMode || '',
          sendModeLabel: seg.pendingDolaSendModeLabel || '',
          status: seg.generateStatus || 'processing',
          progress: typeof seg.generateProgress === 'number' ? seg.generateProgress : 0,
          queuePosition: seg.queuePosition ?? null,
          elapsedSeconds: seg.elapsedSeconds ?? null,
          remainingSeconds: seg.remainingSeconds ?? null,
          timeoutSeconds: seg.timeoutSeconds ?? null,
          estimatedWaitSeconds: seg.estimatedWaitSeconds ?? null,
        });
      });
    });
  }, [segments, registerGenerationTask]); // eslint-disable-line react-hooks/exhaustive-deps

  const uploadImageRefForWizstar = async (imageRef, account) => {
    if (!imageRef) return '';
    if (imageRef.image) return imageRef.image;
    if (!account) {
      throw new Error('本地/角色图片需要先上传：当前没有可用的账号用于上传。请先在账号库注册一个账号。');
    }
    const uploadBody = { account_id: account.id };
    if (imageRef.file_path) uploadBody.file_path = imageRef.file_path;
    if (imageRef.data_url) uploadBody.data_url = imageRef.data_url;
    const uploadRes = await fetch(`${WIZSTAR_API}/tasks/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(uploadBody),
    });
    if (!uploadRes.ok) {
      let uploadErr = '图片上传失败';
      try { const e = await uploadRes.json(); uploadErr = e.detail || uploadErr; } catch (_) {}
      throw new Error(uploadErr);
    }
    const uploadData = await uploadRes.json();
    return uploadData.data?.url || '';
  };

  // Resolve a usable image URL for the given segment.
  // Reuses the Wizstar S3 upload to turn a local file into a remote URL when needed.
  // `account` is required for local upload.
  const resolveImageUrl = async (seg, id, account, promptText = '') => {
    const localImagePath = getReferenceLocalPath(seg);
    const remoteImageUrl = getReferenceRemoteUrl(seg);
    if (remoteImageUrl) return remoteImageUrl;
    if (localImagePath) {
      const picUrl = await uploadImageRefForWizstar({ file_path: localImagePath }, account);
      setSegments(prev => prev.map(s => s.id === id ? {
        ...s,
        referenceImage: { ...(s.referenceImage && typeof s.referenceImage === 'object' ? s.referenceImage : makeLocalReferenceImage(localImagePath)), uploadUrl: picUrl }
      } : s));
      return picUrl;
    }
    const roleBinding = getSegmentCharacterImageBindings(seg, promptText)[0] || null;
    const roleImageRef = roleBinding?.ref || null;
    if (roleImageRef) {
      const roleSource = roleImageRef.file_path
        || roleImageRef.image
        || (roleImageRef.data_url
          ? `data:${roleImageRef.data_url.length}:${roleImageRef.data_url.slice(0, 48)}:${roleImageRef.data_url.slice(-48)}`
          : '');
      const cachedRoleUpload = seg?.roleImageUploadCache;
      if (
        cachedRoleUpload?.alias === roleBinding.alias
        && cachedRoleUpload?.source === roleSource
        && cachedRoleUpload?.url
      ) {
        return cachedRoleUpload.url;
      }
      const picUrl = await uploadImageRefForWizstar(roleImageRef, account);
      setSegments(prev => prev.map(s => s.id === id ? {
        ...s,
        roleImageUploadCache: {
          alias: roleBinding.alias,
          source: roleSource,
          url: picUrl,
        },
      } : s));
      return picUrl;
    }
    if (getReferenceDisplayUrl(seg)?.startsWith('blob:')) {
      throw new Error('浏览器拖入的图片缺少本地路径，无法上传生成。请在桌面客户端中点击“垫图”选择文件。');
    }
    return '';
  };

  const hasActiveGenerationTask = (seg) => !!(seg?.generating || seg?.pendingTaskId || (seg?.pendingTaskIds || []).length > 0);

  const buildGenerationRequestId = (segId, channel = 'wizstar') => `${draftId}:${segId}:${channel}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;

  const selectOreateaiAssetsForRow = async (rowId) => {
    const capability = getOreateaiCapability();
    if (!capability) {
      alert('渠道八动态能力尚未加载，请先刷新配置。');
      return;
    }
    if (!window.electronAPI?.oreateaiSelectAssets) {
      alert('渠道八仅支持 Electron 桌面端。');
      return;
    }
    const response = await window.electronAPI.oreateaiSelectAssets({ allowVideos: capability.scene === 'reference' });
    if (!response?.ok) {
      alert(`选择素材失败：${response?.error || '未知错误'}`);
      return;
    }
    if (response.canceled) return;
    const selected = Array.isArray(response.assets) ? response.assets : [];
    const row = segments.find((segment) => segment.id === rowId);
    const nextAssets = [...(row?.oreateaiAssets || []), ...selected].map((asset) => ({
      path: asset.path,
      name: asset.name || String(asset.path || '').split(/[\\/]/).pop() || '素材',
      kind: asset.kind,
      size: Number(asset.size || 0),
      durationSec: Number(asset.durationSec || 0),
    }));
    const error = validateOreateaiAssetSelection(capability, nextAssets);
    if (error) {
      alert(`无法添加素材：${error}`);
      return;
    }
    setSegments((prev) => prev.map((segment) => segment.id === rowId ? { ...segment, oreateaiAssets: nextAssets } : segment));
  };

  const removeOreateaiAssetFromRow = (rowId, index) => {
    setSegments((prev) => prev.map((segment) => segment.id === rowId ? {
      ...segment,
      oreateaiAssets: (segment.oreateaiAssets || []).filter((_, assetIndex) => assetIndex !== index),
    } : segment));
  };

  useEffect(() => {
    if (!window.electronAPI?.onOreateaiVideoProgress) return undefined;
    return window.electronAPI.onOreateaiVideoProgress((progress = {}) => {
      const requestId = String(progress.requestId || '');
      if (!requestId) return;
      const task = readGenerationTaskRegistry().find((item) => item.taskId === requestId && item.channel === 'oreateai');
      if (!task || task.draftId !== draftId) return;
      const patch = oreateaiProgressPatch(progress);
      updateGenerationTaskRegistry(requestId, patch);
      setSegments((prev) => prev.map((segment) => segment.id === task.segId ? {
        ...segment,
        generating: patch.status !== 'failed',
        generateStatus: patch.status,
        generateProgress: patch.progress,
      } : segment));
    });
  }, [draftId]);

  const handleGenerateOreateai = async (id, options = {}) => {
    const silent = !!options.silent;
    const segment = segments.find((item) => item.id === id);
    const prompt = buildPromptWithSuffix(promptDraftsRef.current[id] ?? segment?.text).trim();
    const capability = getOreateaiCapability(globalModel, oreateaiScene);
    if (!prompt) {
      if (!silent) alert('请先填写该分镜的描述词再生成');
      resetRowGenerationState(id);
      return false;
    }
    if (!capability) {
      if (!silent) alert('渠道八动态能力尚未加载，请先刷新配置。');
      resetRowGenerationState(id);
      return false;
    }
    const assets = segment?.oreateaiAssets || [];
    const assetError = validateOreateaiAssetSelection(capability, assets, { requireMinimum: true });
    if (assetError) {
      if (!silent) alert(`渠道八素材不符合当前场景：${assetError}`);
      resetRowGenerationState(id);
      return false;
    }
    if (capability.promptMaxChars && prompt.length > capability.promptMaxChars) {
      if (!silent) alert(`渠道八提示词最多 ${capability.promptMaxChars} 个字符。`);
      resetRowGenerationState(id);
      return false;
    }
    const duration = Number(String(globalDuration).replace(/\D/g, ''));
    const combination = getOreateaiCombination(capability, { duration, resolution: globalResolution, audio: oreateaiAudio });
    if (!combination || combination.duration !== duration || combination.resolution !== globalResolution) {
      if (!silent) alert('当前渠道八参数组合不在实时配置中，请重新选择模型或参数。');
      resetRowGenerationState(id);
      return false;
    }
    if (!window.electronAPI?.oreateaiGenerateVideo || !window.electronAPI?.oreateaiDownloadVideo) {
      if (!silent) alert('渠道八仅支持 Electron 桌面端。');
      resetRowGenerationState(id);
      return false;
    }

    const requestId = buildGenerationRequestId(id, 'oreateai');
    registerGenerationTask(id, requestId, 'oreateai', 'video', { requestId, status: 'processing', progress: 2 });
    setSegments((prev) => prev.map((item) => item.id === id ? {
      ...item,
      type: 'video',
      model: capability.modelName,
      pendingTaskId: requestId,
      pendingTaskIds: [...new Set([...(item.pendingTaskIds || []), requestId])],
      pendingPrimaryTaskId: requestId,
      pendingChannel: 'oreateai',
      generating: true,
      generateStatus: 'processing',
      generateProgress: 2,
      generationError: '',
      activeTaskCount: Math.max(1, [...new Set([...(item.pendingTaskIds || []), requestId])].length),
    } : item));

    try {
      const generated = await window.electronAPI.oreateaiGenerateVideo({
        requestId,
        modelName: capability.modelName,
        scene: capability.scene,
        prompt,
        ratio: globalAspectRatio,
        resolution: globalResolution,
        duration,
        audio: oreateaiAudio,
        assetPaths: assets.map((asset) => asset.path),
      });
      if (!generated?.ok || !generated.result?.url) throw new Error(generated?.error || '渠道八未返回视频结果');
      updateGenerationTaskRegistry(requestId, { status: 'processing', progress: 97, videoUrl: generated.result.url });
      const downloaded = await window.electronAPI.oreateaiDownloadVideo({
        url: generated.result.url,
        fileName: `OreateAI-${id}-${Date.now()}.mp4`,
        autoSave: true,
      });
      if (!downloaded?.ok || downloaded.canceled || !downloaded.result?.path) {
        throw new Error(downloaded?.error || '渠道八视频下载或 MP4 校验失败');
      }
      updateGenerationTaskRegistry(requestId, {
        status: 'completed',
        progress: 100,
        mediaType: 'video',
        videoUrl: generated.result.url,
        mediaUrl: generated.result.url,
        localPath: downloaded.result.path,
      });
      return true;
    } catch (error) {
      const message = error.message || String(error);
      updateGenerationTaskRegistry(requestId, { status: 'failed', error: message, progress: 0 });
      setSegments((prev) => prev.map((item) => item.id === id ? {
        ...item,
        generating: false,
        pendingTaskId: null,
        pendingTaskIds: (item.pendingTaskIds || []).filter((taskId) => taskId !== requestId),
        pendingPrimaryTaskId: '',
        pendingChannel: null,
        generateStatus: null,
        generateProgress: null,
        activeTaskCount: 0,
        generationError: message,
      } : item));
      if (!silent) alert(`渠道八生成失败：${message}`);
      return false;
    }
  };

  const clearRowGenerationPlaceholder = (id) => {
    setSegments(prev => prev.map(seg => {
      if (seg.id !== id) return seg;
      const pendingIds = [...new Set((seg.pendingTaskIds || []).filter(Boolean))];
      if (pendingIds.length > 0) {
        const nextPrimaryTaskId = pendingIds.includes(seg.pendingPrimaryTaskId)
          ? seg.pendingPrimaryTaskId
          : pendingIds[pendingIds.length - 1];
        return {
          ...seg,
          generating: true,
          pendingTaskId: pendingIds[pendingIds.length - 1],
          pendingPrimaryTaskId: nextPrimaryTaskId,
          activeTaskCount: pendingIds.length,
          generateStatus: seg.generateStatus || 'processing',
        };
      }
      return {
        ...seg,
        generating: false,
        pendingTaskId: null,
        pendingTaskIds: [],
        pendingPrimaryTaskId: '',
        pendingChannel: null,
        pendingAccountId: 0,
        pendingAccountName: '',
        pendingConversationId: '',
        generateStatus: null,
        queuePosition: null,
        generateProgress: null,
        elapsedSeconds: null,
        remainingSeconds: null,
        timeoutSeconds: null,
        estimatedWaitSeconds: null,
        activeTaskCount: 0,
      };
    }));
  };

  const resetRowGenerationState = (id, removeRegisteredTask = false) => {
    const currentSeg = segments.find(seg => seg.id === id);
    const taskIdsToRemove = [currentSeg?.pendingTaskId, ...(currentSeg?.pendingTaskIds || [])].filter(Boolean);
    setSegments(prev => prev.map(seg => {
      if (seg.id !== id) return seg;
      return {
        ...seg,
        generating: false,
        pendingTaskId: null,
        pendingTaskIds: [],
        pendingPrimaryTaskId: '',
        pendingChannel: null,
        pendingAccountId: 0,
        pendingAccountName: '',
        generateStatus: null,
        generationError: '',
        queuePosition: null,
        generateProgress: null,
        activeTaskCount: 0,
      };
    }));
    if (removeRegisteredTask && taskIdsToRemove.length > 0) {
      const removeSet = new Set(taskIdsToRemove);
      writeGenerationTaskRegistry(readGenerationTaskRegistry().filter(t => !removeSet.has(t.taskId)));
    }
  };

  const cancelRowGeneration = (id) => {
    if (!confirm(`确定清空第 ${id} 行当前等待中的生成任务吗？清空后仍可继续点击生成。`)) return;
    resetRowGenerationState(id, true);
  };

  const handleGenerate = async (id, options = {}) => {
    const silent = !!options.silent;

    setSegments(prev => prev.map(seg => seg.id === id ? {
      ...seg,
      generating: true,
      generateStatus: 'pending',
      generationError: '',
      activeTaskCount: Math.max(1, (seg.activeTaskCount || 0) + 1),
    } : seg));

    if (generateChannel === 'pixmax') {
      return handleGeneratePixmax(id, options);
    }
    if (generateChannel === 'oiioii') {
      return handleGenerateOiiOii(id, options);
    }
    if (generateChannel === 'chatgpt2api') {
      return handleGenerateChatGPT2API(id, options);
    }
    if (generateChannel === 'dola') {
      return handleGenerateDola(id, options);
    }
    if (generateChannel === 'lovart') {
      return handleGenerateLovart(id, options);
    }
    if (generateChannel === 'oreateai') {
      return handleGenerateOreateai(id, options);
    }
    if (generateChannel === 'framia') {
      return handleGenerateFramia(id, options);
    }
    if (generateChannel === 'tensorart') {
      return handleGenerateTensorArt(id, options);
    }

    try {
      const segForQuota = segments.find(s => s.id === id);
      const requestedDurationSec = resolveDurationSeconds(segForQuota?.duration, globalDuration, 5);
      const accRes = await fetch(`${WIZSTAR_API}/accounts`);
      const accData = await accRes.json();
      const allAccounts = accData.data || [];
      const dailyLimited = allAccounts.filter(a => a.status === 'daily_limit');
      const unavailableStatuses = new Set(['forbidden', 'auth_expired', 'daily_limit']);
      const accounts = allAccounts.filter(a => !unavailableStatuses.has(a.status));
      const quotaAccounts = requestedDurationSec >= 15
        ? accounts.filter(a => (a.remaining_15s_task_quota ?? 1) > 0 && (a.used_15s_task_count || 0) < 1)
        : accounts;
      const availableAccounts = quotaAccounts.filter(a => (a.active_task_count || 0) < (a.max_concurrency || 1));
      if (accounts.length === 0) {
        const msg = dailyLimited.length > 0
          ? `渠道一账号今日生成次数已达上限（${dailyLimited.length} 个账号被限制），明天自动恢复，请切换其他渠道或添加更多账号`
          : '没有可用的渠道一账号：账号库为空或账号都已被平台禁用/过期/额度耗尽，请注册/切换账号';
        alert(msg);
        resetRowGenerationState(id);
        return false;
      }
      if (quotaAccounts.length === 0) {
        alert('渠道一 15s 视频账号额度已用完：一个账号只能提交一个 15s 视频，请添加新账号或改用其他渠道。');
        resetRowGenerationState(id);
        return false;
      }
      if (availableAccounts.length === 0) {
        alert('渠道一账号并发已满：请等待当前任务完成，或在账号库选中账号后调高并发。');
        resetRowGenerationState(id);
        return false;
      }
      const eligibleAccounts = availableAccounts.filter(a => (a.points_balance || 0) > 0);
      const rotationPool = eligibleAccounts.length > 0 ? eligibleAccounts : availableAccounts;
      const cursor = wizstarAccountCursorRef.current % rotationPool.length;
      const account = rotationPool[cursor];
      wizstarAccountCursorRef.current = (cursor + 1) % rotationPool.length;
      const seg = segForQuota;
      const promptText = buildPromptWithSuffix(promptDraftsRef.current[id] ?? seg?.text);

      if (!promptText || promptText.trim().length === 0) {
        alert('请先填写该分镜的描述词再生成');
        resetRowGenerationState(id);
        return false;
      }

      const prompt = promptText;
      const modelMap = { 'Seedance 2.0': 'seedance2.0', 'Seedance 1.5': 'seedance1.5', 'Kling': 'kling' };
      const durationSec = requestedDurationSec;
      const videoRatio = normalizeAspectRatio(seg?.aspectRatio || globalAspectRatio, {
        channel: 'wizstar',
        modelName: seg?.model || globalModel,
        mediaType: 'video',
      });

      const picUrl = await resolveImageUrl(seg, id, account, promptText);

      const taskType = picUrl ? 2 : 1;
      const body = {
        account_id: account.id,
        task_type: taskType,
        prompt,
        model: modelMap[seg?.model || globalModel] || 'seedance2.0',
        video_ratio: videoRatio,
        video_duration: durationSec,
        video_num: 1,
      };
      if (picUrl) {
        body.pic_url = picUrl;
      }

      const createRes = await fetch(`${WIZSTAR_API}/tasks/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!createRes.ok) {
        let errMsg = `HTTP ${createRes.status}`;
        try {
          const err = await createRes.json();
          errMsg = err.detail || errMsg;
        } catch (_) {}
        throw new Error(errMsg);
      }

      const taskData = await createRes.json();
      const taskId = taskData.data?.task_id;
      if (!taskId) throw new Error('渠道一未返回 task_id');
      registerGenerationTask(id, taskId, 'wizstar', 'video');

      // Save taskId to segment so it persists across project close/switch; global scheduler continues polling.
      setSegments(prev => prev.map(s => s.id === id ? {
        ...s,
        pendingTaskId: taskId,
        pendingTaskIds: [...new Set([...(s.pendingTaskIds || []), taskId])],
        pendingPrimaryTaskId: taskId,
        pendingChannel: 'wizstar',
        generating: true,
        generateStatus: 'processing',
        activeTaskCount: Math.max(1, [...new Set([...(s.pendingTaskIds || []), taskId])].length),
      } : s));
      return true;
    } catch (e) {
      console.error('[wizstar] generate failed:', e);
      const msg = e.message || '';
      let friendlyMsg = msg;
      if (msg.toLowerCase().includes('user forbidden')) {
        friendlyMsg = '当前渠道一账号已被平台禁用，已自动标记为不可用，请换账号后重试';
      } else if (msg.includes('达到上限') || msg.includes('已达上限') || msg.includes('生成次数') || msg.includes('明天再来')) {
        friendlyMsg = '当前渠道一账号今日生成次数已达上限，已自动限制，明天自动恢复，请换账号或切换其他渠道';
      }
      if (!silent) alert(`生成失败: ${friendlyMsg}`);
      clearRowGenerationPlaceholder(id);
      return false;
    }
  };

  const handleStartAllTasks = async () => {
    if (batchStarting) return;

    const targetMediaType = getModelMediaType(globalModel);
    const targetMediaLabel = targetMediaType === 'image' ? '生图' : '视频生成';
    const candidates = segments.filter(seg => {
      const promptText = (promptDraftsRef.current[seg.id] ?? seg.text ?? '').trim();
      return seg.type === targetMediaType && promptText && !hasActiveGenerationTask(seg);
    });

    if (candidates.length === 0) {
      alert(`没有可一键发送的${targetMediaLabel}任务：请先切换到${targetMediaType === 'image' ? '图片' : '视频'}行、填写分镜提示词，并确认没有正在生成/等待中的任务。`);
      return;
    }

    const skippedCount = segments.filter(seg => seg.type !== targetMediaType).length;
    const shouldStart = confirm(`将按当前通道「${getChannelLabel(generateChannel)}」顺序发送 ${candidates.length} 个${targetMediaLabel}任务${skippedCount > 0 ? `，自动跳过 ${skippedCount} 个非${targetMediaType === 'image' ? '图片' : '视频'}行` : ''}。是否继续？`);
    if (!shouldStart) return;

    setBatchStarting(true);
    try {
      if (generateChannel === 'dola') {
        const firstCandidate = candidates[0];
        const ok = await handleGenerate(firstCandidate.id, { silent: true });
        const started = ok ? 1 : 0;
        const remaining = candidates.length - started;
        alert(`一键发送完成：已提交 ${started} 个${targetMediaLabel}任务${remaining > 0 ? `，剩余 ${remaining} 个等待你稍后继续提交` : ''}${ok ? '。渠道六 Dola 会按单任务运行，避免连续提交撞账号忙。' : '。当前任务未能提交，请处理后再继续。'}`);
        return;
      }

      const results = await Promise.all(candidates.map(seg => handleGenerate(seg.id, { silent: true })));
      const started = results.filter(Boolean).length;
      const failed = candidates.length - started;
      alert(`一键发送完成：已并行提交 ${started} 个${targetMediaLabel}任务${failed > 0 ? `，失败 ${failed} 个` : ''}。`);
    } finally {
      setBatchStarting(false);
    }
  };

  const getChannelLabel = (channel) => ({
    wizstar: '渠道一账号池',
    pixmax: '渠道二',
    oiioii: '渠道四',
    chatgpt2api: '渠道五',
    dola: '渠道六 Dola',
    lovart: '渠道七 Lovart',
    oreateai: '渠道八 OreateAI',
    framia: '渠道九 Framia',
    tensorart: '渠道十 Tensor.Art',
  }[channel] || '当前通道');

  const handleGenerateLovart = async (id, options = {}) => {
    const silent = !!options.silent;
    try {
      const seg = segments.find(s => s.id === id);
      const promptText = buildPromptWithSuffix(promptDraftsRef.current[id] ?? seg?.text);

      if (!promptText || promptText.trim().length === 0) {
        alert('请先填写该分镜的描述词再生成');
        resetRowGenerationState(id);
        return false;
      }

      if (seg?.type !== 'image') {
        alert('渠道七 Lovart 是生图通道，请先切换该分镜为「图片」。');
        resetRowGenerationState(id);
        return false;
      }

      const localImagePath = getReferenceLocalPath(seg);
      const remoteImageUrl = getReferenceRemoteUrl(seg);
      const dataImageUrl = getReferenceDataUrl(seg);
      const currentImageUrl = seg?.currentMaterialImage && !isVideoUrl(seg.currentMaterialImage.thumbnail)
        ? (seg.currentMaterialImage.sourceUrl || seg.currentMaterialImage.remoteUrl || seg.currentMaterialImage.thumbnail || '')
        : '';
      const referenceImageUrl = remoteImageUrl || dataImageUrl || (/^https?:\/\//i.test(currentImageUrl) ? currentImageUrl : '');
      const aspectRatio = normalizeAspectRatio(seg?.aspectRatio || globalAspectRatio, {
        channel: 'lovart',
        modelName: '渠道七 Lovart',
        mediaType: 'image',
      });
      const qualitySource = String(seg?.quality || globalResolution || '').toLowerCase();
      const quality = qualitySource === '4k' || qualitySource === 'high'
        ? 'high'
        : qualitySource === 'low'
          ? 'low'
          : 'medium';
      const referenceImages = [
        ...getSegmentCharacterImageRefs(seg, promptText).map(imageRefToReference),
        ...getSegmentSceneImageRefs(promptText).map(imageRefToReference),
      ].filter(Boolean);
      let projectId = '';
      try {
        projectId = localStorage.getItem('maocanju_lovart_project_id') || localStorage.getItem('lovart_project_id') || '';
      } catch (_) {}

      const body = {
        prompt: promptText,
        model: 'openai/gpt-image-2',
        aspect_ratio: aspectRatio,
        resolution: seg?.quality || globalResolution || '2K',
        quality,
        reference_images: [...new Set(referenceImages)],
      };
      if (localImagePath) body.image_path = localImagePath;
      if (referenceImageUrl) body.image_url = referenceImageUrl;
      if (projectId) body.project_id = projectId;

      const createRes = await fetch(`${WIZSTAR_API}/lovart/tasks/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!createRes.ok) {
        let errMsg = `HTTP ${createRes.status}`;
        try { const err = await createRes.json(); errMsg = err.detail || errMsg; } catch (_) {}
        throw new Error(errMsg);
      }

      const taskData = await createRes.json();
      const payload = taskData.data || {};
      const taskId = payload.task_id;
      if (!taskId) throw new Error('渠道七未返回 task_id');
      const accountId = payload.account_id || 0;
      const accountName = payload.account_name || (accountId ? `Lovart账号 #${accountId}` : '');
      registerGenerationTask(id, taskId, 'lovart', 'image', {
        accountId,
        accountName,
        status: payload.status || 'processing',
        queuePosition: payload.queue_position ?? null,
        remainingSeconds: payload.remaining_seconds ?? null,
        estimatedWaitSeconds: payload.estimated_wait_seconds ?? payload.remaining_seconds ?? null,
      });

      setSegments(prev => prev.map(s => s.id === id ? {
        ...s,
        type: 'image',
        model: '渠道七 Lovart',
        pendingTaskId: taskId,
        pendingTaskIds: [...new Set([...(s.pendingTaskIds || []), taskId])],
        pendingPrimaryTaskId: taskId,
        pendingChannel: 'lovart',
        pendingAccountId: accountId,
        pendingAccountName: accountName,
        generating: true,
        generateStatus: payload.status || 'processing',
        queuePosition: payload.queue_position ?? null,
        remainingSeconds: payload.remaining_seconds ?? null,
        estimatedWaitSeconds: payload.estimated_wait_seconds ?? payload.remaining_seconds ?? null,
        generationError: '',
        activeTaskCount: Math.max(1, [...new Set([...(s.pendingTaskIds || []), taskId])].length),
      } : s));
      return true;
    } catch (e) {
      console.error('[lovart] generate failed:', e);
      if (!silent) alert(`生成失败: ${e.message || e}`);
      clearRowGenerationPlaceholder(id);
      return false;
    }
  };

  const handleGenerateFramia = async (id, options = {}) => {
    const silent = !!options.silent;
    try {
      const seg = segments.find(s => s.id === id);
      const promptText = buildPromptWithSuffix(promptDraftsRef.current[id] ?? seg?.text);

      if (!promptText || promptText.trim().length === 0) {
        alert('请先填写该分镜的描述词再生成');
        resetRowGenerationState(id);
        return false;
      }

      const localImagePath = getReferenceLocalPath(seg);
      const remoteImageUrl = getReferenceRemoteUrl(seg);
      const dataImageUrl = getReferenceDataUrl(seg);

      const framiaModelMap = {
        '渠道九 Seedance 2.0 Mini': 'Seedance 2.0 Mini',
        '渠道九 Kling 3.0': 'Kling 3.0',
        'Seedance 2.0 Mini': 'Seedance 2.0 Mini',
        'Kling 3.0': 'Kling 3.0',
      };
      const selectedModelName = framiaModelMap[seg?.model]
        ? seg.model
        : (framiaModelMap[globalModel] ? globalModel : '渠道九 Seedance 2.0 Mini');
      const model = framiaModelMap[selectedModelName] || 'Seedance 2.0 Mini';

      const aspectRatio = normalizeAspectRatio(seg?.aspectRatio || globalAspectRatio, {
        channel: 'framia',
        modelName: selectedModelName,
        mediaType: 'video',
      });
      const durationSec = resolveDurationSeconds(globalDuration, seg?.duration, 4);
      const resolution = seg?.quality || globalResolution || '720p';

      const body = {
        prompt: promptText,
        model,
        aspect_ratio: aspectRatio,
        resolution,
        duration: durationSec,
      };

      const allImagePaths = [
        localImagePath,
        ...getSegmentCharacterImageRefs(seg, promptText).map(imageRefToReference),
        ...getSegmentSceneImageRefs(promptText).map(imageRefToReference),
      ].filter(Boolean);
      const imagePaths = [...new Set(allImagePaths)];
      if (imagePaths.length > 0) body.image_paths = imagePaths;
      if (remoteImageUrl) body.image_url = remoteImageUrl;
      else if (dataImageUrl) body.image_url = dataImageUrl;

      const createRes = await fetch(`${WIZSTAR_API}/framia/tasks/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!createRes.ok) {
        let errMsg = `HTTP ${createRes.status}`;
        try { const err = await createRes.json(); errMsg = err.detail || errMsg; } catch (_) {}
        throw new Error(errMsg);
      }

      const taskData = await createRes.json();
      const payload = taskData.data || {};
      const taskId = payload.task_id;
      if (!taskId) throw new Error('渠道九未返回 task_id');
      const accountId = payload.account_id || 0;
      const accountName = payload.account_name || (accountId ? `Framia账号 #${accountId}` : '');
      registerGenerationTask(id, taskId, 'framia', 'video', {
        accountId,
        accountName,
        status: payload.status || 'processing',
      });

      setSegments(prev => prev.map(s => s.id === id ? {
        ...s,
        type: 'video',
        model: selectedModelName,
        pendingTaskId: taskId,
        pendingTaskIds: [...new Set([...(s.pendingTaskIds || []), taskId])],
        pendingPrimaryTaskId: taskId,
        pendingChannel: 'framia',
        pendingAccountId: accountId,
        pendingAccountName: accountName,
        generating: true,
        generateStatus: payload.status || 'processing',
        generationError: '',
        activeTaskCount: Math.max(1, [...new Set([...(s.pendingTaskIds || []), taskId])].length),
      } : s));
      return true;
    } catch (e) {
      console.error('[framia] generate failed:', e);
      if (!silent) alert(`生成失败: ${e.message || e}`);
      clearRowGenerationPlaceholder(id);
      return false;
    }
  };

  const handleGenerateTensorArt = async (id, options = {}) => {
    const silent = !!options.silent;
    try {
      const seg = segments.find(s => s.id === id);
      const promptText = buildPromptWithSuffix(promptDraftsRef.current[id] ?? seg?.text);
      if (!promptText || promptText.trim().length === 0) {
        alert('请先填写该分镜的描述词再生成');
        resetRowGenerationState(id);
        return false;
      }
      if (seg?.type === 'image') {
        alert('渠道十 Tensor.Art 是图生视频通道，请先切换该分镜为「视频」。');
        resetRowGenerationState(id);
        return false;
      }

      const primaryLocalPath = getReferenceLocalPath(seg);
      const primaryDataUrl = getReferenceDataUrl(seg);
      const primaryRemoteUrl = getReferenceRemoteUrl(seg);
      let stablePrimaryPath = '';
      if (primaryLocalPath) {
        const persisted = await persistLocalImagePath(primaryLocalPath);
        if (persisted?.ok && persisted.path) {
          stablePrimaryPath = persisted.path;
          if (stablePrimaryPath !== primaryLocalPath) {
            setSegments(prev => prev.map(s => s.id === id ? {
              ...s,
              referenceImage: makeLocalReferenceImage(stablePrimaryPath),
              referenceImagePath: stablePrimaryPath,
            } : s));
          }
        } else if (!primaryDataUrl && !primaryRemoteUrl) {
          throw new Error('垫图文件已失效（常见于微信 RWTemp 临时目录），请点击垫图重新选择图片后再生成。');
        }
      }
      const rawImageSources = [
        stablePrimaryPath || primaryDataUrl || primaryRemoteUrl,
        ...getSegmentCharacterImageRefs(seg, promptText).map(imageRefToReference),
        ...getSegmentSceneImageRefs(promptText).map(imageRefToReference),
      ].filter(Boolean);
      const imageSources = [];
      for (const source of rawImageSources) {
        if (isLocalFilePathValue(source) || /^file:\/\//i.test(source)) {
          const localPath = localFilePathFromUrlValue(source) || source;
          const persisted = await persistLocalImagePath(localPath);
          if (!persisted?.ok || !persisted.path) {
            throw new Error('引用的角色或场景图片已失效，请重新选择该图片后再生成。');
          }
          imageSources.push(persisted.path);
        } else {
          imageSources.push(source);
        }
      }
      const uniqueImageSources = [...new Set(imageSources)].slice(0, 2);
      if (uniqueImageSources.length === 0) {
        alert('渠道十当前按已抓取协议仅支持图生视频，请先添加垫图、@角色或 $场景参考图。');
        resetRowGenerationState(id);
        return false;
      }

      const selectedModelName = '渠道十 Tensor.Art 视频';
      const duration = Math.min(
        10,
        Math.max(4, Math.round(resolveDurationSeconds(seg?.duration, globalDuration, 4))),
      );
      const aspectRatio = normalizeAspectRatio(seg?.aspectRatio || globalAspectRatio, {
        channel: 'tensorart',
        modelName: selectedModelName,
        mediaType: 'video',
      });
      const createRes = await fetch(`${WIZSTAR_API}/tensorart/tasks/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: promptText,
          model: 'tensorart-default',
          aspect_ratio: aspectRatio,
          resolution: '480p',
          duration,
          image_paths: uniqueImageSources,
        }),
      });
      if (!createRes.ok) {
        let errMsg = `HTTP ${createRes.status}`;
        try { const err = await createRes.json(); errMsg = err.detail || errMsg; } catch (_) {}
        throw new Error(errMsg);
      }

      const taskData = await createRes.json();
      const payload = taskData.data || taskData || {};
      const taskId = payload.task_id || payload.taskId;
      if (!taskId) {
        throw new Error(taskData.detail || taskData.message || '渠道十未返回 task_id');
      }
      const accountId = payload.account_id || 0;
      const accountName = payload.account_name || (accountId ? `Tensor.Art账号 #${accountId}` : '');
      registerGenerationTask(id, taskId, 'tensorart', 'video', {
        accountId,
        accountName,
        duration: payload.duration || duration,
        credits: payload.credits || TENSORART_DURATION_CREDITS[duration],
        status: payload.status || 'processing',
      });

      setSegments(prev => prev.map(s => s.id === id ? {
        ...s,
        type: 'video',
        model: selectedModelName,
        pendingTaskId: taskId,
        pendingTaskIds: [...new Set([...(s.pendingTaskIds || []), taskId])],
        pendingPrimaryTaskId: taskId,
        pendingChannel: 'tensorart',
        pendingAccountId: accountId,
        pendingAccountName: accountName,
        generating: true,
        generateStatus: payload.status || 'processing',
        generationError: '',
        activeTaskCount: Math.max(1, [...new Set([...(s.pendingTaskIds || []), taskId])].length),
      } : s));
      return true;
    } catch (e) {
      console.error('[tensorart] generate failed:', e);
      if (!silent) alert(`生成失败: ${e.message || e}`);
      clearRowGenerationPlaceholder(id);
      return false;
    }
  };

  const handleGenerateDola = async (id, options = {}) => {
    const silent = !!options.silent;
    try {
      const seg = segments.find(s => s.id === id);
      const promptText = buildPromptWithSuffix(promptDraftsRef.current[id] ?? seg?.text);

      if (!promptText || promptText.trim().length === 0) {
        alert('请先填写该分镜的描述词再生成');
        resetRowGenerationState(id);
        return false;
      }

      if (seg?.type === 'image') {
        alert('渠道六 Dola 是视频生成通道，请先切换该分镜为「视频」。');
        resetRowGenerationState(id);
        return false;
      }

      const dolaModelMap = {
        '渠道六 Seedance 2.0': 'seedance-2.0',
        '渠道六 Seedance 1.5': 'seedance-1.5',
        '渠道六 Seedance Lite': 'seedance-lite',
      };
      const selectedModelName = dolaModelMap[seg?.model] ? seg.model : (dolaModelMap[globalModel] ? globalModel : '渠道六 Seedance 2.0');
      const model = dolaModelMap[selectedModelName] || 'seedance-2.0';
      const ratio = normalizeAspectRatio(seg?.aspectRatio || globalAspectRatio, {
        channel: 'dola',
        modelName: selectedModelName,
        mediaType: 'video',
      });
      const durationSec = resolveDurationSeconds(globalDuration, seg?.duration, 5);

      const localImagePath = getReferenceLocalPath(seg);
      const remoteImageUrl = getReferenceRemoteUrl(seg);
      const dataImageUrl = getReferenceDataUrl(seg);
      const allReferenceImages = [
        localImagePath,
        remoteImageUrl,
        dataImageUrl,
        ...getSegmentCharacterImageRefs(seg, promptText).map(imageRefToReference),
        ...getSegmentSceneImageRefs(promptText).map(imageRefToReference),
      ].filter(Boolean);
      const referenceImages = [...new Set(allReferenceImages)];

      const excludeAccountIds = [];
      const failedAccountId = seg?.pendingAccountId || seg?.lastFailedAccountId || 0;
      if (failedAccountId && (seg?.generationError || seg?.lastFailedTaskId)) {
        excludeAccountIds.push(Number(failedAccountId));
      }

      const body = {
        prompt: promptText,
        model,
        ratio,
        duration: durationSec,
        reference_images: referenceImages,
        exclude_account_ids: excludeAccountIds,
      };

      const createRes = await fetch(`${WIZSTAR_API}/dola/tasks/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!createRes.ok) {
        let errMsg = `HTTP ${createRes.status}`;
        try { const err = await createRes.json(); errMsg = err.detail || errMsg; } catch (_) {}
        throw new Error(errMsg);
      }

      const taskData = await createRes.json();
      const payload = taskData.data || {};
      const taskId = payload.task_id;
      if (!taskId) throw new Error('渠道六未返回 task_id');
      const accountId = payload.account_id || 0;
      const accountName = payload.account_name || (accountId ? `Dola账号 #${accountId}` : '');
      registerGenerationTask(id, taskId, 'dola', 'video', {
        accountId,
        accountName,
        conversationId: payload.conversation_id || '',
        localConversationId: payload.local_conversation_id || '',
        pageUrl: payload.page_url || '',
        sendMode: 'api',
        sendModeLabel: payload.send_mode_label || dolaSendModeLabel,
        browserHeadless: false,
        status: payload.status || 'processing',
        progress: typeof payload.progress === 'number' ? payload.progress : 0,
      });

      setSegments(prev => prev.map(s => s.id === id ? {
        ...s,
        type: 'video',
        model: selectedModelName,
        pendingTaskId: taskId,
        pendingTaskIds: [...new Set([...(s.pendingTaskIds || []), taskId])],
        pendingPrimaryTaskId: taskId,
        pendingChannel: 'dola',
        pendingAccountId: accountId,
        pendingAccountName: accountName,
        pendingConversationId: payload.conversation_id || '',
        pendingLocalConversationId: payload.local_conversation_id || '',
        pendingDolaPageUrl: payload.page_url || '',
        pendingDolaSendMode: 'api',
        pendingDolaSendModeLabel: payload.send_mode_label || dolaSendModeLabel,
        pendingDolaHeadless: false,
        pendingAccounts: [...(s.pendingAccounts || []).filter(a => a.taskId !== taskId), {
          taskId,
          accountId,
          accountName,
          conversationId: payload.conversation_id || '',
          localConversationId: payload.local_conversation_id || '',
          pageUrl: payload.page_url || '',
          sendMode: 'api',
          sendModeLabel: payload.send_mode_label || dolaSendModeLabel,
          browserHeadless: false,
          status: payload.status || 'processing',
          startedAt: Date.now(),
        }],
        generating: true,
        generateStatus: 'processing',
        activeTaskCount: Math.max(1, [...new Set([...(s.pendingTaskIds || []), taskId])].length),
      } : s));
      return true;
    } catch (e) {
      console.error('[dola] generate failed:', e);
      const message = e.message || String(e);
      if (isDolaBusyMessage(message)) {
        if (!silent) alert(message);
        setSegments(prev => prev.map(seg => {
          if (seg.id !== id) return seg;
          const pendingIds = [...new Set([seg.pendingTaskId, ...(seg.pendingTaskIds || [])].filter(Boolean))];
          if (pendingIds.length === 0) {
            return {
              ...seg,
              generating: false,
              pendingTaskId: null,
              pendingTaskIds: [],
              pendingPrimaryTaskId: '',
              pendingChannel: null,
              pendingAccountId: 0,
              pendingAccountName: '',
              pendingConversationId: '',
              generateStatus: null,
              generationError: '',
              queuePosition: null,
              generateProgress: null,
              activeTaskCount: 0,
            };
          }
          return {
            ...seg,
            generating: true,
            pendingTaskId: pendingIds[pendingIds.length - 1],
            pendingTaskIds: pendingIds,
            pendingPrimaryTaskId: pendingIds.includes(seg.pendingPrimaryTaskId) ? seg.pendingPrimaryTaskId : pendingIds[0],
            generateStatus: seg.generateStatus || 'processing',
            generationError: '',
            activeTaskCount: pendingIds.length,
          };
        }));
        return false;
      }
      if (!silent) alert(`生成失败: ${message}`);
      clearRowGenerationPlaceholder(id);
      return false;
    }
  };

  const handleOpenDolaAccountBrowser = async (row) => {
    if (!window.confirm('将打开 Dola 浏览器，仅用于手动授权、登录或诊断；普通生成和采集不会使用浏览器。是否继续？')) return;
    const accountId = row?.pendingAccountId || 0;
    const taskId = row?.pendingTaskId || (row?.pendingTaskIds || [])[0] || row?.lastFailedTaskId || '';
    const conversationId = row?.pendingConversationId || row?.lastConversationId || '';
    const endpoint = accountId
      ? `${WIZSTAR_API}/dola/accounts/${accountId}/open-browser`
      : `${WIZSTAR_API}/dola/open-browser`;
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task_id: taskId, conversation_id: conversationId }),
      });
      const data = await res.json();
      if (!res.ok) {
        const message = data?.detail || data?.message || `HTTP ${res.status}`;
        throw new Error(message);
      }
      const payload = data.data || {};
    } catch (e) {
      alert(`打开渠道六浏览器失败: ${e.message || e}`);
    }
  };

  const handleCollectDolaTask = async (row) => {
    const taskId = row?.pendingTaskId || (row?.pendingTaskIds || [])[0] || row?.lastFailedTaskId;
    const conversationId = row?.pendingConversationId || row?.lastConversationId || '';
    if (!taskId && !conversationId) {
      alert('该行没有可采集的渠道六任务。');
      return;
    }
    if (!conversationId) {
      alert('这个任务还没有拿到 conversation_id，当前无法通过 API 采集。请等待生成接口返回会话 ID；如需排查登录态或页面任务，可由用户单独点击“授权/诊断”。');
      return;
    }
    try {
      setSegments(prev => prev.map(seg => seg.id === row.id ? {
        ...seg,
        generating: true,
        pendingTaskId: taskId || seg.pendingTaskId,
        pendingTaskIds: [...new Set([...(seg.pendingTaskIds || []), taskId || seg.pendingTaskId].filter(Boolean))],
        pendingPrimaryTaskId: seg.pendingPrimaryTaskId || taskId || seg.pendingTaskId || '',
        pendingChannel: 'dola',
        pendingAccountId: row.pendingAccountId || seg.pendingAccountId || 0,
        pendingAccountName: row.pendingAccountName || seg.pendingAccountName || '',
        generateStatus: 'collecting',
        generateProgress: Math.max(20, typeof seg.generateProgress === 'number' ? seg.generateProgress : 20),
        generationError: '',
        pendingConversationId: conversationId,
      } : seg));
      const url = taskId
        ? `${WIZSTAR_API}/dola/tasks/${encodeURIComponent(taskId)}/collect`
        : `${WIZSTAR_API}/dola/tasks/collect`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversation_id: conversationId,
          account_id: row.pendingAccountId || 0,
        }),
      });
      if (!res.ok) {
        let errMsg = `HTTP ${res.status}`;
        try { const err = await res.json(); errMsg = err.detail || errMsg; } catch (_) {}
        throw new Error(errMsg);
      }
      const data = await res.json();
      const payload = data.data || {};
      registerGenerationTask(row.id, payload.task_id || taskId, 'dola', 'video', {
        accountId: row.pendingAccountId || payload.account_id || 0,
        accountName: row.pendingAccountName || payload.account_name || '',
        conversationId,
        status: 'collecting',
        progress: typeof payload.progress === 'number' ? Math.max(20, payload.progress) : 20,
      });
    } catch (e) {
      setSegments(prev => prev.map(seg => seg.id === row.id ? {
        ...seg,
        generating: false,
        generationError: e.message || String(e),
      } : seg));
      alert(`手动采集失败: ${e.message || e}`);
    }
  };

  const [batchCollecting, setBatchCollecting] = useState(false);
  const handleBatchCollectDolaTasks = async () => {
    if (batchCollecting) return;
    // Gather all dola tasks with a conversation_id that are still pending/processing/collectable.
    const targets = [];
    segments.forEach(seg => {
      const conv = seg.pendingConversationId || seg.lastConversationId || '';
      const taskId = seg.pendingTaskId || (seg.pendingTaskIds || [])[0] || seg.lastFailedTaskId;
      const accountId = seg.pendingAccountId || 0;
      if (taskId && conv && seg.pendingChannel === 'dola') {
        targets.push({ seg, taskId, conversationId: conv, accountId });
      }
    });
    if (targets.length === 0) {
      alert('没有可批量采集的渠道六任务：需要有 conversation_id 且未完成的 dola 任务。');
      return;
    }
    if (!confirm(`确定要批量采集 ${targets.length} 个渠道六任务吗？`)) return;
    setBatchCollecting(true);
    let ok = 0;
    let fail = 0;
    await Promise.all(targets.map(async (t) => {
      try {
        const res = await fetch(`${WIZSTAR_API}/dola/tasks/${encodeURIComponent(t.taskId)}/collect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conversation_id: t.conversationId, account_id: t.accountId }),
        });
        if (!res.ok) {
          let errMsg = `HTTP ${res.status}`;
          try { const err = await res.json(); errMsg = err.detail || errMsg; } catch (_) {}
          throw new Error(errMsg);
        }
        const data = await res.json();
        const payload = data.data || {};
        registerGenerationTask(t.seg.id, payload.task_id || t.taskId, 'dola', 'video', {
          accountId: t.accountId || payload.account_id || 0,
          conversationId: t.conversationId,
          status: 'collecting',
          progress: typeof payload.progress === 'number' ? Math.max(20, payload.progress) : 20,
        });
        ok += 1;
      } catch (e) {
        fail += 1;
        console.warn(`[batch-collect] ${t.taskId} failed:`, e);
      }
    }));
    setBatchCollecting(false);
    alert(`批量采集完成：成功 ${ok} 个${fail > 0 ? `，失败 ${fail} 个` : ''}。`);
    onProjectChanged?.();
  };

  const handleGeneratePixmax = async (id, options = {}) => {
    const silent = !!options.silent;
    try {
      const seg = segments.find(s => s.id === id);
      const promptText = buildPromptWithSuffix(promptDraftsRef.current[id] ?? seg?.text);

      if (!promptText || promptText.trim().length === 0) {
        alert('请先填写该分镜的描述词再生成');
        resetRowGenerationState(id);
        return false;
      }

      const localImagePath = getReferenceLocalPath(seg);
      const remoteImageUrl = getReferenceRemoteUrl(seg);
      const dataImageUrl = getReferenceDataUrl(seg);
      const roleImageRefs = getSegmentCharacterImageRefs(seg, promptText);
      const roleAliases = getSegmentCharacterAliases(seg, promptText);
      const sceneImageRefs = getSegmentSceneImageRefs(promptText);

      if (!localImagePath && !remoteImageUrl && roleImageRefs.length === 0 && sceneImageRefs.length === 0) {
        alert('渠道二为图生视频通道，必须提供至少 1 张输入图片。请为该分镜设置「垫图」，或在描述词中插入带图片的 @角色 / $场景。');
        resetRowGenerationState(id);
        return false;
      }

      const pixmaxModelMap = {
        '渠道二 标准': 'pixdance-2-fast',
        '渠道二 高质量': 'pixdance-2',
      };
      const model = pixmaxModelMap[seg?.model || globalModel] || 'pixdance-2-fast';

      const durationSec = resolveDurationSeconds(seg?.duration, globalDuration, 5);
      const aspectRatio = normalizeAspectRatio(seg?.aspectRatio || globalAspectRatio, {
        channel: 'pixmax',
        modelName: seg?.model || globalModel,
        mediaType: 'video',
      });

      const body = {
        prompt: promptText,
        model,
        duration: durationSec,
        aspect_ratio: aspectRatio,
      };

      const imageInputs = [];
      if (localImagePath) {
        imageInputs.push({ file_path: localImagePath });
      } else if (remoteImageUrl) {
        imageInputs.push({ url: remoteImageUrl });
      } else if (dataImageUrl) {
        imageInputs.push({ data_url: dataImageUrl });
      }
      [...roleImageRefs, ...sceneImageRefs].forEach(ref => {
        const input = imageRefToInput(ref);
        if (input) imageInputs.push(input);
      });
      if (imageInputs.length > 0) {
        body.image_inputs = imageInputs;
      }
      const canAttachAliases = roleAliases.length > 0 && imageInputs.length === roleAliases.length;
      if (canAttachAliases) {
        body.aliases = roleAliases;
      }

      const createRes = await fetch(`${WIZSTAR_API}/pixmax/tasks/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!createRes.ok) {
        let errMsg = `HTTP ${createRes.status}`;
        try { const err = await createRes.json(); errMsg = err.detail || errMsg; } catch (_) {}
        throw new Error(errMsg);
      }

      const taskData = await createRes.json();
      const taskId = taskData.data?.task_id;
      if (!taskId) throw new Error('渠道二未返回 task_id');
      registerGenerationTask(id, taskId, 'pixmax', 'video');

      setSegments(prev => prev.map(s => s.id === id ? {
        ...s,
        pendingTaskId: taskId,
        pendingTaskIds: [...new Set([...(s.pendingTaskIds || []), taskId])],
        pendingPrimaryTaskId: taskId,
        pendingChannel: 'pixmax',
        generating: true,
        generateStatus: 'processing',
        activeTaskCount: Math.max(1, [...new Set([...(s.pendingTaskIds || []), taskId])].length),
      } : s));
      return true;
    } catch (e) {
      console.error('[pixmax] generate failed:', e);
      if (!silent) alert(`生成失败: ${e.message || e}`);
      clearRowGenerationPlaceholder(id);
      return false;
    }
  };

  const handleGenerateChatGPT2API = async (id, options = {}) => {
    const silent = !!options.silent;
    try {
      const seg = segments.find(s => s.id === id);
      const promptText = buildPromptWithSuffix(promptDraftsRef.current[id] ?? seg?.text);

      if (!promptText || promptText.trim().length === 0) {
        alert('请先填写该分镜的描述词再生成');
        resetRowGenerationState(id);
        return false;
      }

      const isImageRow = seg?.type === 'image';
      if (!isImageRow) {
        alert('渠道五 GPT-Image2 是生图通道，请先切换该分镜为「图片」。');
        resetRowGenerationState(id);
        return false;
      }

      const localImagePath = getReferenceLocalPath(seg);
      const remoteImageUrl = getReferenceRemoteUrl(seg);
      const dataImageUrl = getReferenceDataUrl(seg);
      const currentImageUrl = seg?.currentMaterialImage && !isVideoUrl(seg.currentMaterialImage.thumbnail)
        ? (seg.currentMaterialImage.sourceUrl || seg.currentMaterialImage.remoteUrl || seg.currentMaterialImage.thumbnail || '')
        : '';
      const referenceImageUrl = remoteImageUrl || dataImageUrl || (/^https?:\/\//i.test(currentImageUrl) ? currentImageUrl : '');
      const aspectRatio = normalizeAspectRatio(seg?.aspectRatio || globalAspectRatio, {
        channel: 'chatgpt2api',
        modelName: '渠道五 GPT-Image2',
        mediaType: 'image',
      });
      const chatgpt2apiSizeMap = {
        '1:1': '1024x1024',
        '16:9': '1536x1024',
        '4:3': '1536x1024',
        '3:2': '1536x1024',
        '9:16': '1024x1536',
        '3:4': '1024x1536',
        '2:3': '1024x1536',
      };
      const imageSize = chatgpt2apiSizeMap[aspectRatio] || 'auto';

      const imageResolution = ['2K', '4K'].includes(seg?.quality || globalResolution)
        ? (seg?.quality || globalResolution)
        : '2K';

      const body = {
        prompt: promptText,
        model: 'gpt-image-2',
        size: imageSize,
        resolution: imageResolution,
      };
      if (localImagePath) body.image_path = localImagePath;
      if (referenceImageUrl) body.image_url = referenceImageUrl;
      const referenceImages = [
        ...getSegmentCharacterImageRefs(seg, promptText),
        ...getSegmentSceneImageRefs(promptText),
      ].map(imageRefToReference).filter(Boolean);
      if (referenceImages.length > 0) body.reference_images = referenceImages;

      const createRes = await fetch(`${WIZSTAR_API}/chatgpt2api/images/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!createRes.ok) {
        let errMsg = `HTTP ${createRes.status}`;
        try { const err = await createRes.json(); errMsg = err.detail || errMsg; } catch (_) {}
        throw new Error(errMsg);
      }

      const taskData = await createRes.json();
      const taskId = taskData.data?.task_id;
      if (!taskId) throw new Error('渠道五未返回 task_id');
      registerGenerationTask(id, taskId, 'chatgpt2api', 'image');

      setSegments(prev => prev.map(s => s.id === id ? {
        ...s,
        pendingTaskId: taskId,
        pendingTaskIds: [...new Set([...(s.pendingTaskIds || []), taskId])],
        pendingPrimaryTaskId: taskId,
        pendingChannel: 'chatgpt2api',
        generating: true,
        generateStatus: 'processing',
        activeTaskCount: Math.max(1, [...new Set([...(s.pendingTaskIds || []), taskId])].length),
      } : s));
      return true;
    } catch (e) {
      console.error('[chatgpt2api] generate failed:', e);
      if (!silent) alert(`生成失败: ${e.message || e}`);
      clearRowGenerationPlaceholder(id);
      return false;
    }
  };

  const handleGenerateOiiOii = async (id, options = {}) => {
    const silent = !!options.silent;
    try {
      const seg = segments.find(s => s.id === id);
      const promptText = buildPromptWithSuffix(promptDraftsRef.current[id] ?? seg?.text);

      if (!promptText || promptText.trim().length === 0) {
        alert('请先填写该分镜的描述词再生成');
        resetRowGenerationState(id);
        return false;
      }

      const isImageRow = seg?.type === 'image';
      const localImagePath = getReferenceLocalPath(seg);
      const remoteImageUrl = getReferenceRemoteUrl(seg);
      const dataImageUrl = getReferenceDataUrl(seg);
      const currentImageUrl = '';
      const referenceImageUrl = remoteImageUrl || dataImageUrl || (/^https?:\/\//i.test(currentImageUrl) ? currentImageUrl : '');

      const oiiVideoModelMap = {
        '渠道四 Gemini': 'gemini',
        '渠道四 Grok': 'grok',
        '渠道四 Grok 1.5': 'grok-imagine-1.5',
      };
      const oiiImageModelMap = {
        '渠道四 GPT-Image2': 'gpt-image2',
        '渠道四 Nano Pro': 'nano-pro',
        '渠道四 Nano 2': 'nano2',
        '渠道四 Seedream 5.0': 'seedream5',
        '渠道四 Seedream 4.5': 'seedream45',
        '渠道四 Midjourney niji7': 'midjourney-niji7',
        '渠道四 Midjourney niji6': 'midjourney-niji6',
        '渠道四 Midjourney v8': 'midjourney8',
        '渠道四 NovelAI': 'novelai',
        '渠道四 GPT-4o': 'gpt4o',
      };
      const modelMap = isImageRow ? oiiImageModelMap : oiiVideoModelMap;
      const fallbackModelName = isImageRow ? '渠道四 GPT-Image2' : '渠道四 Gemini';
      const selectedModelName = modelMap[globalModel]
        ? globalModel
        : (modelMap[seg?.model] ? seg.model : fallbackModelName);
      const model = modelMap[selectedModelName] || modelMap[fallbackModelName];

      const durationSec = resolveDurationSeconds(seg?.duration, globalDuration, 10);
      const aspectRatio = normalizeAspectRatio(seg?.aspectRatio || globalAspectRatio, {
        channel: 'oiioii',
        modelName: selectedModelName,
        mediaType: isImageRow ? 'image' : 'video',
      });

      const imageResolution = ['2K', '4K'].includes(seg?.quality || globalResolution)
        ? (seg?.quality || globalResolution)
        : '2K';

      const oiiPromptText = convertSceneMentionsForOiiOii(promptText);
      const body = {
        prompt: oiiPromptText,
        model,
        aspect_ratio: aspectRatio,
        resolution: isImageRow ? imageResolution : '720p',
      };

      if (!isImageRow) {
        body.duration = durationSec;
        if (model === 'grok-imagine-1.5') {
          body.generateMode = 'firstframe2Video';
        }
      }

      const isGptImage2OiiImage = isImageRow && model === 'gpt-image2';
      if (!isGptImage2OiiImage && localImagePath) {
        body.image_path = localImagePath;
      }
      if (!isGptImage2OiiImage && (remoteImageUrl || dataImageUrl)) {
        body.image_url = remoteImageUrl || dataImageUrl;
      }

      const roleImageRefs = getSegmentCharacterImageRefs(seg, promptText);
      const sceneImageRefs = getSegmentSceneImageRefs(promptText);
      const referenceImages = [];
      [...roleImageRefs, ...sceneImageRefs].forEach(ref => {
        const imageRef = imageRefToReference(ref);
        if (imageRef) referenceImages.push(imageRef);
      });
      if (referenceImages.length > 0) {
        body.reference_images = referenceImages;
      }

      if (!isGptImage2OiiImage && isImageRow && (localImagePath || referenceImageUrl || referenceImages.length > 0)) {
        body.image_to_image = true;
      }

      const createRes = await fetch(`${WIZSTAR_API}${isImageRow ? '/oiioii/images/create' : '/oiioii/tasks/create'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!createRes.ok) {
        let errMsg = `HTTP ${createRes.status}`;
        try { const err = await createRes.json(); errMsg = err.detail || errMsg; } catch (_) {}
        throw new Error(errMsg);
      }

      const taskData = await createRes.json();
      const payload = taskData.data || {};
      const taskId = payload.task_id;
      if (!taskId) throw new Error('渠道四未返回 task_id');
      const timeoutSeconds = payload.timeout_seconds ?? null;
      registerGenerationTask(id, taskId, 'oiioii', isImageRow ? 'image' : 'video', {
        timeoutSeconds,
        remainingSeconds: payload.remaining_seconds ?? timeoutSeconds,
        estimatedWaitSeconds: payload.estimated_wait_seconds ?? payload.remaining_seconds ?? timeoutSeconds,
        elapsedSeconds: payload.elapsed_seconds ?? 0,
        queuePosition: payload.queue_position ?? null,
      });

      setSegments(prev => prev.map(s => s.id === id ? {
        ...s,
        pendingTaskId: taskId,
        pendingTaskIds: [...new Set([...(s.pendingTaskIds || []), taskId])],
        pendingPrimaryTaskId: taskId,
        pendingChannel: 'oiioii',
        generating: true,
        generateStatus: 'processing',
        queuePosition: payload.queue_position ?? null,
        elapsedSeconds: payload.elapsed_seconds ?? 0,
        remainingSeconds: payload.remaining_seconds ?? timeoutSeconds,
        timeoutSeconds,
        estimatedWaitSeconds: payload.estimated_wait_seconds ?? payload.remaining_seconds ?? timeoutSeconds,
        activeTaskCount: Math.max(1, [...new Set([...(s.pendingTaskIds || []), taskId])].length),
      } : s));
      return true;
    } catch (e) {
      console.error('[oiioii] generate failed:', e);
      if (!silent) alert(`生成失败: ${e.message || e}`);
      clearRowGenerationPlaceholder(id);
      return false;
    }
  };

  // Toggle active/play state of current material in a row
  const togglePlayCurrent = (id) => {
    setSegments(prev => prev.map(seg => {
      if (seg.id === id && seg.type === 'video') {
        return {
          ...seg,
          currentMaterialVideo: {
            ...seg.currentMaterialVideo,
            isPlaying: !seg.currentMaterialVideo.isPlaying
          }
        };
      }
      return seg;
    }));
  };

  // Toggle lock state of current material in a row
  const toggleLockRowMaterial = (id) => {
    setSegments(prev => prev.map(seg => {
      if (seg.id === id) {
        return {
          ...seg,
          isLocked: !seg.isLocked
        };
      }
      return seg;
    }));
  };

  // Select material from candidates list for specific row
  const handleSelectCandidateMaterial = (rowId, material) => {
    const row = segments.find(s => s.id === rowId);
    if (row && row.isLocked) {
      alert(`第 ${rowId} 行的画面已被锁定，请先解锁当前素材！`);
      return;
    }

    setSegments(prev => prev.map(seg => {
      if (seg.id === rowId) {
        if (seg.type === 'video') {
          return {
            ...seg,
            currentMaterialVideo: {
              id: material.id,
              name: `${material.name} - 备份`,
              thumbnail: material.thumbnail,
              sourceUrl: material.sourceUrl || material.thumbnail,
              localPath: material.localPath || '',
              remoteUrl: material.remoteUrl || '',
              mediaType: material.mediaType || (isVideoUrl(material.thumbnail) ? 'video' : 'image'),
              isPlaying: false,
              fps: 25,
              duration: material.duration || (material.mediaType === 'video' || isVideoUrl(material.thumbnail) ? '00:05' : '00:04')
            }
          };
        } else {
          return {
            ...seg,
            currentMaterialImage: {
              id: material.id,
              name: `${material.name} - 原画`,
              thumbnail: material.thumbnail,
              sourceUrl: material.sourceUrl || material.thumbnail,
              localPath: material.localPath || '',
              remoteUrl: material.remoteUrl || '',
              mediaType: material.mediaType || (isVideoUrl(material.thumbnail) ? 'video' : 'image'),
              fps: null,
              duration: material.mediaType === 'video' || isVideoUrl(material.thumbnail) ? '00:05' : '静态图片'
            }
          };
        }
      }
      return seg;
    }));
  };

  const handleRenameCurrentMaterial = (rowId) => {
    const row = segments.find(s => s.id === rowId);
    if (!row) return;
    const isVid = row.type === 'video';
    const current = isVid ? row.currentMaterialVideo : row.currentMaterialImage;
    if (!current || !current.id) {
      alert('当前没有可重命名的素材。');
      return;
    }

    const nextName = prompt('请输入新的素材名称：', current.name || '');
    if (!nextName || !nextName.trim()) return;
    const cleanName = nextName.trim();

    setSegments(prev => prev.map(seg => {
      if (seg.id !== rowId) return seg;
      if (isVid) {
        return {
          ...seg,
          currentMaterialVideo: { ...seg.currentMaterialVideo, name: cleanName },
          materialsVideo: (seg.materialsVideo || []).map(mat => mat.id === current.id ? { ...mat, name: cleanName } : mat),
        };
      }
      return {
        ...seg,
        currentMaterialImage: { ...seg.currentMaterialImage, name: cleanName },
        materialsImage: (seg.materialsImage || []).map(mat => mat.id === current.id ? { ...mat, name: cleanName } : mat),
      };
    }));
  };

  // Clear current active preview frame
  const handleClearCurrent = (id) => {
    if (confirm('确定要清除这行分镜的当前预览画面吗？')) {
      setSegments(prev => prev.map(seg => {
        if (seg.id === id) {
          const isVid = seg.type === 'video';
          const emptyMat = {
            id: 0,
            name: '暂无画面',
            thumbnail: '',
            mediaType: isVid ? 'video' : 'image',
            isPlaying: false,
            fps: null,
            duration: null
          };
          return isVid 
            ? { ...seg, currentMaterialVideo: emptyMat }
            : { ...seg, currentMaterialImage: emptyMat };
        }
        return seg;
      }));
    }
  };

  // Delete a specific candidate material frame
  const handleDeleteCandidate = (rowId, materialId) => {
    if (confirm('确定要删除这个备选帧吗？')) {
      setSegments(prev => prev.map(seg => {
        if (seg.id === rowId) {
          const isVid = seg.type === 'video';
          if (isVid) {
            const updatedMaterials = seg.materialsVideo.filter(m => m.id !== materialId);
            const currentSelected = seg.currentMaterialVideo;
            const isDeletingSelected = currentSelected.id === materialId;
            const fallbackMat = updatedMaterials[0] || { id: 0, name: '暂无画面', thumbnail: '', mediaType: 'video' };
            
            return {
              ...seg,
              materialsVideo: updatedMaterials,
              currentMaterialVideo: isDeletingSelected ? {
                id: fallbackMat.id,
                name: fallbackMat.name,
                thumbnail: fallbackMat.thumbnail ? fallbackMat.thumbnail.replace('&w=120', '&w=500') : '',
                sourceUrl: fallbackMat.sourceUrl || fallbackMat.thumbnail || '',
                mediaType: fallbackMat.mediaType || (isVideoUrl(fallbackMat.thumbnail) ? 'video' : 'image'),
                isPlaying: false,
                fps: 25,
                duration: fallbackMat.duration || (fallbackMat.mediaType === 'video' || isVideoUrl(fallbackMat.thumbnail) ? '00:05' : '00:04')
              } : currentSelected
            };
          } else {
            const updatedMaterials = seg.materialsImage.filter(m => m.id !== materialId);
            const currentSelected = seg.currentMaterialImage;
            const isDeletingSelected = currentSelected.id === materialId;
            const fallbackMat = updatedMaterials[0] || { id: 0, name: '暂无画面', thumbnail: '', mediaType: 'image' };

            return {
              ...seg,
              materialsImage: updatedMaterials,
              currentMaterialImage: isDeletingSelected ? {
                id: fallbackMat.id,
                name: fallbackMat.name,
                thumbnail: fallbackMat.thumbnail ? fallbackMat.thumbnail.replace('&w=120', '&w=500') : '',
                sourceUrl: fallbackMat.sourceUrl || fallbackMat.thumbnail || '',
                mediaType: fallbackMat.mediaType || (isVideoUrl(fallbackMat.thumbnail) ? 'video' : 'image'),
                fps: null,
                duration: fallbackMat.mediaType === 'video' || isVideoUrl(fallbackMat.thumbnail) ? '00:05' : '静态图片'
              } : currentSelected
            };
          }
        }
        return seg;
      }));
    }
  };

  // Update prompt text inside a row
  const commitPromptDraft = (id, text = promptDraftsRef.current[id]) => {
    if (typeof text !== 'string') return;
    setSegments(prev => prev.map(seg => seg.id === id && seg.text !== text ? { ...seg, text } : seg));
  };

  const startEditingPrompt = (row) => {
    promptDraftsRef.current[row.id] = promptDraftsRef.current[row.id] ?? row.text ?? '';
    setEditingRowId(row.id);
    requestAnimationFrame(() => {
      const textarea = promptTextareaRefs.current[row.id];
      if (!textarea) return;
      textarea.focus();
      const cursorPosition = textarea.value.length;
      try { textarea.setSelectionRange(cursorPosition, cursorPosition); } catch (_) {}
      resizePromptTextarea(textarea);
    });
  };

  const resetAtState = () => {
    setAtState({
      rowId: null,
      isOpen: false,
      trigger: '@',
      query: '',
      cursorPos: 0,
    });
  };

  // Resolve the asset list backing a given trigger symbol
  const getAssetsForTrigger = (trigger) => {
    const type = TRIGGERS[trigger]?.type;
    if (type === 'scene') return sceneAssets;
    if (type === 'item') return itemAssets;
    return characterAssets;
  };

  // Handle live textarea change with '@' / '$' / '#' autocomplete detection
  const handleTextareaChange = (rowId, text, e) => {
    promptDraftsRef.current[rowId] = text;
    // Immediately sync text to segments state so auto-save persists it,
    // instead of waiting for onBlur which may never fire if the user
    // switches projects or closes the app while still editing.
    setSegments(prev => prev.map(seg => seg.id === rowId && seg.text !== text ? { ...seg, text } : seg));
    resizePromptTextarea(e.target);

    const selectionStart = e.target.selectionStart;
    const textBeforeCursor = text.substring(0, selectionStart);

    // 找到光标前最近的一个触发符（@ / $ / #）
    let trigger = null;
    let triggerIdx = -1;
    Object.keys(TRIGGERS).forEach((sym) => {
      const idx = textBeforeCursor.lastIndexOf(sym);
      if (idx > triggerIdx) {
        triggerIdx = idx;
        trigger = sym;
      }
    });

    if (trigger && triggerIdx !== -1) {
      const query = textBeforeCursor.substring(triggerIdx + 1);
      if (!query.includes(' ') && query.length < 15) {
        setAtState({
          rowId,
          isOpen: true,
          trigger,
          query,
          cursorPos: selectionStart,
        });

        const matches = getAssetsForTrigger(trigger).filter(asset =>
          asset.name.toLowerCase().includes(query.toLowerCase())
        );
        if (matches.length > 0) {
          setHoveredCharId(matches[0].id);
        }
        return;
      }
    }

    setAtState({
      rowId: null,
      isOpen: false,
      trigger: '@',
      query: '',
      cursorPos: 0,
    });
  };

  // Complete asset selection from dropdown and auto-populate row tags
  const handleSelectCharacterFromDropdown = (rowId, assetName, trigger = '@') => {
    setSegments(prev => prev.map(seg => {
      if (seg.id === rowId) {
        const text = promptDraftsRef.current[rowId] ?? seg.text;
        const cursorPos = atState.cursorPos;
        const textBeforeCursor = text.substring(0, cursorPos);
        const textAfterCursor = text.substring(cursorPos);
        const triggerIdx = textBeforeCursor.lastIndexOf(trigger);

        if (triggerIdx !== -1) {
          // Replace "<trigger>query" with "（<trigger>${assetName}）"
          const newTextBefore = textBeforeCursor.substring(0, triggerIdx) + `（${trigger}${assetName}）`;
          const newText = newTextBefore + textAfterCursor;
          promptDraftsRef.current[rowId] = newText;
          const textarea = promptTextareaRefs.current[rowId];
          if (textarea) {
            textarea.value = newText;
            resizePromptTextarea(textarea);
            requestAnimationFrame(() => {
              try { textarea.setSelectionRange(newTextBefore.length, newTextBefore.length); } catch (_) {}
            });
          }

          // 角色才维护 associatedCharacters（场景/物品仅做文本标签）
          if (trigger === '@') {
            const fullChar = characterAssets.find(c => c.name === assetName);
            return {
              ...seg,
              text: newText,
              associatedCharacters: seg.associatedCharacters.some(c => c.name === assetName)
                ? seg.associatedCharacters
                : [
                    ...seg.associatedCharacters,
                    {
                      id: fullChar?.id || '',
                      name: assetName,
                      avatar: fullChar?.avatar || '',
                      avatarPath: fullChar?.avatarPath || '',
                      role: fullChar?.role || '',
                      sendImage: true,
                      val: 1
                    }
                  ]
            };
          }

          return { ...seg, text: newText };
        }
      }
      return seg;
    }));

    // Close autocomplete dropdown
    setAtState({
      rowId: null,
      isOpen: false,
      trigger: '@',
      query: '',
      cursorPos: 0,
    });
  };

  // Backspace deletes a whole （@角色）/（$场景）/（#物品）token as if it were a chip
  const handleTextareaKeyDown = (rowId, e) => {
    if (e.key !== 'Backspace') return;
    const el = e.target;
    const selStart = el.selectionStart;
    const selEnd = el.selectionEnd;
    if (selStart !== selEnd || selStart === 0) return; // only when nothing selected and caret not at start

    const text = el.value;
    const before = text.substring(0, selStart);
    // 光标前是否紧贴一个 token 结尾的右括号
    const m = before.match(/[（(]([@$#])([^）)]+)[）)]$/);
    if (!m) return; // 普通字符，走默认删除

    e.preventDefault();
    const tokenStart = selStart - m[0].length;
    const newText = text.substring(0, tokenStart) + text.substring(selStart);
    const removedTrigger = m[1];
    const removedName = m[2];

    promptDraftsRef.current[rowId] = newText;
    setSegments(prev => prev.map(seg => {
      if (seg.id !== rowId) return seg;
      const next = { ...seg, text: newText };
      // 删的是角色 token，且文本里不再出现该角色，则同步移除关联
      if (removedTrigger === '@' && Array.isArray(seg.associatedCharacters)) {
        const stillReferenced = newText.includes(`（@${removedName}）`) || newText.includes(`(@${removedName})`);
        if (!stillReferenced) {
          next.associatedCharacters = seg.associatedCharacters.filter(c => c.name !== removedName);
        }
      }
      return next;
    }));

    // 还原光标到 token 起点
    requestAnimationFrame(() => {
      try { el.setSelectionRange(tokenStart, tokenStart); } catch (_) {}
    });
  };

  // Add new row/segment
  const handleAddNewSegmentRow = () => {
    const newId = segments.length > 0 ? Math.max(...segments.map(s => Number(s.id) || 0)) + 1 : 1;
    setSegments([...segments, createSegmentRow(newId)]);
  };

  // Delete a row/segment
  const handleDeleteSegmentRow = (id, e) => {
    e.stopPropagation();
    if (segments.length <= 1) {
      alert('至少需要保留一行分镜进行视频生成！');
      return;
    }
    if (confirm(`确定删除第 ${id} 行分镜及所有对应素材吗？`)) {
      setSegments(segments.filter(s => s.id !== id));
    }
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-dark-bg/20">
      {showBatchPromptModal && (
        <div className="fixed inset-0 z-[90] bg-black/60 backdrop-blur-sm flex items-center justify-center p-6">
          <div className="w-full max-w-2xl bg-[#1a1b1f] border border-dark-border rounded-2xl shadow-2xl overflow-hidden">
            <div className="px-5 py-4 border-b border-dark-border flex items-center justify-between">
              <div>
                <h3 className="text-sm font-extrabold text-white">批量添加提示词</h3>
                <p className="text-[10px] text-dark-muted mt-1">支持分镜长提示词：按“1.## 标题 - [镜头1 / 15.0s]”或“## 标题 - [镜头1 / 15.0s]”切分；时间轴 0.0s-1.8s 不会被拆开。</p>
              </div>
              <button
                type="button"
                onClick={() => setShowBatchPromptModal(false)}
                className="p-1.5 rounded-lg text-dark-muted hover:text-white hover:bg-dark-card transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 space-y-3">
              <div className="flex items-center gap-2 text-xs">
                <button
                  type="button"
                  onClick={() => setBatchPromptMode('replace')}
                  className={`px-3 py-1.5 rounded-lg border font-bold transition-all ${batchPromptMode === 'replace' ? 'bg-brand text-black border-brand' : 'bg-dark-input border-dark-border text-dark-muted hover:text-white'}`}
                >
                  覆盖对应行
                </button>
                <button
                  type="button"
                  onClick={() => setBatchPromptMode('append')}
                  className={`px-3 py-1.5 rounded-lg border font-bold transition-all ${batchPromptMode === 'append' ? 'bg-brand text-black border-brand' : 'bg-dark-input border-dark-border text-dark-muted hover:text-white'}`}
                >
                  追加到对应行
                </button>
                <span className="text-[10px] text-dark-subtle ml-auto">当前 {segments.length} 行</span>
              </div>

              <textarea
                value={batchPromptText}
                onChange={(e) => setBatchPromptText(e.target.value)}
                placeholder={'示例：\n1.## 海城大学咖啡厅 - [镜头1 / 15.0s]\n**【第一部分：视觉与技术参数设定】**\n0.0s-1.8s：\n运镜：中景平视 + 手持呼吸感镜头。\n\n===\n\n2.## 海城大学咖啡厅 - [镜头2 / 15.0s]\n**【第一部分：视觉与技术参数设定】**\n0.0s-2.0s：\n画面：继续下一段分镜。'}
                className="w-full h-72 bg-dark-bg border border-dark-border rounded-xl p-3 text-xs text-white placeholder:text-dark-subtle focus:outline-none focus:border-brand/60 resize-none leading-relaxed"
              />

              <div className="flex items-center justify-between gap-3 pt-2">
                <span className="text-[10px] text-dark-muted">
                  已识别 {parseBatchPromptBlocks(batchPromptText).length} 条提示词
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setShowBatchPromptModal(false)}
                    className="px-4 py-2 rounded-lg bg-dark-input border border-dark-border text-dark-muted hover:text-white hover:border-dark-subtle text-xs font-bold transition-all"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={applyBatchPrompts}
                    className="px-5 py-2 rounded-lg bg-brand hover:bg-brand-dark text-black text-xs font-extrabold transition-all"
                  >
                    应用到分镜
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
      
      {/* 1. Page Header (Sub indicator) */}
      <div className="h-11 border-b border-dark-border px-6 flex items-center justify-between shrink-0 bg-dark-bg/60">
        <div className="flex items-center space-x-3.5">
          {onBack && (
            <button 
              type="button"
              onClick={onBack}
              className="flex items-center space-x-1.5 px-2.5 py-1 border border-dark-border hover:border-brand/40 bg-dark-card hover:bg-dark-cardHover text-[10px] font-bold text-dark-muted hover:text-white rounded-lg transition-all"
            >
              <span>◀ 返回项目列表</span>
            </button>
          )}
          <span className="text-xs text-dark-subtle">|</span>
          <span className="text-xs text-dark-muted">正在编辑项目:</span>
          <span className="text-xs font-bold text-brand">{activeDraft?.title || '5月2日项目'}</span>
          <span className="text-[10px] bg-dark-border/60 text-dark-muted border border-dark-border px-2 py-0.5 rounded-full">
            共 {segments.length} 个分镜行
          </span>
        </div>
        <div className="flex items-center space-x-3 text-[11px] text-dark-muted">
          <span>{getModelMediaType(globalModel) === 'image' ? `图片分辨率: ${globalResolution}` : `视频参数: ${globalAspectRatio} · ${globalDuration}`}</span>
          <span>GPU渲染加速: 开启</span>
          <button 
            type="button"
            onClick={handleStartAllTasks}
            disabled={batchStarting}
            className={`flex items-center space-x-1 px-3 py-1 rounded font-extrabold text-[10px] transition-all ${batchStarting ? 'bg-dark-input border border-dark-border text-dark-subtle cursor-not-allowed' : 'bg-brand hover:bg-brand-dark border border-brand text-black shadow-[0_0_14px_rgba(16,185,129,0.25)]'}`}
            title={getModelMediaType(globalModel) === 'image' ? '一键发送所有已填写提示词、且未在生成中的图片分镜生图任务' : '一键发送所有已填写提示词、且未在生成中的视频分镜任务'}
          >
            {batchStarting ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
            <span>{batchStarting ? '任务发送中' : (getModelMediaType(globalModel) === 'image' ? '一键发送生图' : '一键发送任务')}</span>
          </button>
          <button
            type="button"
            onClick={handleBatchCollectDolaTasks}
            disabled={batchCollecting}
            className="flex items-center space-x-1 px-2.5 py-1 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/40 hover:border-amber-500 rounded text-amber-400 font-bold text-[10px] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            title="一键采集所有有 conversation_id 且未完成的渠道六 Dola 任务"
          >
            {batchCollecting ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
            <span>{batchCollecting ? '批量采集中' : '批量采集'}</span>
          </button>
          <button 
            type="button"
            onClick={openBatchPromptModal}
            className="flex items-center space-x-1 px-2.5 py-1 bg-blue-500/10 hover:bg-blue-500/20 border border-blue-500/40 hover:border-blue-500 rounded text-blue-300 font-bold text-[10px] transition-all"
          >
            <Layers className="w-3 h-3" />
            <span>批量提示词</span>
          </button>
          <button 
            onClick={handleRunBatchReferenceImage}
            className="flex items-center space-x-1 px-2.5 py-1 bg-purple-500/10 hover:bg-purple-500/20 border border-purple-500/40 hover:border-purple-500 rounded text-purple-400 font-bold text-[10px] transition-all"
          >
            <FileImage className="w-3 h-3" />
            <span>批量加垫图</span>
          </button>
          <button 
            onClick={handleAddNewSegmentRow}
            className="flex items-center space-x-1 px-2.5 py-1 bg-brand/10 hover:bg-brand/20 border border-brand/40 hover:border-brand rounded text-brand font-bold text-[10px] transition-all"
          >
            <Plus className="w-3 h-3" />
            <span>新增分镜行</span>
          </button>
        </div>
      </div>

      {/* Global Top Control Deck matching Second Screenshot */}
      <div className="bg-dark-sidebar/25 border-b border-dark-border px-6 py-3.5 grid grid-cols-3 gap-4.5 shrink-0 select-none text-xs">
        
        {/* PANEL 1: 全局配置 */}
        <div className="bg-dark-card/45 border border-dark-border p-3 rounded-xl flex flex-col justify-between relative">
          <div className="flex justify-between items-center text-[10px] text-dark-muted font-bold tracking-wider uppercase mb-1.5 shrink-0">
            <span>全局配置</span>
            <div className="flex items-center gap-1.5 normal-case">
              <span className="text-[8px] text-dark-subtle">通道</span>
              <div className="flex bg-dark-input border border-dark-border rounded-md overflow-hidden">
                <button
                  type="button"
                  onClick={() => selectGenerationModel('Seedance 2.0', 'wizstar')}
                  className={`px-1.5 py-0.5 text-[8px] font-bold transition-all ${generateChannel === 'wizstar' ? 'bg-brand text-black' : 'text-dark-muted hover:text-white'}`}
                  title="渠道一账号池通道"
                >账号池</button>
                <button
                  type="button"
                  onClick={() => selectGenerationModel('渠道二 标准', 'pixmax')}
                  className={`px-1.5 py-0.5 text-[8px] font-bold transition-all ${generateChannel === 'pixmax' ? 'bg-brand text-black' : 'text-dark-muted hover:text-white'}`}
                  title="渠道二（Pixmax · 图生视频）"
                >渠道二</button>
                <button
                  type="button"
                  onClick={() => selectGenerationModel('渠道四 Gemini', 'oiioii')}
                  className={`px-1.5 py-0.5 text-[8px] font-bold transition-all ${generateChannel === 'oiioii' ? 'bg-brand text-black' : 'text-dark-muted hover:text-white'}`}
                  title="渠道四（OiiOii · 多模型视频生成）"
                >渠道四</button>
                <button
                  type="button"
                  onClick={() => selectGenerationModel('渠道五 GPT-Image2', 'chatgpt2api')}
                  className={`px-1.5 py-0.5 text-[8px] font-bold transition-all ${generateChannel === 'chatgpt2api' ? 'bg-brand text-black' : 'text-dark-muted hover:text-white'}`}
                  title="渠道五（ChatGPT2API · GPT-Image2 生图）"
                >渠道五</button>
                <button
                  type="button"
                  onClick={() => selectGenerationModel('渠道六 Seedance 2.0', 'dola')}
                  className={`px-1.5 py-0.5 text-[8px] font-bold transition-all ${generateChannel === 'dola' ? 'bg-brand text-black' : 'text-dark-muted hover:text-white'}`}
                  title="渠道六（Dola · Seedance 视频生成）"
                >渠道六</button>
                <button
                  type="button"
                  onClick={() => selectGenerationModel('渠道七 Lovart', 'lovart')}
                  className={`px-1.5 py-0.5 text-[8px] font-bold transition-all ${generateChannel === 'lovart' ? 'bg-brand text-black' : 'text-dark-muted hover:text-white'}`}
                  title="渠道七（Lovart · GPT-Image2 生图）"
                >渠道七</button>
                <button
                  type="button"
                  onClick={() => selectGenerationModel('Seedance 2.0 Mini', 'oreateai')}
                  className={`px-1.5 py-0.5 text-[8px] font-bold transition-all ${generateChannel === 'oreateai' ? 'bg-brand text-black' : 'text-dark-muted hover:text-white'}`}
                  title="渠道八（OreateAI · Seedance 视频生成）"
                >渠道八</button>
                <button
                  type="button"
                  onClick={() => selectGenerationModel('渠道九 Seedance 2.0 Mini', 'framia')}
                  className={`px-1.5 py-0.5 text-[8px] font-bold transition-all ${generateChannel === 'framia' ? 'bg-brand text-black' : 'text-dark-muted hover:text-white'}`}
                  title="渠道九（Framia · Seedance 视频生成）"
                >渠道九</button>
                <button
                  type="button"
                  onClick={() => selectGenerationModel('渠道十 Tensor.Art 视频', 'tensorart')}
                  className={`px-1.5 py-0.5 text-[8px] font-bold transition-all ${generateChannel === 'tensorart' ? 'bg-brand text-black' : 'text-dark-muted hover:text-white'}`}
                  title="渠道十（Tensor.Art · 图生视频）"
                >渠道十</button>
              </div>
            </div>
          </div>
          {generateChannel === 'pixmax' && (
            <div className="mb-1.5 px-2 py-1 rounded-md bg-amber-500/10 border border-amber-500/30 text-[8px] text-amber-300 leading-snug">
              渠道二图生视频：需先在「设置 → 渠道二」配置 API Key，并为分镜设置「垫图」（图片 URL 或本地文件）。
            </div>
          )}
          {generateChannel === 'oiioii' && (
            <div className="mb-1.5 px-2 py-1 rounded-md bg-purple-500/10 border border-purple-500/30 text-[8px] text-purple-300 leading-snug">
              渠道四多模型：需先在「设置 → 渠道四」配置代理并注册账号。生图最长等待 30 分钟，任务卡片会显示已等多久 / 最多还剩多久。
            </div>
          )}
          {generateChannel === 'chatgpt2api' && (
            <div className="mb-1.5 px-2 py-1 rounded-md bg-sky-500/10 border border-sky-500/30 text-[8px] text-sky-300 leading-snug">
              渠道五 GPT-Image2 生图：需先在「设置 → 渠道五」配置 API Key。支持文生图，也可用垫图做图生图。
            </div>
          )}
          {generateChannel === 'dola' && (
            <div className="mb-1.5 px-2 py-1 rounded-md bg-orange-500/10 border border-orange-500/30 text-[8px] text-orange-300 leading-snug flex items-center justify-between gap-2">
              <span>
                渠道六 Dola 视频：当前使用「{dolaSendModeLabel}」。生成、轮询、URL 解析、下载和采集均走后端 API；浏览器只用于用户手动授权或诊断。
              </span>
              <div className="shrink-0 flex items-center gap-1">
                <button
                  type="button"
                  onClick={refreshDolaConfig}
                  className="px-1.5 py-0.5 rounded bg-black/20 border border-orange-400/20 hover:border-orange-300/50 text-[8px] font-bold"
                  title="重新读取设置页保存的 Dola 发送方式"
                >
                  刷新
                </button>
              </div>
            </div>
          )}
          {generateChannel === 'lovart' && (
            <div className="mb-1.5 px-2 py-1 rounded-md bg-blue-500/10 border border-blue-500/30 text-[8px] text-blue-300 leading-snug">
              渠道七 Lovart：需先在「设置 → 渠道七」采集 Lovart 登录态。支持文生图，也可用垫图 / @角色 / $场景作为参考图。
            </div>
          )}
          {generateChannel === 'framia' && (
            <div className="mb-1.5 px-2 py-1 rounded-md bg-teal-500/10 border border-teal-500/30 text-[8px] text-teal-300 leading-snug">
              渠道九 Framia：需先在「设置 → 渠道九」通过 Google OAuth 登录采集账号。支持文生视频和图生视频，使用 Seedance / Kling 模型。
            </div>
          )}
          {generateChannel === 'tensorart' && (
            <div className="mb-1.5 px-2 py-1 rounded-md bg-violet-500/10 border border-violet-500/30 text-[8px] text-violet-300 leading-snug">
              渠道十 Tensor.Art：支持 4–10 秒图生视频；4 秒 19 积分，10 秒 47 积分。完成后直接使用任务返回的 downloadUrl 下载。
            </div>
          )}
          {generateChannel === 'oreateai' && (
            <div className="mb-1.5 px-2 py-1 rounded-md bg-cyan-500/10 border border-cyan-500/30 text-[8px] text-cyan-200 leading-snug flex items-center justify-between gap-2">
              <span>渠道八 OreateAI：能力、积分和素材限制由当前账号实时配置决定；仅上传桌面端选择的本地文件。</span>
              <button
                type="button"
                onClick={refreshOreateaiCapabilities}
                disabled={oreateaiCapabilitiesLoading}
                className="shrink-0 px-1.5 py-0.5 rounded bg-black/20 border border-cyan-300/20 hover:border-cyan-200/50 disabled:opacity-50 text-[8px] font-bold"
              >{oreateaiCapabilitiesLoading ? '读取中' : '刷新'}</button>
            </div>
          )}
          {oreateaiCapabilitiesError && generateChannel === 'oreateai' && (
            <div className="mb-1.5 px-2 py-1 rounded-md bg-red-500/10 border border-red-500/30 text-[8px] text-red-200 leading-snug">
              渠道八配置不可用：{oreateaiCapabilitiesError}
            </div>
          )}
          <div className="grid grid-cols-5 gap-1.5 flex-1 items-stretch">
            {/* Tile 1: 选择模型 dropdown trigger */}
            <div 
              onClick={() => setActivePopover(activePopover === 'model' ? null : 'model')}
              className={`bg-dark-input hover:bg-dark-bg border p-1.5 rounded-lg text-center flex flex-col justify-center cursor-pointer transition-all ${
                activePopover === 'model' ? 'border-brand shadow-[0_0_8px_rgba(16,185,129,0.25)]' : 'border-dark-border hover:border-brand/40'
              }`}
            >
              <span className="text-[10px] font-bold text-brand leading-none mb-1 block">{getModelLabel(globalModel)}</span>
              <span className="text-[8px] text-white truncate max-w-full block scale-90">{globalModel}</span>
            </div>
            
            {/* Tile 2: 生成参数 */}
            <div 
              onClick={() => setActivePopover(activePopover === 'params' ? null : 'params')}
              className={`bg-dark-input hover:bg-dark-bg border p-1.5 rounded-lg text-center flex flex-col justify-center cursor-pointer transition-all ${
                activePopover === 'params' ? 'border-brand shadow-[0_0_8px_rgba(16,185,129,0.25)]' : 'border-dark-border hover:border-brand/40'
              }`}
            >
              <span className="text-[9px] font-extrabold text-white leading-none block">
                {globalAspectRatio}
                {generateChannel === 'oreateai' ? ` · ${String(globalResolution).replace(/p$/i, '')}P` : ''}
              </span>
              <span className="text-[8px] text-dark-muted mt-0.5 scale-90 block">{globalDuration}</span>
              <span className="text-[7px] text-dark-subtle block scale-75 mt-0.5">生成参数</span>
            </div>

            {/* Tile 3: 提示词前缀 */}
            <div 
              onClick={() => setActivePopover(activePopover === 'prefix' ? null : 'prefix')}
              className={`bg-dark-input hover:bg-dark-bg border p-1.5 rounded-lg text-center flex flex-col justify-center cursor-pointer transition-all relative ${
                activePopover === 'prefix' ? 'border-brand shadow-[0_0_8px_rgba(16,185,129,0.25)]' : 'border-dark-border hover:border-brand/40'
              }`}
            >
              <span className="absolute -top-1 -right-1 text-[7px] bg-dark-border text-dark-muted px-1 rounded border border-white/5 scale-75">预设</span>
              <Sparkles className="w-3.5 h-3.5 mx-auto text-brand mb-0.5" />
              <span className="text-[8px] text-white truncate">{selectedPromptPrefix.name}</span>
            </div>

            {/* Tile 4: 提示词后缀 */}
            <div 
              onClick={() => setActivePopover(activePopover === 'suffix' ? null : 'suffix')}
              className={`bg-dark-input hover:bg-dark-bg border p-1.5 rounded-lg text-center flex flex-col justify-center cursor-pointer transition-all relative ${
                activePopover === 'suffix' ? 'border-brand shadow-[0_0_8px_rgba(16,185,129,0.25)]' : 'border-dark-border hover:border-brand/40'
              }`}
            >
              <span className="absolute -top-1 -right-1 text-[7px] bg-dark-border text-dark-muted px-1 rounded border border-white/5 scale-75">预设</span>
              <Sparkles className="w-3.5 h-3.5 mx-auto text-brand mb-0.5" />
              <span className="text-[8px] text-white truncate">{selectedPromptSuffix.name}</span>
            </div>

            {/* Tile 5: 添加音频 */}
            <div 
              onClick={() => alert('选择本地音频背景乐')}
              className="bg-dark-input hover:bg-dark-bg border border-dark-border hover:border-brand/40 p-1.5 rounded-lg text-center flex flex-col justify-center cursor-pointer transition-all relative"
            >
              <span className="absolute -top-1 -right-1 text-[7px] bg-dark-border text-dark-muted px-1 rounded border border-white/5 scale-75">未添加</span>
              <span className="text-[9px] font-bold text-dark-muted mb-0.5">🎵</span>
              <span className="text-[8px] text-dark-muted truncate">添加音频</span>
            </div>
          </div>

          {/* POPOVER 1: 选择模型 Modal matching Image 2 */}
          {activePopover === 'model' && (
            <div className="absolute top-[102%] left-0 w-[310px] bg-[#1a1b1f] border border-dark-border p-4 rounded-xl shadow-[0_12px_30px_rgba(0,0,0,0.6)] z-50 text-xs text-dark-text animate-in fade-in slide-in-from-top-2 duration-150">
              <div className="flex justify-between items-center pb-2 border-b border-dark-border/40 mb-3.5">
                <span className="font-extrabold text-white text-[13px] tracking-wide">选择模型</span>
                <div className="flex space-x-2.5 text-dark-subtle">
                  <button onClick={() => alert('刷新模型列表中...')} className="hover:text-white text-sm" title="刷新">↻</button>
                  <button onClick={() => setActivePopover(null)} className="hover:text-white text-sm font-bold" title="关闭">✕</button>
                </div>
              </div>
              <div className="flex rounded-lg bg-dark-input border border-dark-border p-0.5 mb-3">
                <button
                  type="button"
                  onClick={() => setModelPopoverTab('video')}
                  className={`flex-1 py-1.5 rounded-md text-[10px] font-extrabold transition-all ${modelPopoverTab === 'video' ? 'bg-brand text-black' : 'text-dark-muted hover:text-white'}`}
                >
                  视频模型
                </button>
                <button
                  type="button"
                  onClick={() => setModelPopoverTab('image')}
                  className={`flex-1 py-1.5 rounded-md text-[10px] font-extrabold transition-all ${modelPopoverTab === 'image' ? 'bg-brand text-black' : 'text-dark-muted hover:text-white'}`}
                >
                  图片模型
                </button>
              </div>
              
              <div className="space-y-4">
                {modelPopoverTab === 'video' && <>
                {/* Category 2: 视频模型 */}
                <div>
                  <p className="text-[10px] text-dark-muted font-bold mb-2 uppercase tracking-wider">视频模型</p>
                  <div className="grid grid-cols-3 gap-1.5">
                    {['Seedance 2.0', 'Seedance 1.5', 'Kling'].map(m => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => selectGenerationModel(m, 'wizstar')}
                        className={`py-2.5 px-1 rounded-lg border text-center flex flex-col items-center justify-center relative transition-all ${
                          globalModel === m 
                            ? 'border-brand bg-brand/10 text-brand font-bold shadow-[0_0_8px_rgba(16,185,129,0.15)]' 
                            : 'border-dark-border bg-[#222328] hover:border-dark-subtle text-white'
                        }`}
                      >
                        <div className="absolute top-0.5 right-0.5 flex space-x-0.5 scale-75 origin-top-right text-dark-muted text-[6px]">
                          <span>￥</span>
                          <span>☁</span>
                        </div>
                        <span className="text-[9px] leading-tight mt-1.5 font-semibold text-center">{m}</span>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Category 2.5: 渠道二（Pixmax · 图生视频） */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-[10px] text-dark-muted font-bold uppercase tracking-wider">渠道二（图生视频）</p>
                    {generateChannel === 'pixmax' && (
                      <span className="text-[8px] text-brand font-bold px-1.5 py-0.5 rounded bg-brand/10 border border-brand/30">当前通道</span>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-1.5">
                    {[
                      { name: '渠道二 标准', desc: '账号池 · 图生视频', model: 'pixdance-2-fast' },
                      { name: '渠道二 高质量', desc: '高质量 · 图生视频', model: 'pixdance-2' },
                    ].map(p => (
                      <button
                        key={p.name}
                        type="button"
                        onClick={() => selectGenerationModel(p.name, 'pixmax')}
                        className={`py-2.5 px-1 rounded-lg border text-center flex flex-col items-center justify-center relative transition-all ${
                          globalModel === p.name
                            ? 'border-brand bg-brand/10 text-brand font-bold shadow-[0_0_8px_rgba(16,185,129,0.15)]'
                            : 'border-dark-border bg-[#222328] hover:border-dark-subtle text-white'
                        }`}
                      >
                        <span className="absolute top-0.5 right-0.5 scale-75 origin-top-right text-amber-400 text-[6px] font-bold">PX</span>
                        <span className="text-[9px] leading-tight font-semibold text-center">{p.name}</span>
                        <span className="text-[7px] text-dark-muted mt-0.5 scale-90">{p.desc}</span>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Category 4: 渠道四（OiiOii · 视频模型） */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-[10px] text-dark-muted font-bold uppercase tracking-wider">渠道四（视频模型）</p>
                    {generateChannel === 'oiioii' && [
                      '渠道四 Gemini',
                      '渠道四 Grok',
                      '渠道四 Grok 1.5',
                    ].includes(globalModel) && (
                      <span className="text-[8px] text-brand font-bold px-1.5 py-0.5 rounded bg-brand/10 border border-brand/30">当前通道</span>
                    )}
                  </div>
                  <div className="grid grid-cols-3 gap-1.5">
                    {[
                      { name: '渠道四 Gemini', desc: 'Gemini Omni' },
                      { name: '渠道四 Grok', desc: 'Grok Imagine' },
                      { name: '渠道四 Grok 1.5', desc: 'Grok Imagine 1.5' },
                    ].map(p => (
                      <button
                        key={p.name}
                        type="button"
                        onClick={() => selectGenerationModel(p.name, 'oiioii')}
                        className={`py-2.5 px-1 rounded-lg border text-center flex flex-col items-center justify-center relative transition-all ${
                          globalModel === p.name
                            ? 'border-brand bg-brand/10 text-brand font-bold shadow-[0_0_8px_rgba(16,185,129,0.15)]'
                            : 'border-dark-border bg-[#222328] hover:border-dark-subtle text-white'
                        }`}
                      >
                        <span className="absolute top-0.5 right-0.5 scale-75 origin-top-right text-purple-400 text-[6px] font-bold">OI</span>
                        <span className="text-[9px] leading-tight font-semibold text-center">{p.name.replace('渠道四 ', '')}</span>
                        <span className="text-[7px] text-dark-muted mt-0.5 scale-90">视频 · {p.desc}</span>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Category 6: 渠道六（Dola · 视频模型） */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-[10px] text-dark-muted font-bold uppercase tracking-wider">
                      渠道六（Dola 视频）
                    </p>
                    {generateChannel === 'dola' && (
                      <span className="text-[8px] text-brand font-bold px-1.5 py-0.5 rounded bg-brand/10 border border-brand/30">当前通道</span>
                    )}
                  </div>
                  <div className="grid grid-cols-3 gap-1.5">
                    {[
                      { name: '渠道六 Seedance 2.0', desc: '默认模型' },
                      { name: '渠道六 Seedance 1.5', desc: '兼容模型' },
                      { name: '渠道六 Seedance Lite', desc: '轻量模型' },
                    ].map(p => (
                      <button
                        key={p.name}
                        type="button"
                        onClick={() => selectGenerationModel(p.name, 'dola')}
                        className={`py-2.5 px-1 rounded-lg border text-center flex flex-col items-center justify-center relative transition-all ${
                          globalModel === p.name
                            ? 'border-brand bg-brand/10 text-brand font-bold shadow-[0_0_8px_rgba(16,185,129,0.15)]'
                            : 'border-dark-border bg-[#222328] hover:border-dark-subtle text-white'
                        }`}
                      >
                        <span className="absolute top-0.5 right-0.5 scale-75 origin-top-right text-orange-300 text-[6px] font-bold">D6</span>
                        <span className="text-[9px] leading-tight font-semibold text-center">{p.name.replace('渠道六 ', '')}</span>
                        <span className="text-[7px] text-dark-muted mt-0.5 scale-90">视频 · {p.desc}</span>
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-[10px] text-dark-muted font-bold uppercase tracking-wider">渠道八（OreateAI 视频）</p>
                    {generateChannel === 'oreateai' && (
                      <span className="text-[8px] text-brand font-bold px-1.5 py-0.5 rounded bg-brand/10 border border-brand/30">当前通道</span>
                    )}
                  </div>
                  <div className="grid grid-cols-3 gap-1.5">
                    {(oreateaiCapabilities?.models || []).map((modelName) => (
                      <button
                        key={modelName}
                        type="button"
                        onClick={() => selectGenerationModel(modelName, 'oreateai')}
                        className={`py-2.5 px-1 rounded-lg border text-center flex flex-col items-center justify-center relative transition-all ${
                          globalModel === modelName && generateChannel === 'oreateai'
                            ? 'border-brand bg-brand/10 text-brand font-bold shadow-[0_0_8px_rgba(16,185,129,0.15)]'
                            : 'border-dark-border bg-[#222328] hover:border-dark-subtle text-white'
                        }`}
                      >
                        <span className="absolute top-0.5 right-0.5 scale-75 origin-top-right text-cyan-300 text-[6px] font-bold">O8</span>
                        <span className="text-[9px] leading-tight font-semibold text-center">{modelName.replace('Seedance ', '')}</span>
                        <span className="text-[7px] text-dark-muted mt-0.5 scale-90">视频 · 动态配置</span>
                      </button>
                    ))}
                    {!oreateaiCapabilities?.models?.length && (
                      <button type="button" onClick={refreshOreateaiCapabilities} className="col-span-3 py-2 rounded-lg border border-dashed border-cyan-500/40 text-cyan-200 text-[9px] font-bold hover:bg-cyan-500/10">
                        {oreateaiCapabilitiesLoading ? '正在读取渠道八模型…' : '读取渠道八模型'}
                      </button>
                    )}
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-[10px] text-dark-muted font-bold uppercase tracking-wider">渠道九（Framia 视频）</p>
                    {generateChannel === 'framia' && (
                      <span className="text-[8px] text-brand font-bold px-1.5 py-0.5 rounded bg-brand/10 border border-brand/30">当前通道</span>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-1.5">
                    {[
                      { name: '渠道九 Seedance 2.0 Mini', desc: 'Seedance · 默认' },
                      { name: '渠道九 Kling 3.0', desc: 'Kling · 高质量' },
                    ].map(p => (
                      <button
                        key={p.name}
                        type="button"
                        onClick={() => selectGenerationModel(p.name, 'framia')}
                        className={`py-2.5 px-1 rounded-lg border text-center flex flex-col items-center justify-center relative transition-all ${
                          globalModel === p.name && generateChannel === 'framia'
                            ? 'border-brand bg-brand/10 text-brand font-bold shadow-[0_0_8px_rgba(16,185,129,0.15)]'
                            : 'border-dark-border bg-[#222328] hover:border-dark-subtle text-white'
                        }`}
                      >
                        <span className="absolute top-0.5 right-0.5 scale-75 origin-top-right text-teal-300 text-[6px] font-bold">F9</span>
                        <span className="text-[9px] leading-tight font-semibold text-center">{p.name.replace('渠道九 ', '')}</span>
                        <span className="text-[7px] text-dark-muted mt-0.5 scale-90">视频 · {p.desc}</span>
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-[10px] text-dark-muted font-bold uppercase tracking-wider">渠道十（Tensor.Art 视频）</p>
                    {generateChannel === 'tensorart' && (
                      <span className="text-[8px] text-brand font-bold px-1.5 py-0.5 rounded bg-brand/10 border border-brand/30">当前通道</span>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-1.5">
                    <button
                      type="button"
                      onClick={() => selectGenerationModel('渠道十 Tensor.Art 视频', 'tensorart')}
                      className={`py-2.5 px-1 rounded-lg border text-center flex flex-col items-center justify-center relative transition-all ${
                        globalModel === '渠道十 Tensor.Art 视频' && generateChannel === 'tensorart'
                          ? 'border-brand bg-brand/10 text-brand font-bold shadow-[0_0_8px_rgba(16,185,129,0.15)]'
                          : 'border-dark-border bg-[#222328] hover:border-dark-subtle text-white'
                      }`}
                    >
                      <span className="absolute top-0.5 right-0.5 scale-75 origin-top-right text-violet-300 text-[6px] font-bold">T10</span>
                      <span className="text-[9px] leading-tight font-semibold text-center">Tensor.Art 默认视频</span>
                      <span className="text-[7px] text-dark-muted mt-0.5 scale-90">图生视频 · 4–10s / 480p</span>
                    </button>
                  </div>
                </div>
                </>}

                {modelPopoverTab === 'image' && <>
                {/* Category 5: ChatGPT2API · GPT-Image2 */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-[10px] text-dark-muted font-bold uppercase tracking-wider">渠道五（GPT-Image2 生图）</p>
                    {generateChannel === 'chatgpt2api' && globalModel === '渠道五 GPT-Image2' && (
                      <span className="text-[8px] text-brand font-bold px-1.5 py-0.5 rounded bg-brand/10 border border-brand/30">当前通道</span>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-1.5">
                    <button
                      type="button"
                      onClick={() => selectGenerationModel('渠道五 GPT-Image2', 'chatgpt2api')}
                      className={`py-2.5 px-1 rounded-lg border text-center flex flex-col items-center justify-center relative transition-all ${
                        globalModel === '渠道五 GPT-Image2'
                          ? 'border-brand bg-brand/10 text-brand font-bold shadow-[0_0_8px_rgba(16,185,129,0.15)]'
                          : 'border-dark-border bg-[#222328] hover:border-dark-subtle text-white'
                      }`}
                    >
                      <span className="absolute top-0.5 right-0.5 scale-75 origin-top-right text-sky-300 text-[6px] font-bold">G2</span>
                      <span className="text-[9px] leading-tight font-semibold text-center">GPT-Image2</span>
                      <span className="text-[7px] text-dark-muted mt-0.5 scale-90">图片 · 文生图/图生图</span>
                    </button>
                  </div>
                </div>

                {/* Category 7: Lovart · 设计智能体 */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-[10px] text-dark-muted font-bold uppercase tracking-wider">渠道七（Lovart 设计智能体）</p>
                    {generateChannel === 'lovart' && globalModel === '渠道七 Lovart' && (
                      <span className="text-[8px] text-brand font-bold px-1.5 py-0.5 rounded bg-brand/10 border border-brand/30">当前通道</span>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-1.5">
                    <button
                      type="button"
                      onClick={() => selectGenerationModel('渠道七 Lovart', 'lovart')}
                      className={`py-2.5 px-1 rounded-lg border text-center flex flex-col items-center justify-center relative transition-all ${
                        globalModel === '渠道七 Lovart'
                          ? 'border-brand bg-brand/10 text-brand font-bold shadow-[0_0_8px_rgba(16,185,129,0.15)]'
                          : 'border-dark-border bg-[#222328] hover:border-dark-subtle text-white'
                      }`}
                    >
                      <span className="absolute top-0.5 right-0.5 scale-75 origin-top-right text-blue-300 text-[6px] font-bold">L7</span>
                      <span className="text-[9px] leading-tight font-semibold text-center">Lovart</span>
                      <span className="text-[7px] text-dark-muted mt-0.5 scale-90">图片 · GPT-Image2</span>
                    </button>
                  </div>
                </div>

                {/* Category 5: 渠道四（OiiOii · 图片模型） */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-[10px] text-dark-muted font-bold uppercase tracking-wider">渠道四（图片模型）</p>
                    {generateChannel === 'oiioii' && [
                      '渠道四 GPT-Image2',
                      '渠道四 Nano Pro',
                      '渠道四 Nano 2',
                      '渠道四 Seedream 5.0',
                      '渠道四 Seedream 4.5',
                      '渠道四 Midjourney niji7',
                      '渠道四 Midjourney niji6',
                      '渠道四 Midjourney v8',
                      '渠道四 NovelAI',
                      '渠道四 GPT-4o',
                    ].includes(globalModel) && (
                      <span className="text-[8px] text-brand font-bold px-1.5 py-0.5 rounded bg-brand/10 border border-brand/30">当前通道</span>
                    )}
                  </div>
                  <div className="grid grid-cols-3 gap-1.5">
                    {[
                      { name: '渠道四 GPT-Image2', desc: '文字控制' },
                      { name: '渠道四 Nano Pro', desc: 'Nano Pro' },
                      { name: '渠道四 Nano 2', desc: 'Nano 2' },
                      { name: '渠道四 Seedream 5.0', desc: 'Seedream 5.0' },
                      { name: '渠道四 Seedream 4.5', desc: 'Seedream 4.5' },
                      { name: '渠道四 Midjourney niji7', desc: '动漫 niji7' },
                      { name: '渠道四 Midjourney niji6', desc: '动漫 niji6' },
                      { name: '渠道四 Midjourney v8', desc: '写实 v8' },
                      { name: '渠道四 NovelAI', desc: '插画' },
                      { name: '渠道四 GPT-4o', desc: '理解强' },
                    ].map(p => (
                      <button
                        key={p.name}
                        type="button"
                        onClick={() => selectGenerationModel(p.name, 'oiioii')}
                        className={`py-2.5 px-1 rounded-lg border text-center flex flex-col items-center justify-center relative transition-all ${
                          globalModel === p.name
                            ? 'border-brand bg-brand/10 text-brand font-bold shadow-[0_0_8px_rgba(16,185,129,0.15)]'
                            : 'border-dark-border bg-[#222328] hover:border-dark-subtle text-white'
                        }`}
                      >
                        <span className="absolute top-0.5 right-0.5 scale-75 origin-top-right text-sky-400 text-[6px] font-bold">OI</span>
                        <span className="text-[9px] leading-tight font-semibold text-center">{p.name.replace('渠道四 ', '')}</span>
                        <span className="text-[7px] text-dark-muted mt-0.5 scale-90">图片 · {p.desc}</span>
                      </button>
                    ))}
                  </div>
                </div>
                </>}
              </div>
            </div>
          )}

          {/* POPOVER: 提示词前缀模板 */}
          {activePopover === 'prefix' && (
            <div className="absolute top-[102%] left-[100px] w-[420px] max-h-[78vh] overflow-hidden bg-[#1a1b1f] border border-dark-border p-4 rounded-xl shadow-[0_12px_30px_rgba(0,0,0,0.6)] z-50 text-xs text-dark-text animate-in fade-in slide-in-from-top-2 duration-150 flex flex-col">
              <div className="flex justify-between items-center pb-2 border-b border-dark-border/40 mb-3">
                <div>
                  <span className="font-extrabold text-white text-[13px] tracking-wide">提示词前缀模板</span>
                  <p className="text-[9px] text-dark-muted mt-0.5">选择预设后，生成时会自动追加到每个分镜提示词开头。</p>
                </div>
                <button onClick={() => setActivePopover(null)} className="text-dark-subtle hover:text-white text-sm font-bold">✕</button>
              </div>

              <div className="grid grid-cols-1 gap-2 overflow-y-auto pr-1 max-h-[42vh]">
                {promptPrefixTemplates.map(tpl => {
                  const isExpanded = expandedPromptPrefixId === tpl.id;
                  const prefixText = tpl.prefix || '不追加任何全局前缀。';
                  const isLongPrefix = prefixText.length > 120;
                  return (
                  <button
                    key={tpl.id}
                    type="button"
                    onClick={() => {
                      setSelectedPromptPrefixId(tpl.id);
                      localStorage.setItem('maocanju_prompt_prefix_id', tpl.id);
                    }}
                    className={`p-2.5 rounded-lg border text-left transition-all ${
                      selectedPromptPrefixId === tpl.id
                        ? 'border-brand bg-brand/10 shadow-[0_0_8px_rgba(16,185,129,0.15)]'
                        : 'border-dark-border bg-[#222328] hover:border-dark-subtle hover:bg-dark-card'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] font-extrabold text-white">{tpl.name}</span>
                      <div className="flex items-center gap-1.5">
                        {tpl.id !== 'none' && (
                          <span
                            role="button"
                            tabIndex={0}
                            onClick={(e) => {
                              e.stopPropagation();
                              startEditingPromptPrefixTemplate(tpl);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                e.stopPropagation();
                                startEditingPromptPrefixTemplate(tpl);
                              }
                            }}
                            className="px-1.5 py-0.5 rounded text-[9px] font-bold text-dark-muted hover:text-brand hover:bg-brand/10"
                          >
                            编辑
                          </span>
                        )}
                        {tpl.id !== 'none' && (
                          <span
                            role="button"
                            tabIndex={0}
                            onClick={(e) => {
                              e.stopPropagation();
                              deletePromptPrefixTemplate(tpl.id);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                e.stopPropagation();
                                deletePromptPrefixTemplate(tpl.id);
                              }
                            }}
                            className="px-1.5 py-0.5 rounded text-[9px] font-bold text-dark-muted hover:text-red-300 hover:bg-red-500/10"
                          >
                            删除
                          </span>
                        )}
                        {selectedPromptPrefixId === tpl.id && <Check className="w-3.5 h-3.5 text-brand" />}
                      </div>
                    </div>
                    <p className={`text-[9px] text-dark-muted leading-relaxed mt-1 whitespace-pre-wrap break-words ${isExpanded ? 'max-h-40 overflow-y-auto pr-1' : 'line-clamp-3'}`}>{prefixText}</p>
                    {isLongPrefix && (
                      <span
                        role="button"
                        tabIndex={0}
                        onClick={(e) => {
                          e.stopPropagation();
                          setExpandedPromptPrefixId(isExpanded ? null : tpl.id);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            e.stopPropagation();
                            setExpandedPromptPrefixId(isExpanded ? null : tpl.id);
                          }
                        }}
                        className="inline-flex mt-1 text-[9px] font-bold text-brand hover:text-brand-dark"
                      >
                        {isExpanded ? '收起全文' : '展开全文'}
                      </span>
                    )}
                  </button>
                  );
                })}
              </div>

              {isAddingPromptPrefix ? (
                <div className="mt-3 p-3 rounded-xl border border-brand/40 bg-brand/5 space-y-2 animate-in fade-in slide-in-from-top-1 duration-150">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] font-extrabold text-white">
                      {editingPromptPrefixId ? '修改前缀模板' : '添加前缀模板'}
                    </span>
                    {editingPromptPrefixId && (
                      <button
                        type="button"
                        onClick={startAddingPromptPrefixTemplate}
                        className="text-[9px] font-bold text-dark-muted hover:text-brand"
                      >
                        改为新增
                      </button>
                    )}
                  </div>
                  <input
                    type="text"
                    value={newPromptPrefixName}
                    onChange={(e) => setNewPromptPrefixName(e.target.value)}
                    placeholder="模板名称，例如：中文风格"
                    className="w-full bg-dark-bg border border-dark-border rounded-lg px-3 py-2 text-[10px] text-white placeholder:text-dark-subtle focus:outline-none focus:border-brand/60"
                    autoFocus
                  />
                  <textarea
                    value={newPromptPrefixValue}
                    onChange={(e) => setNewPromptPrefixValue(e.target.value)}
                    placeholder="前缀内容，例如：高质量电影感画面，"
                    className="w-full h-20 bg-dark-bg border border-dark-border rounded-lg px-3 py-2 text-[10px] text-white placeholder:text-dark-subtle focus:outline-none focus:border-brand/60 resize-none leading-relaxed"
                  />
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={savePromptPrefixTemplateForm}
                      className="flex-1 py-2 rounded-lg bg-brand hover:bg-brand-dark text-black text-[10px] font-extrabold transition-all"
                    >
                      {editingPromptPrefixId ? '保存修改' : '保存模板'}
                    </button>
                    <button
                      type="button"
                      onClick={resetPromptPrefixForm}
                      className="px-3 py-2 rounded-lg bg-dark-input border border-dark-border text-dark-muted hover:text-white hover:border-dark-subtle text-[10px] font-bold"
                    >
                      取消
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={startAddingPromptPrefixTemplate}
                  className="w-full mt-3 py-2 rounded-lg border border-dashed border-brand/60 bg-brand/5 text-brand hover:bg-brand/10 text-[10px] font-extrabold transition-all"
                >
                  添加我的前缀模板
                </button>
              )}

              <div className="flex items-center justify-between gap-2 mt-3 pt-3 border-t border-dark-border/40">
                <span className="text-[9px] text-dark-muted leading-relaxed">
                  选择模板后不会改写分镜文本，只会在点击生成/一键发送时自动带入。
                </span>
                <button
                  type="button"
                  onClick={() => setActivePopover(null)}
                  className="shrink-0 px-3 py-2 rounded-lg bg-dark-input border border-dark-border text-dark-muted hover:text-white hover:border-dark-subtle text-[10px] font-bold"
                >
                  完成
                </button>
              </div>
            </div>
          )}

          {/* POPOVER: 提示词后缀模板 */}
          {activePopover === 'suffix' && (
            <div className="absolute top-[102%] left-[200px] w-[420px] max-h-[78vh] overflow-hidden bg-[#1a1b1f] border border-dark-border p-4 rounded-xl shadow-[0_12px_30px_rgba(0,0,0,0.6)] z-50 text-xs text-dark-text animate-in fade-in slide-in-from-top-2 duration-150 flex flex-col">
              <div className="flex justify-between items-center pb-2 border-b border-dark-border/40 mb-3">
                <div>
                  <span className="font-extrabold text-white text-[13px] tracking-wide">提示词后缀模板</span>
                  <p className="text-[9px] text-dark-muted mt-0.5">选择预设后，生成时会自动追加到每个分镜提示词末尾。</p>
                </div>
                <button onClick={() => setActivePopover(null)} className="text-dark-subtle hover:text-white text-sm font-bold">✕</button>
              </div>

              <div className="grid grid-cols-1 gap-2 overflow-y-auto pr-1 max-h-[42vh]">
                {promptSuffixTemplates.map(tpl => {
                  const isExpanded = expandedPromptSuffixId === tpl.id;
                  const suffixText = tpl.suffix || '不追加任何全局后缀。';
                  const isLongSuffix = suffixText.length > 120;
                  return (
                  <button
                    key={tpl.id}
                    type="button"
                    onClick={() => {
                      setSelectedPromptSuffixId(tpl.id);
                      localStorage.setItem('maocanju_prompt_suffix_id', tpl.id);
                    }}
                    className={`p-2.5 rounded-lg border text-left transition-all ${
                      selectedPromptSuffixId === tpl.id
                        ? 'border-brand bg-brand/10 shadow-[0_0_8px_rgba(16,185,129,0.15)]'
                        : 'border-dark-border bg-[#222328] hover:border-dark-subtle hover:bg-dark-card'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] font-extrabold text-white">{tpl.name}</span>
                      <div className="flex items-center gap-1.5">
                        {tpl.id !== 'none' && (
                          <span
                            role="button"
                            tabIndex={0}
                            onClick={(e) => {
                              e.stopPropagation();
                              startEditingPromptSuffixTemplate(tpl);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                e.stopPropagation();
                                startEditingPromptSuffixTemplate(tpl);
                              }
                            }}
                            className="px-1.5 py-0.5 rounded text-[9px] font-bold text-dark-muted hover:text-brand hover:bg-brand/10"
                          >
                            编辑
                          </span>
                        )}
                        {tpl.id !== 'none' && (
                          <span
                            role="button"
                            tabIndex={0}
                            onClick={(e) => {
                              e.stopPropagation();
                              deletePromptSuffixTemplate(tpl.id);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                e.stopPropagation();
                                deletePromptSuffixTemplate(tpl.id);
                              }
                            }}
                            className="px-1.5 py-0.5 rounded text-[9px] font-bold text-dark-muted hover:text-red-300 hover:bg-red-500/10"
                          >
                            删除
                          </span>
                        )}
                        {selectedPromptSuffixId === tpl.id && <Check className="w-3.5 h-3.5 text-brand" />}
                      </div>
                    </div>
                    <p className={`text-[9px] text-dark-muted leading-relaxed mt-1 whitespace-pre-wrap break-words ${isExpanded ? 'max-h-40 overflow-y-auto pr-1' : 'line-clamp-3'}`}>{suffixText}</p>
                    {isLongSuffix && (
                      <span
                        role="button"
                        tabIndex={0}
                        onClick={(e) => {
                          e.stopPropagation();
                          setExpandedPromptSuffixId(isExpanded ? null : tpl.id);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            e.stopPropagation();
                            setExpandedPromptSuffixId(isExpanded ? null : tpl.id);
                          }
                        }}
                        className="inline-flex mt-1 text-[9px] font-bold text-brand hover:text-brand-dark"
                      >
                        {isExpanded ? '收起全文' : '展开全文'}
                      </span>
                    )}
                  </button>
                  );
                })}
              </div>

              {isAddingPromptSuffix ? (
                <div className="mt-3 p-3 rounded-xl border border-brand/40 bg-brand/5 space-y-2 animate-in fade-in slide-in-from-top-1 duration-150">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] font-extrabold text-white">
                      {editingPromptSuffixId ? '修改后缀模板' : '添加后缀模板'}
                    </span>
                    {editingPromptSuffixId && (
                      <button
                        type="button"
                        onClick={startAddingPromptSuffixTemplate}
                        className="text-[9px] font-bold text-dark-muted hover:text-brand"
                      >
                        改为新增
                      </button>
                    )}
                  </div>
                  <input
                    type="text"
                    value={newPromptSuffixName}
                    onChange={(e) => setNewPromptSuffixName(e.target.value)}
                    placeholder="模板名称，例如：中文无水印"
                    className="w-full bg-dark-bg border border-dark-border rounded-lg px-3 py-2 text-[10px] text-white placeholder:text-dark-subtle focus:outline-none focus:border-brand/60"
                    autoFocus
                  />
                  <textarea
                    value={newPromptSuffixValue}
                    onChange={(e) => setNewPromptSuffixValue(e.target.value)}
                    placeholder="后缀内容，例如：All text in Chinese, No watermarks, 禁止出现任何logo"
                    className="w-full h-20 bg-dark-bg border border-dark-border rounded-lg px-3 py-2 text-[10px] text-white placeholder:text-dark-subtle focus:outline-none focus:border-brand/60 resize-none leading-relaxed"
                  />
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={savePromptSuffixTemplateForm}
                      className="flex-1 py-2 rounded-lg bg-brand hover:bg-brand-dark text-black text-[10px] font-extrabold transition-all"
                    >
                      {editingPromptSuffixId ? '保存修改' : '保存模板'}
                    </button>
                    <button
                      type="button"
                      onClick={resetPromptSuffixForm}
                      className="px-3 py-2 rounded-lg bg-dark-input border border-dark-border text-dark-muted hover:text-white hover:border-dark-subtle text-[10px] font-bold"
                    >
                      取消
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={startAddingPromptSuffixTemplate}
                  className="w-full mt-3 py-2 rounded-lg border border-dashed border-brand/60 bg-brand/5 text-brand hover:bg-brand/10 text-[10px] font-extrabold transition-all"
                >
                  添加我的后缀模板
                </button>
              )}

              <div className="flex items-center justify-between gap-2 mt-3 pt-3 border-t border-dark-border/40">
                <span className="text-[9px] text-dark-muted leading-relaxed">
                  选择模板后不会改写分镜文本，只会在点击生成/一键发送时自动带入。
                </span>
                <button
                  type="button"
                  onClick={() => setActivePopover(null)}
                  className="shrink-0 px-3 py-2 rounded-lg bg-dark-input border border-dark-border text-dark-muted hover:text-white hover:border-dark-subtle text-[10px] font-bold"
                >
                  完成
                </button>
              </div>
            </div>
          )}

          {/* POPOVER 2: 属性参数 Modal matching Image 3 */}
          {activePopover === 'params' && (
            <div className="absolute bottom-2 left-[45px] w-[310px] max-h-[70vh] overflow-y-auto bg-[#1a1b1f] border border-dark-border p-4 rounded-xl shadow-[0_12px_30px_rgba(0,0,0,0.6)] z-50 text-xs text-dark-text animate-in fade-in slide-in-from-bottom-2 duration-150">
              <div className="flex justify-between items-center pb-2 border-b border-dark-border/40 mb-3.5">
                <span className="font-extrabold text-white text-[12px] tracking-wide">{globalModel} 参数</span>
                <button onClick={() => setActivePopover(null)} className="text-dark-subtle hover:text-white text-sm font-bold">✕</button>
              </div>

              <div className="space-y-4">
                {generateChannel === 'oreateai' && (() => {
                  const capability = getOreateaiCapability();
                  const combination = getOreateaiCombination(capability);
                  const sceneOptions = oreateaiCapabilities?.scenes || [];
                  const durationOptions = [...new Set((capability?.combinations || []).map((item) => item.duration))].sort((a, b) => a - b);
                  const resolutionOptions = [...new Set((capability?.combinations || []).filter((item) => item.duration === Number(String(globalDuration).replace(/\D/g, ''))).map((item) => item.resolution))];
                  const point = combination?.point;
                  return (
                    <>
                      <div>
                        <p className="text-[10px] text-dark-muted font-bold mb-2 uppercase tracking-wider">生成场景</p>
                        <div className="grid grid-cols-2 gap-1.5">
                          {sceneOptions.map((scene) => {
                            const sceneCapability = getOreateaiCapability(globalModel, scene.id);
                            return <button key={scene.id} type="button" disabled={!sceneCapability} onClick={() => {
                              setOreateaiScene(scene.id);
                              const next = getOreateaiCombination(sceneCapability) || sceneCapability.combinations[0];
                              setGlobalDuration(`${next.duration}秒`);
                              setGlobalResolution(next.resolution);
                            }} className={`py-1.5 rounded-lg border text-[10px] font-bold disabled:opacity-35 ${oreateaiScene === scene.id ? 'border-brand bg-brand/10 text-brand' : 'border-dark-border bg-[#222328] hover:border-dark-subtle text-white'}`}>
                              {scene.name}
                            </button>;
                          })}
                        </div>
                      </div>
                      {capability && <>
                        <div>
                          <p className="text-[10px] text-dark-muted font-bold mb-2 uppercase tracking-wider">视频时长</p>
                          <div className="flex flex-wrap gap-1.5">
                            {durationOptions.map((duration) => <button key={duration} type="button" onClick={() => {
                              const next = capability.combinations.find((item) => item.duration === duration && (capability.scene === 'reference' || item.audio === null || item.audio === oreateaiAudio))
                                || capability.combinations.find((item) => item.duration === duration);
                              setGlobalDuration(`${next.duration}秒`);
                              setGlobalResolution(next.resolution);
                            }} className={`px-3 py-1.5 rounded-lg border text-[10px] font-bold ${Number(String(globalDuration).replace(/\D/g, '')) === duration ? 'border-brand bg-brand/10 text-brand' : 'border-dark-border bg-[#222328] hover:border-dark-subtle text-white'}`}>{duration}秒</button>)}
                          </div>
                        </div>
                        <div>
                          <p className="text-[10px] text-dark-muted font-bold mb-2 uppercase tracking-wider">分辨率</p>
                          <div className="flex flex-wrap gap-1.5">
                            {resolutionOptions.map((resolution) => <button key={resolution} type="button" onClick={() => {
                              const next = capability.combinations.find((item) => item.resolution === resolution && (capability.scene === 'reference' || item.audio === null || item.audio === oreateaiAudio))
                                || capability.combinations.find((item) => item.resolution === resolution);
                              setGlobalDuration(`${next.duration}秒`);
                              setGlobalResolution(next.resolution);
                            }} className={`px-3 py-1.5 rounded-lg border text-[10px] font-bold ${globalResolution === resolution ? 'border-brand bg-brand/10 text-brand' : 'border-dark-border bg-[#222328] hover:border-dark-subtle text-white'}`}>{resolution}P</button>)}
                          </div>
                        </div>
                        <div>
                          <p className="text-[10px] text-dark-muted font-bold mb-2 uppercase tracking-wider">生成音频</p>
                          <div className="grid grid-cols-2 gap-1.5">
                            {capability.audioValues.map((value) => <button key={String(value)} type="button" onClick={() => setOreateaiAudio(value)} className={`py-1.5 rounded-lg border text-[10px] font-bold ${oreateaiAudio === value ? 'border-brand bg-brand/10 text-brand' : 'border-dark-border bg-[#222328] hover:border-dark-subtle text-white'}`}>{value ? '开启音频' : '关闭音频'}</button>)}
                          </div>
                        </div>
                        <p className="-mt-2 text-[9px] text-cyan-200 leading-relaxed">{point != null ? `当前组合预计消耗 ${point} 积分。` : '当前组合由服务端配置校验。'} {capability.promptMaxChars ? `提示词最多 ${capability.promptMaxChars} 字。` : ''}</p>
                      </>}
                    </>
                  );
                })()}
                {/* Section 1: 宽高比 */}
                <div>
                  <p className="text-[10px] text-dark-muted font-bold mb-2 uppercase tracking-wider">宽高比 ①</p>
                  <div className="flex flex-wrap gap-1.5">
                    {getSupportedAspectRatios({ channel: generateChannel, modelName: globalModel, mediaType: getModelMediaType(globalModel) }).map(r => (
                      <button
                        key={r}
                        type="button"
                        onClick={() => updateGlobalAspectRatio(r)}
                        className={`px-3 py-1.5 rounded-lg border text-center text-[10px] font-bold transition-all ${
                          globalAspectRatio === r 
                            ? 'border-brand bg-brand/10 text-brand font-extrabold shadow-[0_0_6px_rgba(16,185,129,0.15)]' 
                            : 'border-dark-border bg-[#222328] hover:border-dark-subtle text-white'
                        }`}
                      >
                        {r}
                      </button>
                    ))}
                  </div>
                  {getModelMediaType(globalModel) === 'video' && generateChannel === 'dola' && (
                    <p className="mt-1.5 text-[9px] text-dark-subtle leading-relaxed">
                      渠道六 Seedance 2.0 支持 1:1 / 3:4 / 4:3 / 9:16 / 16:9 / 21:9 六种比例。
                    </p>
                  )}
                </div>

                {/* Section 2: 图片分辨率 */}
                {getModelMediaType(globalModel) === 'image' && (
                  <div>
                    <p className="text-[10px] text-dark-muted font-bold mb-2 uppercase tracking-wider">图片分辨率</p>
                    <div className="grid grid-cols-2 gap-1.5">
                      {['2K', '4K'].map(q => (
                        <button
                          key={q}
                          type="button"
                          onClick={() => updateGlobalResolution(q)}
                          className={`py-1.5 rounded-lg border text-center text-[10px] font-bold transition-all ${
                            globalResolution === q
                              ? 'border-brand bg-brand/10 text-brand font-extrabold shadow-[0_0_6px_rgba(16,185,129,0.15)]'
                              : 'border-dark-border bg-[#222328] hover:border-dark-subtle text-white'
                          }`}
                        >
                          {q}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Section 3: 视频时长 */}
                {getModelMediaType(globalModel) === 'video' && generateChannel !== 'oreateai' && (
                <div>
                  <p className="text-[10px] text-dark-muted font-bold mb-2 uppercase tracking-wider">视频时长 ①</p>
                  <div className="grid grid-cols-7 gap-1">
                    {(generateChannel === 'tensorart'
                      ? TENSORART_DURATION_OPTIONS
                      : ['2秒', '3秒', '4秒', '5秒', '6秒', '7秒', '8秒', '9秒', '10秒', '11秒', '12秒', '13秒', '14秒', '15秒']
                    ).map(d => (
                      <button
                        key={d}
                        type="button"
                        onClick={() => updateGlobalDuration(d)}
                        className={`py-1.5 rounded-lg border text-center text-[10px] font-bold transition-all ${
                          globalDuration === d 
                            ? 'border-brand bg-brand/10 text-brand font-extrabold shadow-[0_0_6px_rgba(16,185,129,0.15)]' 
                            : 'border-dark-border bg-[#222328] hover:border-dark-subtle text-white'
                        }`}
                      >
                        <span className="block">{d}</span>
                        {generateChannel === 'tensorart' && (
                          <span className="block text-[7px] opacity-70">
                            {TENSORART_DURATION_CREDITS[Number.parseInt(d, 10)]}积分
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
                )}
              </div>
            </div>
          )}

        </div>

        {/* PANEL 2: 角色 场景 物品 */}
        <div className="bg-dark-card/45 border border-dark-border p-3 rounded-xl flex flex-col justify-between">
          <div className="flex justify-between items-center text-[10px] text-dark-muted font-bold tracking-wider mb-1.5 shrink-0">
            {/* Asset sub-tabs */}
            <div className="flex space-x-2">
              <button 
                onClick={() => setActiveAssetSubTab('character')}
                className={`pb-0.5 border-b transition-all ${activeAssetSubTab === 'character' ? 'text-brand border-brand font-extrabold' : 'hover:text-white border-transparent'}`}
              >角色</button>
              <button 
                onClick={() => setActiveAssetSubTab('scene')}
                className={`pb-0.5 border-b transition-all ${activeAssetSubTab === 'scene' ? 'text-brand border-brand font-extrabold' : 'hover:text-white border-transparent'}`}
              >场景</button>
              <button 
                onClick={() => setActiveAssetSubTab('item')}
                className={`pb-0.5 border-b transition-all ${activeAssetSubTab === 'item' ? 'text-brand border-brand font-extrabold' : 'hover:text-white border-transparent'}`}
              >物品</button>
            </div>
            <div className="flex space-x-1.5">
              <button
                type="button"
                onClick={() => importAssetImages(activeAssetSubTab)}
                className="hover:text-brand"
                title={`选择图片文件夹批量导入${activeAssetSubTab === 'character' ? '角色' : activeAssetSubTab === 'scene' ? '场景' : '物品'}，名称自动使用图片文件名`}
              >
                文件夹导入
              </button>
              <span>|</span>
              <button 
                onClick={() => {
                  if (activeAssetSubTab === 'character') {
                    setEditingCharId('new');
                    setNewCharName('');
                    setNewCharRole('主角设定');
                    setNewCharAvatar('https://images.unsplash.com/photo-1578632767115-351597cf2477?auto=format&fit=crop&q=80&w=260');
                    setNewCharAvatarPath('');
                    setShowCharacterModal(true);
                  } else {
                    setEditingAssetType(activeAssetSubTab);
                    setEditingAssetId('new');
                    setNewAssetName('');
                    setNewAssetAvatar('');
                    setNewAssetAvatarPath('');
                    setShowAssetModal(true);
                  }
                }} 
                className="hover:text-brand"
              >
                新增
              </button>
              <span>|</span>
              <button 
                onClick={() => {
                  if (activeAssetSubTab === 'character') {
                    if (characterAssets[0]) {
                      setEditingCharId(characterAssets[0].id);
                      setNewCharName(characterAssets[0].name);
                      setNewCharRole(characterAssets[0].role || '');
                      setNewCharAvatar(characterAssets[0].avatar);
                      setNewCharAvatarPath(characterAssets[0].avatarPath || '');
                      setShowCharacterModal(true);
                    } else {
                      setEditingCharId('new');
                      setNewCharName('');
                      setNewCharRole('主角设定');
                      setNewCharAvatar('https://images.unsplash.com/photo-1578632767115-351597cf2477?auto=format&fit=crop&q=80&w=260');
                      setNewCharAvatarPath('');
                      setShowCharacterModal(true);
                    }
                  } else {
                    const assets = activeAssetSubTab === 'scene' ? sceneAssets : itemAssets;
                    setEditingAssetType(activeAssetSubTab);
                    if (assets[0]) {
                      setEditingAssetId(assets[0].id);
                      setNewAssetName(assets[0].name);
                      setNewAssetAvatar(assets[0].avatar || '');
                      setNewAssetAvatarPath(assets[0].avatarPath || '');
                    } else {
                      setEditingAssetId('new');
                      setNewAssetName('');
                      setNewAssetAvatar('');
                      setNewAssetAvatarPath('');
                    }
                    setShowAssetModal(true);
                  }
                }} 
                className="hover:text-white"
              >
                管理
              </button>
            </div>
          </div>

          {/* Render asset lists by active sub-tab */}
          {activeAssetSubTab === 'character' ? (
            <div className="flex items-center space-x-2 flex-1 overflow-x-auto no-scrollbar pt-1">
              <button 
                onClick={() => {
                  setEditingCharId('new');
                  setNewCharName('');
                  setNewCharRole('主角设定');
                  setNewCharAvatar('https://images.unsplash.com/photo-1578632767115-351597cf2477?auto=format&fit=crop&q=80&w=260');
                  setNewCharAvatarPath('');
                  setShowCharacterModal(true);
                }}
                className="w-7 h-7 rounded-full border border-dashed border-dark-border flex items-center justify-center text-dark-muted hover:text-brand hover:border-brand/40 transition-colors shrink-0"
                title="添加新角色"
              >
                <Plus className="w-4 h-4" />
              </button>
              {characterAssets.map(c => (
                <div 
                  key={c.id} 
                  onClick={() => {
                    setEditingCharId(c.id);
                    setNewCharName(c.name);
                    setNewCharRole(c.role || '');
                    setNewCharAvatar(c.avatar);
                    setNewCharAvatarPath(c.avatarPath || '');
                    setShowCharacterModal(true);
                  }}
                  className="flex flex-col items-center justify-center shrink-0 cursor-pointer group"
                  title={`点击编辑: ${c.name} (${c.role})`}
                >
                  <img src={displayAvatarUrlForAsset(c)} alt={c.name} className="w-7 h-7 rounded-full border border-dark-border group-hover:border-brand/50 transition-all object-cover" />
                  <span className="text-[8px] text-dark-muted group-hover:text-white mt-0.5 truncate max-w-[40px] scale-90">{c.name}</span>
                </div>
              ))}
            </div>
          ) : (() => {
            const isScene = activeAssetSubTab === 'scene';
            const list = isScene ? sceneAssets : itemAssets;
            const setList = isScene ? setSceneAssets : setItemAssets;
            const label = isScene ? '场景' : '物品';
            const triggerSym = isScene ? '$' : '#';
            const AssetIcon = isScene ? Mountain : Gamepad2;
            return (
              <div className="flex items-center space-x-2 flex-1 overflow-x-auto no-scrollbar pt-1">
                <button
                  onClick={() => {
                    setEditingAssetType(activeAssetSubTab);
                    setEditingAssetId('new');
                    setNewAssetName('');
                    setNewAssetAvatar('');
                    setNewAssetAvatarPath('');
                    setShowAssetModal(true);
                  }}
                  className="w-7 h-7 rounded-full border border-dashed border-dark-border flex items-center justify-center text-dark-muted hover:text-brand hover:border-brand/40 transition-colors shrink-0"
                  title={`添加新${label}`}
                >
                  <Plus className="w-4 h-4" />
                </button>
                {list.map(a => (
                  <div
                    key={a.id}
                    className="relative flex flex-col items-center justify-center shrink-0 cursor-pointer group"
                    title={`点击编辑: ${a.name}（描述词中输入 ${triggerSym} 调用）`}
                  >
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (confirm(`删除${label} "${a.name}" ？`)) {
                          setList(prev => prev.filter(x => x.id !== a.id));
                        }
                      }}
                      className="absolute -top-1 -right-1 z-10 w-3.5 h-3.5 rounded-full bg-red-500/80 text-white opacity-0 group-hover:opacity-100 hover:bg-red-500 transition-all flex items-center justify-center"
                      title={`删除${label}`}
                    >
                      <X className="w-2.5 h-2.5" />
                    </button>
                    <div
                      onClick={() => {
                        setEditingAssetType(activeAssetSubTab);
                        setEditingAssetId(a.id);
                        setNewAssetName(a.name);
                        setNewAssetAvatar(a.avatar || '');
                        setNewAssetAvatarPath(a.avatarPath || '');
                        setShowAssetModal(true);
                      }}
                      className="flex flex-col items-center justify-center"
                    >
                      <span className="w-7 h-7 rounded-full border border-dark-border group-hover:border-brand/50 transition-all bg-[#18191c] flex items-center justify-center overflow-hidden">
                        {displayAvatarUrlForAsset(a) ? (
                          <img src={displayAvatarUrlForAsset(a)} alt={a.name} className="w-full h-full object-cover" />
                        ) : (
                          <AssetIcon className="w-3.5 h-3.5 text-dark-muted group-hover:text-brand" />
                        )}
                      </span>
                      <span className="text-[8px] text-dark-muted group-hover:text-white mt-0.5 truncate max-w-[40px] scale-90">{a.name}</span>
                    </div>
                  </div>
                ))}
                {list.length === 0 && (
                  <span className="text-[9px] text-dark-subtle pl-1">暂无{label}，点 + 添加后可在描述词输入 {triggerSym} 调用</span>
                )}
              </div>
            );
          })()}
        </div>

        {/* PANEL 3: 草稿进度监控 */}
        <div className="bg-dark-card/45 border border-dark-border p-3 rounded-xl flex flex-col justify-between">
          <div className="flex justify-between items-center text-[10px] text-dark-muted font-bold uppercase shrink-0">
            <span>草稿任务统计</span>
            <span>进度 {segments.length > 0 ? Math.round((segments.filter(s => s.text && s.text.length > 20).length / segments.length) * 100) : 0}%</span>
          </div>
          
          <div className="grid grid-cols-3 gap-1.5 py-1">
            <div className="text-[9px] text-dark-muted leading-tight">
              配音 <span className="text-white font-bold block text-xs">0/{segments.length}</span>
            </div>
            <div className="text-[9px] text-dark-muted leading-tight border-l border-dark-border/40 pl-1.5">
              描述 <span className="text-white font-bold block text-xs">{segments.filter(s => s.text && s.text.length > 20).length}/{segments.length}</span>
            </div>
            <div className="text-[9px] text-dark-muted leading-tight border-l border-dark-border/40 pl-1.5">
              素材 <span className="text-white font-bold block text-xs">{segments.filter(s => (s.type === 'video' ? s.materialsVideo.length : s.materialsImage.length) > 0).length}/{segments.length}</span>
            </div>
          </div>

          {/* Smooth custom rendering progress bar */}
          <div className="w-full h-1 bg-dark-bg rounded-full overflow-hidden shrink-0 mt-0.5">
            <div 
              className="h-full bg-gradient-to-r from-brand to-emerald-400 rounded-full transition-all duration-1000" 
              style={{ width: `${segments.length > 0 ? Math.round((segments.filter(s => s.text && s.text.length > 20).length / segments.length) * 100) : 0}%` }}
            />
          </div>
        </div>

      </div>

      {/* 2. Column Headers Bar (Sticky Top) */}
      <div className="h-10 px-6 bg-dark-sidebar/40 border-b border-dark-border flex items-center text-xs font-bold text-dark-muted shrink-0 select-none">
        <div className="w-[48%] flex items-center justify-between pr-4 border-r border-dark-border/40">
          <span>描述词</span>
          <button className="flex items-center space-x-1 text-[10px] text-dark-muted hover:text-white px-2 py-0.5 rounded bg-dark-card border border-dark-border">
            <SlidersHorizontal className="w-2.5 h-2.5" />
            <span>筛选</span>
          </button>
        </div>
        <div className="w-[26%] flex items-center justify-between px-4 border-r border-dark-border/40">
          <span>当前素材</span>
          <div className="flex items-center space-x-1.5">
            <button
              onClick={handleExportAllCurrent}
              className="flex items-center space-x-1 text-[10px] text-dark-muted hover:text-black hover:bg-brand px-2 py-0.5 rounded bg-dark-card border border-dark-border hover:border-brand transition-all"
              title="导出所有行的当前素材"
            >
              <Download className="w-2.5 h-2.5" />
              <span>导出</span>
            </button>
            <button
              onClick={handleClearAllMaterials}
              className="flex items-center space-x-1 text-[10px] text-dark-muted hover:text-white hover:bg-red-500/80 px-2 py-0.5 rounded bg-dark-card border border-dark-border hover:border-red-400 transition-all"
              title="清空所有行的当前素材和可选素材"
            >
              <Trash2 className="w-2.5 h-2.5" />
              <span>清空所有素材</span>
            </button>
            <button
              onClick={handleMergeAllRows}
              disabled={mergeAllProgress.running}
              className="flex items-center space-x-1 text-[10px] text-dark-muted hover:text-black hover:bg-brand px-2 py-0.5 rounded bg-dark-card border border-dark-border hover:border-brand transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              title="对所有未锁定的行：把垫图 + @角色 + $场景 + #物品 合成为新的垫图"
            >
              <Combine className="w-2.5 h-2.5" />
              <span>
                {mergeAllProgress.running
                  ? `合并中 ${mergeAllProgress.current}/${mergeAllProgress.total}`
                  : '一键合并垫图'}
              </span>
            </button>
            <span className="text-[9px] bg-dark-input text-dark-subtle px-1.5 py-0.2 rounded font-normal">多行独立锁定</span>
          </div>
        </div>
        <div className="w-[26%] flex items-center justify-between pl-4">
          <span>可选素材</span>
          <div className="flex items-center space-x-1 bg-blue-500/10 border border-blue-500/30 text-blue-400 px-2 py-0.5 rounded text-[9px]">
            <span>☁️ 拖拽至此上传</span>
          </div>
        </div>
      </div>

      {/* 3. Rows Content Area (Each row has description, current material and available materials) */}
      <div className="flex-1 overflow-y-auto no-scrollbar bg-dark-bg/10 divide-y divide-dark-border/30 pb-12">
        {segments.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-center space-y-4">
            <div className="w-16 h-16 rounded-full bg-dark-card border border-dark-border flex items-center justify-center">
              <FolderPlus className="w-7 h-7 text-dark-muted" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-bold text-dark-text">暂无分镜内容</p>
              <p className="text-xs text-dark-muted">点击下方按钮新增第一行分镜，开始创作</p>
            </div>
            <button
              type="button"
              onClick={handleAddNewSegmentRow}
              className="flex items-center space-x-2 px-5 py-2.5 bg-brand hover:bg-brand-dark text-black rounded-lg text-xs font-bold transition-all shadow-md"
            >
              <Plus className="w-4 h-4" />
              <span>新增第一行分镜</span>
            </button>
          </div>
        )}
        {segments.map((row) => {
          const isVid = row.type === 'video';
          const currentMaterial = (isVid ? row.currentMaterialVideo : row.currentMaterialImage) || { id: 0, name: '暂无画面', thumbnail: '', duration: '00:00', fps: 0, isPlaying: false };
          const rawMaterials = (isVid ? row.materialsVideo : row.materialsImage) || [];
          const materials = rawMaterials.filter(m => {
            const matIsVideo = m.mediaType === 'video' || isVideoUrl(m.thumbnail || '');
            return isVid ? matIsVideo : !matIsVideo;
          });
          const isCurrentPlaying = isVid ? currentMaterial.isPlaying : false;
          const imageSource = currentMaterial.localPath || currentMaterial.sourceUrl || currentMaterial.thumbnail || '';
          const previewUrl = isVid
            ? playableUrlForMaterial(currentMaterial)
            : (isLocalFilePath(imageSource) ? makeLocalFileUrl(imageSource) : imageSource);
          const hasPreview = !!previewUrl;
          
          return (
            <div 
              key={row.id}
              className="flex px-6 py-5 items-stretch hover:bg-dark-card/5 transition-all relative group/row"
            >
              {/* Floating Row Deletion Button on hover */}
              <button 
                onClick={(e) => handleDeleteSegmentRow(row.id, e)}
                className="absolute left-1.5 top-1/2 -translate-y-1/2 opacity-0 group-hover/row:opacity-100 p-1.5 bg-red-500/15 border border-red-500/30 hover:bg-red-500 text-dark-muted hover:text-white rounded-full transition-all z-20"
                title="删除此行分镜"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>

              {/* COLUMN 1: Prompt segment (48% width) */}
              <div className="w-[48%] pr-4 flex flex-col justify-between border-r border-dark-border/20">
                <div className="space-y-3.5">
                  {/* Row ID, Mode switcher & Header info */}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-2">
                      <span className="w-5 h-5 rounded-full bg-brand text-black flex items-center justify-center text-[11px] font-extrabold shadow-[0_0_8px_rgba(16,185,129,0.3)]">
                        {row.id}
                      </span>
                      
                      {/* Media mode button */}
                      <div className="flex bg-dark-bg p-0.5 rounded-lg border border-dark-border text-[10px]">
                        <button 
                          onClick={() => {
                            const nextModel = IMAGE_MODEL_NAMES.has(globalModel) ? '渠道四 Gemini' : globalModel;
                            const nextChannel = generateChannel === 'oreateai'
                              ? 'oreateai'
                              : generateChannel === 'pixmax'
                                ? 'pixmax'
                                : nextModel.startsWith('渠道四')
                                  ? 'oiioii'
                                  : nextModel.startsWith('渠道六')
                                    ? 'dola'
                                    : nextModel.startsWith('渠道九')
                                      ? 'framia'
                                      : nextModel.startsWith('渠道十')
                                        ? 'tensorart'
                                        : 'wizstar';
                            const nextAspectRatio = normalizeAspectRatio(globalAspectRatio, {
                              channel: nextChannel,
                              modelName: nextModel,
                              mediaType: 'video',
                            });
                            setGlobalModel(nextModel);
                            setGenerateChannel(nextChannel);
                            setGlobalAspectRatio(nextAspectRatio);
                            setSegments(prev => prev.map(s => s.id === row.id ? { ...s, type: 'video', model: nextModel, aspectRatio: nextAspectRatio } : s));
                          }}
                          className={`flex items-center space-x-1 px-2.5 py-1 rounded-md font-bold transition-all ${
                            row.type === 'video' ? 'bg-brand text-black shadow-sm' : 'text-dark-muted hover:text-white'
                          }`}
                        >
                          <Video className="w-2.5 h-2.5" />
                          <span>视频</span>
                        </button>
                        <button 
                          onClick={() => {
                            const nextModel = IMAGE_MODEL_NAMES.has(globalModel) && globalModel !== '渠道七 Lovart' ? globalModel : '渠道四 GPT-Image2';
                            const nextChannel = nextModel.startsWith('渠道五') ? 'chatgpt2api' : 'oiioii';
                            const nextAspectRatio = normalizeAspectRatio(globalAspectRatio, {
                              channel: nextChannel,
                              modelName: nextModel,
                              mediaType: 'image',
                            });
                            setGlobalModel(nextModel);
                            setGenerateChannel(nextChannel);
                            setGlobalAspectRatio(nextAspectRatio);
                            setSegments(prev => prev.map(s => s.id === row.id ? { ...s, type: 'image', model: nextModel, aspectRatio: nextAspectRatio } : s));
                          }}
                          className={`flex items-center space-x-1 px-2.5 py-1 rounded-md font-bold transition-all ${
                            row.type === 'image' ? 'bg-brand text-black shadow-sm' : 'text-dark-muted hover:text-white'
                          }`}
                        >
                          <ImageIcon className="w-2.5 h-2.5" />
                          <span>图片</span>
                        </button>
                      </div>
                    </div>

                    <span className="text-[9px] text-dark-subtle font-semibold">支持输入 @ 角色 · $ 场景 · # 物品 · @角色可切换仅发送文本</span>
                  </div>

                  {/* Single Big Text Bubble with Embedded Inline Badges matching Screenshot 2 */}
                  <div
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      e.dataTransfer.dropEffect = 'copy';
                      e.currentTarget.classList.add('ring-2', 'ring-purple-500', 'border-purple-500');
                    }}
                    onDragLeave={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      e.currentTarget.classList.remove('ring-2', 'ring-purple-500', 'border-purple-500');
                    }}
                    onDrop={async (e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      e.currentTarget.classList.remove('ring-2', 'ring-purple-500', 'border-purple-500');
                      const files = Array.from(e.dataTransfer.files || []);
                      const imgFile = files.find(f => f.type.startsWith('image/'));
                      if (!imgFile) {
                        alert('请拖入图片文件作为垫图');
                        return;
                      }
                      const filePath = imgFile.path || '';
                      if (filePath) {
                        setSegments(prev => prev.map(s => s.id === row.id ? {...s, referenceImage: makeLocalReferenceImage(filePath), referenceImagePath: filePath} : s));
                        return;
                      }
                      const dataUrl = await fileToDataUrl(imgFile);
                      setSegments(prev => prev.map(s => s.id === row.id ? {...s, referenceImage: makeDataUrlReferenceImage(dataUrl), referenceImagePath: ''} : s));
                    }}
                    onPaste={(e) => handlePasteReferenceImage(row.id, e)}
                    tabIndex={0}
                    className="bg-[#18191c] border border-dark-border/60 hover:border-[#10b981]/30 focus:border-[#10b981]/50 focus:outline-none focus:ring-1 focus:ring-[#10b981]/30 rounded-xl p-3 flex flex-col justify-start min-h-[112px] transition-all relative"
                    title="点击后可编辑文本，也可直接粘贴图片作为垫图"
                  >
                    {/* 垫图徽章始终显示在文本区域上方 */}
                    <div className="mb-1.5 flex items-center">
                      {getReferenceDisplayUrl(row) ? (
                        <span 
                          className="inline-flex items-center space-x-1 bg-[#4c2d9a] hover:bg-[#5b39b0] text-white pl-2 pr-1 py-0.5 rounded font-bold select-none scale-95"
                        >
                          <span
                            onClick={async (e) => {
                              e.stopPropagation();
                              if (window.electronAPI && window.electronAPI.selectFile) {
                                const filePath = await window.electronAPI.selectFile([
                                  { name: '图片文件', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif'] }
                                ]);
                                if (filePath) {
                                  setSegments(prev => prev.map(s => s.id === row.id ? {...s, referenceImage: makeLocalReferenceImage(filePath), referenceImagePath: filePath} : s));
                                }
                              }
                            }}
                            className="inline-flex items-center space-x-1 cursor-pointer"
                            title="点击更换垫图，双击放大预览"
                          >
                            <img
                              src={getReferenceDisplayUrl(row)}
                              alt="ref"
                              className="w-3.5 h-3.5 object-cover rounded-sm"
                              onClick={(e) => { e.stopPropagation(); }}
                              onDoubleClick={(e) => {
                                e.stopPropagation();
                                e.preventDefault();
                                setFullscreenVideo({ src: getReferenceDisplayUrl(row), mediaType: 'image', materialName: '垫图' });
                              }}
                            />
                            <span className="text-[9px]">垫图</span>
                          </span>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setSegments(prev => prev.map(s => s.id === row.id ? {...s, referenceImage: null, referenceImagePath: ''} : s));
                            }}
                            className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full hover:bg-black/30 text-white/70 hover:text-white transition-colors"
                            title="删除垫图"
                          >
                            <X className="w-2.5 h-2.5" />
                          </button>
                        </span>
                      ) : (
                        <span
                          onClick={async (e) => {
                            e.stopPropagation();
                            if (window.electronAPI && window.electronAPI.selectFile) {
                              const filePath = await window.electronAPI.selectFile([
                                { name: '图片文件', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif'] }
                              ]);
                              if (filePath) {
                                setSegments(prev => prev.map(s => s.id === row.id ? {...s, referenceImage: makeLocalReferenceImage(filePath), referenceImagePath: filePath} : s));
                              }
                            }
                          }}
                          className="inline-flex items-center space-x-1 bg-dark-card hover:bg-[#4c2d9a] text-dark-muted hover:text-white px-2 py-0.5 rounded cursor-pointer font-bold select-none scale-95 border border-dashed border-dark-border hover:border-purple-500 transition-all"
                        >
                          <Plus className="w-3 h-3" />
                          <span className="text-[9px]">垫图</span>
                        </span>
                      )}
                    </div>

                    {editingRowId === row.id ? (
                      <textarea
                        ref={(el) => {
                          if (el) {
                            promptTextareaRefs.current[row.id] = el;
                            requestAnimationFrame(() => resizePromptTextarea(el));
                          } else delete promptTextareaRefs.current[row.id];
                        }}
                        defaultValue={promptDraftsRef.current[row.id] ?? row.text}
                        onChange={(e) => handleTextareaChange(row.id, e.target.value, e)}
                        onKeyDown={(e) => handleTextareaKeyDown(row.id, e)}
                        onBlur={() => {
                          commitPromptDraft(row.id);
                          setTimeout(() => {
                            setEditingRowId((current) => current === row.id ? null : current);
                            resetAtState();
                          }, 150);
                        }}
                        placeholder="请输入描述词，输入 @ 选择角色、$ 选择场景、# 选择物品..."
                        className="w-full min-h-[72px] max-h-[260px] bg-transparent text-xs leading-relaxed text-dark-text placeholder-dark-subtle resize-none overflow-y-auto border-none outline-none focus:ring-0 p-0 cursor-text"
                      />
                    ) : (
                      <div
                        role="textbox"
                        tabIndex={0}
                        onClick={() => startEditingPrompt(row)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            startEditingPrompt(row);
                          }
                        }}
                        className="w-full min-h-[72px] max-h-[260px] overflow-y-auto whitespace-pre-wrap break-words bg-transparent text-xs leading-relaxed text-dark-text border-none outline-none focus:ring-0 p-0 cursor-text"
                        title="点击编辑；引用会以小标签显示，提交时仍使用原始文本"
                      >
                        {renderPromptPreviewText(promptDraftsRef.current[row.id] ?? row.text)}
                      </div>
                    )}

                    {(() => {
                      const mentionedCharacters = getReferencedCharacterDisplayItems(
                        row,
                        promptDraftsRef.current[row.id] ?? row.text ?? ''
                      );
                      if (mentionedCharacters.length === 0) return null;
                      return (
                        <div className="mt-2 pt-2 border-t border-dark-border/40">
                          <div className="mb-1.5 text-[8px] font-bold tracking-wide text-dark-subtle">
                            已识别角色引用
                          </div>
                          <div className="flex flex-wrap gap-1.5">
                            {mentionedCharacters.map(({ name, asset, hasAsset, hasImage, sendImage }) => {
                              const avatarUrl = displayAvatarUrlForAsset(asset || {});
                              const statusText = !hasAsset
                                ? '未找到资产 · 仅文本'
                                : !hasImage
                                  ? '无角色图片 · 仅文本'
                                  : sendImage
                                    ? '发送图片'
                                    : '不发送图片';
                              return (
                                <div
                                  key={name}
                                  className={`inline-flex items-center gap-1.5 rounded-md border px-1.5 py-1 text-[9px] ${
                                    sendImage
                                      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-100'
                                      : hasImage
                                        ? 'border-amber-500/35 bg-amber-500/10 text-amber-100'
                                        : 'border-dark-border bg-black/15 text-dark-muted'
                                  }`}
                                  title={`已识别 @${name}；提示词始终发送，角色图片可单独控制`}
                                >
                                  {avatarUrl ? (
                                    <img src={avatarUrl} alt={name} className="h-4 w-4 rounded object-cover" />
                                  ) : (
                                    <span className="flex h-4 w-4 items-center justify-center rounded bg-black/25 font-black">@</span>
                                  )}
                                  <span className="max-w-[120px] truncate font-bold">@{name}</span>
                                  {hasImage ? (
                                    <button
                                      type="button"
                                      aria-pressed={sendImage}
                                      onMouseDown={(e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                      }}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setCharacterImagePreference(row.id, name, !sendImage);
                                      }}
                                      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-bold transition-colors ${
                                        sendImage
                                          ? 'bg-emerald-400/20 hover:bg-emerald-400/30'
                                          : 'bg-amber-400/15 hover:bg-amber-400/25'
                                      }`}
                                      title={sendImage ? '点击后仅发送 @角色 文本，不附带角色图片' : '点击后恢复附带角色图片'}
                                    >
                                      <span>{statusText}</span>
                                      <span className={`relative h-3 w-5 rounded-full ${sendImage ? 'bg-emerald-400' : 'bg-dark-border'}`}>
                                        <span className={`absolute top-0.5 h-2 w-2 rounded-full bg-white transition-all ${sendImage ? 'left-2.5' : 'left-0.5'}`} />
                                      </span>
                                    </button>
                                  ) : (
                                    <span className="rounded bg-black/20 px-1.5 py-0.5">{statusText}</span>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })()}

                    {/* Autocomplete @ / $ / # asset choice popover */}
                    {atState.isOpen && atState.rowId === row.id && (() => {
                      const activeTrigger = atState.trigger || '@';
                      const triggerMeta = TRIGGERS[activeTrigger] || TRIGGERS['@'];
                      const assetList = getAssetsForTrigger(activeTrigger);
                      const filtered = assetList.filter(a => a.name.toLowerCase().includes(atState.query.toLowerCase()));
                      const TriggerIcon = triggerMeta.type === 'scene' ? Mountain : (triggerMeta.type === 'item' ? Gamepad2 : null);
                      return (
                      <div 
                        onMouseDown={(e) => e.preventDefault()} // Prevent blur on click!
                        className="absolute left-6 top-[78px] w-[460px] h-[190px] bg-[#222328] border border-dark-border rounded-xl shadow-[0_12px_28px_rgba(0,0,0,0.6)] flex items-stretch overflow-hidden z-50 animate-in fade-in zoom-in-95 duration-100"
                      >
                        {/* Left List of Assets */}
                        <div className="w-[220px] border-r border-dark-border/40 p-2 flex flex-col space-y-1 overflow-y-auto no-scrollbar">
                          <div className="text-[9px] text-dark-subtle font-bold px-1 pb-1 uppercase tracking-wider shrink-0">
                            {triggerMeta.label}（{activeTrigger}）
                          </div>
                          {filtered.map((asset, index) => {
                              const isHovered = hoveredCharId === asset.id;
                              return (
                                <div
                                  key={asset.id}
                                  onMouseEnter={() => setHoveredCharId(asset.id)}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleSelectCharacterFromDropdown(row.id, asset.name, activeTrigger);
                                  }}
                                  className={`flex items-center space-x-3 p-1.5 rounded-lg cursor-pointer transition-colors ${
                                    isHovered ? 'bg-[#323338] text-brand' : 'hover:bg-[#2d2e33]/50 text-dark-text'
                                  }`}
                                >
                                  {/* Index Badge */}
                                  <span className={`w-5 h-5 rounded flex items-center justify-center text-[10px] font-extrabold transition-colors shrink-0 ${
                                    isHovered ? 'bg-[#10b981] text-black font-extrabold shadow-[0_0_6px_rgba(16,185,129,0.3)]' : 'bg-[#18191c] text-dark-muted'
                                  }`}>
                                    {index + 1}
                                  </span>
                                  
                                  {/* Small avatar or icon fallback */}
                                  {displayAvatarUrlForAsset(asset) ? (
                                    <img src={displayAvatarUrlForAsset(asset)} alt={asset.name} className="w-6 h-6 rounded-full object-cover border border-dark-border/20 shrink-0" />
                                  ) : (
                                    <span className="w-6 h-6 rounded-full bg-[#18191c] border border-dark-border/20 flex items-center justify-center shrink-0">
                                      {TriggerIcon ? <TriggerIcon className="w-3 h-3 text-dark-muted" /> : <span className="text-[10px] text-dark-muted">{activeTrigger}</span>}
                                    </span>
                                  )}
                                  
                                  {/* Asset Name */}
                                  <span className="text-xs font-semibold truncate flex-1">{asset.name}</span>
                                </div>
                              );
                            })}
                          {filtered.length === 0 && (
                            <div className="text-[10px] text-dark-subtle text-center py-6">
                              无匹配{triggerMeta.label}{assetList.length === 0 ? `，请先在下方资产区添加${triggerMeta.label}` : ''}
                            </div>
                          )}
                        </div>

                        {/* Right Larger Asset Profile Card */}
                        {(() => {
                          const activeChar = assetList.find(c => c.id === hoveredCharId) || filtered[0] || assetList[0];
                          return activeChar ? (
                            <div className="flex-1 bg-black/15 p-3 flex items-stretch space-x-3 relative">
                              <div className="w-[125px] h-full rounded-lg overflow-hidden border border-dark-border/30 relative shrink-0">
                                {displayAvatarUrlForAsset(activeChar) ? (
                                  <img src={displayAvatarUrlForAsset(activeChar)} alt="preview" className="w-full h-full object-cover" />
                                ) : (
                                  <div className="w-full h-full bg-[#18191c] flex items-center justify-center">
                                    {TriggerIcon ? <TriggerIcon className="w-8 h-8 text-dark-muted" /> : <span className="text-2xl text-dark-muted">{activeTrigger}</span>}
                                  </div>
                                )}
                                <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-1 text-center">
                                  <span className="text-[8px] text-brand font-extrabold tracking-wider bg-black/40 px-1 py-0.2 rounded">{activeChar.role || triggerMeta.label}</span>
                                </div>
                              </div>
                              <div className="flex-1 flex flex-col justify-center text-left">
                                <div className="text-xs font-bold text-white text-base">{activeChar.name}</div>
                                <div className="text-[10px] text-[#10b981] mt-1 font-semibold">{triggerMeta.label}就绪</div>
                                <div className="text-[9px] text-dark-subtle mt-1.5 leading-relaxed">
                                  点击插入描述词标签。角色引用插入后，可单独选择是否附带角色图片。
                                </div>
                              </div>
                            </div>
                          ) : null;
                        })()}
                      </div>
                      );
                    })()}

                    {generateChannel === 'oreateai' && (() => {
                      const capability = getOreateaiCapability();
                      const assets = row.oreateaiAssets || [];
                      const limits = capability ? getOreateaiEffectiveSlots(capability, assets) : null;
                      const selectionError = capability ? validateOreateaiAssetSelection(capability, assets) : '动态能力尚未加载';
                      const summary = limits ? [
                        limits.slots.image && `图片 ${limits.counts.image}/${limits.slots.image.max ?? '∞'}`,
                        limits.slots.video && `视频 ${limits.counts.video}/${limits.slots.video.max ?? '∞'}`,
                      ].filter(Boolean).join(' · ') : '';
                      return (
                        <div className="rounded-lg border border-cyan-500/25 bg-cyan-500/5 px-2.5 py-2 space-y-1.5">
                          <div className="flex items-center justify-between gap-2">
                            <div className="min-w-0">
                              <span className="text-[9px] font-extrabold text-cyan-100">OreateAI 本地参考素材</span>
                              <span className="ml-1.5 text-[8px] text-cyan-200/70">{summary || '按实时配置限制'}</span>
                            </div>
                            <button type="button" onClick={() => selectOreateaiAssetsForRow(row.id)} disabled={!capability} className="shrink-0 rounded border border-cyan-400/40 px-1.5 py-0.5 text-[8px] font-bold text-cyan-100 hover:bg-cyan-500/15 disabled:opacity-40">
                              + 选择本地素材
                            </button>
                          </div>
                          {assets.length > 0 && <div className="flex flex-wrap gap-1">
                            {assets.map((asset, index) => <span key={`${asset.path}-${index}`} className="inline-flex max-w-full items-center gap-1 rounded bg-black/20 px-1.5 py-0.5 text-[8px] text-cyan-50">
                              <span className="shrink-0">{asset.kind === 'video' ? '视频' : '图片'}</span>
                              <span className="max-w-[150px] truncate">{asset.name}</span>
                              <button type="button" onClick={() => removeOreateaiAssetFromRow(row.id, index)} className="text-cyan-100/60 hover:text-white" title="移除素材">×</button>
                            </span>)}
                          </div>}
                          {selectionError && <p className="text-[8px] text-amber-200">{selectionError}</p>}
                          {capability?.scene === 'reference' && <p className="text-[8px] text-cyan-100/65">保留选择顺序；视频时长由主进程重新探测并校验。</p>}
                        </div>
                      );
                    })()}

                  </div>
                </div>

                {/* Sub row controls - High-fidelity Row Segment Footer matching Image 1 */}
                <div className="flex items-center justify-between pt-3 border-t border-dark-border/20 mt-2.5">
                  {/* Left Side: Parameters badges */}
                  <div className="flex items-center space-x-1.5 text-[10px]">
                    {/* Model Dropdown Trigger */}
                    <div 
                      onClick={() => setActivePopover('model')}
                      className="bg-[#222328] hover:bg-dark-bg border border-dark-border hover:border-brand/40 px-2.5 py-1.5 rounded-lg text-[#d1d5db] font-semibold cursor-pointer transition-colors scale-95"
                    >
                      <span className="text-[9px] text-brand font-extrabold mr-1">{getRowMediaLabel(row)}</span>
                      {getRowModelName(row)}
                    </div>

                    {/* API/Local channel selector with dropdown arrow ▼ */}
                    <div 
                      onClick={() => {
                        const currentChannel = row.channel || 'API';
                        const nextChannel = currentChannel === 'API' ? '本地' : 'API';
                        setSegments(prev => prev.map(s => s.id === row.id ? { ...s, channel: nextChannel } : s));
                      }}
                      className="bg-[#222328] hover:bg-dark-bg border border-dark-border hover:border-brand/40 px-2.5 py-1.5 rounded-lg text-dark-muted font-bold cursor-pointer transition-colors flex items-center space-x-1.5 uppercase scale-95"
                      title="点击切换渠道"
                    >
                      <span>{row.channel || 'API'}</span>
                      <span className="scale-75 text-[8px] text-dark-subtle">▼</span>
                    </div>

                    {/* Aspect Ratio, Duration and OreateAI Resolution Badge */}
                    <div 
                      onClick={() => setActivePopover('params')}
                      className="bg-[#222328] hover:bg-dark-bg border border-dark-border hover:border-brand/40 px-2.5 py-1.5 rounded-lg text-dark-muted font-medium cursor-pointer transition-colors scale-95"
                      title={generateChannel === 'oreateai' ? '点击选择比例、时长和分辨率' : '点击选择比例和时长'}
                    >
                      {globalAspectRatio} · {globalDuration}
                      {generateChannel === 'oreateai' ? ` · ${String(globalResolution).replace(/p$/i, '')}P` : ''}
                    </div>
                  </div>

                  {/* Right Side: Merge / Reasoning / Generate buttons */}
                  <div className="flex items-center space-x-2">
                    {/* Text to reference image button: render prompt text onto white background as 垫图 */}
                    <button
                      type="button"
                      onClick={() => handleTextToReferenceImage(row.id)}
                      className="flex items-center space-x-1 px-2.5 py-1.5 bg-[#1a2a1d] hover:bg-[#243a28] border border-[#1e3d28] text-[#5fd4a0] font-bold rounded-lg text-[11px] transition-colors"
                      title="把当前描述词文字渲染到白色背景板上，生成一张图片作为垫图"
                    >
                      <Type className="w-3 h-3" />
                      <span>描述词转垫图</span>
                    </button>
                    {/* Merge images button: pull @角色 / $场景 / #物品 / 垫图 into a single reference */}
                    <button
                      type="button"
                      onClick={() => openMergeModalForRow(row)}
                      className="flex items-center space-x-1 px-2.5 py-1.5 bg-[#1d1830] hover:bg-[#2a2244] border border-[#3a2f5e] text-[#b9a4ff] font-bold rounded-lg text-[11px] transition-colors"
                      title="把该行的垫图 + @角色 + $场景 + #物品 合成为一张新的垫图（不压缩分辨率）"
                    >
                      <Combine className="w-3 h-3" />
                      <span>合并图片</span>
                    </button>
                    {/* API collect button */}
                    {generateChannel === 'dola' && (
                      <button
                        type="button"
                        onClick={() => handleCollectDolaTask(row)}
                        className="px-3 py-1.5 bg-[#162923] hover:bg-[#1f3a2f] border border-[#1a3d31] text-[#10b981] font-bold rounded-lg text-[11px] transition-colors"
                        title="通过 Dola API 采集视频结果，不会打开浏览器"
                      >
                        API 采集
                      </button>
                    )}

                    {/* Generate button */}
                    <button 
                      type="button"
                      onClick={() => {
                        handleGenerate(row.id);
                      }}
                      className="flex items-center space-x-1 px-3.5 py-1.5 bg-brand hover:bg-brand-dark text-black rounded-lg text-[11px] font-bold transition-all shadow-[0_2px_10px_rgba(16,185,129,0.15)] active:scale-95"
                      title={generateChannel === 'dola' ? '渠道六 Dola 单账号一次只能跑一个视频任务；可连续点击多次，系统会自动换用下一个空闲账号并行生成' : '可连续点击多次，每次都会提交一个新的生成任务'}
                    >
                      <Send className="w-3 h-3" />
                      <span>
                        {row.generating
                          ? `继续生成${getRowMediaLabel(row)}${row.activeTaskCount ? ` (${row.activeTaskCount})` : ''}`
                          : `生成${getRowMediaLabel(row)}`}
                      </span>
                    </button>
                    {(row.pendingChannel === 'dola' || row.lastFailedChannel === 'dola') && (row.pendingTaskId || row.lastFailedTaskId) && (
                      <button
                        type="button"
                        onClick={() => handleCollectDolaTask(row)}
                        className="px-2.5 py-1.5 rounded-lg bg-orange-500/10 border border-orange-500/30 text-orange-300 hover:bg-orange-500/20 hover:text-orange-200 text-[11px] font-bold transition-all"
                        title="通过 Dola API 主动轮询结果，不会打开浏览器"
                      >
                        {row.generateStatus === 'collecting' ? '采集中...' : '手动采集'}
                      </button>
                    )}
                    {hasActiveGenerationTask(row) && (
                      <button
                        type="button"
                        onClick={() => cancelRowGeneration(row.id)}
                        className="px-2.5 py-1.5 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 hover:bg-red-500/20 hover:text-red-200 text-[11px] font-bold transition-all"
                        title="清空当前行所有等待中的任务状态"
                      >
                        清空等待
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* COLUMN 2: Row Current Material Viewport (26% width) */}
              <div className="w-[26%] px-4 flex flex-col justify-start space-y-2 border-r border-dark-border/20 relative">
                {/* Lock overlay if toggled on */}
                {row.isLocked && (
                  <div className="absolute inset-x-4 inset-y-0 bg-black/75 z-10 rounded-xl flex flex-col items-center justify-center text-center p-3 animate-in fade-in duration-200">
                    <Lock className="w-7 h-7 text-amber-500 animate-bounce mb-1" />
                    <span className="text-[10px] text-white font-bold">画面已锁定</span>
                    <button 
                      onClick={() => toggleLockRowMaterial(row.id)}
                      className="mt-2 px-2.5 py-0.5 bg-brand text-black rounded text-[9px] font-bold"
                    >
                      解锁
                    </button>
                  </div>
                )}

                {/* Sub-header inside column */}
                <div className="flex items-center justify-between mb-1 shrink-0">
                  <span className="text-[10px] font-bold text-dark-muted truncate max-w-[55%]">{currentMaterial.name}</span>
                  <div className="flex items-center space-x-1">
                    {/* Clear current preview button */}
                    {currentMaterial.id > 0 && (
                      <button 
                        type="button"
                        onClick={() => handleClearCurrent(row.id)}
                        className="p-1.5 hover:bg-red-500/15 rounded-md text-dark-muted hover:text-red-400 transition-all"
                        title="清除当前预览画面"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                    <button 
                      onClick={() => toggleLockRowMaterial(row.id)}
                      className="flex items-center space-x-1 text-[9px] text-dark-muted hover:text-white px-1.5 py-0.5 rounded bg-dark-card border border-dark-border"
                    >
                      {row.isLocked ? <Lock className="w-2.5 h-2.5 text-amber-500" /> : <Unlock className="w-2.5 h-2.5" />}
                      <span>{row.isLocked ? '锁定' : '未锁'}</span>
                    </button>
                  </div>
                </div>

                {/* Canvas viewport container */}
                <div
                  className="w-full h-[156px] rounded-xl bg-zinc-950 border border-dark-border overflow-hidden relative flex items-center justify-center group/viewport shrink-0"
                  draggable={isVid && hasPreview}
                  onMouseEnter={() => { if (isVid && hasPreview) prepareExternalVideoDrag(currentMaterial); }}
                  onMouseDown={(e) => { if (e.button === 0 && isVid && hasPreview) prepareExternalVideoDrag(currentMaterial); }}
                  onDragStart={(e) => { if (isVid && hasPreview) startExternalVideoDrag(e, currentMaterial); }}
                  onDoubleClick={() => {
                    if (hasPreview) {
                      const previewSrc = isVid
                        ? playableUrlForMaterial(currentMaterial)
                        : previewUrl;
                      setFullscreenLoading(isVid);
                      setFullscreenVideo({
                        src: previewSrc,
                        fallbackSrc: isVid ? playableFallbackUrlForMaterial(currentMaterial) : '',
                        mediaType: currentMaterial.mediaType || (isVideoUrl(previewSrc) ? 'video' : 'image'),
                        rowId: row.id,
                        materialId: currentMaterial.id,
                        materialName: currentMaterial.name,
                      });
                    }
                  }}
                  title={hasPreview ? (isVid ? '双击放大预览，可拖出到剪映' : '双击放大预览，可拖出到其他软件') : undefined}
                >
                  {hasPreview ? (
                    currentMaterial.mediaType === 'video' || isVideoUrl(previewUrl) ? (
                      <video
                        ref={(el) => {
                          if (!el) return;
                          if (isCurrentPlaying && el.paused) el.play().catch(()=>{});
                          if (!isCurrentPlaying && !el.paused) el.pause();
                        }}
                        key={playableUrlForMaterial(currentMaterial)}
                        src={isCurrentPlaying ? playableUrlForMaterial(currentMaterial) : undefined}
                        className={`w-full h-full object-contain bg-zinc-950 ${isCurrentPlaying ? 'scale-105 brightness-110' : ''} transition-all duration-700`}
                        draggable={false}
                        muted
                        playsInline
                        loop
                        preload="none"
                        onError={(event) => {
                          const fallbackUrl = playableFallbackUrlForMaterial(currentMaterial);
                          if (!switchVideoToFallback(event, fallbackUrl, isCurrentPlaying) && isCurrentPlaying) {
                            console.warn('Video preview failed:', currentMaterial.thumbnail);
                          }
                        }}
                      />
                    ) : (
                      <img 
                        src={previewUrl} 
                        alt={currentMaterial.name}
                        draggable={!isVid}
                        onMouseEnter={() => prepareExternalImageDrag(currentMaterial)}
                        onMouseDown={() => prepareExternalImageDrag(currentMaterial)}
                        onDragStart={(e) => startExternalImageDrag(e, currentMaterial)}
                        className={`w-full h-full object-contain bg-zinc-950 ${isCurrentPlaying ? 'scale-105 brightness-110' : ''} transition-all duration-700`}
                      />
                    )
                  ) : (
                    <div className="flex flex-col items-center justify-center text-dark-muted space-y-1">
                      <Video className="w-6 h-6 opacity-30" />
                      <span className="text-[9px] opacity-50">等待生成</span>
                    </div>
                  )}

                  {/* Generating progress overlay */}
                  {row.generating && (
                    <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-zinc-950/80 backdrop-blur-[2px] px-5 space-y-2.5">
                      <RefreshCw className="w-5 h-5 text-brand animate-spin" />
                      <span className="text-[10px] font-bold text-white">
                        {row.activeTaskCount > 1
                          ? `${row.activeTaskCount} 个任务生成中...`
                          : row.queuePosition != null && row.queuePosition > 0
                          ? `排队中 #${row.queuePosition}`
                          : row.generateStatus === 'collecting' ? '手动采集中...'
                          : row.generateStatus === 'collectable' ? '可手动采集'
                          : (typeof row.generateProgress === 'number' && row.generateProgress > 0
                              ? `生成中 ${row.generateProgress}%`
                              : row.generateStatus === 'processing' ? '生成中...' : '等待中...')}
                      </span>
                      {generationWaitLabel(row) && (
                        <span className="text-[8px] font-semibold text-brand/90 text-center leading-tight">
                          {generationWaitLabel(row)}
                        </span>
                      )}
                      <div className="w-full max-w-[180px] h-1.5 rounded-full bg-dark-border/60 overflow-hidden">
                        {typeof row.generateProgress === 'number' && row.generateProgress > 0 ? (
                          <div
                            className="h-full bg-brand rounded-full transition-all duration-500 ease-out shadow-[0_0_8px_rgba(16,185,129,0.5)]"
                            style={{ width: `${Math.min(100, Math.max(2, row.generateProgress))}%` }}
                          />
                        ) : (
                          <div className="h-full w-1/3 bg-brand/70 rounded-full animate-pulse" />
                        )}
                      </div>
                    </div>
                  )}

                  {/* Generation failure message */}
                  {!row.generating && row.generationError && (
                    <div className="absolute inset-x-2 bottom-2 z-30 rounded-lg border border-red-500/40 bg-red-950/85 px-3 py-2 text-[10px] text-red-100 shadow-lg backdrop-blur-sm">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="font-extrabold text-red-300">生成失败</div>
                          <div className="mt-0.5 max-h-8 overflow-hidden break-words" title={row.generationError}>{row.generationError}</div>
                        </div>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSegments(prev => prev.map(seg => seg.id === row.id ? { ...seg, generationError: '' } : seg));
                          }}
                          className="shrink-0 rounded bg-white/10 p-0.5 text-red-100 hover:bg-white/20"
                          title="关闭提示"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Play Action center overlay (Only when there's actual content) */}
                  {isVid && currentMaterial.thumbnail && (
                    <button 
                      type="button"
                      draggable={true}
                      onMouseDown={(e) => { if (e.button === 0) prepareExternalVideoDrag(currentMaterial); }}
                      onDragStart={(e) => startExternalVideoDrag(e, currentMaterial)}
                      onClick={() => togglePlayCurrent(row.id)}
                      className={`absolute inset-0 m-auto w-10 h-10 rounded-full bg-brand hover:scale-110 shadow-lg shadow-brand/25 flex items-center justify-center text-black font-bold transition-all cursor-grab active:cursor-grabbing ${isCurrentPlaying ? 'opacity-0 group-hover/viewport:opacity-90' : 'opacity-90'}`}
                      title="点击播放/暂停，左键按住可拖到剪映"
                    >
                      {isCurrentPlaying ? <Pause className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current ml-0.5" />}
                    </button>
                  )}

                  {/* Fullscreen button */}
                  {currentMaterial.thumbnail && (
                    <button
                      onClick={() => {
                        const previewSrc = isVid
                          ? playableUrlForMaterial(currentMaterial)
                          : (currentMaterial.sourceUrl || currentMaterial.remoteUrl || (currentMaterial.localPath ? makeLocalFileUrl(currentMaterial.localPath) : '') || currentMaterial.thumbnail);
                        setFullscreenLoading(isVid);
                        setFullscreenVideo({
                          src: previewSrc,
                          fallbackSrc: isVid ? playableFallbackUrlForMaterial(currentMaterial) : '',
                          mediaType: currentMaterial.mediaType || (isVideoUrl(previewSrc) ? 'video' : 'image'),
                          rowId: row.id,
                          materialId: currentMaterial.id,
                          materialName: currentMaterial.name,
                        });
                      }}
                      className="absolute top-2 right-2 p-1.5 rounded-md bg-black/60 hover:bg-black/80 text-white/70 hover:text-white opacity-0 group-hover/viewport:opacity-100 transition-all"
                      title="放大预览"
                    >
                      <Maximize2 className="w-3.5 h-3.5" />
                    </button>
                  )}

                  {/* Download button (video and image, local and remote) */}
                  {currentMaterial.thumbnail && currentMaterial.id > 0 && (
                    <button
                      onClick={() => {
                        const dlName = `${row.id}-${currentMaterial.name || (isVid ? 'video' : 'image')}`;
                        if (isVid) {
                          handleDownloadVideo(currentMaterial, dlName);
                        } else {
                          handleDownloadImage(currentMaterial, dlName);
                        }
                      }}
                      className="absolute top-2 right-10 p-1.5 rounded-md bg-black/60 hover:bg-brand text-white/70 hover:text-black opacity-0 group-hover/viewport:opacity-100 transition-all"
                      title={isVid ? '下载视频' : '下载图片'}
                    >
                      <Download className="w-3.5 h-3.5" />
                    </button>
                  )}

                  {/* Timeline overlay footer (only when there's content) */}
                  {currentMaterial.thumbnail && (
                    isVid ? (
                      <div className="absolute bottom-0 inset-x-0 bg-black/60 p-2 border-t border-white/5 backdrop-blur-[2px] flex items-center justify-between text-[8px] text-dark-muted">
                        <span>{isCurrentPlaying ? '00:03' : '00:00'} / {currentMaterial.duration}</span>
                        <span>fps: {currentMaterial.fps}</span>
                      </div>
                    ) : (
                      <div className="absolute bottom-0 inset-x-0 bg-black/60 p-2 border-t border-white/5 backdrop-blur-[2px] flex items-center justify-center text-[8px] text-brand font-bold">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleRenameCurrentMaterial(row.id);
                          }}
                          className="hover:text-brand-light max-w-full truncate"
                          title="点击修改素材名称"
                        >
                          {currentMaterial.name || '当前图片素材'}
                        </button>
                      </div>
                    )
                  )}
                </div>
              </div>

              {/* COLUMN 3: Row Candidate Available Materials Grid (26% width) */}
              <div className="w-[26%] pl-4 flex flex-col justify-start">
                {/* Header row */}
                <div className="flex items-center justify-between mb-2 shrink-0">
                  <div className="flex items-center space-x-1">
                    <span className="text-[10px] font-bold text-dark-muted">可选备选帧</span>
                    <span className="text-[9px] text-dark-subtle">({materials.length})</span>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {/* 清理卡住的生成中占位格子（失败任务残留） */}
                    {(row.pendingAccounts || []).filter(a => a.accountId || a.accountName).length > 0 && (
                      <button
                        onClick={() => {
                          if (!confirm('确定清理本行所有「生成中」占位格子吗？\n这只会移除转圈的占位格子，不会影响已生成的素材。')) return;
                          setSegments(prev => prev.map(s => {
                            if (s.id !== row.id) return s;
                            return {
                              ...s,
                              pendingAccounts: [],
                              generating: false,
                              generateStatus: null,
                              generateProgress: null,
                              pendingTaskId: null,
                              pendingTaskIds: [],
                              pendingPrimaryTaskId: '',
                              pendingAccountId: 0,
                              pendingAccountName: '',
                              pendingConversationId: '',
                              pendingLocalConversationId: '',
                              pendingDolaPageUrl: '',
                              pendingDolaSendMode: '',
                              pendingDolaSendModeLabel: '',
                              queuePosition: null,
                              activeTaskCount: 0,
                            };
                          }));
                        }}
                        className="text-[9px] text-dark-muted hover:text-red-300 font-bold bg-dark-card border border-dark-border hover:border-red-400/40 px-1.5 py-0.5 rounded transition-all"
                        title="清理本行所有卡住的「生成中」占位格子（失败任务残留）"
                      >
                        清空转圈
                      </button>
                    )}
                    {/* Clean local upload trigger on header */}
                    <button 
                      onClick={() => {
                        const name = prompt('请输入导入的本地素材名称:', `本地导入素材_${Date.now().toString().slice(-4)}.${isVid ? 'mp4' : 'jpg'}`);
                        if (name) {
                          const newMatId = Math.max(...materials.map(m => m.id)) + 1;
                          const newMat = {
                            id: newMatId,
                            name,
                            thumbnail: isVid ? 'https://images.unsplash.com/photo-1492691527719-9d1e07e534b4?auto=format&fit=crop&q=80&w=120' : 'https://images.unsplash.com/photo-1579783900882-c0d3dad7b119?auto=format&fit=crop&q=80&w=120',
                            status: 'new',
                            textStatus: isVid ? '+ 拖拽' : '原画',
                            mediaType: isVid ? 'video' : 'image'
                          };
                          setSegments(prev => prev.map(s => {
                            if (s.id === row.id) {
                              return isVid 
                                ? { ...s, materialsVideo: [newMat, ...s.materialsVideo] }
                                : { ...s, materialsImage: [newMat, ...s.materialsImage] };
                            }
                            return s;
                          }));
                        }
                      }}
                      className="text-[9px] text-brand hover:text-brand-light font-bold bg-dark-card border border-dark-border hover:border-brand/40 px-1.5 py-0.5 rounded transition-all shrink-0"
                      title="导入本地文件"
                    >
                      + 导入
                    </button>
                  </div>
                </div>

                {/* Materials grid container - 2x2 forcing height */}
                <div className="grid grid-cols-2 gap-1.5 h-[156px] overflow-y-auto no-scrollbar pb-1 relative">
                  
                  {/* Pending Dola tasks expose browser access only as an explicit authorization or diagnostic action. */}
                  {(row.pendingAccounts || []).filter(a => a.accountId || a.accountName).map((acc) => (
                    <div
                      key={`gen-${acc.taskId}`}
                      className="relative rounded-lg border border-brand/40 bg-brand/5 overflow-hidden h-[74px] flex flex-col items-center justify-center"
                    >
                      <div className="absolute inset-0 bg-gradient-to-br from-brand/10 to-transparent animate-pulse" />
                      <RefreshCw className="w-3.5 h-3.5 text-brand animate-spin relative z-10 mb-1" />
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleOpenDolaAccountBrowser({
                            id: row.id,
                            pendingAccountId: acc.accountId,
                            pendingAccountName: acc.accountName,
                            pendingTaskId: acc.taskId,
                            pendingConversationId: acc.conversationId,
                          });
                        }}
                        className="relative z-10 max-w-full truncate rounded-full border border-brand/50 bg-brand/15 px-1.5 py-0.5 text-[8px] font-extrabold text-brand hover:bg-brand hover:text-black transition-all"
                        title={`手动打开账号 ${acc.accountName || '#' + acc.accountId} 的 Dola 浏览器进行授权或诊断`}
                      >
                        {(() => {
                          const name = acc.accountName || '';
                          const match = name.match(/#(\d+)/);
                          const accountLabel = match ? `#${match[1]}` : (name || `#${acc.accountId}`);
                          return `授权/诊断 ${accountLabel}`;
                        })()}
                      </button>
                    </div>
                  ))}

                  {/* Generic generating placeholder for non-Dola channels (shows progress bar) */}
                  {row.generating && (row.pendingAccounts || []).filter(a => a.accountId || a.accountName).length === 0 && (
                    <div
                      key={`gen-generic-${row.id}`}
                      className="relative rounded-lg border border-brand/40 bg-brand/5 overflow-hidden h-[74px] flex flex-col items-center justify-center"
                    >
                      <div className="absolute inset-0 bg-gradient-to-br from-brand/10 to-transparent animate-pulse" />
                      <RefreshCw className="w-3.5 h-3.5 text-brand animate-spin relative z-10 mb-1" />
                      <span className="relative z-10 text-[8px] font-bold text-brand mb-1 truncate max-w-full px-1">
                        {row.activeTaskCount > 1
                          ? `${row.activeTaskCount} 个任务`
                          : row.queuePosition != null && row.queuePosition > 0
                          ? `排队 #${row.queuePosition}`
                          : row.generateStatus === 'collecting' ? '采集中'
                          : (typeof row.generateProgress === 'number' && row.generateProgress > 0
                              ? `生成中 ${row.generateProgress}%`
                              : '生成中...')}
                      </span>
                      {generationWaitLabel(row) && (
                        <span className="relative z-10 text-[7px] font-semibold text-brand/80 mb-1 truncate max-w-full px-1">
                          {generationWaitLabel(row)}
                        </span>
                      )}
                      <div className="relative z-10 w-[80%] h-1 rounded-full bg-dark-border/60 overflow-hidden">
                        {typeof row.generateProgress === 'number' && row.generateProgress > 0 ? (
                          <div
                            className="h-full bg-brand rounded-full transition-all duration-500 ease-out shadow-[0_0_6px_rgba(16,185,129,0.5)]"
                            style={{ width: `${Math.min(100, Math.max(2, row.generateProgress))}%` }}
                          />
                        ) : (
                          <div className="h-full w-1/3 bg-brand/70 rounded-full animate-pulse" />
                        )}
                      </div>
                    </div>
                  )}
                  
                  {/* Candidates items in 2x2 grid */}
                  {materials.map((mat) => {
                    const matThumb = mat.thumbnail || '';
                    const curThumb = currentMaterial.thumbnail || '';
                    const isActive = !!matThumb && !!curThumb && curThumb.split('?')[0] === matThumb.split('?')[0];
                    const isVideoMat = mat.mediaType === 'video' || isVideoUrl(matThumb);
                    return (
                      <div 
                        key={mat.id}
                        draggable={!!matThumb}
                        onMouseEnter={(e) => {
                          if (isVideoMat) {
                            prepareExternalVideoDrag(mat);
                            e.currentTarget.querySelector('video')?.play().catch(() => {});
                          } else {
                            prepareExternalImageDrag(mat);
                          }
                        }}
                        onMouseLeave={(e) => {
                          if (!isVideoMat) return;
                          const preview = e.currentTarget.querySelector('video');
                          if (!preview) return;
                          preview.pause();
                          preview.currentTime = 0;
                        }}
                        onMouseDown={(e) => { if (e.button === 0) { isVideoMat ? prepareExternalVideoDrag(mat) : prepareExternalImageDrag(mat); } }}
                        onDragStart={(e) => isVideoMat ? startExternalVideoDrag(e, mat) : startExternalImageDrag(e, mat)}
                        onClick={() => handleSelectCandidateMaterial(row.id, mat)}
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          if (!matThumb) return;
                          const isVidMat = mat.mediaType === 'video' || isVideoUrl(matThumb);
                          const fullSrc = isVidMat ? playableUrlForMaterial(mat) : matThumb;
                          setFullscreenLoading(isVidMat);
                          setFullscreenVideo({
                            src: fullSrc,
                            fallbackSrc: isVidMat ? playableFallbackUrlForMaterial(mat) : '',
                            mediaType: mat.mediaType || (isVideoUrl(matThumb) ? 'video' : 'image'),
                            rowId: row.id,
                            materialId: mat.id,
                            materialName: mat.name,
                          });
                        }}
                        className={`relative rounded-lg border overflow-hidden h-[74px] cursor-pointer transition-all flex flex-col group/candidate ${
                          isActive 
                            ? 'border-brand bg-brand/5 shadow-[0_0_8px_rgba(16,185,129,0.15)]' 
                            : 'border-dark-border bg-dark-card/40 hover:bg-dark-card hover:border-dark-subtle'
                        }`}
                        title={isActive ? '当前已选中；双击放大预览，可拖出到剪映' : '点击选为当前画面；双击放大预览，可拖出到剪映'}
                      >
                        {/* Badges Overlay */}
                        <div className="absolute top-1 left-1 z-10 flex items-center justify-between w-[85%] pointer-events-none">
                          <span className="w-3.5 h-3.5 rounded bg-black/70 backdrop-blur-sm flex items-center justify-center text-[9px] font-bold text-white scale-90">
                            {mat.id}
                          </span>
                          {mat.status && (
                            <span className={`text-[7px] px-1 py-0.2 rounded font-semibold scale-90 ${
                              mat.status === 'new' 
                                ? 'bg-brand/20 text-brand border border-brand/30' 
                                : 'bg-amber-500/10 text-amber-500 border border-amber-500/20'
                            }`}>
                              {mat.textStatus}
                            </span>
                          )}
                        </div>

                        {/* Active checkmark badge */}
                        {isActive && (
                          <div className="absolute top-1 right-1 z-10 w-3.5 h-3.5 rounded-full bg-brand flex items-center justify-center pointer-events-none shadow">
                            <Check className="w-2.5 h-2.5 text-black" strokeWidth={3} />
                          </div>
                        )}

                        {/* Preview - video for mp4, image otherwise */}
                        {isVideoMat ? (
                          <>
                            <video
                              key={toPlayableUrl(matThumb)}
                              src={toPlayableUrl(matThumb)}
                              className="w-full h-full object-cover bg-zinc-950 pointer-events-none"
                              draggable={false}
                              muted
                              playsInline
                              loop
                              preload="none"
                              onMouseEnter={(e) => { e.currentTarget.play().catch(()=>{}); }}
                              onMouseLeave={(e) => { e.currentTarget.pause(); e.currentTarget.currentTime = 0; }}
                            />
                            <span className="absolute bottom-1 left-1 z-10 px-1 py-0.5 bg-black/70 text-white text-[8px] rounded font-bold scale-90 pointer-events-none">视频</span>
                          </>
                        ) : matThumb ? (
                          <img 
                            src={matThumb} 
                            alt={mat.name} 
                            className="w-full h-full object-cover pointer-events-none"
                            draggable={false}
                          />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center bg-zinc-900 text-dark-subtle text-[8px]">无预览</div>
                        )}

                        {/* Account chip: which Dola account produced this frame */}
                        {mat.accountName && (
                          <div className="absolute bottom-1 inset-x-0 z-10 flex justify-center px-6 pointer-events-none group-hover/candidate:opacity-0 transition-opacity">
                            <span
                              className="max-w-full truncate rounded bg-black/75 backdrop-blur-sm px-1 py-0.5 text-[7px] font-bold text-brand scale-90"
                              title={`生成账号：${mat.accountName}`}
                            >
                              {mat.accountName}
                            </span>
                          </div>
                        )}

                        {/* Label name Overlay on hover */}
                        <div className="absolute inset-x-0 bottom-0 bg-black/75 p-1 text-center scale-y-0 group-hover/candidate:scale-y-100 origin-bottom transition-transform duration-200">
                          <p className="text-[8px] text-white truncate pr-5">{mat.name}</p>
                        </div>

                        {/* Image to Video reference application hover button */}
                        {!isVid && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleConvertToVideoReference(row.id, mat);
                            }}
                            className="absolute bottom-1 left-1 opacity-0 group-hover/candidate:opacity-100 px-1.5 py-1 bg-black/85 hover:bg-brand border border-white/10 rounded text-[8px] font-bold text-dark-muted hover:text-black transition-all z-20 shadow-md flex items-center space-x-0.5"
                            title="一键转为视频垫图"
                          >
                            <span>转为视频垫图</span>
                          </button>
                        )}

                        {/* Floating Trash Delete Button on hover */}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteCandidate(row.id, mat.id);
                          }}
                          className="absolute bottom-1 right-1 opacity-0 group-hover/candidate:opacity-100 p-1 bg-black/75 hover:bg-red-500 border border-white/10 rounded text-dark-muted hover:text-white transition-all z-20 shadow-md"
                          title="删除备选帧"
                        >
                          <Trash2 className="w-2.5 h-2.5" />
                        </button>
                      </div>
                    );
                  })}

                </div>
              </div>

            </div>
          );
        })}

        {/* Big Add Segment Row Action trigger at the bottom of the list */}
        <div className="p-6 flex justify-center">
          <button 
            type="button"
            onClick={handleAddNewSegmentRow}
            className="flex items-center space-x-2 px-8 py-3 bg-dark-card border border-dark-border hover:border-brand/40 text-xs text-dark-muted hover:text-white rounded-xl transition-all font-semibold"
          >
            <FolderPlus className="w-4 h-4 text-brand" />
            <span>新增一格分镜行 (每一行拥有独立素材预览与素材库)</span>
          </button>
        </div>
      </div>

      {/* 4. Batch Operations & Task settings Modal */}
      {showBatchModal && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 z-50 animate-in fade-in duration-200">
          <div className="bg-dark-sidebar border border-dark-border w-full max-w-2xl rounded-xl overflow-hidden shadow-2xl animate-in zoom-in duration-200">
            
            {/* Modal Header */}
            <div className="h-12 border-b border-dark-border px-5 flex items-center justify-between bg-dark-bg select-none">
              <div className="flex items-center space-x-2">
                <Settings className="w-4 h-4 text-brand animate-[spin_5s_infinite_linear]" />
                <span className="text-xs font-bold text-white">批量素材处理与多媒体导入中心</span>
              </div>
              <button 
                onClick={() => setShowBatchModal(false)}
                className="text-dark-muted hover:text-white text-xs transition-colors"
              >
                ✕
              </button>
            </div>

            {/* Modal Scroll Body */}
            <div className="p-6 space-y-5 max-h-[380px] overflow-y-auto no-scrollbar">

              <div className="space-y-4 animate-in fade-in duration-200">
                <div className="border border-dashed border-dark-border hover:border-brand/40 bg-dark-bg/40 hover:bg-dark-bg/60 p-6 rounded-xl text-center cursor-pointer transition-all space-y-2 group" onClick={handleSelectBatchFolder}>
                  <div className="w-10 h-10 rounded-full border border-dark-border bg-dark-card flex items-center justify-center text-dark-muted mx-auto group-hover:text-brand group-hover:border-brand/30 transition-all">
                    <FolderOpen className="w-5 h-5" />
                  </div>
                  <div className="space-y-1">
                    <p className="text-xs font-bold text-white group-hover:text-brand transition-colors">选择本地素材目录 或 拖入多个媒体文件</p>
                    <p className="text-[10px] text-dark-subtle leading-normal">
                      一键扫描并加载文件夹内的所有 `.mp4` 视频及 `.jpg / .png / .webp` 图片
                    </p>
                  </div>
                </div>

                {/* Selected files preview */}
                <div className="space-y-2">
                  <label className="text-[10px] font-bold text-dark-muted uppercase">待导入的媒体列表 ({batchFiles.length})</label>
                  <div className="border border-dark-border bg-dark-bg/30 rounded-xl divide-y divide-dark-border/30 max-h-[140px] overflow-y-auto no-scrollbar text-xs">
                    {batchFiles.map(f => (
                      <div key={f.id} className="p-2.5 flex items-center justify-between text-dark-text hover:bg-dark-card/20">
                        <div className="flex items-center space-x-2.5 min-w-0">
                          {f.type === 'video' ? <FileVideo className="w-4 h-4 text-blue-400 shrink-0" /> : <FileImage className="w-4 h-4 text-purple-400 shrink-0" />}
                          <span className="truncate max-w-[280px] text-white" title={f.name}>{f.name}</span>
                          <span className="text-[9px] text-dark-subtle font-mono truncate">{f.path}</span>
                        </div>
                        <div className="flex items-center space-x-2 text-[10px] shrink-0">
                          <span className="text-dark-muted">{f.size}</span>
                          {f.appliedAsRef && <span className="text-brand bg-brand/10 border border-brand/20 px-1 py-0.2 rounded font-bold scale-90">已转垫图</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <button 
                  type="button"
                  onClick={handleRunBatchImport}
                  className="w-full flex items-center justify-center space-x-1.5 py-2.5 bg-brand hover:bg-brand-dark rounded-lg text-xs text-black font-bold transition-all shadow-md"
                >
                  <CheckCircle2 className="w-4 h-4" />
                  <span>一键批量导入候选媒体库 (按视频/图片分镜类型智能匹配)</span>
                </button>
              </div>

            </div>

            {/* Modal Footer */}
            <div className="h-12 border-t border-dark-border px-5 flex items-center justify-end bg-dark-bg select-none shrink-0">
              <button 
                onClick={() => setShowBatchModal(false)}
                className="px-5 py-1.5 bg-dark-card hover:bg-dark-cardHover border border-dark-border text-white text-xs font-bold rounded-lg transition-colors"
              >
                关闭窗口
              </button>
            </div>

          </div>
        </div>
      )}

      {/* 5. Character特征资产管理器 Sub-Window Modal matching screenshot */}
      {showCharacterModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[100] select-none">
          {/* Floating Sub-Window Card */}
          <div className="w-[640px] h-[460px] bg-[#1a1b1f] border border-dark-border/80 rounded-xl shadow-[0_20px_50px_rgba(0,0,0,0.7)] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-150">
            
            {/* Titlebar matching native title bar frame */}
            <div className="h-10 bg-[#111214] border-b border-dark-border px-4 flex items-center justify-between shrink-0">
              <div className="flex items-center space-x-2">
                <span className="w-2.5 h-2.5 rounded-full bg-brand animate-pulse" />
                <span className="text-xs font-bold text-dark-text">角色特征资产管理器 (特征垫图与关联中心)</span>
              </div>
              <div className="flex items-center space-x-2">
                <button
                  type="button"
                  onClick={handleCensorAllCharacters}
                  disabled={censorProgress.running}
                  title="自动识别所有角色人脸并在脸上叠加打码符号（覆盖头像，可单独撤销）"
                  className="px-2.5 py-1 rounded-md bg-brand/15 border border-brand/40 text-[11px] font-bold text-brand hover:bg-brand/25 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center space-x-1"
                >
                  {censorProgress.running ? (
                    <>
                      <RefreshCw className="w-3 h-3 animate-spin" />
                      <span>打码中 {censorProgress.current}/{censorProgress.total}</span>
                    </>
                  ) : (
                    <span>一键打码全部</span>
                  )}
                </button>
                <button
                  onClick={() => setShowCharacterModal(false)}
                  className="text-dark-muted hover:text-white text-base hover:bg-white/10 w-6 h-6 rounded flex items-center justify-center transition-colors"
                >
                  ✕
                </button>
              </div>
            </div>

            {/* Main Content Area */}
            <div className="flex-1 flex overflow-hidden">
              
              {/* Left List Pane: All Current Characters */}
              <div className="w-[200px] border-r border-dark-border/40 bg-[#15161a] p-3 flex flex-col justify-between overflow-y-auto no-scrollbar shrink-0">
                <div className="space-y-1.5 flex-1 flex flex-col min-h-0">
                  <div className="text-[10px] text-dark-muted font-bold px-1 uppercase tracking-wider">当前角色资产 ({characterAssets.length})</div>
                  <div className="space-y-1 mt-2 flex-1 overflow-y-auto no-scrollbar">
                    {characterAssets.map((char) => {
                      const isActive = editingCharId === char.id;
                      const charAvatarSrc = displayAvatarUrlForAsset(char);
                      return (
                        <div
                          key={char.id}
                          onClick={() => {
                            setEditingCharId(char.id);
                            setNewCharName(char.name);
                            setNewCharRole(char.role || '');
                            setNewCharAvatar(char.avatar);
                            setNewCharAvatarPath(char.avatarPath || '');
                            setNewCharAvatarOriginal(char.avatarOriginal || '');
                          }}
                          className={`flex items-center space-x-2.5 p-2 rounded-lg cursor-pointer transition-all border ${
                            isActive ? 'bg-[#323338]/30 border-[#10b981]/40 text-brand' : 'hover:bg-[#1c1d22]/40 border-transparent text-dark-text'
                          }`}
                        >
                          <img
                            src={charAvatarSrc}
                            alt={char.name}
                            className="w-7 h-7 rounded-full object-cover border border-dark-border/20 shrink-0"
                            onDoubleClick={(e) => {
                              e.stopPropagation();
                              if (charAvatarSrc) setFullscreenVideo({ src: charAvatarSrc, mediaType: 'image', materialName: char.name, assetType: 'character', assetId: char.id });
                            }}
                          />
                          <div className="flex-1 min-w-0">
                            <div className="text-xs font-bold truncate">{char.name}</div>
                            <div className="text-[9px] text-dark-subtle truncate">{char.role || '无标签'}</div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => {
                    setEditingCharId('new');
                    setNewCharName('');
                    setNewCharRole('主角设定');
                    setNewCharAvatar('https://images.unsplash.com/photo-1578632767115-351597cf2477?auto=format&fit=crop&q=80&w=260');
                    setNewCharAvatarPath('');
                    setNewCharAvatarOriginal('');
                  }}
                  className="w-full py-1.5 rounded-lg bg-dark-card border border-dashed border-dark-border hover:border-brand/40 text-xs font-bold text-dark-muted hover:text-brand transition-colors flex items-center justify-center space-x-1 mt-3 shrink-0"
                >
                  <span>+ 新增角色特征</span>
                </button>
              </div>

              {/* Right Detail Pane: Edit/Create Character */}
              <div className="flex-1 p-5 flex flex-col justify-between bg-[#1e1f24]/30 overflow-y-auto no-scrollbar">
                <div className="space-y-4">
                  <div className="text-[10px] text-dark-muted font-bold uppercase tracking-wider">
                    {editingCharId === 'new' ? '✨ 新增角色特征资产' : '📝 编辑角色特征资产'}
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    {/* Avatar Selector Slot with Upload matching description */}
                    <div className="space-y-1.5 flex flex-col items-center">
                      <label className="text-[10px] text-dark-muted self-start font-bold">角色图片/特征头像</label>
                      <div className="w-32 h-32 relative rounded-xl border border-dashed border-dark-border/80 hover:border-brand/40 bg-dark-input/20 flex flex-col items-center justify-center overflow-hidden cursor-pointer group transition-colors shrink-0">
                        {toDisplayImageUrl(newCharAvatar, newCharAvatarPath) ? (
                          <div className="w-full h-full relative">
                            <img
                              src={toDisplayImageUrl(newCharAvatar, newCharAvatarPath)}
                              alt="upload preview"
                              className="w-full h-full object-cover"
                              onDoubleClick={(e) => {
                                e.stopPropagation();
                                setFullscreenVideo({ src: toDisplayImageUrl(newCharAvatar, newCharAvatarPath), mediaType: 'image', materialName: newCharName, assetType: 'character', assetId: editingCharId });
                              }}
                            />
                            {charGridOverlay && (
                              <div
                                className="absolute inset-0 pointer-events-none"
                                style={{
                                  backgroundImage: `linear-gradient(to right, rgba(255,255,255,0.3) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.3) 1px, transparent 1px)`,
                                  backgroundSize: '10% 10%',
                                }}
                              />
                            )}
                            <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 flex flex-col items-center justify-center space-y-1 text-[9px] text-white transition-opacity">
                              <span>更换本地图片</span>
                              <span className="text-[7px] text-dark-subtle">点击选择文件</span>
                            </div>
                          </div>
                        ) : (
                          <div className="flex flex-col items-center text-center p-2 text-dark-subtle">
                            <Plus className="w-6 h-6 text-dark-muted group-hover:text-brand" />
                            <span className="text-[9px] mt-1">本地图片</span>
                          </div>
                        )}
                        {/* Invisible HTML File input */}
                        <input
                          type="file"
                          accept="image/*"
                          onChange={handleLocalAvatarUpload}
                          onDoubleClick={(e) => { e.stopPropagation(); e.preventDefault(); }}
                          className="absolute inset-0 opacity-0 cursor-pointer z-10"
                        />
                      </div>
                      <div className="text-[8px] text-dark-subtle mt-1 text-center leading-tight">
                        支持 PNG, JPG, WebP 格式<br />点击自动导入本地特征图
                      </div>
                      <div className="flex flex-wrap items-center justify-center gap-1.5 mt-1.5">
                        <button
                          type="button"
                          onClick={() => setCharGridOverlay((v) => !v)}
                          disabled={!newCharAvatar}
                          title="切换 10x10 宫格辅助线"
                          className={`px-2 py-1 rounded-md text-[10px] font-bold transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${charGridOverlay ? 'bg-brand/20 border border-brand/50 text-brand' : 'bg-dark-input border border-dark-border text-dark-text hover:text-white hover:border-brand/40'}`}
                        >
                          宫格
                        </button>
                        <button
                          type="button"
                          onClick={handleCensorCurrentCharacter}
                          disabled={censorProgress.running || !newCharAvatar}
                          title="自动识别人脸并在脸上叠加打码符号"
                          className="px-2 py-1 rounded-md bg-brand/15 border border-brand/40 text-[10px] font-bold text-brand hover:bg-brand/25 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        >
                          {censorProgress.running && censorProgress.total === 1 ? '打码中…' : '自动打码'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setManualCensorOpen(true)}
                          disabled={censorProgress.running || !newCharAvatar}
                          title="手动拖动放置打码符号（自动识别不准时用）"
                          className="px-2 py-1 rounded-md bg-dark-input border border-dark-border text-[10px] font-bold text-dark-text hover:text-white hover:border-brand/40 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        >
                          手动打码
                        </button>
                        <button
                          type="button"
                          onClick={() => setGridMaskOpen(true)}
                          disabled={censorProgress.running || !newCharAvatar}
                          title="用网格方块遮挡面部，可拖动定位、调大小和格数"
                          className="px-2 py-1 rounded-md bg-dark-input border border-dark-border text-[10px] font-bold text-dark-text hover:text-white hover:border-brand/40 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        >
                          网格遮罩
                        </button>
                        {newCharAvatarOriginal && (
                          <button
                            type="button"
                            onClick={handleUndoCensorCurrentCharacter}
                            disabled={censorProgress.running}
                            title="恢复打码前的原图"
                            className="px-2 py-1 rounded-md bg-dark-input border border-dark-border text-[10px] font-bold text-dark-muted hover:text-white disabled:opacity-50 transition-colors"
                          >
                            撤销
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Form inputs */}
                    <div className="space-y-3.5 flex flex-col justify-center">
                      <div className="space-y-1">
                        <label className="text-[10px] text-dark-muted font-bold">角色名称 (@触发名称)</label>
                        <input
                          type="text"
                          value={newCharName}
                          onChange={(e) => setNewCharName(e.target.value)}
                          placeholder="例如: 娘, 爹爹, 林涵"
                          className="w-full bg-[#18191c] border border-dark-border rounded-lg px-2.5 py-1.5 text-xs text-dark-text placeholder-dark-subtle focus:border-brand/50 focus:ring-0 outline-none"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] text-dark-muted font-bold">角色特征标签/设定</label>
                        <input
                          type="text"
                          value={newCharRole}
                          onChange={(e) => setNewCharRole(e.target.value)}
                          placeholder="例如: 主角设定, 爹爹/夏志"
                          className="w-full bg-[#18191c] border border-dark-border rounded-lg px-2.5 py-1.5 text-xs text-dark-text placeholder-dark-subtle focus:border-brand/50 focus:ring-0 outline-none"
                        />
                      </div>
                    </div>
                  </div>
                </div>

                {/* Action buttons */}
                <div className="flex items-center justify-end space-x-2 border-t border-dark-border/20 pt-3 mt-4 shrink-0">
                  {editingCharId !== 'new' && (
                    <button
                      type="button"
                      onClick={handleDeleteCharacter}
                      className="px-3 py-1.5 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 hover:bg-red-500 hover:text-white transition-all text-xs font-bold mr-auto"
                    >
                      删除角色
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setShowCharacterModal(false)}
                    className="px-4 py-1.5 rounded-lg bg-[#222328] border border-dark-border text-xs font-bold text-dark-text hover:bg-[#2d2e33] transition-colors"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={handleSaveCharacter}
                    className="px-4 py-1.5 rounded-lg bg-brand text-xs font-bold text-black hover:bg-brand/90 transition-colors shadow-[0_0_8px_rgba(16,185,129,0.3)]"
                  >
                    保存资产
                  </button>
                </div>

              </div>

            </div>

          </div>
        </div>
      )}

      {/* Scene/Item Asset Manager Modal */}
      {showAssetModal && (() => {
        const isScene = editingAssetType === 'scene';
        const label = isScene ? '场景' : '物品';
        const triggerSym = isScene ? '$' : '#';
        const assets = isScene ? sceneAssets : itemAssets;
        const AssetIcon = isScene ? Mountain : Gamepad2;
        return (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[100] select-none">
          <div className="w-[640px] h-[460px] bg-[#1a1b1f] border border-dark-border/80 rounded-xl shadow-[0_20px_50px_rgba(0,0,0,0.7)] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-150">

            {/* Titlebar */}
            <div className="h-10 bg-[#111214] border-b border-dark-border px-4 flex items-center justify-between shrink-0">
              <div className="flex items-center space-x-2">
                <span className="w-2.5 h-2.5 rounded-full bg-brand animate-pulse" />
                <span className="text-xs font-bold text-dark-text">{label}资产管理器</span>
              </div>
              <button
                onClick={() => setShowAssetModal(false)}
                className="text-dark-muted hover:text-white text-base hover:bg-white/10 w-6 h-6 rounded flex items-center justify-center transition-colors"
              >
                ✕
              </button>
            </div>

            {/* Main Content Area */}
            <div className="flex-1 flex overflow-hidden">

              {/* Left List Pane */}
              <div className="w-[200px] border-r border-dark-border/40 bg-[#15161a] p-3 flex flex-col justify-between overflow-y-auto no-scrollbar shrink-0">
                <div className="space-y-1.5 flex-1 flex flex-col min-h-0">
                  <div className="text-[10px] text-dark-muted font-bold px-1 uppercase tracking-wider">当前{label}资产 ({assets.length})</div>
                  <div className="space-y-1 mt-2 flex-1 overflow-y-auto no-scrollbar">
                    {assets.map((a) => {
                      const isActive = editingAssetId === a.id;
                      const assetAvatarSrc = displayAvatarUrlForAsset(a);
                      return (
                        <div
                          key={a.id}
                          onClick={() => {
                            setEditingAssetId(a.id);
                            setNewAssetName(a.name);
                            setNewAssetAvatar(a.avatar || '');
                            setNewAssetAvatarPath(a.avatarPath || '');
                          }}
                          className={`flex items-center space-x-2.5 p-2 rounded-lg cursor-pointer transition-all border ${
                            isActive ? 'bg-[#323338]/30 border-[#10b981]/40 text-brand' : 'hover:bg-[#1c1d22]/40 border-transparent text-dark-text'
                          }`}
                        >
                          {assetAvatarSrc ? (
                            <img
                              src={assetAvatarSrc}
                              alt={a.name}
                              className="w-7 h-7 rounded-full object-cover border border-dark-border/20 shrink-0"
                              onDoubleClick={(e) => {
                                e.stopPropagation();
                                setFullscreenVideo({ src: assetAvatarSrc, mediaType: 'image', materialName: a.name, assetType: editingAssetType, assetId: a.id });
                              }}
                            />
                          ) : (
                            <span className="w-7 h-7 rounded-full border border-dark-border/20 bg-[#18191c] flex items-center justify-center shrink-0">
                              <AssetIcon className="w-3.5 h-3.5 text-dark-muted" />
                            </span>
                          )}
                          <div className="flex-1 min-w-0">
                            <div className="text-xs font-bold truncate">{a.name}</div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => {
                    setEditingAssetId('new');
                    setNewAssetName('');
                    setNewAssetAvatar('');
                    setNewAssetAvatarPath('');
                  }}
                  className="w-full py-1.5 rounded-lg bg-dark-card border border-dashed border-dark-border hover:border-brand/40 text-xs font-bold text-dark-muted hover:text-brand transition-colors flex items-center justify-center space-x-1 mt-3 shrink-0"
                >
                  <span>+ 新增{label}资产</span>
                </button>
              </div>

              {/* Right Detail Pane */}
              <div className="flex-1 p-5 flex flex-col justify-between bg-[#1e1f24]/30 overflow-y-auto no-scrollbar">
                <div className="space-y-4">
                  <div className="text-[10px] text-dark-muted font-bold uppercase tracking-wider">
                    {editingAssetId === 'new' ? `✨ 新增${label}资产` : `📝 编辑${label}资产`}
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    {/* Image Selector Slot */}
                    <div className="space-y-1.5 flex flex-col items-center">
                      <label className="text-[10px] text-dark-muted self-start font-bold">{label}图片</label>
                      <div className="w-32 h-32 relative rounded-xl border border-dashed border-dark-border/80 hover:border-brand/40 bg-dark-input/20 flex flex-col items-center justify-center overflow-hidden cursor-pointer group transition-colors shrink-0">
                        {toDisplayImageUrl(newAssetAvatar, newAssetAvatarPath) ? (
                          <div className="w-full h-full relative">
                            <img
                              src={toDisplayImageUrl(newAssetAvatar, newAssetAvatarPath)}
                              alt="upload preview"
                              className="w-full h-full object-cover"
                              onDoubleClick={(e) => {
                                e.stopPropagation();
                                setFullscreenVideo({ src: toDisplayImageUrl(newAssetAvatar, newAssetAvatarPath), mediaType: 'image', materialName: newAssetName, assetType: editingAssetType, assetId: editingAssetId });
                              }}
                            />
                            <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 flex flex-col items-center justify-center space-y-1 text-[9px] text-white transition-opacity">
                              <span>更换本地图片</span>
                              <span className="text-[7px] text-dark-subtle">点击选择文件</span>
                            </div>
                          </div>
                        ) : (
                          <div className="flex flex-col items-center text-center p-2 text-dark-subtle">
                            <Plus className="w-6 h-6 text-dark-muted group-hover:text-brand" />
                            <span className="text-[9px] mt-1">本地图片</span>
                          </div>
                        )}
                        <input
                          type="file"
                          accept="image/*"
                          onChange={handleLocalAssetUpload}
                          onDoubleClick={(e) => { e.stopPropagation(); e.preventDefault(); }}
                          className="absolute inset-0 opacity-0 cursor-pointer z-10"
                        />
                      </div>
                      <div className="text-[8px] text-dark-subtle mt-1 text-center leading-tight">
                        支持 PNG, JPG, WebP 格式<br />点击导入本地{label}图片
                      </div>
                    </div>

                    {/* Form inputs */}
                    <div className="space-y-3.5 flex flex-col justify-center">
                      <div className="space-y-1">
                        <label className="text-[10px] text-dark-muted font-bold">{label}名称 ({triggerSym}触发名称)</label>
                        <input
                          type="text"
                          value={newAssetName}
                          onChange={(e) => setNewAssetName(e.target.value)}
                          placeholder={`例如: ${isScene ? '森林, 城堡, 街道' : '宝剑, 药瓶, 信件'}`}
                          className="w-full bg-[#18191c] border border-dark-border rounded-lg px-2.5 py-1.5 text-xs text-dark-text placeholder-dark-subtle focus:border-brand/50 focus:ring-0 outline-none"
                        />
                      </div>
                      <div className="text-[9px] text-dark-subtle leading-relaxed">
                        在描述词中输入 <span className="text-brand font-bold">{triggerSym}</span> 可触发调用该{label}图片作为垫图。
                      </div>
                    </div>
                  </div>
                </div>

                {/* Action buttons */}
                <div className="flex items-center justify-end space-x-2 border-t border-dark-border/20 pt-3 mt-4 shrink-0">
                  {editingAssetId !== 'new' && (
                    <button
                      type="button"
                      onClick={handleDeleteAsset}
                      className="px-3 py-1.5 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 hover:bg-red-500 hover:text-white transition-all text-xs font-bold mr-auto"
                    >
                      删除{label}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setShowAssetModal(false)}
                    className="px-4 py-1.5 rounded-lg bg-[#222328] border border-dark-border text-xs font-bold text-dark-text hover:bg-[#2d2e33] transition-colors"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={handleSaveAsset}
                    className="px-4 py-1.5 rounded-lg bg-brand text-xs font-bold text-black hover:bg-brand/90 transition-colors shadow-[0_0_8px_rgba(16,185,129,0.3)]"
                  >
                    保存资产
                  </button>
                </div>

              </div>

            </div>

          </div>
        </div>
        );
      })()}

      {/* 手动打码弹窗 */}
      <FaceCensorModal
        open={manualCensorOpen}
        src={toDisplayImageUrl(newCharAvatarOriginal || newCharAvatar, newCharAvatarPath)}
        onApply={handleApplyManualCensor}
        onClose={() => setManualCensorOpen(false)}
      />

      {/* 网格遮罩弹窗 */}
      <GridMaskModal
        open={gridMaskOpen}
        src={toDisplayImageUrl(newCharAvatarOriginal || newCharAvatar, newCharAvatarPath)}
        onApply={handleApplyManualCensor}
        onClose={() => setGridMaskOpen(false)}
      />

      {/* Fullscreen Video/Image Preview Modal */}
      {fullscreenVideo && (
        <div 
          className="fixed inset-0 z-[9999] bg-black/90 flex items-center justify-center backdrop-blur-sm"
          onClick={closeFullscreenPreview}
        >
          <button
            onClick={closeFullscreenPreview}
            className="absolute top-4 right-4 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
          {!(fullscreenVideo.mediaType === 'video' || isVideoUrl(fullscreenVideo.src)) && (
            <div className="absolute top-4 right-16 flex items-center space-x-2 flex-wrap justify-end max-w-[40%]">
              <button
                onClick={(e) => { e.stopPropagation(); setImageEditorEnabled((value) => !value); }}
                className={`flex items-center space-x-1.5 px-3 py-2 rounded-full font-bold text-xs transition-colors ${imageEditorEnabled ? 'bg-red-500 hover:bg-red-400 text-white' : 'bg-white/10 hover:bg-white/20 text-white'}`}
                title="在当前页面画线标注"
              >
                <span>{imageEditorEnabled ? '退出编辑' : '编辑画线'}</span>
              </button>
              {!imageEditorEnabled && (
                <button
                  onClick={(e) => { e.stopPropagation(); copyImageToClipboard(fullscreenVideo.src); }}
                  className="flex items-center space-x-1.5 px-3 py-2 rounded-full bg-brand hover:bg-brand-dark text-black font-bold text-xs transition-colors"
                  title="复制图片到剪贴板"
                >
                  <Copy className="w-4 h-4" />
                  <span>复制图片</span>
                </button>
              )}
              {imageEditorEnabled && (
                <>
                  <button
                    onClick={(e) => { e.stopPropagation(); undoImageEditorStroke(); }}
                    className="flex items-center space-x-1.5 px-3 py-2 rounded-full bg-white/10 hover:bg-white/20 text-white font-bold text-xs transition-colors"
                    title="撤销上一笔画线"
                  >
                    <span>撤销</span>
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); resetImageEditorCanvas().catch((err) => alert(`重置失败：${err.message || err}`)); }}
                    className="flex items-center space-x-1.5 px-3 py-2 rounded-full bg-white/10 hover:bg-white/20 text-white font-bold text-xs transition-colors"
                    title="清空所有画线，恢复原图"
                  >
                    <span>清空线条</span>
                  </button>
                </>
              )}
            </div>
          )}
          {fullscreenVideo.src && (fullscreenVideo.mediaType === 'video' || isVideoUrl(fullscreenVideo.src)) && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                const fsMaterial = {
                  thumbnail: fullscreenVideo.src,
                  sourceUrl: fullscreenVideo.src,
                  localPath: localFilePathFromUrlValue(fullscreenVideo.src) || '',
                  remoteUrl: fullscreenVideo.src,
                };
                handleDownloadVideo(fsMaterial, fullscreenVideo.materialName || 'video');
              }}
              className="absolute top-4 right-16 flex items-center space-x-1.5 px-3 py-2 rounded-full bg-brand hover:bg-brand-dark text-black font-bold text-xs transition-colors"
              title="下载视频"
            >
              <Download className="w-4 h-4" />
              <span>下载</span>
            </button>
          )}
          {fullscreenVideo.src && fullscreenVideo.mediaType !== 'video' && !isVideoUrl(fullscreenVideo.src) && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                const fsMaterial = {
                  thumbnail: fullscreenVideo.src,
                  sourceUrl: fullscreenVideo.src,
                  localPath: localFilePathFromUrlValue(fullscreenVideo.src) || '',
                  remoteUrl: fullscreenVideo.src,
                };
                handleDownloadImage(fsMaterial, fullscreenVideo.materialName || 'image');
              }}
              className="absolute top-4 right-16 flex items-center space-x-1.5 px-3 py-2 rounded-full bg-brand hover:bg-brand-dark text-black font-bold text-xs transition-colors"
              title="下载图片"
            >
              <Download className="w-4 h-4" />
              <span>下载</span>
            </button>
          )}
          {imageEditorEnabled && !(fullscreenVideo.mediaType === 'video' || isVideoUrl(fullscreenVideo.src)) && (
            <div className="absolute left-1/2 top-4 -translate-x-1/2 rounded-full border border-white/20 bg-black/70 px-4 py-2 flex items-center space-x-3">
              <div className="flex items-center space-x-1.5">
                {['#ff2f2f', '#ffeb3b', '#10b981', '#3b82f6', '#ffffff', '#000000'].map((c) => (
                  <button
                    key={c}
                    onClick={(e) => { e.stopPropagation(); setImageEditorColor(c); }}
                    className={`w-5 h-5 rounded-full border-2 transition-transform ${imageEditorColor === c ? 'border-white scale-110' : 'border-white/30 hover:border-white/60'}`}
                    style={{ backgroundColor: c }}
                    title={c}
                  />
                ))}
                <input
                  type="color"
                  value={imageEditorColor}
                  onChange={(e) => setImageEditorColor(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  className="w-5 h-5 rounded cursor-pointer border-0 bg-transparent p-0"
                  title="自定义颜色"
                />
              </div>
              <div className="w-px h-5 bg-white/20" />
              <div className="flex items-center space-x-1.5">
                <span className="text-[10px] text-white/70 font-bold">粗细</span>
                <input
                  type="range"
                  min="1"
                  max="20"
                  value={imageEditorLineWidth}
                  onChange={(e) => setImageEditorLineWidth(Number(e.target.value))}
                  onClick={(e) => e.stopPropagation()}
                  className="w-16 h-1 cursor-pointer accent-brand"
                />
                <span className="text-[10px] text-white/70 font-bold w-4">{imageEditorLineWidth}</span>
              </div>
              <div className="w-px h-5 bg-white/20" />
              <div className="flex items-center space-x-1.5">
                <button
                  onClick={(e) => { e.stopPropagation(); setImageEditorShowGrid((v) => !v); }}
                  className={`px-2 py-0.5 rounded-full text-[10px] font-bold transition-colors ${imageEditorShowGrid ? 'bg-brand text-black' : 'bg-white/10 text-white hover:bg-white/20'}`}
                  title="切换九宫格/三分线辅助网格"
                >
                  网格
                </button>
                {imageEditorShowGrid && (
                  <select
                    value={imageEditorGridSize}
                    onChange={(e) => setImageEditorGridSize(Number(e.target.value))}
                    onClick={(e) => e.stopPropagation()}
                    className="bg-white/10 text-white text-[10px] rounded px-1 py-0.5 border-0 outline-none cursor-pointer"
                    title="网格类型"
                  >
                    <option value={3} className="bg-zinc-800">三分线</option>
                    <option value={2} className="bg-zinc-800">二分线</option>
                    <option value={4} className="bg-zinc-800">四分格</option>
                    <option value={6} className="bg-zinc-800">六分格</option>
                  </select>
                )}
              </div>
              <div className="w-px h-5 bg-white/20" />
              <span className="text-[10px] text-white/60 font-bold">左键拖动画线</span>
              <div className="w-px h-5 bg-white/20" />
              <button
                onClick={(e) => { e.stopPropagation(); saveEditedImage(); }}
                disabled={imageEditorSaving}
                className="px-3 py-1 rounded-full bg-brand hover:bg-brand-dark disabled:opacity-60 disabled:cursor-wait text-black text-[10px] font-bold transition-colors"
                title="保存编辑后的图片"
              >
                {imageEditorSaving ? '保存中...' : '保存编辑'}
              </button>
            </div>
          )}
          <div className="max-w-[90vw] max-h-[90vh] flex items-center justify-center" onClick={(e) => e.stopPropagation()}>
            {fullscreenVideo.mediaType === 'video' || isVideoUrl(fullscreenVideo.src) ? (
              <div className="relative flex items-center justify-center">
                {fullscreenLoading && (
                  <div className="absolute inset-0 flex items-center justify-center z-10">
                    <RefreshCw className="w-8 h-8 text-white/70 animate-spin" />
                  </div>
                )}
                <video
                  key={toPlayableUrl(fullscreenVideo.src)}
                  src={toPlayableUrl(fullscreenVideo.src)}
                  className="max-w-full max-h-[85vh] rounded-lg shadow-2xl"
                  controls
                  autoPlay
                  loop
                  preload="auto"
                  onLoadedData={() => setFullscreenLoading(false)}
                  onCanPlay={() => setFullscreenLoading(false)}
                  onError={(event) => { setFullscreenLoading(false); switchVideoToFallback(event, fullscreenVideo.fallbackSrc || '', true); }}
                />
              </div>
            ) : imageEditorEnabled ? (
              <div className="relative inline-block">
                <canvas
                  ref={imageEditorCanvasRef}
                  className="max-w-full max-h-[82vh] rounded-lg shadow-2xl object-contain cursor-crosshair touch-none bg-black"
                  onMouseDown={startImageEditorStroke}
                  onMouseMove={moveImageEditorStroke}
                  onMouseUp={endImageEditorStroke}
                  onMouseLeave={endImageEditorStroke}
                  onTouchStart={startImageEditorStroke}
                  onTouchMove={moveImageEditorStroke}
                  onTouchEnd={endImageEditorStroke}
                />
                {imageEditorShowGrid && (
                  <div
                    className="absolute inset-0 pointer-events-none rounded-lg"
                    style={{
                      backgroundImage: `linear-gradient(to right, rgba(255,255,255,0.35) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.35) 1px, transparent 1px)`,
                      backgroundSize: `${100 / imageEditorGridSize}% ${100 / imageEditorGridSize}%`,
                    }}
                  />
                )}
              </div>
            ) : (
              <img
                src={fullscreenVideo.src}
                alt="preview"
                className="max-w-full max-h-[85vh] rounded-lg shadow-2xl object-contain"
              />
            )}
          </div>
        </div>
      )}

      <ImageMergeModal
        open={mergeModalState.open}
        initialItems={mergeModalState.items}
        title={`合并图片${mergeModalState.rowId ? ` · 第 ${mergeModalState.rowId} 行` : ''}`}
        onClose={() => setMergeModalState({ open: false, rowId: null, items: [] })}
        onApplyAsReference={mergeModalState.rowId ? (filePath) => applyMergedImageToRow(mergeModalState.rowId, filePath) : undefined}
      />

    </div>
  );
}
