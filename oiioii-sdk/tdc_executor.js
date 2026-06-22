/**
 * TDC Executor - 在 jsdom 环境中执行腾讯 tdc.js
 * 
 * 通过模拟浏览器环境让 tdc.js 正常运行，生成 collect 和 eks 参数。
 * 由主程序通过 child_process 调用，通过 stdin/stdout 传递数据。
 */

const { JSDOM } = require('jsdom');
const https = require('https');
const zlib = require('zlib');

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    https.get({
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept-Encoding': 'gzip, deflate'
      }
    }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        let buf = Buffer.concat(chunks);
        const enc = res.headers['content-encoding'];
        try {
          if (enc === 'gzip') buf = zlib.gunzipSync(buf);
          else if (enc === 'deflate') buf = zlib.inflateSync(buf);
          else if (enc === 'br') buf = zlib.brotliDecompressSync(buf);
        } catch (e) { /* not compressed */ }
        resolve(buf.toString('utf-8'));
      });
    }).on('error', reject);
  });
}

/**
 * 生成仿真滑动轨迹 (ease-in-out cubic + 微抖动)
 */
function generateTrajectory(dx, duration) {
  const points = [];
  const sampleInterval = 30;
  const steps = Math.max(10, Math.floor(duration / sampleInterval));

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    // ease-in-out cubic
    let eased;
    if (t < 0.5) {
      eased = 4 * t * t * t;
    } else {
      eased = 1 - Math.pow(-2 * t + 2, 3) / 2;
    }

    let x = Math.round(dx * eased);
    let y = 0;

    // 10%-90% 时间段内添加微抖动
    if (t > 0.1 && t < 0.9) {
      x += Math.round((Math.random() - 0.5) * 2);
      y += Math.round((Math.random() - 0.5) * 2);
    }

    const time = Math.round(duration * t);
    points.push([x, y, time]);
  }

  // 确保最后一个点精确到达目标
  points[points.length - 1] = [dx, 0, duration];

  return points;
}

/**
 * 在 jsdom 中执行 tdc.js 并获取 collect/eks
 */
async function executeTDC(tdcSource, trajectory, sid) {
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
    url: 'https://turing.captcha.qcloud.com/cap_union_new_show',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    pretendToBeVisual: true,
    runScripts: 'dangerously',
    resources: 'usable'
  });

  const { window } = dom;

  // 模拟浏览器环境属性
  Object.defineProperty(window, 'innerWidth', { value: 1536, writable: true });
  Object.defineProperty(window, 'innerHeight', { value: 864, writable: true });
  Object.defineProperty(window, 'outerWidth', { value: 1536, writable: true });
  Object.defineProperty(window, 'outerHeight', { value: 936, writable: true });
  Object.defineProperty(window, 'devicePixelRatio', { value: 1.25, writable: true });

  Object.defineProperty(window.screen, 'width', { value: 1536, writable: true });
  Object.defineProperty(window.screen, 'height', { value: 864, writable: true });
  Object.defineProperty(window.screen, 'availWidth', { value: 1536, writable: true });
  Object.defineProperty(window.screen, 'availHeight', { value: 824, writable: true });
  Object.defineProperty(window.screen, 'colorDepth', { value: 24, writable: true });
  Object.defineProperty(window.screen, 'pixelDepth', { value: 24, writable: true });

  // 模拟 performance.now
  const startTime = Date.now();
  if (!window.performance) {
    window.performance = {};
  }
  window.performance.now = () => Date.now() - startTime;

  // 模拟 canvas (返回空白数据)
  const origCreateElement = window.document.createElement.bind(window.document);
  window.document.createElement = function(tag) {
    const el = origCreateElement(tag);
    if (tag.toLowerCase() === 'canvas') {
      el.getContext = function(type) {
        if (type === '2d') {
          return {
            fillRect: () => {},
            clearRect: () => {},
            getImageData: (x, y, w, h) => ({ data: new Uint8Array(w * h * 4) }),
            putImageData: () => {},
            createImageData: () => [],
            setTransform: () => {},
            drawImage: () => {},
            save: () => {},
            fillText: () => {},
            restore: () => {},
            beginPath: () => {},
            moveTo: () => {},
            lineTo: () => {},
            closePath: () => {},
            stroke: () => {},
            translate: () => {},
            scale: () => {},
            rotate: () => {},
            arc: () => {},
            fill: () => {},
            measureText: () => ({ width: 0 }),
            transform: () => {},
            rect: () => {},
            clip: () => {},
            font: '',
            fillStyle: '',
            strokeStyle: '',
            globalAlpha: 1,
            globalCompositeOperation: 'source-over',
            lineWidth: 1,
            lineCap: 'butt',
            lineJoin: 'miter',
            textAlign: 'start',
            textBaseline: 'alphabetic',
            shadowBlur: 0,
            shadowColor: 'rgba(0, 0, 0, 0)',
            shadowOffsetX: 0,
            shadowOffsetY: 0
          };
        }
        if (type === 'webgl' || type === 'experimental-webgl') {
          return {
            getParameter: (p) => {
              if (p === 7937) return 'WebKit WebGL';
              if (p === 7936) return 'WebKit';
              if (p === 37445) return 'Google Inc. (NVIDIA)';
              if (p === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER Direct3D11 vs_5_0 ps_5_0, D3D11)';
              return null;
            },
            getExtension: () => ({ UNMASKED_VENDOR_WEBGL: 37445, UNMASKED_RENDERER_WEBGL: 37446 }),
            getSupportedExtensions: () => ['WEBGL_debug_renderer_info'],
            createBuffer: () => ({}),
            bindBuffer: () => {},
            bufferData: () => {},
            createProgram: () => ({}),
            createShader: () => ({}),
            shaderSource: () => {},
            compileShader: () => {},
            attachShader: () => {},
            linkProgram: () => {},
            useProgram: () => {},
            getAttribLocation: () => 0,
            enableVertexAttribArray: () => {},
            vertexAttribPointer: () => {},
            drawArrays: () => {},
            canvas: el
          };
        }
        return null;
      };
      el.toDataURL = () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    }
    return el;
  };

  // 注入 tdc.js
  const scriptEl = window.document.createElement('script');
  scriptEl.textContent = tdcSource;
  window.document.head.appendChild(scriptEl);

  // 等待 tdc.js 初始化
  await new Promise(resolve => setTimeout(resolve, 500));

  // 检查 TDC 是否可用
  if (!window.TDC) {
    throw new Error('TDC not initialized after script injection');
  }

  // 设置轨迹数据
  const slideData = {
    data: trajectory,
    type: 'slide'
  };
  window.TDC.setData(slideData);

  // 获取 collect
  const collect = window.TDC.getData(true);

  // 获取 info (包含 eks)
  const info = window.TDC.getInfo();

  // 提取 eks
  let eks = '';
  const eksKeys = Object.keys(window).filter(k => {
    try {
      const v = window[k];
      return typeof v === 'string' && v.length > 100 && v.length < 500 && /^[A-Za-z0-9+/=]+$/.test(v);
    } catch (e) { return false; }
  });
  if (eksKeys.length > 0) {
    eks = window[eksKeys[0]];
  }

  dom.window.close();

  return { collect, eks, info };
}

/**
 * 主入口 - 从 stdin 读取参数，输出结果到 stdout
 * 
 * 输入 JSON: { tdcUrl, trajectory, sid }
 * 或: { tdcSource, trajectory, sid }
 */
async function main() {
  // 从命令行参数或 stdin 读取
  let input;

  if (process.argv[2]) {
    // 从文件读取参数
    const fs = require('fs');
    input = JSON.parse(fs.readFileSync(process.argv[2], 'utf-8'));
  } else {
    // 从 stdin 读取
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    input = JSON.parse(Buffer.concat(chunks).toString());
  }

  const { tdcUrl, tdcSource: inputSource, dx, duration, sid } = input;

  // 获取 tdc.js 源码
  let tdcSource = inputSource;
  if (!tdcSource && tdcUrl) {
    tdcSource = await fetchUrl(tdcUrl);
  }
  if (!tdcSource) {
    throw new Error('No tdc source provided (need tdcUrl or tdcSource)');
  }

  // 生成轨迹
  const slideDuration = duration || (800 + Math.floor(Math.random() * 1200));
  const trajectory = generateTrajectory(dx || 200, slideDuration);

  // 执行 TDC
  const result = await executeTDC(tdcSource, trajectory, sid);

  // 输出结果
  const output = {
    collect: result.collect,
    eks: result.eks,
    info: result.info,
    tlg: slideDuration,
    trajectory
  };

  process.stdout.write(JSON.stringify(output));
}

// 也可以作为模块使用
module.exports = { executeTDC, generateTrajectory, fetchUrl };

if (require.main === module) {
  main().catch(err => {
    process.stderr.write(JSON.stringify({ error: err.message }));
    process.exit(1);
  });
}
