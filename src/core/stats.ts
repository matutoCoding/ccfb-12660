/**
 * 针迹统计、用线量与密度（起坨）分析。
 */

import type { DensityWarning, DesignStats, Stitch } from './types';
import { StitchFlag } from './types';
import { dist } from './units';

export type { DesignStats };

/** 机台默认速度：每分钟 700 针（平绣常用区间 600~800） */
export const DEFAULT_SPM = 700;
/** 换色一次预计停机耗时（秒） */
export const SECONDS_PER_COLOR_CHANGE = 25;
/** 跳针空走等效速度（针/分钟），用于工时估算 */
export const JUMPS_PER_MINUTE = 400;

/** 密度分析格子边长：2mm = 20 DST 单位 */
const DENSITY_CELL = 20;
/** 格子内针数告警阈值 */
const WARN_PER_CELL = 18;
const CRITICAL_PER_CELL = 28;

export function computeStats(stitches: Stitch[], spm = DEFAULT_SPM): DesignStats {
  let jumpCount = 0;
  let colorChangeCount = 0;
  let totalThreadLength = 0;
  let sewingLength = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  let px = 0;
  let py = 0;
  const grid = new Map<string, number>();

  for (const s of stitches) {
    const d = dist(px, py, s.x, s.y);
    totalThreadLength += d;
    const isJump = (s.flags & StitchFlag.Jump) !== 0;
    const isCC = (s.flags & StitchFlag.ColorChange) !== 0;
    if (isJump) jumpCount++;
    if (isCC) colorChangeCount++;
    if (!isJump) sewingLength += d;
    minX = Math.min(minX, s.x);
    minY = Math.min(minY, s.y);
    maxX = Math.max(maxX, s.x);
    maxY = Math.max(maxY, s.y);
    if (!isJump) {
      const key = `${Math.floor(s.x / DENSITY_CELL)},${Math.floor(s.y / DENSITY_CELL)}`;
      grid.set(key, (grid.get(key) ?? 0) + 1);
    }
    px = s.x;
    py = s.y;
  }

  const warnings: DensityWarning[] = [];
  for (const [key, count] of grid) {
    if (count < WARN_PER_CELL) continue;
    const [gx, gy] = key.split(',').map(Number);
    warnings.push({
      x: (gx + 0.5) * DENSITY_CELL,
      y: (gy + 0.5) * DENSITY_CELL,
      count,
      cellSize: DENSITY_CELL,
      level: count >= CRITICAL_PER_CELL ? 'critical' : 'warn'
    });
  }
  warnings.sort((a, b) => b.count - a.count);

  const normalCount = stitches.filter((s) => s.flags === StitchFlag.Normal).length;
  const sewingSeconds = (normalCount / spm) * 60;
  const jumpSeconds = (jumpCount / JUMPS_PER_MINUTE) * 60;
  const estimatedSeconds =
    sewingSeconds + jumpSeconds + colorChangeCount * SECONDS_PER_COLOR_CHANGE;

  return {
    stitchCount: stitches.length,
    jumpCount,
    colorChangeCount,
    totalThreadLength,
    sewingLength,
    bbox: stitches.length ? { minX, minY, maxX, maxY } : null,
    estimatedSeconds,
    warnings
  };
}

/**
 * 用线量按色号汇总。
 * 返回 threadId → 线长（DST 单位）。跳针不计入用线（机台抬针不耗面线）。
 */
export function threadUsageByColor(stitches: Stitch[]): Map<string | null, number> {
  const usage = new Map<string | null, number>();
  let px = 0;
  let py = 0;
  for (const s of stitches) {
    const d = dist(px, py, s.x, s.y);
    if (!(s.flags & StitchFlag.Jump)) {
      const key = s.threadId;
      usage.set(key, (usage.get(key) ?? 0) + d);
    }
    px = s.x;
    py = s.y;
  }
  return usage;
}

/** 简单的布面拉伸模拟：把每个针点沿局部针迹方向做微量位移，返回形变后坐标 */
export function simulateFabricStretch(
  stitches: Stitch[],
  /** 拉伸系数 0~0.05（沿针方向收缩的比例） */
  factor: number
): Stitch[] {
  if (factor <= 0) return stitches;
  return stitches.map((s, i) => {
    if (i === 0) return s;
    const prev = stitches[i - 1];
    const dx = s.x - prev.x;
    const dy = s.y - prev.y;
    return {
      ...s,
      x: Math.round(s.x - dx * factor),
      y: Math.round(s.y - dy * factor)
    };
  });
}
