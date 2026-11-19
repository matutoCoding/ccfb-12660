// 平面几何工具:多边形偏移、扫描线求交、重采样、简化。

import { Vec2 } from './types';

export function polygonArea(pts: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

export function ensureCcw(pts: Vec2[]): Vec2[] {
  return polygonArea(pts) < 0 ? [...pts].reverse() : pts;
}

export function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) &&
        p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** 简单多边形外扩(拉线补偿用)。按顶点法线方向平移,斜接长度限幅防止尖角爆炸。 */
export function offsetPolygon(pts: Vec2[], dist: number): Vec2[] {
  if (Math.abs(dist) < 1e-9 || pts.length < 3) return pts.map(p => ({ ...p }));
  const ccw = polygonArea(pts) > 0;
  const d = ccw ? dist : -dist;
  const n = pts.length;
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n], cur = pts[i], next = pts[(i + 1) % n];
    // 两条边的单位法线(朝外)
    const e1 = norm({ x: cur.x - prev.x, y: cur.y - prev.y });
    const e2 = norm({ x: next.x - cur.x, y: next.y - cur.y });
    const n1 = { x: e1.y, y: -e1.x };
    const n2 = { x: e2.y, y: -e2.x };
    let nx = n1.x + n2.x, ny = n1.y + n2.y;
    const len = Math.hypot(nx, ny);
    if (len < 1e-9) { nx = n1.x; ny = n1.y; } else { nx /= len; ny /= len; }
    // 斜接系数限幅
    const dot = Math.max(0.3, nx * n1.x + ny * n1.y);
    const scale = d / dot;
    out.push({ x: cur.x + nx * scale, y: cur.y + ny * scale });
  }
  return out;
}

function norm(v: Vec2): Vec2 {
  const l = Math.hypot(v.x, v.y);
  return l < 1e-12 ? { x: 0, y: 0 } : { x: v.x / l, y: v.y / l };
}

/** 按固定步长重采样折线(平针用),返回含起点的点列 */
export function resamplePolyline(pts: Vec2[], step: number, closed: boolean): Vec2[] {
  if (pts.length < 2 || step <= 0) return pts.map(p => ({ ...p }));
  const out: Vec2[] = [{ ...pts[0] }];
  let carry = 0;
  const count = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < count; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    if (segLen < 1e-9) continue;
    let t = carry > 1e-9 ? step - carry : step;
    while (t < segLen) {
      const r = t / segLen;
      out.push({ x: a.x + (b.x - a.x) * r, y: a.y + (b.y - a.y) * r });
      t += step;
    }
    carry = segLen - (t - step);
  }
  if (!closed) out.push({ ...pts[pts.length - 1] });
  return out;
}

/** Douglas-Peucker 简化 */
export function simplify(pts: Vec2[], tol: number): Vec2[] {
  if (pts.length < 3) return pts;
  const keep = new Array<boolean>(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const stack: Array<[number, number]> = [[0, pts.length - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop()!;
    const a = pts[i0], b = pts[i1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1e-12;
    let maxD = -1, maxI = -1;
    for (let i = i0 + 1; i < i1; i++) {
      const d = Math.abs((pts[i].x - a.x) * dy - (pts[i].y - a.y) * dx) / len;
      if (d > maxD) { maxD = d; maxI = i; }
    }
    if (maxD > tol) {
      keep[maxI] = true;
      stack.push([i0, maxI], [maxI, i1]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/**
 * 扫描线求交:方向 dir(弧度)的平行线,间距 spacing,与多边形(含孔洞)求交。
 * 返回每条扫描线上的线段列表 [{p, q, lineIndex}]。这是榻榻米/缎纹填充的基础。
 */
export function scanlineFill(
  outline: Vec2[],
  holes: Vec2[][],
  angleDeg: number,
  spacing: number,
): Array<{ p: Vec2; q: Vec2; lineIndex: number }> {
  if (outline.length < 3 || spacing <= 0) return [];
  const theta = (angleDeg * Math.PI) / 180;
  // 扫描线方向 u,法线方向 v(沿线法线推进)
  const u = { x: Math.cos(theta), y: Math.sin(theta) };
  const v = { x: -u.y, y: u.x };
  const proj = (p: Vec2) => p.x * v.x + p.y * v.y;

  let minV = Infinity, maxV = -Infinity;
  for (const p of outline) {
    const t = proj(p);
    if (t < minV) minV = t;
    if (t > maxV) maxV = t;
  }

  const result: Array<{ p: Vec2; q: Vec2; lineIndex: number }> = [];
  const firstLine = Math.ceil(minV / spacing - 1e-9);
  const lastLine = Math.floor(maxV / spacing + 1e-9);

  const intersectRing = (ring: Vec2[], lineV: number): number[] => {
    const ts: number[] = [];
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i], b = ring[j];
      const pa = proj(a) - lineV, pb = proj(b) - lineV;
      if ((pa < 0 && pb < 0) || (pa >= 0 && pb >= 0)) continue;
      const t = pa / (pa - pb);
      ts.push((a.x + (b.x - a.x) * t) * u.x + (a.y + (b.y - a.y) * t) * u.y);
    }
    ts.sort((x, y) => x - y);
    return ts;
  };

  for (let li = firstLine; li <= lastLine; li++) {
    const lineV = li * spacing;
    // 外轮廓区间两两配对,再减去孔洞区间
    let intervals: Array<[number, number]> = [];
    const outer = intersectRing(outline, lineV);
    for (let i = 0; i + 1 < outer.length; i += 2) intervals.push([outer[i], outer[i + 1]]);
    for (const hole of holes) {
      const hs = intersectRing(hole, lineV);
      for (let i = 0; i + 1 < hs.length; i += 2) {
        const [h0, h1] = [hs[i], hs[i + 1]];
        const next: Array<[number, number]> = [];
        for (const [a, b] of intervals) {
          if (h1 <= a || h0 >= b) { next.push([a, b]); continue; }
          if (h0 > a) next.push([a, h0]);
          if (h1 < b) next.push([h1, b]);
        }
        intervals = next;
      }
    }
    for (const [a, b] of intervals) {
      if (b - a < 1e-6) continue;
      result.push({
        p: { x: u.x * a + v.x * lineV, y: u.y * a + v.y * lineV },
        q: { x: u.x * b + v.x * lineV, y: u.y * b + v.y * lineV },
        lineIndex: li,
      });
    }
  }
  return result;
}

export function polylineLength(pts: Vec2[]): number {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return L;
}

export function centroid(pts: Vec2[]): Vec2 {
  let x = 0, y = 0;
  for (const p of pts) { x += p.x; y += p.y; }
  return { x: x / pts.length, y: y / pts.length };
}
