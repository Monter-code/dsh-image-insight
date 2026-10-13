/**
 * dsh-image-insight —— 本地感知层（sharp）
 *
 * 为什么要有这一层？“识别要准确”不只是模型的事：
 *  - 送进去的是被旋转摆正、合理缩放、且**已确认可解码**的图，模型才不会看歪、看糊；
 *  - 先算好主色/清晰度/构图/指纹这些客观量，模型只负责语义，二者互补可交叉印证；
 *  - 出网之前就发现“太小/太糊/全黑”等根本性缺陷，能直接给出比模型更可靠的结论。
 *
 * 全部计算在此进程内完成（sharp 走 libvips），单张图通常 5–50ms。
 * sharp 采用惰性 import：插件启动不加载原生库，首次真正要用时才付加载成本。
 */

import { createHash } from 'node:crypto';
import { loadDependency } from './deps.mjs';

let sharpModule;

async function loadSharp() {
  if (!sharpModule) sharpModule = await loadDependency('sharp');
  return sharpModule;
}

/** 感知哈希统一用 64bit 表示成 16 位十六进制字符串。 */
function toHex64(bits) {
  let value = 0n;
  for (let index = 0; index < 64; index += 1) {
    value = (value << 1n) | (bits[index] ? 1n : 0n);
  }
  return value.toString(16).padStart(16, '0');
}

/** 差异哈希 dHash：缩放 (w+1)×h 灰度后比较相邻像素亮度，对缩放/压缩极稳。 */
async function computeDhash(sharp, input, size = 8) {
  const { data } = await sharp(input)
    .rotate()
    .resize(size + 1, size, { fit: 'fill', kernel: 'lanczos3' })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const bits = new Array(64).fill(0);
  let cursor = 0;
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      const left = data[row * (size + 1) + column];
      const right = data[row * (size + 1) + column + 1];
      bits[cursor] = left > right ? 1 : 0;
      cursor += 1;
    }
  }
  return toHex64(bits);
}

/** 均值哈希 aHash：与 dHash 互补（aHash 抗噪声，dHash 抗形变）。 */
async function computeAhash(sharp, input, size = 8) {
  const { data } = await sharp(input)
    .rotate()
    .resize(size, size, { fit: 'fill', kernel: 'lanczos3' })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let sum = 0;
  for (const value of data) sum += value;
  const mean = sum / (size * size);
  const bits = new Array(64).fill(0);
  for (let index = 0; index < size * size; index += 1) bits[index] = data[index] > mean ? 1 : 0;
  return toHex64(bits);
}

/** 全图均值/直方图：用于曝光、对比度、纯色图判定。 */
async function computeTone(sharp, input) {
  const { data, info } = await sharp(input)
    .rotate()
    .resize(256, 256, { fit: 'inside', withoutEnlargement: true })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const total = data.length || 1;
  const histogram = new Array(256).fill(0);
  let sum = 0;
  for (const value of data) {
    histogram[value] += 1;
    sum += value;
  }
  const mean = sum / total;
  let variance = 0;
  for (let index = 0; index < 256; index += 1) {
    variance += histogram[index] * (index - mean) ** 2;
  }
  const stdDev = Math.sqrt(variance / total);
  const clippedLow = (histogram.slice(0, 4).reduce((a, b) => a + b, 0) / total) * 100;
  const clippedHigh = (histogram.slice(252).reduce((a, b) => a + b, 0) / total) * 100;
  return {
    mean: Number(mean.toFixed(1)),
    stdDev: Number(stdDev.toFixed(1)),
    clippedLowPct: Number(clippedLow.toFixed(2)),
    clippedHighPct: Number(clippedHigh.toFixed(2)),
    sampledWidth: info.width,
    sampledHeight: info.height,
  };
}

/**
 * 清晰度：拉普拉斯方差法（工业界通用的对焦度量）。
 * 阈值分档只做“够不够给模型看”的判断，不臆断摄影意图。
 */
async function computeSharpness(sharp, input) {
  const width = 512;
  const { data, info } = await sharp(input)
    .rotate()
    .resize(width, null, { fit: 'inside', withoutEnlargement: true })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  if (w < 3 || h < 3) return { laplacianVariance: 0, verdict: 'too-small' };
  let sum = 0;
  let sumSquares = 0;
  let count = 0;
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const center = data[y * w + x];
      const laplacian =
        data[(y - 1) * w + x] + data[(y + 1) * w + x] + data[y * w + x - 1] + data[y * w + x + 1] - 4 * center;
      sum += laplacian;
      sumSquares += laplacian * laplacian;
      count += 1;
    }
  }
  const mean = count ? sum / count : 0;
  const variance = count ? sumSquares / count - mean * mean : 0;
  const laplacianVariance = Math.max(0, variance);
  const verdict =
    laplacianVariance < 15 ? 'blurry' : laplacianVariance < 60 ? 'soft' : laplacianVariance < 600 ? 'normal' : 'sharp';
  return { laplacianVariance: Number(laplacianVariance.toFixed(1)), verdict };
}

/** 主色与配色：k-means 太重，改用 4bit/通道直方图峰值 + 饱和度统计，快且稳。 */
async function computeColors(sharp, input) {
  const { data, info } = await sharp(input)
    .rotate()
    .resize(128, 128, { fit: 'inside', withoutEnlargement: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const buckets = new Map();
  let colourful = 0;
  let greyish = 0;
  let totalPixels = 0;
  const channels = info.channels || 3;
  for (let index = 0; index + channels <= data.length; index += channels) {
    const r = data[index];
    const g = data[index + 1];
    const b = data[index + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const saturation = max === 0 ? 0 : (max - min) / max;
    if (saturation > 0.25 && max > 40) colourful += 1;
    else if (saturation < 0.12) greyish += 1;
    totalPixels += 1;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bucket = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
    bucket.count += 1;
    bucket.r += r;
    bucket.g += g;
    bucket.b += b;
    buckets.set(key, bucket);
  }
  const top = [...buckets.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .map((bucket) => {
      const r = Math.round(bucket.r / bucket.count);
      const g = Math.round(bucket.g / bucket.count);
      const b = Math.round(bucket.b / bucket.count);
      return {
        hex: `#${[r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('')}`,
        sharePct: Number(((bucket.count / Math.max(1, totalPixels)) * 100).toFixed(1)),
        rgb: [r, g, b],
      };
    });
  return {
    dominant: top,
    colourfulRatio: Number((colourful / Math.max(1, totalPixels)).toFixed(3)),
    greyscaleRatio: Number((greyish / Math.max(1, totalPixels)).toFixed(3)),
    isLikelyGrey: greyish / Math.max(1, totalPixels) > 0.85,
    isLikelyMonochrome: top.length > 0 && top[0].sharePct > 90,
  };
}

/**
 * 近似连通域计数：在 256 宽的饱和度/亮度显著掩膜上做连通域标记。
 * 明确定位为“候选区域数”而非“物体数”——所以调用方必须把它当提示而非事实。
 */
async function computeRegions(sharp, input) {
  const width = 256;
  const { data, info } = await sharp(input)
    .rotate()
    .resize(width, null, { fit: 'inside', withoutEnlargement: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const channels = info.channels || 3;
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const offset = (y * w + x) * channels;
      const r = data[offset];
      const g = data[offset + 1];
      const b = data[offset + 2];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const saturation = max === 0 ? 0 : (max - min) / max;
      const bright = (r + g + b) / 3;
      mask[y * w + x] = (bright > 55 && saturation > 0.22) || (bright < 26 && saturation > 0.15) ? 1 : 0;
    }
  }
  // 3x3 腐蚀一次，去掉噪点，避免把颗粒纹理算成区域。
  const eroded = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      let keep = 1;
      for (let dy = -1; dy <= 1 && keep; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (!mask[(y + dy) * w + (x + dx)]) {
            keep = 0;
            break;
          }
        }
      }
      eroded[y * w + x] = keep;
    }
  }
  const visited = new Uint8Array(w * h);
  const regions = [];
  const queue = new Int32Array(w * h).fill(-1);
  const minArea = Math.max(24, Math.round(w * h * 0.0015));
  for (let start = 0; start < w * h; start += 1) {
    if (!eroded[start] || visited[start]) continue;
    let head = 0;
    let tail = 0;
    queue[tail] = start;
    tail += 1;
    visited[start] = 1;
    let area = 0;
    let minX = w;
    let minY = h;
    let maxX = 0;
    let maxY = 0;
    while (head < tail) {
      const current = queue[head];
      head += 1;
      const cx = current % w;
      const cy = (current - cx) / w;
      area += 1;
      if (cx < minX) minX = cx;
      if (cy < minY) minY = cy;
      if (cx > maxX) maxX = cx;
      if (cy > maxY) maxY = cy;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const neighbour = ny * w + nx;
          if (!eroded[neighbour] || visited[neighbour]) continue;
          visited[neighbour] = 1;
          queue[tail] = neighbour;
          tail += 1;
        }
      }
    }
    if (area >= minArea) {
      regions.push({
        areaPx: area,
        bboxPx: [minX, minY, maxX - minX + 1, maxY - minY + 1],
        bboxPct: [
          Number(((minX / w) * 100).toFixed(1)),
          Number(((minY / h) * 100).toFixed(1)),
          Number((((maxX - minX + 1) / w) * 100).toFixed(1)),
          Number((((maxY - minY + 1) / h) * 100).toFixed(1)),
        ],
      });
    }
  }
  regions.sort((a, b) => b.areaPx - a.areaPx);
  return {
    candidateRegions: regions.length,
    coveragePct: Number(((regions.reduce((sum, item) => sum + item.areaPx, 0) / (w * h)) * 100).toFixed(1)),
    topRegions: regions.slice(0, 8),
    note: '本地连通域统计仅供参考，物体语义请以云端的 objects 字段为准',
  };
}

/** 边缘密度：机器生成的界面图/表格图通常极高，自然照片适中，可用于预判图片类型。 */
async function computeEdgeDensity(sharp, input) {
  const width = 320;
  const { data, info } = await sharp(input)
    .rotate()
    .resize(width, null, { fit: 'inside', withoutEnlargement: true })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  let edges = 0;
  let count = 0;
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const gx = data[y * w + x + 1] - data[y * w + x - 1];
      const gy = data[(y + 1) * w + x] - data[(y - 1) * w + x];
      if (Math.abs(gx) + Math.abs(gy) > 80) edges += 1;
      count += 1;
    }
  }
  return Number(((edges / Math.max(1, count)) * 100).toFixed(2));
}

/** 综合质量评分（0–100）与送模型前的建议，直接回答“这张图能不能被准确识别”。 */
function gradeQuality({ width, height, sharpness, tone }) {
  const notes = [];
  let score = 100;
  if (Math.min(width, height) < 64) {
    score -= 45;
    notes.push('分辨率过低（最短边 < 64px），小字与细节不可恢复');
  } else if (Math.min(width, height) < 200) {
    score -= 18;
    notes.push('分辨率偏低，细小文字可能无法辨认');
  }
  if (sharpness.verdict === 'blurry') {
    score -= 35;
    notes.push('模糊（拉普拉斯方差很低），建议重拍或寻找原图');
  } else if (sharpness.verdict === 'soft') {
    score -= 12;
    notes.push('略软焦，细节置信度会下降');
  }
  const clipped = tone.clippedLowPct + tone.clippedHighPct;
  if (clipped > 25) {
    score -= 20;
    notes.push(`曝光严重（过暗/过曝像素 ${clipped.toFixed(1)}%），文本或暗部可能丢失`);
  } else if (clipped > 10) {
    score -= 8;
    notes.push(`局部过曝或欠曝（${clipped.toFixed(1)}%）`);
  }
  if (tone.stdDev < 12) {
    score -= 20;
    notes.push('对比度极低（近似纯色或雾化），几乎无可识别内容');
  }
  score = Math.max(0, Math.min(100, Math.round(score)));
  const verdict = score >= 85 ? 'good' : score >= 65 ? 'fair' : score >= 40 ? 'poor' : 'unusable';
  return { score, verdict, notes };
}

/**
 * 单张图的完整本地分析。
 * @param {Buffer|string} input 图片字节或绝对路径
 * @param {Buffer} [bytes] 当 input 为路径时可选地传入已读字节（用于指纹）
 */
export async function analyzeLocal(input, bytes) {
  const sharp = await loadSharp();
  const pipeline = sharp(input, { failOn: 'none' });
  const metadata = await pipeline.metadata();

  const rawBytes = bytes ?? (Buffer.isBuffer(input) ? input : undefined);
  const sha256 = rawBytes ? createHash('sha256').update(rawBytes).digest('hex') : undefined;
  const [dhash, ahash, tone, sharpness, colors, regions, edgeDensity] = await Promise.all([
    computeDhash(sharp, input),
    computeAhash(sharp, input),
    computeTone(sharp, input),
    computeSharpness(sharp, input),
    computeColors(sharp, input),
    computeRegions(sharp, input),
    computeEdgeDensity(sharp, input),
  ]);

  const width = metadata.width ?? tone.sampledWidth;
  const height = metadata.height ?? tone.sampledHeight;
  const orientation = metadata.orientation ?? 1;
  const quality = gradeQuality({ width, height, sharpness, tone });

  // 图片类型预判：给云端提示词提供上下文，能显著提升“界面图/截图/文档扫描件”的识别准确率。
  const likelyKind =
    edgeDensity > 12 && colors.colourfulRatio < 0.2
      ? 'ui-or-document'
      : edgeDensity > 8
        ? 'mixed'
        : 'photo';

  return {
    bytes: rawBytes?.length,
    mediaType: metadata.format ? `image/${metadata.format}` : undefined,
    width,
    height,
    aspectRatio: width && height ? Number((width / height).toFixed(4)) : undefined,
    orientation,
    orientationApplied: orientation !== 1,
    hasAlpha: Boolean(metadata.hasAlpha),
    animated: (metadata.pages ?? 1) > 1,
    space: metadata.space,
    isAnimatedGif: metadata.format === 'gif' && (metadata.pages ?? 1) > 1,
    sha256,
    fingerprints: { dhash, ahash },
    tone,
    sharpness,
    colors,
    layout: {
      edgeDensityPct: edgeDensity,
      likelyKind,
      candidateRegions: regions.candidateRegions,
      regionCoveragePct: regions.coveragePct,
      topRegions: regions.topRegions,
    },
    quality,
  };
}

/**
 * 生成送进视觉模型的 PNG 字节：摆正方向、限制长边、JPEG/PNG 归一。
 * 这是“准确”与“迅速”的共同前提——既保证模型看到正确方向与足够细节，
 * 又避免把 8000px 原图整块塞进请求导致高延迟。
 * @returns {Promise<{ data: Buffer, mediaType: string, width: number, height: number, scaled: boolean, sourceWidth: number, sourceHeight: number }>}
 */
export async function prepareForVision(input, options = {}) {
  const sharp = await loadSharp();
  const maxEdge = options.maxEdge ?? 1536;
  const metadata = await sharp(input, { failOn: 'none' }).metadata();
  const sourceWidth = metadata.width ?? 0;
  const sourceHeight = metadata.height ?? 0;
  const pages = metadata.pages ?? 1;

  let pipeline = sharp(input, { failOn: 'none', animated: false });
  if (pages > 1) pipeline = pipeline.pages(0); // 动图只取首帧：语义识别不需要全部帧
  pipeline = pipeline.rotate();

  const needsScale = Math.max(sourceWidth, sourceHeight) > maxEdge;
  if (needsScale) pipeline = pipeline.resize(maxEdge, maxEdge, { fit: 'inside', withoutEnlargement: true });

  // 有 alpha 的合成到白底，避免透明区在部分上游被渲染成黑色干扰识别。
  if (metadata.hasAlpha) pipeline = pipeline.flatten({ background: '#ffffff' });

  const hasTransparency = Boolean(metadata.hasAlpha);
  const encode = hasTransparency
    ? pipeline.png({ compressionLevel: 9, palette: false })
    : pipeline.jpeg({ quality: 92, mozjpeg: true, chromaSubsampling: '4:4:4' });
  const { data, info } = await encode.toBuffer({ resolveWithObject: true });

  return {
    data,
    mediaType: hasTransparency ? 'image/png' : 'image/jpeg',
    width: info.width,
    height: info.height,
    scaled: needsScale,
    sourceWidth,
    sourceHeight,
    firstFrameOnly: pages > 1,
  };
}

/** 读取本地文件为 Buffer（工具参数走 path 时使用）。 */
export async function readImageFile(path) {
  const { readFile } = await import('node:fs/promises');
  return readFile(path);
}
