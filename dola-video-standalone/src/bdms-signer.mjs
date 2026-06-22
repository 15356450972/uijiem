// Loads the real bdms-sdk.js in a Node.js VM and uses its bytecode VM
// to generate authentic a_bogus signatures for API requests.
//
// Usage:
//   import { initSigner, signUrl } from './bdms-signer.mjs';
//   await initSigner();                          // doubao (default)
//   await initSigner('', { platform: 'dola' });  // dola
//   const signed = signUrl(url);

import * as fs from 'node:fs';
import * as path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SDK_PATH = path.resolve(__dirname, '..', 'sdk', 'bdms-sdk.js');

const PLATFORM_CONFIG = {
  doubao: {
    aid: 497858,
    domain: 'www.doubao.com',
    origin: 'https://www.doubao.com',
    referer: 'https://www.doubao.com/',
    href: 'https://www.doubao.com/chat/',
  },
  dola: {
    aid: 495671,
    domain: 'www.dola.com',
    origin: 'https://www.dola.com',
    referer: 'https://www.dola.com/',
    href: 'https://www.dola.com/chat/',
  },
};

let sandbox = null;
let initialized = false;
let _latestMsToken = null;
let _platform = 'doubao';

/**
 * Returns the latest msToken obtained from the mssdk endpoint,
 * or null if none has been received yet.
 */
export function getLatestMsToken() { return _latestMsToken; }

/** Returns the current platform name ('doubao' or 'dola'). */
export function getPlatform() { return _platform; }

/** Resets the signer so it can be re-initialized with a different platform. */
export function resetSigner() {
  sandbox = null;
  initialized = false;
  _latestMsToken = null;
  _platform = 'doubao';
}

export async function initSigner(cookie = '', options = {}) {
  if (initialized) return;

  _platform = options.platform || 'doubao';
  const cfg = PLATFORM_CONFIG[_platform];
  if (!cfg) throw new Error(`bdms-signer: unknown platform "${_platform}"`);

  const code = fs.readFileSync(SDK_PATH, 'utf8');

  const ua = options.userAgent || process.env.DOUBAO_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';
  const platformName = options.platformName || (/Macintosh|Mac OS X/i.test(ua) ? 'MacIntel' : 'Win32');

  const navigator = {
    userAgent: ua,
    language: 'zh-CN', languages: ['zh-CN', 'zh', 'en'], platform: platformName,
    cookieEnabled: true, doNotTrack: null, hardwareConcurrency: 16,
    deviceMemory: 8, vendor: 'Google Inc.', webdriver: false,
    maxTouchPoints: 0,
    plugins: { length: 5, item: () => null, namedItem: () => null, refresh: () => {} },
    mimeTypes: { length: 2, item: () => null, namedItem: () => null },
    sendBeacon: () => true,
    connection: { effectiveType: '4g', downlink: 10, rtt: 50, saveData: false },
    getBattery: () => Promise.resolve({ charging: true, chargingTime: 0, dischargingTime: Infinity, level: 1 }),
  };

  const screen = { width: 1536, height: 864, availWidth: 1536, availHeight: 824, colorDepth: 24, pixelDepth: 24 };
  const location = {
    href: cfg.href, protocol: 'https:',
    host: cfg.domain, hostname: cfg.domain,
    origin: cfg.origin, pathname: '/chat/', search: '', hash: '',
    toString: () => cfg.href,
  };
  const canvasCtx = {
    fillStyle: '', font: '', textBaseline: '',
    fillRect: () => {}, fillText: () => {},
    measureText: () => ({ width: 10 }),
    arc: () => {}, fill: () => {}, beginPath: () => {},
    closePath: () => {}, stroke: () => {},
    getImageData: () => ({ data: new Uint8Array(100) }),
    toDataURL: () => 'data:image/png;base64,',
    canvas: { width: 200, height: 200, toDataURL: () => 'data:image/png;base64,' },
    clearRect: () => {},
    createRadialGradient: () => ({ addColorStop: () => {} }),
    rect: () => {},
    isPointInPath: () => false,
  };
  const documentStub = {
    cookie: cookie,
    referrer: '',
    visibilityState: 'visible',
    hidden: false,
    hasFocus: () => true,
    documentElement: { clientWidth: 1536, clientHeight: 742, style: {} },
    body: { clientWidth: 1536, clientHeight: 742 },
    createElement: (tag) => {
      if (tag === 'canvas') return {
        getContext: () => canvasCtx,
        width: 200, height: 200,
        toDataURL: () => 'data:image/png;base64,',
        style: {},
      };
      return { style: {}, setAttribute: () => {}, appendChild: () => {}, innerHTML: '', getContext: () => null, src: '' };
    },
    addEventListener: () => {}, removeEventListener: () => {},
    querySelector: () => null, querySelectorAll: () => [],
    getElementById: () => null, getElementsByTagName: () => [],
    head: { appendChild: () => {} },
    createTreeWalker: () => ({ nextNode: () => null }),
  };

  const win = {};
  win.window = win; win.self = win; win.globalThis = win; win.top = win;
  win.parent = win; win.frames = win;
  win.navigator = navigator; win.screen = screen;
  win.location = location; win.document = documentStub;
  win.history = { length: 1, pushState: () => {}, replaceState: () => {} };
  const perfStart = Date.now() - 5000;
  win.performance = {
    now: () => Date.now() - perfStart,
    timeOrigin: perfStart,
    timing: { navigationStart: perfStart },
    getEntriesByType: () => [],
    mark: () => {},
  };
  win.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {}, length: 0 };
  win.sessionStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {}, length: 0 };
  win.addEventListener = () => {}; win.removeEventListener = () => {};
  win.setTimeout = setTimeout; win.clearTimeout = clearTimeout;
  win.setInterval = setInterval; win.clearInterval = clearInterval;
  win.requestAnimationFrame = (cb) => setTimeout(cb, 16);
  win.cancelAnimationFrame = clearTimeout;
  win.console = console;
  win.crypto = globalThis.crypto;
  win.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
  win.atob = (s) => Buffer.from(s, 'base64').toString('binary');
  win.TextEncoder = TextEncoder; win.TextDecoder = TextDecoder;
  win.Uint8Array = Uint8Array; win.ArrayBuffer = ArrayBuffer;
  win.DataView = DataView; win.Int32Array = Int32Array;
  win.Float64Array = Float64Array; win.Uint32Array = Uint32Array;
  win.Int8Array = Int8Array; win.Uint8ClampedArray = Uint8ClampedArray;
  win.Int16Array = Int16Array; win.Uint16Array = Uint16Array;
  win.Float32Array = Float32Array; win.BigInt64Array = BigInt64Array;
  win.BigUint64Array = BigUint64Array;
  win.Map = Map; win.Set = Set; win.WeakMap = WeakMap; win.WeakSet = WeakSet;
  win.WeakRef = WeakRef;
  win.Promise = Promise; win.Symbol = Symbol;
  win.Proxy = Proxy; win.Reflect = Reflect;
  win.JSON = JSON; win.Math = Math; win.Date = Date;
  win.parseInt = parseInt; win.parseFloat = parseFloat;
  win.isNaN = isNaN; win.isFinite = isFinite;
  win.encodeURIComponent = encodeURIComponent; win.decodeURIComponent = decodeURIComponent;
  win.encodeURI = encodeURI; win.decodeURI = decodeURI;
  win.Object = Object; win.Array = Array; win.String = String;
  win.Number = Number; win.Boolean = Boolean; win.RegExp = RegExp;
  win.Error = Error; win.TypeError = TypeError; win.RangeError = RangeError;
  win.SyntaxError = SyntaxError; win.ReferenceError = ReferenceError;
  win.URIError = URIError; win.EvalError = EvalError;
  win.Function = Function; win.eval = eval;
  win.URL = URL; win.URLSearchParams = URLSearchParams;
  win.Headers = Headers; win.Request = Request; win.Response = Response;
  win.Blob = Blob; win.File = File;
  win.FileReader = class FileReader { readAsDataURL() {} readAsText() {} addEventListener() {} };
  win.FormData = FormData; win.AbortController = AbortController;
  win.AbortSignal = AbortSignal;
  win.JS_MD5_NO_NODE_JS = true;
  win.JS_MD5_NO_COMMON_JS = true;
  win.require = () => { throw new Error('no require in this VM'); };
  win.module = undefined; win.exports = undefined;
  win.process = process;
  win.Image = function() { this.src = ''; };
  win.MutationObserver = class { observe() {} disconnect() {} };
  win.IntersectionObserver = class { observe() {} disconnect() {} };
  win.ResizeObserver = class { observe() {} disconnect() {} };
  win.getComputedStyle = () => new Proxy({}, { get: () => '' });
  win.matchMedia = () => ({ matches: false, addListener: () => {}, removeListener: () => {} });
  win.innerWidth = 1536; win.innerHeight = 742;
  win.outerWidth = 1536; win.outerHeight = 864;
  win.devicePixelRatio = 1;
  win.chrome = { runtime: {} };
  win.Intl = Intl;
  win.queueMicrotask = queueMicrotask;
  win.structuredClone = structuredClone;

  // Smart fetch stub: makes REAL requests to mssdk.bytedance.com (needed for
  // msToken acquisition), stubs everything else.
  const realFetch = globalThis.fetch;
  const nativeFetch = (url, init) => {
    const urlStr = typeof url === 'string' ? url : (url instanceof Request ? url.url : String(url));
    if (urlStr.includes('mssdk.bytedance.com')) {
      return realFetch(urlStr, {
        method: init?.method || 'POST',
        headers: {
          'content-type': init?.headers?.['Content-Type'] || init?.headers?.['content-type'] || 'text/plain;charset=UTF-8',
          'user-agent': navigator.userAgent,
          'origin': cfg.origin,
          'referer': cfg.referer,
        },
        body: init?.body,
      }).then(res => {
        const ms = res.headers.get('x-ms-token');
        if (ms) _latestMsToken = ms;
        return res;
      });
    }
    return Promise.resolve(new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
  };
  win.fetch = nativeFetch;

  win.XMLHttpRequest = function() {
    this.open = () => {}; this.send = () => {};
    this.setRequestHeader = () => {};
    this.addEventListener = () => {};
    this.readyState = 4; this.status = 200;
    this.responseText = ''; this.response = '';
  };

  // Minimal webpack chunk loader stubs
  const outerModules = {
    288976: (mod) => { mod.exports = { default: (s) => s, filterXss: (s) => s }; },
    515122: (mod) => { mod.exports = process; },
  };
  const outerCache = {};
  function outerRequire(id) {
    if (outerCache[id]) return outerCache[id].exports;
    const mod = outerCache[id] = { exports: {} };
    const fn = outerModules[id];
    if (!fn) throw new Error(`outer require: unknown id ${id}`);
    fn(mod, mod.exports, outerRequire);
    return mod.exports;
  }
  outerRequire.r = (exports) => {
    Object.defineProperty(exports, '__esModule', { value: true });
  };
  outerRequire.d = (exports, definition) => {
    for (const key in definition) {
      if (Object.prototype.hasOwnProperty.call(definition, key) && !Object.prototype.hasOwnProperty.call(exports, key)) {
        Object.defineProperty(exports, key, { enumerable: true, get: definition[key] });
      }
    }
  };

  const loaded = {
    push: ([names, modules, runtime]) => {
      Object.assign(outerModules, modules);
      if (runtime) runtime(outerRequire);
    },
  };
  win.__LOADABLE_LOADED_CHUNKS__ = loaded;

  sandbox = vm.createContext(win);
  vm.runInContext(code, sandbox, { filename: 'bdms-sdk.js', timeout: 15000 });

  // Bootstrap the bdms module
  const chunkEntry = outerModules[341690];
  if (chunkEntry) {
    const m = { exports: {} };
    chunkEntry(m, m.exports, outerRequire);
  }

  if (!win.bdms?.init) {
    throw new Error('bdms-signer: bdms.init not found after loading SDK');
  }

  // Initialize with the same config the browser uses (aid varies by platform)
  win.bdms.init({
    aid: cfg.aid,
    pageId: 26930,
    paths: {
      include: ["/alice", "/samantha", "/passport", "/chat/completion", "/chat/async/chunk_stream"],
      exclude: [
        "/samantha/notice/info", "/samantha/user/preference/get",
        "/samantha/user/ab/get", "/samantha/plugin/recommend/webtodesktop",
        "/samantha/guidance/get_task", "/samantha/guidance/draw_result",
      ],
    },
    ic: 13,
    ddrt: 13,
  });

  // Install a signing helper into the VM context that captures the a_bogus
  // value by intercepting URLSearchParams.append inside the VM
  vm.runInContext(`
    globalThis.__signUrlHelper = function(urlStr, method, body) {
      var captured = null;
      var origAppend = URLSearchParams.prototype.append;
      URLSearchParams.prototype.append = function(name, value) {
        if (name === 'a_bogus') captured = value;
        return origAppend.call(this, name, value);
      };
      try {
        fetch(urlStr, {
          method: method || 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: body || '{}',
        });
      } catch(e) {}
      URLSearchParams.prototype.append = origAppend;
      return captured;
    };
  `, sandbox);

  initialized = true;
}

/**
 * Generate an a_bogus value for a given URL by running it through the
 * bdms-sdk's bytecode VM inside the Node VM context.
 * Returns just the a_bogus string, or null if the URL doesn't match
 * the configured paths.
 */
export function generateABogus(urlStr, method = 'POST', body = '{}') {
  if (!initialized) throw new Error('bdms-signer: call initSigner() first');
  return vm.runInContext(
    `globalThis.__signUrlHelper(${JSON.stringify(urlStr)}, ${JSON.stringify(method)}, ${JSON.stringify(body)})`,
    sandbox,
    { timeout: 10000 }
  );
}

/**
 * Takes a full URL string and returns it with a_bogus appended.
 * If the URL's path doesn't match the SDK's include list, returns
 * the original URL unchanged.
 */
export function addABogus(urlStr, method = 'POST', body = '{}') {
  const aBogus = generateABogus(urlStr, method, body);
  if (!aBogus) return urlStr;
  const sep = urlStr.includes('?') ? '&' : '?';
  return `${urlStr}${sep}a_bogus=${encodeURIComponent(aBogus)}`;
}
