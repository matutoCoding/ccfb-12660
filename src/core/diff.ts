// 版本对比：两版针迹差异（按 0.1mm 量化坐标比较）

import type { SimRecord } from './types';

export interface StitchDiff {
  onlyA: { x: number; y: number }[]; // 仅 A 版有的针点
  onlyB: { x: number; y: number }[]; // 仅 B 版有的针点
  common: number;                    // 共同针点数
}

const keyOf = (r: { x: number; y: number }) => `${Math.round(r.x * 10)},${Math.round(r.y * 10)}`;

export function diffRecords(a: SimRecord[], b: SimRecord[]): StitchDiff {
  const countA = new Map<string, number>();
  const countB = new Map<string, number>();
  for (const r of a) {
    if (r.flag !== 'stitch') continue;
    const k = keyOf(r);
    countA.set(k, (countA.get(k) ?? 0) + 1);
  }
  for (const r of b) {
    if (r.flag !== 'stitch') continue;
    const k = keyOf(r);
    countB.set(k, (countB.get(k) ?? 0) + 1);
  }
  const onlyA: { x: number; y: number }[] = [];
  const onlyB: { x: number; y: number }[] = [];
  let common = 0;
  for (const [k, n] of countA) {
    const m = countB.get(k) ?? 0;
    common += Math.min(n, m);
    if (n > m) {
      const [x, y] = k.split(',').map(Number);
      for (let i = 0; i < n - m; i++) onlyA.push({ x: x / 10, y: y / 10 });
    }
  }
  for (const [k, n] of countB) {
    const m = countA.get(k) ?? 0;
    if (n > m) {
      const [x, y] = k.split(',').map(Number);
      for (let i = 0; i < n - m; i++) onlyB.push({ x: x / 10, y: y / 10 });
    }
  }
  return { onlyA, onlyB, common };
}
