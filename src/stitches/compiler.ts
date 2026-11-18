/**
 * 分区 → 针迹编译器。
 * 输入分区多边形与针法参数，输出该分区的实际针迹（不含入口连接针）。
 * 跨分区的跳针/换色标志由 compileDesign 统一挂在每个分区的首针上，
 * 保证连接语义不会因为“入口点与当前位置重合”而丢失。
 * 所有输出坐标取整为 DST 整数单位。
 */

import type { Pt, Region, RegionParams, Stitch } from '../core/types';
import { StitchFlag } from '../core/types';
import {
  dirFromAngle,
  perp,
  scanPolygon,
  unproject,
  walkPolygon,
  resamplePath,
  pointInRegion
} from '../core/geometry';
import { roundUnit } from '../core/units';
import { clampParams } from '../core/params';

export interface CompiledRegion {
  regionId: string;
  threadId: string;
  /** 本分区实际针迹（首针即连接针，由 compileDesign 赋标志） */
  stitches: Stitch[];
}

function pt(p: Pt, regionId: string, threadId: string): Stitch {
  return { x: roundUnit(p.x), y: roundUnit(p.y), flags: StitchFlag.Normal, regionId, threadId };
}

/* ---------- 平针（running stitch）：沿轮廓均匀走线 ---------- */

function compileRunning(region: Region): Stitch[] {
  const p = clampParams(region.params);
  return walkPolygon(region.polygon, p.runningStitchLength).map((q) =>
    pt(q, region.id, region.threadId)
  );
}

/* ---------- 填充类针法公共扫描 ---------- */

interface FillRow {
  offset: number;
  spans: { from: Pt; to: Pt }[];
}

function buildFillRows(region: Region, params: RegionParams): { rows: FillRow[]; d: Pt } {
  const d = dirFromAngle(params.angle);
  const n = perp(d);
  const scanned = scanPolygon(region.polygon, region.holes, d, params.rowSpacing);
  const rows: FillRow[] = scanned.map((s) => ({
    offset: s.offset,
    spans: s.ranges.map((r) => ({
      from: unproject(d, n, r.from, s.offset),
      to: unproject(d, n, r.to, s.offset)
    }))
  }));
  return { rows, d };
}

/** 拉线补偿：沿针迹方向（d）把每行两端向外延伸 pull，飞出多边形则回退 */
function applyPull(region: Region, from: Pt, to: Pt, d: Pt, pull: number): [Pt, Pt] {
  if (pull <= 0) return [from, to];
  const a = { x: from.x - d.x * pull, y: from.y - d.y * pull };
  const b = { x: to.x + d.x * pull, y: to.y + d.y * pull };
  const safeA = pointInRegion(a, region.polygon, region.holes) ? a : from;
  const safeB = pointInRegion(b, region.polygon, region.holes) ? b : to;
  return [safeA, safeB];
}

/** 超长针插入兜底针（沿线段均分） */
function splitLongStitch(a: Pt, b: Pt, maxLen: number): Pt[] {
  const segLen = Math.hypot(b.x - a.x, b.y - a.y);
  if (segLen <= maxLen) return [b];
  const pieces = Math.ceil(segLen / maxLen);
  const mid: Pt[] = [];
  for (let k = 1; k < pieces; k++) {
    const t = k / pieces;
    mid.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  }
  mid.push(b);
  return mid;
}

/* ---------- 缎纹（satin）：逐行左右往返，单行一根长针 ---------- */

/** 同分区内两个针点间隙超过该值（1mm）则抬针跳过去，避免跨孔/跨段长线 */
const INTRA_REGION_JUMP_GAP = 10;

function jumpIfGap(out: Stitch[], p: Pt, region: Region, gap: number): Stitch {
  const prev = out[out.length - 1];
  const s = pt(p, region.id, region.threadId);
  if (prev && Math.hypot(s.x - prev.x, s.y - prev.y) > gap) {
    s.flags = StitchFlag.Jump;
  }
  out.push(s);
  return s;
}

function compileSatin(region: Region): Stitch[] {
  const p = clampParams(region.params);
  const { rows, d } = buildFillRows(region, p);
  const out: Stitch[] = [];
  let forward = true;

  for (const row of rows) {
    for (const span of row.spans) {
      let [a, b] = applyPull(region, span.from, span.to, d, p.pullCompensation);
      if (!forward) [a, b] = [b, a];
      jumpIfGap(out, a, region, INTRA_REGION_JUMP_GAP);
      for (const mid of splitLongStitch(a, b, p.maxStitchLength)) {
        out.push(pt(mid, region.id, region.threadId));
      }
      forward = !forward;
    }
  }
  return out;
}

/* ---------- 榻榻米（tatami）：沿扫描方向分段打点，行间错位 ---------- */

function compileTatami(region: Region): Stitch[] {
  const p = clampParams(region.params);
  const { rows, d } = buildFillRows(region, p);
  const out: Stitch[] = [];
  let forward = true;

  rows.forEach((row, rowIdx) => {
    // 相邻行错位半个针长，形成典型榻榻米纹理
    const stagger = (rowIdx % 2) * p.tatamiStitchLength * 0.5;
    for (const span of row.spans) {
      let [a, b] = applyPull(region, span.from, span.to, d, p.pullCompensation);
      if (!forward) [a, b] = [b, a];
      const segLen = Math.hypot(b.x - a.x, b.y - a.y);
      if (segLen < 1) continue;
      const dir = { x: (b.x - a.x) / segLen, y: (b.y - a.y) / segLen };
      const path: Pt[] = [a];
      let t = stagger;
      while (t < segLen) {
        path.push({ x: a.x + dir.x * t, y: a.y + dir.y * t });
        t += p.tatamiStitchLength;
      }
      path.push(b);
      const sampled = resamplePath(path, p.tatamiStitchLength);
      for (let i = 0; i < sampled.length; i++) {
        // 与上一 span 末点重合的首点跳过，避免零长度针
        const prev = out[out.length - 1];
        if (i === 0 && prev && prev.x === roundUnit(sampled[0].x) && prev.y === roundUnit(sampled[0].y)) {
          continue;
        }
        if (i === 0) {
          jumpIfGap(out, sampled[0], region, INTRA_REGION_JUMP_GAP);
        } else {
          out.push(pt(sampled[i], region.id, region.threadId));
        }
      }
      forward = !forward;
    }
  });
  return out;
}

/* ---------- 底衬针（underlay）：稀疏垂直走向 ---------- */

function compileUnderlay(region: Region): Stitch[] {
  const p = clampParams(region.params);
  const underlayParams: RegionParams = {
    ...p,
    angle: p.angle + Math.PI / 2,
    rowSpacing: p.underlaySpacing
  };
  const { rows } = buildFillRows({ ...region, params: underlayParams }, underlayParams);
  const out: Stitch[] = [];
  let forward = true;
  for (const row of rows) {
    for (const span of row.spans) {
      const [a, b] = forward ? [span.from, span.to] : [span.to, span.from];
      jumpIfGap(out, a, region, INTRA_REGION_JUMP_GAP);
      out.push(pt(b, region.id, region.threadId));
      forward = !forward;
    }
  }
  return out;
}

/* ---------- 分区编译入口 ---------- */

export function compileRegion(region: Region): CompiledRegion {
  let stitches: Stitch[];
  switch (region.params.kind) {
    case 'running':
      stitches = compileRunning(region);
      break;
    case 'satin':
      stitches = region.params.underlay
        ? [...compileUnderlay(region), ...compileSatin(region)]
        : compileSatin(region);
      break;
    case 'tatami':
      stitches = region.params.underlay
        ? [...compileUnderlay(region), ...compileTatami(region)]
        : compileTatami(region);
      break;
  }
  return { regionId: region.id, threadId: region.threadId, stitches };
}

/**
 * 编译整份花版：按 stitchOrder 合并分区。
 * 每个分区首针承担连接语义：同色 → 跳针，异色 → 换色+跳针。
 * 首分区首点若恰在原点 (0,0)，保持普通针（零位移记录无意义）。
 */
export function compileDesign(regions: Region[], order: string[]): Stitch[] {
  const byId = new Map(regions.map((r) => [r.id, r]));
  const all: Stitch[] = [];
  let prevThread: string | null = null;
  let isFirstRegion = true;

  for (const rid of order) {
    const region = byId.get(rid);
    if (!region || !region.visible || region.polygon.length < 3) continue;
    const compiled = compileRegion(region);
    if (!compiled.stitches.length) continue;
    const first = compiled.stitches[0];

    if (isFirstRegion && first.x === 0 && first.y === 0) {
      first.flags = StitchFlag.Normal;
    } else if (prevThread !== null && region.threadId !== prevThread) {
      first.flags = StitchFlag.ColorChange | StitchFlag.Jump;
    } else {
      first.flags = StitchFlag.Jump;
    }
    all.push(...compiled.stitches);
    prevThread = region.threadId;
    isFirstRegion = false;
  }
  return all;
}
