/**
 * NCC (Normalized Cross-Correlation) 模板匹配求解器
 * 
 * 从精灵图裁剪拼图块，在背景图上做 NCC 匹配，找到缺口位置。
 * 两阶段搜索：粗搜 stride=4 + 精搜 ±6px，性能提升 800+ 倍。
 */

const sharp = require('sharp');

class NCCSolver {
  constructor(options = {}) {
    this.ySearchRange = options.ySearchRange || 5;
    this.coarseStride = options.coarseStride || 4;
    this.fineRange = options.fineRange || 6;
  }

  /**
   * 求解滑块验证码
   * @param {Buffer} bgImageBuf - 背景图 PNG buffer
   * @param {Buffer} fgImageBuf - 前景精灵图 PNG buffer (RGBA)
   * @param {Object} pieceElem - 拼图块配置 { sprite_pos, size_2d, init_pos }
   * @returns {{ dx, gapX, gapY, confidence }}
   */
  async solve(bgImageBuf, fgImageBuf, pieceElem) {
    const [spX, spY] = pieceElem.sprite_pos;
    const [pw, ph] = pieceElem.size_2d;
    const [initX, initY] = pieceElem.init_pos;

    // 从精灵图裁剪拼图块 (RGBA)
    const pieceRaw = await sharp(fgImageBuf)
      .extract({ left: spX, top: spY, width: pw, height: ph })
      .raw()
      .toBuffer({ resolveWithObject: true });

    // 背景图 (RGB)
    const bgRaw = await sharp(bgImageBuf)
      .raw()
      .toBuffer({ resolveWithObject: true });

    const bgData = bgRaw.data;
    const bgW = bgRaw.info.width;
    const bgH = bgRaw.info.height;
    const bgCh = bgRaw.info.channels;

    const pieceData = pieceRaw.data;
    const pieceCh = pieceRaw.info.channels; // should be 4 (RGBA)

    // 提取不透明像素的 RGB 值和掩码
    const mask = [];
    const piecePixels = []; // [r, g, b] for each opaque pixel

    for (let py = 0; py < ph; py++) {
      for (let px = 0; px < pw; px++) {
        const idx = (py * pw + px) * pieceCh;
        const alpha = pieceData[idx + 3];
        if (alpha > 128) {
          mask.push({ x: px, y: py });
          piecePixels.push([pieceData[idx], pieceData[idx + 1], pieceData[idx + 2]]);
        }
      }
    }

    if (mask.length < 100) {
      console.log(`[NCC] Warning: only ${mask.length} opaque pixels, may be inaccurate`);
    }

    // 计算模板均值和归一化
    const n = piecePixels.length;
    let sumR = 0, sumG = 0, sumB = 0;
    for (let i = 0; i < n; i++) {
      sumR += piecePixels[i][0];
      sumG += piecePixels[i][1];
      sumB += piecePixels[i][2];
    }
    const meanR = sumR / n, meanG = sumG / n, meanB = sumB / n;

    // piece_centered 和 piece_norm
    let pieceNormSq = 0;
    const pieceCentered = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) {
      const dr = piecePixels[i][0] - meanR;
      const dg = piecePixels[i][1] - meanG;
      const db = piecePixels[i][2] - meanB;
      pieceCentered[i * 3] = dr;
      pieceCentered[i * 3 + 1] = dg;
      pieceCentered[i * 3 + 2] = db;
      pieceNormSq += dr * dr + dg * dg + db * db;
    }
    const pieceNorm = Math.sqrt(pieceNormSq) + 1e-8;

    // NCC 计算函数
    const computeNCC = (bx, by) => {
      let rSumR = 0, rSumG = 0, rSumB = 0;
      for (let i = 0; i < n; i++) {
        const px = mask[i].x + bx;
        const py = mask[i].y + by;
        if (px < 0 || px >= bgW || py < 0 || py >= bgH) return -2;
        const idx = (py * bgW + px) * bgCh;
        rSumR += bgData[idx];
        rSumG += bgData[idx + 1];
        rSumB += bgData[idx + 2];
      }
      const rMeanR = rSumR / n, rMeanG = rSumG / n, rMeanB = rSumB / n;

      let dot = 0, rNormSq = 0;
      for (let i = 0; i < n; i++) {
        const px = mask[i].x + bx;
        const py = mask[i].y + by;
        const idx = (py * bgW + px) * bgCh;
        const dr = bgData[idx] - rMeanR;
        const dg = bgData[idx + 1] - rMeanG;
        const db = bgData[idx + 2] - rMeanB;
        dot += pieceCentered[i * 3] * dr + pieceCentered[i * 3 + 1] * dg + pieceCentered[i * 3 + 2] * db;
        rNormSq += dr * dr + dg * dg + db * db;
      }
      const rNorm = Math.sqrt(rNormSq) + 1e-8;
      return dot / (pieceNorm * rNorm);
    };

    // 阶段一：粗搜 stride=4，在 initY 行扫描
    const xMax = bgW - pw;
    let coarseBestX = 0;
    let coarseBestNCC = -2;

    console.log(`[NCC] Coarse search: x=[0, ${xMax}], stride=${this.coarseStride}, y=${initY}`);

    for (let x = 0; x <= xMax; x += this.coarseStride) {
      const ncc = computeNCC(x, initY);
      if (ncc > coarseBestNCC) {
        coarseBestNCC = ncc;
        coarseBestX = x;
      }
    }

    console.log(`[NCC] Coarse result: x=${coarseBestX}, ncc=${coarseBestNCC.toFixed(4)}`);

    // 阶段二：精搜 ±fineRange px (x), ±ySearchRange (y)
    const fineXMin = Math.max(0, coarseBestX - this.fineRange);
    const fineXMax = Math.min(xMax, coarseBestX + this.fineRange);
    const fineYMin = Math.max(0, initY - this.ySearchRange);
    const fineYMax = Math.min(bgH - ph, initY + this.ySearchRange);

    let bestX = coarseBestX;
    let bestY = initY;
    let bestNCC = coarseBestNCC;

    for (let y = fineYMin; y <= fineYMax; y++) {
      for (let x = fineXMin; x <= fineXMax; x++) {
        const ncc = computeNCC(x, y);
        if (ncc > bestNCC) {
          bestNCC = ncc;
          bestX = x;
          bestY = y;
        }
      }
    }

    const dx = bestX - initX;

    console.log(`[NCC] Fine result: x=${bestX}, y=${bestY}, ncc=${bestNCC.toFixed(4)}, dx=${dx}`);

    return {
      dx,
      gapX: bestX,
      gapY: bestY,
      confidence: bestNCC,
      initX,
      initY
    };
  }
}

module.exports = { NCCSolver };

// CLI 测试
if (require.main === module) {
  const fs = require('fs');
  const bgPath = process.argv[2] || './captcha_bg.png';
  const fgPath = process.argv[3] || './captcha_sprite.png';

  if (!fs.existsSync(bgPath)) {
    console.error(`Background image not found: ${bgPath}`);
    process.exit(1);
  }
  if (!fs.existsSync(fgPath)) {
    console.error(`Sprite image not found: ${fgPath}`);
    process.exit(1);
  }

  const pieceElem = {
    sprite_pos: [10, 20],
    size_2d: [68, 68],
    init_pos: [30, 161]
  };

  // 如果有配置文件则读取
  const configPath = process.argv[4];
  if (configPath && fs.existsSync(configPath)) {
    Object.assign(pieceElem, JSON.parse(fs.readFileSync(configPath, 'utf-8')));
  }

  const solver = new NCCSolver();
  solver.solve(fs.readFileSync(bgPath), fs.readFileSync(fgPath), pieceElem)
    .then(result => {
      console.log('\n=== NCC Solve Result ===');
      console.log(JSON.stringify(result, null, 2));
    })
    .catch(err => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}
