// 位图导入：颜色聚类 → 分区掩膜 → 轮廓追踪 → 多边形分区

import type { Region, Vec2 } from './types';
import { uid } from './types';
import { douglasPeucker, ensureCCW, signedArea, pointInPolygon } from './geometry';
import { nearestThread } from './threadlib';

export interface TraceOptions {
  colors: number;   // 聚类颜色数
  widthMm: number;  // 成品宽度（mm），高度按比例
  minAreaPx: number; // 忽略小色块
}

export interface TraceResult {
  regions: Region[];
  widthMm: number;
  heightMm: number;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 简单 k-means 颜色聚类，返回每像素簇号与簇中心 */
function quantize(data: Uint8ClampedArray, pixelCount: number, k: number): { labels: Uint8Array; centers: [number, number, number][] } {
  const rand = mulberry32(42);
  const step = Math.max(1, Math.floor(pixelCount / 8000));
  const sampleIdx: number[] = [];
  for (let i = 0; i < pixelCount; i += step) sampleIdx.push(i);

  const centers: [number, number, number][] = [];
  // k-means++ 简化版：第一个随机，其余选离已有中心最远的
  const first = sampleIdx[Math.floor(rand() * sampleIdx.length)];
  centers.push([data[first * 4], data[first * 4 + 1], data[first * 4 + 2]]);
  while (centers.length < k) {
    let bestIdx = sampleIdx[0];
    let bestD = -1;
    for (const i of sampleIdx) {
      const r = data[i * 4];
      const g = data[i * 4 + 1];
      const b = data[i * 4 + 2];
      let dmin = Infinity;
      for (const c of centers) {
        const d = (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2;
        if (d < dmin) dmin = d;
      }
      if (dmin > bestD) {
        bestD = dmin;
        bestIdx = i;
      }
    }
    centers.push([data[bestIdx * 4], data[bestIdx * 4 + 1], data[bestIdx * 4 + 2]]);
  }

  const labels = new Uint8Array(pixelCount);
  for (let iter = 0; iter < 8; iter++) {
    const sums = centers.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < pixelCount; i++) {
      const r = data[i * 4];
      const g = data[i * 4 + 1];
      const b = data[i * 4 + 2];
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < k; c++) {
        const d = (centers[c][0] - r) ** 2 + (centers[c][1] - g) ** 2 + (centers[c][2] - b) ** 2;
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      labels[i] = best;
      sums[best][0] += r;
      sums[best][1] += g;
      sums[best][2] += b;
      sums[best][3]++;
    }
    for (let c = 0; c < k; c++) {
      if (sums[c][3] > 0) {
        centers[c] = [sums[c][0] / sums[c][3], sums[c][1] / sums[c][3], sums[c][2] / sums[c][3]];
      }
    }
  }
  return { labels, centers };
}

/** 掩膜轮廓追踪（沿像素边界的 crack following），返回像素坐标多边形列表 */
function traceContours(mask: Uint8Array, w: number, h: number): Vec2[][] {
  // 边界段：内部像素与外部相邻的边。点用栅格坐标 (0..w, 0..h)
  const adj = new Map<number, number[]>();
  const key = (x: number, y: number) => y * (w + 1) + x;
  const addEdge = (x1: number, y1: number, x2: number, y2: number) => {
    const a = key(x1, y1);
    const b = key(x2, y2);
    (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
    (adj.get(b) ?? adj.set(b, []).get(b)!).push(a);
  };
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] === 1;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x] !== 1) continue;
      if (!inside(x, y - 1)) addEdge(x, y, x + 1, y);         // 上
      if (!inside(x, y + 1)) addEdge(x, y + 1, x + 1, y + 1); // 下
      if (!inside(x - 1, y)) addEdge(x, y, x, y + 1);         // 左
      if (!inside(x + 1, y)) addEdge(x + 1, y, x + 1, y + 1); // 右
    }
  }

  const used = new Set<string>();
  const edgeKey = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`);
  const contours: Vec2[][] = [];

  for (const [start, neighbors] of adj) {
    for (const first of neighbors) {
      const ek = edgeKey(start, first);
      if (used.has(ek)) continue;
      const path: number[] = [start, first];
      used.add(ek);
      let prev = start;
      let cur = first;
      while (cur !== start) {
        const nexts = (adj.get(cur) ?? []).filter((n) => !used.has(edgeKey(cur, n)));
        if (nexts.length === 0) break;
        // 优先选择"继续直行/右转"的边，减少自交；简单起见取第一个未用边
        const next = nexts[0];
        used.add(edgeKey(cur, next));
        path.push(next);
        prev = cur;
        cur = next;
      }
      if (cur === start && path.length >= 4) {
        const pts = path.map((p) => ({ x: p % (w + 1), y: Math.floor(p / (w + 1)) }));
        contours.push(pts);
      }
      void prev;
    }
  }
  return contours;
}

export function traceImage(img: HTMLImageElement, opts: TraceOptions): TraceResult {
  const canvas = document.createElement('canvas');
  // 限制处理分辨率，太大先缩小
  const maxDim = 800;
  const scaleDown = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scaleDown));
  const h = Math.max(1, Math.round(img.naturalHeight * scaleDown));
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0, w, h);
  const imageData = ctx.getImageData(0, 0, w, h);
  const { labels, centers } = quantize(imageData.data, w * h, opts.colors);

  // 背景判定：四个角出现最多的簇
  const cornerCount = new Map<number, number>();
  const corners = [0, w - 1, (h - 1) * w, (h - 1) * w + w - 1];
  for (const c of corners) {
    const l = labels[c];
    cornerCount.set(l, (cornerCount.get(l) ?? 0) + 1);
  }
  let bgCluster = -1;
  let bgMax = 0;
  for (const [c, n] of cornerCount) {
    if (n > bgMax) {
      bgMax = n;
      bgCluster = c;
    }
  }

  const mmPerPx = opts.widthMm / w;
  const heightMm = h * mmPerPx;
  const regions: Region[] = [];

  for (let c = 0; c < centers.length; c++) {
    if (c === bgCluster) continue;
    const mask = new Uint8Array(w * h);
    let count = 0;
    for (let i = 0; i < w * h; i++) {
      if (labels[i] === c) {
        mask[i] = 1;
        count++;
      }
    }
    if (count < opts.minAreaPx) continue;
    const contours = traceContours(mask, w, h);
    // 去掉被其他轮廓包含的（孔洞），只留外轮廓
    const outer = contours.filter((poly, i) => {
      const testPt = poly[0];
      return !contours.some((other, j) => j !== i && signedArea(other) !== 0 && pointInPolygon(other, testPt));
    });
    const center = centers[c];
    const thread = nearestThread(center[0], center[1], center[2]);
    for (const poly of outer) {
      const simplified = douglasPeucker(poly, 1.2);
      if (simplified.length < 3) continue;
      // 像素 → mm，Y 翻转（图像 y 向下 → 绣品 y 向上），并居中
      const pts = simplified.map((p) => ({
        x: p.x * mmPerPx - opts.widthMm / 2,
        y: heightMm / 2 - p.y * mmPerPx,
      }));
      const ccw = ensureCCW(pts);
      if (Math.abs(signedArea(ccw)) < 1) continue; // 小于 1mm² 忽略
      regions.push({
        id: uid(),
        name: `描边分区 ${regions.length + 1}`,
        polygon: ccw,
        source: 'traced',
        stitchType: 'tatami',
        angle: 45,
        spacing: 0.4,
        stitchLength: 4,
        pullComp: 0,
        colorId: thread.id,
      });
    }
  }
  return { regions, widthMm: opts.widthMm, heightMm };
}
