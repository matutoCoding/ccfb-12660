// DST 记录 → 分区（导入用）：按跳针/换色切块，针点原样保留，保证与文件一致

import type { Region, SimRecord, Vec2 } from './types';
import { uid } from './types';
import { DEFAULT_THREAD_SEQUENCE } from './threadlib';
import { boundsOf, ensureCCW } from './geometry';

export function recordsToRegions(records: SimRecord[]): Region[] {
  const regions: Region[] = [];
  let current: Vec2[] = [];
  let colorIdx = -1;

  const flush = () => {
    if (current.length === 0) return;
    const pts = current;
    current = [];
    const b = boundsOf(pts);
    // 外接框作为轮廓（仅用于选择/显示，针迹以 points 为准）
    const polygon = ensureCCW([
      { x: b.minX, y: b.minY },
      { x: b.maxX, y: b.minY },
      { x: b.maxX, y: b.maxY },
      { x: b.minX, y: b.maxY },
    ]);
    const colorId = DEFAULT_THREAD_SEQUENCE[Math.max(0, colorIdx) % DEFAULT_THREAD_SEQUENCE.length];
    regions.push({
      id: uid(),
      name: `DST 针迹块 ${regions.length + 1}`,
      polygon,
      source: 'dst',
      points: pts,
      stitchType: 'run',
      angle: 0,
      spacing: 0.4,
      stitchLength: 2.5,
      pullComp: 0,
      colorId,
    });
  };

  for (const r of records) {
    if (r.flag === 'color') {
      flush();
      colorIdx++;
    } else if (r.flag === 'jump') {
      flush();
    } else {
      current.push({ x: r.x, y: r.y });
    }
  }
  flush();
  return regions;
}
