/** 单位与数值工具 */

/** DST 单位与毫米换算：1 DST unit = 0.1 mm */
export const MM_PER_UNIT = 0.1;

export const mmToUnit = (mm: number): number => mm / MM_PER_UNIT;
export const unitToMm = (u: number): number => u * MM_PER_UNIT;

/** 取整为 DST 整数坐标（四舍五入，避免负数截断问题） */
export const roundUnit = (v: number): number => Math.round(v);

export const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v));

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(bx - ax, by - ay);
}

/** 线段长度 */
export function segmentLength(x1: number, y1: number, x2: number, y2: number): number {
  return Math.hypot(x2 - x1, y2 - y1);
}

let counter = 0;
/** 生成 id（不依赖 crypto，兼容性好） */
export function uid(prefix = 'id'): string {
  counter = (counter + 1) % 1_000_000;
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}_${Math.floor(
    Math.random() * 1e6
  ).toString(36)}`;
}

/** 角度归一化到 [0, PI)（针迹方向具有 π 周期性） */
export function normalizeAngle(a: number): number {
  const pi = Math.PI;
  let r = a % pi;
  if (r < 0) r += pi;
  return r;
}

/** 格式化毫米显示 */
export function fmtMm(units: number): string {
  return `${unitToMm(units).toFixed(1)}mm`;
}

/** 格式化米 */
export function fmtMeters(units: number): string {
  return `${(unitToMm(units) / 1000).toFixed(2)}m`;
}
