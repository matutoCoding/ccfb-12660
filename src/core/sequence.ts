// 绣制顺序优化与生产统计。

import { Flag, Pattern, Region, StitchRec } from './types';
import { centroid } from './geometry';

export interface PatternStats {
  stitchCount: number;    // 普通针迹数
  jumpCount: number;
  colorChanges: number;
  totalLengthMm: number;  // 针迹总长度
  jumpLengthMm: number;
  /** 预计工时(秒),按 750 针/分 + 换色 8 秒/次 + 跳针 1.5 秒/次 */
  estimatedSeconds: number;
}

export function computeStats(stitches: StitchRec[], stitchesPerMinute = 750): PatternStats {
  let stitchCount = 0, jumpCount = 0, colorChanges = 0;
  let totalLengthMm = 0, jumpLengthMm = 0;
  let px = 0, py = 0, first = true;
  for (const s of stitches) {
    if (s.flag === Flag.End) break;
    const d = first ? 0 : Math.hypot(s.x - px, s.y - py);
    if (s.flag === Flag.Stitch) { stitchCount++; totalLengthMm += d; }
    else if (s.flag === Flag.Jump) { jumpCount++; jumpLengthMm += d; }
    else if (s.flag === Flag.Color) colorChanges++;
    px = s.x; py = s.y; first = false;
  }
  const estimatedSeconds =
    (stitchCount / stitchesPerMinute) * 60 + colorChanges * 8 + jumpCount * 1.5;
  return { stitchCount, jumpCount, colorChanges, totalLengthMm, jumpLengthMm, estimatedSeconds };
}

/**
 * 自动排绣制顺序:先按颜色分组(减少换色),组内最近邻排序(减少跳针)。
 * 返回重排后的分区数组(不改原数组)。
 */
export function optimizeSequence(regions: Region[]): Region[] {
  const byColor = new Map<string, Region[]>();
  for (const r of regions) {
    const list = byColor.get(r.colorId) ?? [];
    list.push(r);
    byColor.set(r.colorId, list);
  }
  // 颜色组按首次出现顺序,组内最近邻
  const out: Region[] = [];
  let cur = { x: 0, y: 0 };
  for (const group of byColor.values()) {
    const rest = [...group];
    while (rest.length) {
      let bestI = 0, bestD = Infinity;
      for (let i = 0; i < rest.length; i++) {
        const c = centroid(rest[i].outline);
        const d = Math.hypot(c.x - cur.x, c.y - cur.y);
        if (d < bestD) { bestD = d; bestI = i; }
      }
      const [r] = rest.splice(bestI, 1);
      out.push(r);
      cur = centroid(r.outline);
    }
  }
  return out;
}

/** 排序收益评估:对给定顺序模拟换色次数与跳针总长 */
export function sequenceCost(pattern: Pattern): { colorChanges: number; jumpMm: number } {
  let colorChanges = 0, prevColor: string | null = null;
  let jumpMm = 0, cur = { x: 0, y: 0 };
  for (const r of pattern.regions) {
    if (prevColor !== null && prevColor !== r.colorId) colorChanges++;
    prevColor = r.colorId;
    if (r.outline.length) {
      const c = centroid(r.outline);
      jumpMm += Math.hypot(c.x - cur.x, c.y - cur.y);
      cur = c;
    }
  }
  return { colorChanges, jumpMm };
}
