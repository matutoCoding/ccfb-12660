// 针迹生成引擎:按分区针法/方向/密度/拉线补偿生成针迹点列,并拼装成整版绣制顺序。

import { Flag, Pattern, Region, StitchRec, Vec2 } from './types';
import { offsetPolygon, resamplePolyline, scanlineFill } from './geometry';

/** 跳针阈值:分区间移动距离超过该值(mm)用跳针,否则走针过渡 */
const JUMP_THRESHOLD = 2.0;

/** 生成单个分区的针迹点列(绝对坐标,不含跳针/换色) */
export function generateRegionStitches(region: Region): Vec2[] {
  const outline = region.pullComp !== 0
    ? offsetPolygon(region.outline, region.pullComp)
    : region.outline;
  if (outline.length < 3) return [];

  switch (region.stitchType) {
    case 'run':
      return genRun(outline, region.stitchLength);
    case 'satin':
      return genSatin(outline, region.holes, region.angle, region.density);
    case 'tatami':
      return genTatami(outline, region.holes, region.angle, region.density, region.stitchLength);
  }
}

/** 平针:沿轮廓按针距走针 */
function genRun(outline: Vec2[], stitchLength: number): Vec2[] {
  return resamplePolyline(outline, Math.max(0.5, stitchLength), true);
}

/** 缎纹:扫描线垂直于针迹方向,每条横贯线段即一针(两端下针),间距=密度 */
function genSatin(outline: Vec2[], holes: Vec2[][], angle: number, density: number): Vec2[] {
  // 缎纹的"针迹方向"是横跨方向;扫描线沿 angle 推进,线方向取 angle+90
  const lines = scanlineFill(outline, holes, angle + 90, Math.max(0.2, density));
  const pts: Vec2[] = [];
  // 按扫描线索引排序后首尾相接(之字形),相邻行共享端点侧,减少跳线
  lines.sort((a, b) => a.lineIndex - b.lineIndex);
  let flip = false;
  for (const l of lines) {
    if (flip) pts.push(l.q, l.p);
    else pts.push(l.p, l.q);
    flip = !flip;
  }
  return pts;
}

/** 榻榻米:平行扫描线来回填针,行距=密度,行内按针迹长度下针,奇偶行错位半针 */
function genTatami(outline: Vec2[], holes: Vec2[][], angle: number, density: number, stitchLength: number): Vec2[] {
  const spacing = Math.max(0.2, density);
  const step = Math.max(1.0, stitchLength);
  const lines = scanlineFill(outline, holes, angle, spacing);
  lines.sort((a, b) => a.lineIndex - b.lineIndex);
  const pts: Vec2[] = [];
  let rowIdx = 0;
  for (const l of lines) {
    // 蛇形:偶数行正走,奇数行反走
    const forward = rowIdx % 2 === 0;
    const from = forward ? l.p : l.q;
    const to = forward ? l.q : l.p;
    const len = Math.hypot(to.x - from.x, to.y - from.y);
    const n = Math.max(1, Math.round(len / step));
    // 奇数行错位半个针距,避免针孔成行
    const offset = rowIdx % 2 === 0 ? 0 : 0.5;
    for (let i = 0; i <= n; i++) {
      const t = Math.min(1, (i + offset) / n);
      if (t >= 1 && i < n) continue;
      pts.push({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
    }
    rowIdx++;
  }
  return pts;
}

/**
 * 拼装整版针迹序列:按分区顺序,分区之间自动跳过/走针,颜色变化插入换色记录。
 * 这是仿真与 DST 导出的唯一数据源,保证顺序一致。
 */
export function buildPatternStitches(pattern: Pattern): StitchRec[] {
  const out: StitchRec[] = [];
  let cur: Vec2 = { x: 0, y: 0 };
  let curColor: string | null = null;

  pattern.regions.forEach((region, ri) => {
    const pts = generateRegionStitches(region);
    if (pts.length === 0) return;

    if (curColor !== null && curColor !== region.colorId) {
      out.push({ x: cur.x, y: cur.y, flag: Flag.Color, region: ri });
    }
    curColor = region.colorId;

    // 过渡到分区起点
    const d = Math.hypot(pts[0].x - cur.x, pts[0].y - cur.y);
    if (d > 1e-6) {
      if (d > JUMP_THRESHOLD) {
        out.push({ x: pts[0].x, y: pts[0].y, flag: Flag.Jump, region: ri });
      } else {
        // 短距离走针过渡,按针距补点
        const n = Math.ceil(d / 3);
        for (let i = 1; i <= n; i++) {
          out.push({
            x: cur.x + ((pts[0].x - cur.x) * i) / n,
            y: cur.y + ((pts[0].y - cur.y) * i) / n,
            flag: Flag.Stitch,
            region: ri,
          });
        }
      }
    }
    for (const p of pts) out.push({ x: p.x, y: p.y, flag: Flag.Stitch, region: ri });
    cur = pts[pts.length - 1];
  });

  out.push({ x: cur.x, y: cur.y, flag: Flag.End, region: -1 });
  return out;
}

/** 重新生成并写回 pattern.stitches */
export function regenerate(pattern: Pattern): void {
  pattern.stitches = buildPatternStitches(pattern);
  pattern.updatedAt = Date.now();
}
