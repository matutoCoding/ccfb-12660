import type { Pt } from './types';

/** 二维向量/多边形几何工具（坐标单位由调用方约定） */

export const v = (x: number, y: number): Pt => ({ x, y });
export const add = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Pt, s: number): Pt => ({ x: a.x * s, y: a.y * s });
export const dot = (a: Pt, b: Pt): number => a.x * b.x + a.y * b.y;
export const cross = (a: Pt, b: Pt): number => a.x * b.y - a.y * b.x;
export const len = (a: Pt): number => Math.hypot(a.x, a.y);
export const distPt = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y);

export function normalize(a: Pt): Pt {
  const l = len(a);
  return l < 1e-9 ? { x: 1, y: 0 } : { x: a.x / l, y: a.y / l };
}

export function perp(a: Pt): Pt {
  return { x: -a.y, y: a.x };
}

/** 方向单位向量（角度相对 +X） */
export function dirFromAngle(angle: number): Pt {
  return { x: Math.cos(angle), y: Math.sin(angle) };
}

export function polygonCentroid(poly: Pt[]): Pt {
  let sx = 0;
  let sy = 0;
  for (const p of poly) {
    sx += p.x;
    sy += p.y;
  }
  return { x: sx / poly.length, y: sy / poly.length };
}

export function polygonBBox(poly: Pt[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of poly) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

/** 射线法判断点是否在多边形内 */
export function pointInPolygon(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    const intersect =
      yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** 点是否在区域内（考虑孔洞） */
export function pointInRegion(p: Pt, outer: Pt[], holes: Pt[][]): boolean {
  if (!pointInPolygon(p, outer)) return false;
  for (const h of holes) if (pointInPolygon(p, h)) return false;
  return true;
}

/** 有向面积，>0 表示逆时针 */
export function signedArea(poly: Pt[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length;
    a += poly[i].x * poly[j].y - poly[j].x * poly[i].y;
  }
  return a / 2;
}

export function ensureCCW(poly: Pt[]): Pt[] {
  return signedArea(poly) < 0 ? [...poly].reverse() : poly;
}

export interface LineSeg {
  a: Pt;
  b: Pt;
}

/** 线段与水平扫描线 y=sy 的交点 x（无交点返回 null） */
function scanCrossX(a: Pt, b: Pt, sy: number): number | null {
  if ((a.y > sy) === (b.y > sy) || a.y === b.y) return null;
  return a.x + ((sy - a.y) * (b.x - a.x)) / (b.y - a.y);
}

/**
 * 用一组平行扫描线求多边形截面区间。
 * scanDir：扫描线方向单位向量；扫描线沿 perp(scanDir) 等间距平移。
 * 返回每条扫描线上落在多边形（扣除孔洞）内的参数区间 [t0,t1]（沿 scanDir 的投影坐标）。
 */
export interface ScanSpan {
  /** 扫描线索引对应的平移参数（沿 perp(scanDir)） */
  offset: number;
  /** 沿 scanDir 方向的区间对 */
  ranges: { from: number; to: number }[];
  /** 扫描线起点（offset 处的原点投影点），便于还原坐标 */
  origin: Pt;
}

export function scanPolygon(
  outer: Pt[],
  holes: Pt[][],
  scanDir: Pt,
  spacing: number
): ScanSpan[] {
  const d = normalize(scanDir);
  const n = perp(d);
  const project = (p: Pt) => ({ s: dot(p, d), t: dot(p, n) });

  const all = [outer, ...holes];
  let minT = Infinity;
  let maxT = -Infinity;
  let minS = Infinity;
  let maxS = -Infinity;
  for (const poly of all) {
    for (const p of poly) {
      const pr = project(p);
      minT = Math.min(minT, pr.t);
      maxT = Math.max(maxT, pr.t);
      minS = Math.min(minS, pr.s);
      maxS = Math.max(maxS, pr.s);
    }
  }

  const spans: ScanSpan[] = [];
  // 扫描线必须覆盖负坐标：从 minT 向下对齐到 spacing 网格，不能用 ceil（会跳过整个负半轴）
  const start = Math.floor(minT / spacing) * spacing;
  for (let t = start; t < maxT; t += spacing) {
    const collect = (poly: Pt[]): number[] => {
      const xs: number[] = [];
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i];
        const b = poly[(i + 1) % poly.length];
        // 在 (s,t) 投影坐标系里做水平扫描
        const pa = project(a);
        const pb = project(b);
        if ((pa.t > t) !== (pb.t > t) && pa.t !== pb.t) {
          const s = pa.s + ((t - pa.t) * (pb.s - pa.s)) / (pb.t - pa.t);
          xs.push(s);
        }
      }
      return xs.sort((p, q) => p - q);
    };

    const outerX = collect(outer);
    const inRanges: { from: number; to: number }[] = [];
    for (let i = 0; i + 1 < outerX.length; i += 2) {
      inRanges.push({ from: outerX[i], to: outerX[i + 1] });
    }
    for (const hole of holes) {
      const hx = collect(hole);
      for (let i = 0; i + 1 < hx.length; i += 2) {
        subtractRange(inRanges, hx[i], hx[i + 1]);
      }
    }
    const filtered = inRanges
      .map((r) => ({ from: Math.max(r.from, minS), to: Math.min(r.to, maxS) }))
      .filter((r) => r.to - r.from > 0.5);
    if (filtered.length) {
      spans.push({
        offset: t,
        ranges: filtered,
        origin: scale(n, t)
      });
    }
  }
  return spans;
}

function subtractRange(
  ranges: { from: number; to: number }[],
  from: number,
  to: number
): void {
  for (let i = ranges.length - 1; i >= 0; i--) {
    const r = ranges[i];
    if (to <= r.from || from >= r.to) continue;
    const rest: { from: number; to: number }[] = [];
    if (from > r.from) rest.push({ from: r.from, to: from });
    if (to < r.to) rest.push({ from: to, to: r.to });
    ranges.splice(i, 1, ...rest);
  }
}

/** 投影坐标 (s 沿 d, t 沿 n 的 offset) 还原为平面坐标 */
export function unproject(d: Pt, n: Pt, s: number, t: number): Pt {
  return { x: d.x * s + n.x * t, y: d.y * s + n.y * t };
}

/** 多边形周长 */
export function polygonPerimeter(poly: Pt[]): number {
  let p = 0;
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length;
    p += distPt(poly[i], poly[j]);
  }
  return p;
}

/** 多边形面积（绝对值） */
export function polygonArea(poly: Pt[]): number {
  return Math.abs(signedArea(poly));
}

/** 沿多边形周长均匀采点（用于平针包边/行进点） */
export function walkPolygon(poly: Pt[], step: number): Pt[] {
  const pts: Pt[] = [];
  let carry = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const seg = distPt(a, b);
    let d0 = carry;
    while (d0 < seg) {
      const t = d0 / seg;
      pts.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      d0 += step;
    }
    carry = d0 - seg;
  }
  return pts;
}

/** 对一组点做等距重采样（路径版） */
export function resamplePath(points: Pt[], step: number): Pt[] {
  if (points.length < 2 || step <= 0) return points;
  const out: Pt[] = [points[0]];
  let acc = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const seg = distPt(a, b);
    if (seg < 1e-9) continue;
    let remain = seg;
    let from = a;
    while (acc + remain >= step) {
      const need = step - acc;
      const t = need / distPt(from, b);
      const np = {
        x: from.x + (b.x - from.x) * t,
        y: from.y + (b.y - from.y) * t
      };
      out.push(np);
      from = np;
      remain = distPt(from, b);
      acc = 0;
    }
    acc += remain;
  }
  out.push(points[points.length - 1]);
  return out;
}

export { scanCrossX };
