/**
 * 自动绣制顺序排程。
 * 目标：先按线色归组以最小化换色次数，组间/组内用最近邻降低跳针距离。
 */

import type { Pt, Region } from './types';
import { polygonCentroid, distPt } from './geometry';

export interface ScheduleResult {
  order: string[];
  colorChanges: number;
  totalJumpDistance: number;
}

/** 贪心：颜色分组 + 最近邻，起始点为原点（机台停车位置） */
export function autoSchedule(regions: Region[]): ScheduleResult {
  const visible = regions.filter((r) => r.visible && r.polygon.length >= 3);
  const centroids = new Map<string, Pt>();
  for (const r of visible) centroids.set(r.id, polygonCentroid(r.polygon));

  // 按线色稳定分组（保留首次出现顺序，减少意外重排）
  const colorGroups: { threadId: string; ids: string[] }[] = [];
  for (const r of visible) {
    let g = colorGroups.find((x) => x.threadId === r.threadId);
    if (!g) {
      g = { threadId: r.threadId, ids: [] };
      colorGroups.push(g);
    }
    g.ids.push(r.id);
  }

  const order: string[] = [];
  let cursor: Pt = { x: 0, y: 0 };
  let totalJumpDistance = 0;
  let colorChanges = 0;
  let prevThread: string | null = null;

  // 组顺序也按“组内最近点离当前位置最近”来选，进一步压缩跳针
  const remainingGroups = [...colorGroups];
  while (remainingGroups.length) {
    let bestGroupIdx = 0;
    let bestDist = Infinity;
    remainingGroups.forEach((g, idx) => {
      const nearest = Math.min(...g.ids.map((id) => distPt(cursor, centroids.get(id)!)));
      if (nearest < bestDist) {
        bestDist = nearest;
        bestGroupIdx = idx;
      }
    });
    const group = remainingGroups.splice(bestGroupIdx, 1)[0];
    if (prevThread !== null && group.threadId !== prevThread) colorChanges++;

    // 组内最近邻
    const pool = new Set(group.ids);
    while (pool.size) {
      let next: string | null = null;
      let nd = Infinity;
      for (const id of pool) {
        const d = distPt(cursor, centroids.get(id)!);
        if (d < nd) {
          nd = d;
          next = id;
        }
      }
      if (!next) break;
      pool.delete(next);
      order.push(next);
      totalJumpDistance += nd;
      cursor = centroids.get(next)!;
    }
    prevThread = group.threadId;
  }

  return { order, colorChanges, totalJumpDistance };
}

/** 手动调整：把 order 中的 id 上移/下移一位 */
export function moveInOrder(order: string[], id: string, delta: -1 | 1): string[] {
  const idx = order.indexOf(id);
  const target = idx + delta;
  if (idx < 0 || target < 0 || target >= order.length) return order;
  const next = [...order];
  [next[idx], next[target]] = [next[target], next[idx]];
  return next;
}
