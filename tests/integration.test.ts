import { describe, it, expect } from 'vitest';
import { createPattern, createRegion, Flag } from '../src/core/types';
import { buildPatternStitches } from '../src/core/stitchgen';
import { writeDst, parseDst } from '../src/core/dst';

describe('生成 → 导出 DST → 重新导入:走针顺序一致', () => {
  it('导入后的针迹序列与原始生成序列逐步对应', () => {
    const pat = createPattern('集成');
    pat.regions = [
      createRegion({
        name: 'r1',
        outline: [{ x: 0, y: 0 }, { x: 15, y: 0 }, { x: 15, y: 8 }, { x: 0, y: 8 }],
        stitchType: 'tatami', angle: 30, density: 0.6, stitchLength: 3, pullComp: 0.2, colorId: 'T1800',
      }),
      createRegion({
        name: 'r2',
        outline: [{ x: 40, y: 20 }, { x: 55, y: 20 }, { x: 55, y: 30 }, { x: 40, y: 30 }],
        stitchType: 'satin', angle: 90, density: 0.4, stitchLength: 3, pullComp: 0, colorId: 'T1410',
      }),
    ];
    const original = buildPatternStitches(pat);
    const reimported = parseDst(writeDst(pat.name, original)).stitches;

    // 关键不变量:普通针迹的相对顺序与坐标(0.1mm 精度)一致。
    // DST 导出会把 >12.1mm 的长位移拆分,因此用"顺序子序列 + 终点汇合"校验:
    // 原始序列中每条记录的目标点,必须按同样顺序出现在重导入序列中。
    let j = 0;
    let matched = 0;
    for (const want of original) {
      if (want.flag === Flag.End) continue;
      let found = false;
      for (; j < reimported.length; j++) {
        const got = reimported[j];
        if (Math.abs(got.x - want.x) < 0.051 && Math.abs(got.y - want.y) < 0.051) {
          // 换色/跳针标志必须严格一致;普通针迹允许拆分后汇合于终点
          if (want.flag === Flag.Stitch || got.flag === want.flag) { found = true; j++; break; }
        }
      }
      if (found) matched++;
    }
    const total = original.filter(s => s.flag !== Flag.End).length;
    expect(matched).toBe(total);

    // 换色次数、跳针次数一致
    const count = (arr: typeof original, f: Flag) => arr.filter(s => s.flag === f).length;
    expect(count(reimported, Flag.Color)).toBe(count(original, Flag.Color));
    // 跳针:原始的长跳针可能被拆分,但短跳针(≤12.1mm)数量不变
    const shortJumps = original.filter((s, i) => {
      if (s.flag !== Flag.Jump) return false;
      const prev = original[i - 1] ?? { x: 0, y: 0 };
      return Math.hypot(s.x - prev.x, s.y - prev.y) <= 12.1;
    }).length;
    expect(count(reimported, Flag.Jump)).toBeGreaterThanOrEqual(shortJumps);
  });
});
