/**
 * 位图自动描边分区。
 * 纯前端实现：canvas 取像素 → 灰度 → 自适应阈值二值化 → 连通域标记 →
 * 轮廓追踪（Moore 邻域）→ Douglas-Peucker 抽稀 → 简化多边形。
 * 输出多边形坐标由调用方映射到 DST 单位。
 */

import type { Pt } from '../core/types';

export interface TraceOptions {
  /** 二值化阈值 0~255，null 时用 Otsu 自动阈值 */
  threshold: number | null;
  /** 最小连通域面积（像素），小于该值视为噪点丢弃 */
  minComponentArea: number;
  /** DP 抽稀容差（像素） */
  simplifyEpsilon: number;
}

export const DEFAULT_TRACE: TraceOptions = {
  threshold: null,
  minComponentArea: 64,
  simplifyEpsilon: 2.5
};

/* ---------- Otsu 自动阈值 ---------- */

export function otsuThreshold(gray: Uint8ClampedArray, width: number, height: number): number {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < width * height; i++) hist[gray[i]]++;
  const total = width * height;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0;
  let wB = 0;
  let maxVar = -1;
  let threshold = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxVar) {
      maxVar = between;
      threshold = t;
    }
  }
  return threshold;
}

/* ---------- 连通域标记（4 邻域两遍法） ---------- */

export function labelComponents(
  binary: Uint8Array,
  width: number,
  height: number
): { labels: Int32Array; count: number; areas: number[] } {
  const labels = new Int32Array(width * height).fill(0);
  const parent: number[] = [0];
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  let next = 1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!binary[i]) continue;
      const up = y > 0 ? labels[i - width] : 0;
      const left = x > 0 ? labels[i - 1] : 0;
      if (!up && !left) {
        labels[i] = next;
        parent[next] = next;
        next++;
      } else if (up && !left) {
        labels[i] = up;
      } else if (!up && left) {
        labels[i] = left;
      } else {
        labels[i] = Math.min(up, left);
        union(up, left);
      }
    }
  }
  const remap = new Map<number, number>();
  let count = 0;
  const areas: number[] = [0];
  for (let i = 0; i < labels.length; i++) {
    if (!labels[i]) continue;
    const root = find(labels[i]);
    let cid = remap.get(root);
    if (cid === undefined) {
      count++;
      cid = count;
      remap.set(root, cid);
      areas.push(0);
    }
    labels[i] = cid;
    areas[cid]++;
  }
  return { labels, count, areas };
}

/* ---------- Moore 邻域轮廓追踪 ---------- */

export function traceBoundary(
  labels: Int32Array,
  width: number,
  height: number,
  cid: number
): Pt[] {
  const start = (() => {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (labels[y * width + x] === cid) return { x, y };
      }
    }
    return null;
  })();
  if (!start) return [];

  // 8 邻域，顺时针：N, NE, E, SE, S, SW, W, NW（图像坐标 y 向下）
  const dirs = [
    [0, -1],
    [1, -1],
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [-1, -1]
  ];
  const boundary: Pt[] = [];
  let cur = start;
  // 来向：扫描起点位于区域最左上，首个背景邻点从它的西侧进入
  let incoming = 6;
  const startKey = `${start.x},${start.y}`;
  let guard = 0;
  const maxSteps = width * height * 8;

  do {
    boundary.push({ x: cur.x, y: cur.y });
    let found = false;
    // 从来向的下一个顺时针邻点开始检查一圈
    for (let k = 1; k <= 8; k++) {
      const dIdx = (incoming + k) % 8;
      const nx = cur.x + dirs[dIdx][0];
      const ny = cur.y + dirs[dIdx][1];
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      if (labels[ny * width + nx] === cid) {
        // 新点是从其反方向进入的
        incoming = (dIdx + 4) % 8;
        cur = { x: nx, y: ny };
        found = true;
        break;
      }
    }
    if (!found) break; // 单点区域等退化情况
    guard++;
  } while (`${cur.x},${cur.y}` !== startKey && guard < maxSteps);

  return boundary;
}

/* ---------- Douglas-Peucker 抽稀 ---------- */

export function simplifyDP(points: Pt[], epsilon: number): Pt[] {
  if (points.length < 3 || epsilon <= 0) return points;
  const keep = new Array(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  const perpDist = (p: Pt, a: Pt, b: Pt) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    if (l2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
    const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
    const px = a.x + t * dx;
    const py = a.y + t * dy;
    return Math.hypot(p.x - px, p.y - py);
  };
  while (stack.length) {
    const [lo, hi] = stack.pop()!;
    let maxD = -1;
    let idx = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = perpDist(points[i], points[lo], points[hi]);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > epsilon && idx > 0) {
      keep[idx] = true;
      stack.push([lo, idx], [idx, hi]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/* ---------- 主入口 ---------- */

export interface TracedRegion {
  /** 像素坐标多边形（y 向下，与 canvas 一致） */
  polygonPx: Pt[];
  areaPx: number;
}

export function traceImageData(
  image: ImageData,
  opts: TraceOptions = DEFAULT_TRACE
): TracedRegion[] {
  const { width, height, data } = image;
  const gray = new Uint8ClampedArray(width * height);
  for (let i = 0; i < width * height; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    // 亮度（Rec.601）
    gray[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  }
  const threshold = opts.threshold ?? otsuThreshold(gray, width, height);
  // 深色为前景（绣花图案通常是深色线条/块）
  const binary = new Uint8Array(width * height);
  for (let i = 0; i < binary.length; i++) binary[i] = gray[i] <= threshold ? 1 : 0;

  const { labels, count, areas } = labelComponents(binary, width, height);
  const out: TracedRegion[] = [];
  for (let cid = 1; cid <= count; cid++) {
    if (areas[cid] < opts.minComponentArea) continue;
    const raw = traceBoundary(labels, width, height, cid);
    const poly = simplifyDP(raw, opts.simplifyEpsilon);
    if (poly.length >= 3) out.push({ polygonPx: poly, areaPx: areas[cid] });
  }
  // 大区域在前，方便制版时先铺底
  return out.sort((a, b) => b.areaPx - a.areaPx);
}

/**
 * 把像素坐标多边形映射为 DST 单位多边形。
 * targetSize：图案期望的绣花尺寸（DST 单位），按图像短边等比缩放。
 * 同时翻转 y 轴（canvas y 向下 → 绣花坐标 y 向上）。
 */
export function pxPolygonToDst(
  poly: Pt[],
  imgWidth: number,
  imgHeight: number,
  targetSize: number
): Pt[] {
  const scale = targetSize / Math.min(imgWidth, imgHeight);
  const cy = imgHeight / 2;
  return poly.map((p) => ({
    x: Math.round((p.x - imgWidth / 2) * scale),
    y: Math.round((cy - p.y) * scale)
  }));
}
