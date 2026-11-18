/**
 * 拼版与生产单计算测试。
 */

import { describe, it, expect } from 'vitest';
import { autoNest, composeSheet, computeSheetUsage, buildPatternSvg, stitchesOf } from '../src/production/nesting';
import { compileDesign } from '../src/stitches/compiler';
import { defaultParams } from '../src/core/params';
import { mmToUnit } from '../src/core/units';
import type { Design, Region } from '../src/core/types';
import { StitchFlag } from '../src/core/types';

function makeDesign(id: string, w: number, h: number, threadId: string): Design {
  const region: Region = {
    id: `${id}_r`,
    name: 'r',
    polygon: [
      { x: 0, y: 0 },
      { x: w, y: 0 },
      { x: w, y: h },
      { x: 0, y: h }
    ],
    holes: [],
    threadId,
    params: defaultParams('tatami'),
    visible: true
  };
  return {
    id,
    name: id,
    createdAt: 0,
    updatedAt: 0,
    width: w,
    height: h,
    regions: [region],
    stitchOrder: [region.id],
    importedStitches: null,
    version: 1
  };
}

describe('自动拼版', () => {
  it('按份数生成对应数量的拼版项，带间距排列', () => {
    const d = makeDesign('a', mmToUnit(50), mmToUnit(50), 't1');
    const result = autoNest([d], [{ design: d, copies: 3 }], 10);
    expect(result.items.length).toBe(3);
    // 第二项 x = 宽度 + 间距
    expect(result.items[1].x).toBe(mmToUnit(50) + mmToUnit(10));
    expect(result.items.every((it) => it.y === 0)).toBe(true);
  });

  it('超过幅宽限制自动换行', () => {
    const d = makeDesign('a', mmToUnit(300), mmToUnit(100), 't1');
    const result = autoNest([d], [{ design: d, copies: 4 }], 10);
    const rows = new Set(result.items.map((it) => it.y));
    expect(rows.size).toBeGreaterThan(1);
    expect(result.sheetHeight).toBeGreaterThan(0);
  });
});

describe('拼版针迹合成', () => {
  it('各花版针迹平移到拼版坐标，总针数等于各版之和', () => {
    const d1 = makeDesign('a', mmToUnit(20), mmToUnit(20), 't1');
    const d2 = makeDesign('b', mmToUnit(20), mmToUnit(20), 't2');
    const nested = autoNest([d1, d2], [
      { design: d1, copies: 1 },
      { design: d2, copies: 1 }
    ]);
    const placed = nested.items.map((item) => {
      const design = [d1, d2].find((x) => x.id === item.designId)!;
      return { item, design, stitches: stitchesOf(design) };
    });
    const combined = composeSheet(placed);
    const expected = placed.reduce((s, p) => s + p.stitches.length, 0);
    expect(combined.length).toBe(expected);
    // 第二版针迹整体右移，x 坐标整体偏大
    const second = combined.filter((s) => s.threadId === 't2');
    expect(Math.min(...second.map((s) => s.x))).toBeGreaterThan(mmToUnit(20));
  });

  it('用线量按色汇总，跳针不计入', () => {
    const d = makeDesign('a', mmToUnit(20), mmToUnit(20), 't1');
    const sts = compileDesign(d.regions, d.stitchOrder);
    const usage = computeSheetUsage(sts);
    expect(usage.length).toBeGreaterThan(0);
    const total = usage.reduce((s, u) => s + u.length, 0);
    // 手工核对：缝制长度应等于非跳针段长度和
    let manual = 0;
    for (let i = 1; i < sts.length; i++) {
      if (sts[i].flags & StitchFlag.Jump) continue;
      manual += Math.hypot(sts[i].x - sts[i - 1].x, sts[i].y - sts[i - 1].y);
    }
    expect(total).toBeCloseTo(manual, 4);
  });
});

describe('纸样 SVG 导出', () => {
  it('生成合法 SVG，含尺寸标注与针迹线', () => {
    const d = makeDesign('a', mmToUnit(30), mmToUnit(20), 't1');
    const sts = stitchesOf(d);
    const names = new Map([['t1', '测试线']]);
    const svg = buildPatternSvg(sts, d.width, d.height, () => '#d23b3b', names);
    expect(svg.startsWith('<?xml')).toBe(true);
    expect(svg).toContain('<svg');
    expect(svg).toContain('30.0 mm');
    expect(svg).toContain('<line');
    expect(svg).toContain('测试线');
  });
});
