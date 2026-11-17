import type { Vec2 } from './types';

export const rad = (deg: number) => (deg * Math.PI) / 180;

export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const scale = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });
export const len = (a: Vec2): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);

export function norm(a: Vec2): Vec2 {
  const l = len(a);
  return l > 1e-12 ? { x: a.x / l, y: a.y / l } : { x: 1, y: 0 };
}

export function rotatePoint(p: Vec2, angleRad: number): Vec2 {
  const c = Math.cos(angleRad);
  const s = Math.sin(angleRad);
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c };
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function boundsOf(pts: Vec2[]): Bounds {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

export function signedArea(poly: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/** 保证逆时针（面积符号统一，offset 外扩方向才正确） */
export function ensureCCW(poly: Vec2[]): Vec2[] {
  return signedArea(poly) < 0 ? [...poly].reverse() : poly;
}

export function centroidOf(poly: Vec2[]): Vec2 {
  let x = 0, y = 0;
  for (const p of poly) { x += p.x; y += p.y; }
  return { x: x / poly.length, y: y / poly.length };
}

function lineIntersect(p1: Vec2, d1: Vec2, p2: Vec2, d2: Vec2): Vec2 | null {
  const den = d1.x * d2.y - d1.y * d2.x;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((p2.x - p1.x) * d2.y - (p2.y - p1.y) * d2.x) / den;
  return { x: p1.x + d1.x * t, y: p1.y + d1.y * t };
}

/**
 * 多边形外扩（拉线补偿用）。逐边沿外法线平移后求交。
 * 对凸角精确，凹角/自交严重的形状是近似，制版场景够用。
 */
export function offsetPolygon(poly: Vec2[], d: number): Vec2[] {
  if (d === 0 || poly.length < 3) return poly;
  const p = ensureCCW(poly);
  const n = p.length;
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const prev = p[(i + n - 1) % n];
    const cur = p[i];
    const next = p[(i + 1) % n];
    const e1 = norm(sub(cur, prev));
    const e2 = norm(sub(next, cur));
    // CCW 多边形的外法线 = 边方向右转 90°
    const n1 = { x: e1.y, y: -e1.x };
    const n2 = { x: e2.y, y: -e2.x };
    const a1 = add(prev, scale(n1, d));
    const a2 = add(cur, scale(n2, d));
    const hit = lineIntersect(a1, e1, a2, e2);
    if (hit) {
      out.push(hit);
    } else {
      const nm = norm(add(n1, n2));
      out.push(add(cur, scale(nm, d)));
    }
  }
  return out;
}

/** 竖直扫描线 x=c 与多边形的交点 y 列表（升序） */
export function scanlineX(poly: Vec2[], x: number): number[] {
  const ys: number[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    if ((a.x <= x) !== (b.x <= x)) {
      const t = (x - a.x) / (b.x - a.x);
      ys.push(a.y + t * (b.y - a.y));
    }
  }
  return ys.sort((p, q) => p - q);
}

/** 水平扫描线 y=c 与多边形的交点 x 列表（升序） */
export function scanlineY(poly: Vec2[], y: number): number[] {
  const xs: number[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    if ((a.y <= y) !== (b.y <= y)) {
      const t = (y - a.y) / (b.y - a.y);
      xs.push(a.x + t * (b.x - a.x));
    }
  }
  return xs.sort((p, q) => p - q);
}

export function pointInPolygon(poly: Vec2[], p: Vec2): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** 按固定步长重采样折线（closed 时首尾相连） */
export function resamplePolyline(pts: Vec2[], step: number, closed: boolean): Vec2[] {
  if (pts.length < 2 || step <= 0) return [...pts];
  const out: Vec2[] = [];
  const count = closed ? pts.length : pts.length - 1;
  let carry = 0;
  for (let i = 0; i < count; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const segLen = dist(a, b);
    if (segLen < 1e-9) continue;
    let t = carry;
    while (t < segLen) {
      const k = t / segLen;
      out.push({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k });
      t += step;
    }
    carry = t - segLen;
  }
  if (!closed && pts.length > 0) out.push(pts[pts.length - 1]);
  return out;
}

/** Douglas-Peucker 简化 */
export function douglasPeucker(pts: Vec2[], epsilon: number): Vec2[] {
  if (pts.length < 3) return pts;
  let maxD = 0;
  let index = 0;
  const first = pts[0];
  const last = pts[pts.length - 1];
  const d = sub(last, first);
  const dLen = len(d);
  for (let i = 1; i < pts.length - 1; i++) {
    let distToLine: number;
    if (dLen < 1e-12) {
      distToLine = dist(pts[i], first);
    } else {
      distToLine = Math.abs(d.x * (first.y - pts[i].y) - (first.x - pts[i].x) * d.y) / dLen;
    }
    if (distToLine > maxD) {
      maxD = distToLine;
      index = i;
    }
  }
  if (maxD > epsilon) {
    const left = douglasPeucker(pts.slice(0, index + 1), epsilon);
    const right = douglasPeucker(pts.slice(index), epsilon);
    return left.slice(0, -1).concat(right);
  }
  return [first, last];
}
