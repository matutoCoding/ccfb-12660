// 针迹生成：平针 / 缎纹 / 榻榻米，以及整版针迹计划（含跳针、换色、统计、起坨检测）

import type {
  Region,
  StitchPlan,
  StitchBlock,
  SimRecord,
  PlanStats,
  Vec2,
  ColorStat,
} from './types';
import {
  rad,
  rotatePoint,
  boundsOf,
  offsetPolygon,
  scanlineX,
  scanlineY,
  resamplePolyline,
  centroidOf,
  dist,
  ensureCCW,
} from './geometry';

const MAX_SATIN_SPAN = 10; // mm，缎纹跨距超过则自动分割
const MIN_ROW_SPACING = 0.2;

/** 单个分区生成针迹点列（mm，绝对坐标） */
export function generateRegionStitches(region: Region): Vec2[] {
  // DST 导入的分区：针迹直接来自文件，不重算，保证与文件一致
  if (region.source === 'dst' && region.points && region.points.length > 0) {
    return region.points;
  }
  const poly =
    region.pullComp > 0
      ? offsetPolygon(ensureCCW(region.polygon), region.pullComp)
      : ensureCCW(region.polygon);
  if (poly.length < 3) return [];
  const spacing = Math.max(MIN_ROW_SPACING, region.spacing);
  switch (region.stitchType) {
    case 'run':
      return runStitches(poly, Math.max(0.5, region.stitchLength));
    case 'satin':
      return satinStitches(poly, region.angle, spacing);
    case 'tatami':
      return tatamiStitches(poly, region.angle, spacing, Math.max(1, region.stitchLength));
  }
}

/** 平针：沿轮廓等距走针 */
function runStitches(poly: Vec2[], stitchLength: number): Vec2[] {
  return resamplePolyline(poly, stitchLength, true);
}

/** 缎纹：垂直于流向的扫描线，左右交错扎针；超宽自动分割 */
function satinStitches(poly: Vec2[], angleDeg: number, spacing: number): Vec2[] {
  const a = rad(angleDeg);
  const rotated = poly.map((p) => rotatePoint(p, -a));
  const b = boundsOf(rotated);
  const pts: Vec2[] = [];
  let flip = false;
  for (let x = b.minX + spacing / 2; x < b.maxX; x += spacing) {
    const ys = scanlineX(rotated, x);
    for (let i = 0; i + 1 < ys.length; i += 2) {
      let y0 = ys[i];
      let y1 = ys[i + 1];
      if (flip) [y0, y1] = [y1, y0];
      const span = Math.abs(y1 - y0);
      if (span > MAX_SATIN_SPAN) {
        // 自动分割：中间加过渡针，避免超长跨距
        const n = Math.ceil(span / MAX_SATIN_SPAN);
        for (let k = 0; k < n; k++) {
          const ya = y0 + ((y1 - y0) * k) / n;
          const yb = y0 + ((y1 - y0) * (k + 1)) / n;
          const xo = x + (k % 2 === 0 ? 0 : spacing * 0.4);
          pts.push(rotatePoint({ x: xo, y: ya }, a));
          pts.push(rotatePoint({ x: xo, y: yb }, a));
        }
      } else {
        pts.push(rotatePoint({ x, y: y0 }, a));
        pts.push(rotatePoint({ x, y: y1 }, a));
      }
      flip = !flip;
    }
  }
  return pts;
}

/** 榻榻米：按流向的扫描行，行内等距针、行向交错、错针排列 */
function tatamiStitches(poly: Vec2[], angleDeg: number, spacing: number, stitchLength: number): Vec2[] {
  const a = rad(angleDeg);
  const rotated = poly.map((p) => rotatePoint(p, -a));
  const b = boundsOf(rotated);
  const pts: Vec2[] = [];
  let rowIdx = 0;
  for (let y = b.minY + spacing / 2; y < b.maxY; y += spacing) {
    const xs = scanlineY(rotated, y);
    const leftToRight = rowIdx % 2 === 0;
    const offset = (rowIdx % 2) * (stitchLength / 2); // 错针，避免成行针孔
    const segs: [number, number][] = [];
    for (let i = 0; i + 1 < xs.length; i += 2) segs.push([xs[i], xs[i + 1]]);
    if (!leftToRight) segs.reverse();
    for (const seg of segs) {
      const [x0, x1] = leftToRight ? seg : [seg[1], seg[0]];
      const dir = Math.sign(x1 - x0) || 1;
      const length = Math.abs(x1 - x0);
      let x = x0 + dir * Math.min(offset, length * 0.5);
      pts.push(rotatePoint({ x: x0, y }, a));
      while (dir > 0 ? x < x1 : x > x1) {
        pts.push(rotatePoint({ x, y }, a));
        x += dir * stitchLength;
      }
      pts.push(rotatePoint({ x: x1, y }, a));
    }
    rowIdx++;
  }
  return pts;
}

/**
 * 自动排绣制顺序：先按颜色分组（减少换色），同色内最近邻贪心（减少跳针）。
 */
export function optimizeRegionOrder(regions: Region[]): Region[] {
  const groups = new Map<string, Region[]>();
  for (const r of regions) {
    const g = groups.get(r.colorId) ?? [];
    g.push(r);
    groups.set(r.colorId, g);
  }
  const ordered: Region[] = [];
  let cursor: Vec2 = { x: 0, y: 0 };
  const remaining = [...groups.values()];
  while (remaining.length > 0) {
    // 选首针离当前位置最近的色组
    let bestGi = 0;
    let bestD = Infinity;
    for (let gi = 0; gi < remaining.length; gi++) {
      for (const r of remaining[gi]) {
        const d = dist(cursor, centroidOf(r.polygon));
        if (d < bestD) {
          bestD = d;
          bestGi = gi;
        }
      }
    }
    const group = remaining.splice(bestGi, 1)[0];
    // 组内最近邻
    const rest = [...group];
    while (rest.length > 0) {
      let bi = 0;
      let bd = Infinity;
      for (let i = 0; i < rest.length; i++) {
        const d = dist(cursor, centroidOf(rest[i].polygon));
        if (d < bd) {
          bd = d;
          bi = i;
        }
      }
      const next = rest.splice(bi, 1)[0];
      ordered.push(next);
      cursor = centroidOf(next.polygon);
    }
  }
  return ordered;
}

export interface PlanOptions {
  spm?: number; // 机器速度（针/分钟），用于工时估算
}

/** 由分区序列生成整版针迹计划 */
export function buildPlan(regions: Region[], opts: PlanOptions = {}): StitchPlan {
  const spm = opts.spm ?? 800;
  const blocks: StitchBlock[] = [];
  const records: SimRecord[] = [];
  const perColor = new Map<string, ColorStat>();

  let cur: Vec2 = { x: 0, y: 0 };
  let curColor: string | null = null;
  let stitches = 0;
  let jumps = 0;
  let colorChanges = 0;
  let lengthMm = 0;

  regions.forEach((region, bi) => {
    const pts = generateRegionStitches(region);
    if (pts.length === 0) return;
    blocks.push({ regionId: region.id, colorId: region.colorId, points: pts });

    if (region.colorId !== curColor) {
      records.push({ x: cur.x, y: cur.y, flag: 'color', block: bi });
      colorChanges++;
      curColor = region.colorId;
    }
    if (dist(cur, pts[0]) > 0.2) {
      records.push({ x: pts[0].x, y: pts[0].y, flag: 'jump', block: bi });
      jumps++;
    }
    let stat = perColor.get(region.colorId);
    if (!stat) {
      stat = { colorId: region.colorId, stitches: 0, lengthMm: 0 };
      perColor.set(region.colorId, stat);
    }
    for (const p of pts) {
      const segLen = dist(cur, p);
      records.push({ x: p.x, y: p.y, flag: 'stitch', block: bi });
      stitches++;
      lengthMm += segLen;
      stat.stitches++;
      stat.lengthMm += segLen;
      cur = p;
    }
  });

  const estSeconds =
    (stitches / spm) * 60 + colorChanges * 8 + jumps * 2;

  const stats: PlanStats = {
    stitches,
    jumps,
    colorChanges,
    lengthMm,
    estSeconds,
    perColor: [...perColor.values()],
  };

  const hotspots = findHotspots(records);

  return { blocks, records, stats, hotspots };
}

/**
 * 起坨检测：统计每个 1mm 网格附近的落针密度，超过阈值的位置报警。
 * 榻榻米正常约 0.6 针/mm²，缎纹约 5 针/mm²，重叠或密度过大才会超阈值。
 */
export function findHotspots(records: SimRecord[], perMm2 = 7): Vec2[] {
  const cell = 1; // mm
  const grid = new Map<string, { count: number; x: number; y: number }>();
  for (const r of records) {
    if (r.flag !== 'stitch') continue;
    const k = `${Math.floor(r.x / cell)},${Math.floor(r.y / cell)}`;
    const c = grid.get(k);
    if (c) c.count++;
    else grid.set(k, { count: 1, x: r.x, y: r.y });
  }
  const out: Vec2[] = [];
  const threshold = perMm2 * 9; // 3x3 邻域
  for (const [k, c] of grid) {
    const [gx, gy] = k.split(',').map(Number);
    let sum = 0;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        sum += grid.get(`${gx + dx},${gy + dy}`)?.count ?? 0;
      }
    }
    if (sum > threshold) out.push({ x: c.x, y: c.y });
  }
  // 合并相邻告警点，避免满屏红点
  const merged: Vec2[] = [];
  for (const p of out) {
    if (!merged.some((m) => dist(m, p) < 3)) merged.push(p);
    if (merged.length >= 200) break;
  }
  return merged;
}
