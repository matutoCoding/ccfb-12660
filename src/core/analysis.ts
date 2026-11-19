// 质量分析:起坨(针迹过密)警告、布面拉伸位移场、用线量。

import { Flag, StitchRec } from './types';
import { patternBounds } from './types';

export interface DensityWarning {
  x: number;      // 网格中心(mm)
  y: number;
  count: number;  // 单位面积下针数
  severity: number; // 超出阈值倍数
}

/**
 * 起坨检测:把花版划分成网格,统计每格下针数,超过阈值报警。
 * 经验阈值:2mm × 2mm 格内超过 10 针视为过密。
 */
export function detectDensityWarnings(
  stitches: StitchRec[],
  cellMm = 2,
  threshold = 10,
): DensityWarning[] {
  const cells = new Map<string, { x: number; y: number; count: number }>();
  for (const s of stitches) {
    if (s.flag !== Flag.Stitch) continue;
    const cx = Math.floor(s.x / cellMm), cy = Math.floor(s.y / cellMm);
    const key = cx + ',' + cy;
    let c = cells.get(key);
    if (!c) { c = { x: (cx + 0.5) * cellMm, y: (cy + 0.5) * cellMm, count: 0 }; cells.set(key, c); }
    c.count++;
  }
  const warnings: DensityWarning[] = [];
  for (const c of cells.values()) {
    if (c.count > threshold) {
      warnings.push({ x: c.x, y: c.y, count: c.count, severity: c.count / threshold });
    }
  }
  return warnings.sort((a, b) => b.severity - a.severity);
}

/** 过短针迹检测(容易断线/起坨) */
export function detectShortStitches(stitches: StitchRec[], minLenMm = 0.5): number {
  let n = 0;
  let px = 0, py = 0, first = true;
  for (const s of stitches) {
    if (s.flag !== Flag.Stitch) { if (s.flag !== Flag.Color) { px = s.x; py = s.y; } continue; }
    if (!first) {
      const d = Math.hypot(s.x - px, s.y - py);
      if (d > 1e-6 && d < minLenMm) n++;
    }
    px = s.x; py = s.y; first = false;
  }
  return n;
}

/**
 * 布面拉伸/起皱位移场:针迹把布往密集方向拉。
 * 在覆盖花版的网格上计算位移向量 = -∇(密度) × 强度,编码进 RGBA 纹理供着色器采样。
 */
export function computeDisplacementField(
  stitches: StitchRec[],
  gridSize = 64,
  strength = 1.0,
): { data: Uint8Array; size: number; bounds: { minX: number; minY: number; maxX: number; maxY: number }; maxDisp: number } {
  const b = patternBounds(stitches);
  const pad = Math.max(2, (b.maxX - b.minX) * 0.05, (b.maxY - b.minY) * 0.05);
  const bounds = { minX: b.minX - pad, minY: b.minY - pad, maxX: b.maxX + pad, maxY: b.maxY + pad };
  const w = gridSize, h = gridSize;
  const density = new Float32Array(w * h);
  const sx = (w - 1) / Math.max(1e-6, bounds.maxX - bounds.minX);
  const sy = (h - 1) / Math.max(1e-6, bounds.maxY - bounds.minY);
  for (const s of stitches) {
    if (s.flag !== Flag.Stitch) continue;
    const gx = Math.round((s.x - bounds.minX) * sx);
    const gy = Math.round((s.y - bounds.minY) * sy);
    if (gx >= 0 && gx < w && gy >= 0 && gy < h) density[gy * w + gx] += 1;
  }
  // 简单 3×3 平滑两轮
  for (let pass = 0; pass < 2; pass++) {
    const src = density.slice();
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        let sum = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) sum += src[(y + dy) * w + x + dx];
        density[y * w + x] = sum / 9;
      }
    }
  }
  // 位移 = -密度梯度 × 强度(布被拉向高密度区)
  const cellW = (bounds.maxX - bounds.minX) / (w - 1);
  const cellH = (bounds.maxY - bounds.minY) / (h - 1);
  const disp = new Float32Array(w * h * 2);
  let maxDisp = 1e-6;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const gx = (density[y * w + x + 1] - density[y * w + x - 1]) / (2 * cellW);
      const gy = (density[(y + 1) * w + x] - density[(y - 1) * w + x]) / (2 * cellH);
      const i = (y * w + x) * 2;
      disp[i] = -gx * strength * 0.15;
      disp[i + 1] = -gy * strength * 0.15;
      maxDisp = Math.max(maxDisp, Math.abs(disp[i]), Math.abs(disp[i + 1]));
    }
  }
  // 编码到 RGBA8:RG 各存一个位移分量,0.5 为零点
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = Math.round((disp[i * 2] / maxDisp / 2 + 0.5) * 255);
    data[i * 4 + 1] = Math.round((disp[i * 2 + 1] / maxDisp / 2 + 0.5) * 255);
    data[i * 4 + 2] = 0;
    data[i * 4 + 3] = 255;
  }
  return { data, size: w, bounds, maxDisp };
}

/** 每个颜色的用线量(米)。经验:面线 ≈ 针迹长 × 1.25,每次换色加 10cm 线头损耗。 */
export function threadUsagePerColor(
  stitches: StitchRec[],
  colorOfRegion: (regionIdx: number) => string,
): Map<string, { lengthM: number; stitches: number }> {
  const usage = new Map<string, { lengthM: number; stitches: number }>();
  let px = 0, py = 0, first = true;
  let curColor = '';
  for (const s of stitches) {
    if (s.flag === Flag.End) break;
    if (s.flag === Flag.Color) {
      if (curColor) {
        const u = usage.get(curColor)!;
        u.lengthM += 0.1; // 线头损耗
      }
      curColor = colorOfRegion(s.region);
      if (!usage.has(curColor)) usage.set(curColor, { lengthM: 0, stitches: 0 });
      continue;
    }
    if (s.flag === Flag.Stitch) {
      if (curColor === '') {
        curColor = colorOfRegion(s.region);
        if (!usage.has(curColor)) usage.set(curColor, { lengthM: 0, stitches: 0 });
      }
      const u = usage.get(curColor)!;
      if (!first) u.lengthM += (Math.hypot(s.x - px, s.y - py) * 1.25) / 1000;
      u.stitches++;
    }
    px = s.x; py = s.y; first = false;
  }
  return usage;
}
