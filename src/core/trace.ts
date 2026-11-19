// 位图自动描边:颜色量化分区 → marching squares 提取轮廓 → 简化成多边形分区。

import { Vec2 } from './types';
import { ensureCcw, polygonArea, simplify } from './geometry';
import { nearestThread } from './palette';

export interface TracedRegion {
  outline: Vec2[];
  holes: Vec2[][];
  colorId: string;
  pixelCount: number;
}

/** k-means 颜色量化,返回各类中心色与每像素类别 */
function quantize(data: Uint8ClampedArray, k: number, maxIter = 8): { centers: number[][]; labels: Uint8Array } {
  const n = data.length / 4;
  // 采样初始化中心
  const centers: number[][] = [];
  const stride = Math.max(1, Math.floor(n / (k * 4)));
  for (let i = 0; i < n && centers.length < k; i += stride) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    if (centers.every(c => Math.abs(c[0] - r) + Math.abs(c[1] - g) + Math.abs(c[2] - b) > 30)) {
      centers.push([r, g, b]);
    }
  }
  while (centers.length < k) centers.push([Math.random() * 255, Math.random() * 255, Math.random() * 255]);

  const labels = new Uint8Array(n);
  for (let iter = 0; iter < maxIter; iter++) {
    const sums = centers.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < n; i++) {
      const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
      let best = 0, bestD = Infinity;
      for (let c = 0; c < k; c++) {
        const d = (centers[c][0] - r) ** 2 + (centers[c][1] - g) ** 2 + (centers[c][2] - b) ** 2;
        if (d < bestD) { bestD = d; best = c; }
      }
      labels[i] = best;
      const s = sums[best];
      s[0] += r; s[1] += g; s[2] += b; s[3]++;
    }
    for (let c = 0; c < k; c++) {
      if (sums[c][3] > 0) {
        centers[c] = [sums[c][0] / sums[c][3], sums[c][1] / sums[c][3], sums[c][2] / sums[c][3]];
      }
    }
  }
  return { centers, labels };
}

/** marching squares:从二值掩码提取闭合轮廓(像素坐标,y 向下) */
function extractContours(mask: Uint8Array, w: number, h: number): Vec2[][] {
  // 边中点用整数键表示:水平边中点 (x*2+1, y*2),垂直边中点 (x*2, y*2+1)
  type Seg = { a: number; b: number };
  const segs: Seg[] = [];
  const key = (x: number, y: number) => y * (w * 2 + 2) + x;

  for (let j = 0; j < h - 1; j++) {
    for (let i = 0; i < w - 1; i++) {
      const tl = mask[j * w + i] ? 8 : 0;
      const tr = mask[j * w + i + 1] ? 4 : 0;
      const br = mask[(j + 1) * w + i + 1] ? 2 : 0;
      const bl = mask[(j + 1) * w + i] ? 1 : 0;
      const c = tl | tr | br | bl;
      if (c === 0 || c === 15) continue;
      const top = key(i * 2 + 1, j * 2);
      const right = key((i + 1) * 2, j * 2 + 1);
      const bottom = key(i * 2 + 1, (j + 1) * 2);
      const left = key(i * 2, j * 2 + 1);
      switch (c) {
        case 1: case 14: segs.push({ a: left, b: bottom }); break;
        case 2: case 13: segs.push({ a: bottom, b: right }); break;
        case 3: case 12: segs.push({ a: left, b: right }); break;
        case 4: case 11: segs.push({ a: top, b: right }); break;
        case 5: segs.push({ a: left, b: top }, { a: bottom, b: right }); break;
        case 6: case 9: segs.push({ a: top, b: bottom }); break;
        case 7: case 8: segs.push({ a: left, b: top }); break;
        case 10: segs.push({ a: left, b: bottom }, { a: top, b: right }); break;
      }
    }
  }

  // 链接成环
  const from = new Map<number, number[]>();
  for (const s of segs) {
    (from.get(s.a) ?? from.set(s.a, []).get(s.a)!).push(s.b);
    (from.get(s.b) ?? from.set(s.b, []).get(s.b)!).push(s.a);
  }
  const loops: Vec2[][] = [];
  const visited = new Set<number>();
  for (const s of segs) {
    if (visited.has(s.a)) continue;
    const loop: Vec2[] = [];
    let cur = s.a;
    while (!visited.has(cur)) {
      visited.add(cur);
      loop.push({ x: (cur % (w * 2 + 2)) / 2, y: Math.floor(cur / (w * 2 + 2)) / 2 });
      const nexts = (from.get(cur) ?? []).filter(n => !visited.has(n));
      if (!nexts.length) break;
      cur = nexts[0];
    }
    if (loop.length >= 6) loops.push(loop);
  }
  return loops;
}

/**
 * 位图 → 分区。
 * @param imageData 源图像
 * @param widthMm 目标宽度(mm),高度按比例
 * @param maxColors 量化颜色数
 * @param minAreaPx 忽略小于该面积的区域(去噪)
 */
export function traceBitmap(
  imageData: ImageData,
  widthMm: number,
  maxColors = 6,
  minAreaPx = 40,
): TracedRegion[] {
  const { width: w, height: h, data } = imageData;
  const { centers, labels } = quantize(data, maxColors);

  // 背景色:取四角出现最多的类
  const cornerLabels = [labels[0], labels[w - 1], labels[(h - 1) * w], labels[h * w - 1]];
  const bgCount = new Map<number, number>();
  for (const l of cornerLabels) bgCount.set(l, (bgCount.get(l) ?? 0) + 1);
  const bgLabel = [...bgCount.entries()].sort((a, b) => b[1] - a[1])[0][0];

  const scale = widthMm / w;
  const regions: TracedRegion[] = [];

  for (let c = 0; c < centers.length; c++) {
    if (c === bgLabel) continue;
    const mask = new Uint8Array(w * h);
    let count = 0;
    for (let i = 0; i < labels.length; i++) {
      if (labels[i] === c) { mask[i] = 1; count++; }
    }
    if (count < minAreaPx) continue;

    const loops = extractContours(mask, w, h);
    // 像素坐标(y 向下)→ mm(y 向上,中心为原点)
    const toMm = (p: Vec2): Vec2 => ({
      x: (p.x - w / 2) * scale,
      y: (h / 2 - p.y) * scale,
    });
    const outers: Vec2[][] = [];
    const holes: Vec2[][] = [];
    for (const loop of loops) {
      const pts = simplify(loop.map(toMm), scale * 0.8);
      if (pts.length < 3) continue;
      if (Math.abs(polygonArea(pts)) < minAreaPx * scale * scale) continue;
      // y 翻转后外环应为逆时针
      if (polygonArea(pts) > 0) outers.push(ensureCcw(pts));
      else holes.push(pts);
    }
    // 孔洞挂到包含它的外环上
    const regionHoles = new Map<Vec2[], Vec2[][]>();
    for (const o of outers) regionHoles.set(o, []);
    for (const hole of holes) {
      const p = hole[0];
      let best: Vec2[] | null = null, bestArea = Infinity;
      for (const o of outers) {
        if (pointInPoly(p, o)) {
          const a = Math.abs(polygonArea(o));
          if (a < bestArea) { bestArea = a; best = o; }
        }
      }
      if (best) regionHoles.get(best)!.push(hole);
    }
    const [r, g, b] = centers[c];
    const thread = nearestThread(r / 255, g / 255, b / 255);
    for (const o of outers) {
      regions.push({ outline: o, holes: regionHoles.get(o) ?? [], colorId: thread.id, pixelCount: count });
    }
  }
  return regions.sort((a, b) => b.pixelCount - a.pixelCount);
}

function pointInPoly(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) &&
        p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
