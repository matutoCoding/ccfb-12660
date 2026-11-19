import { describe, it, expect } from 'vitest';
import { generateRegionStitches, buildPatternStitches } from '../src/core/stitchgen';
import { createPattern, createRegion, Flag, Vec2 } from '../src/core/types';

function square(cx: number, cy: number, size: number): Vec2[] {
  const h = size / 2;
  return [
    { x: cx - h, y: cy - h },
    { x: cx + h, y: cy - h },
    { x: cx + h, y: cy + h },
    { x: cx - h, y: cy + h },
  ];
}

describe('针迹生成', () => {
  it('榻榻米:针迹点都在分区内,行距≈密度', () => {
    const r = createRegion({ outline: square(0, 0, 20), stitchType: 'tatami', angle: 0, density: 0.5, stitchLength: 3, pullComp: 0 });
    const pts = generateRegionStitches(r);
    expect(pts.length).toBeGreaterThan(100);
    for (const p of pts) {
      expect(Math.abs(p.x)).toBeLessThanOrEqual(10.01);
      expect(Math.abs(p.y)).toBeLessThanOrEqual(10.01);
    }
    // 行数 ≈ 高度 / 行距
    const rows = new Set(pts.map(p => Math.round(p.y / 0.5)));
    expect(rows.size).toBeGreaterThanOrEqual(38);
    expect(rows.size).toBeLessThanOrEqual(42);
  });

  it('缎纹:针迹横跨方向垂直于设定角度', () => {
    const r = createRegion({ outline: square(0, 0, 10), stitchType: 'satin', angle: 0, density: 0.4, pullComp: 0 });
    const pts = generateRegionStitches(r);
    expect(pts.length).toBeGreaterThan(10);
    // angle=0 → 扫描线方向 90°,每针对 (p,q) 应沿 Y 方向
    const dx = Math.abs(pts[1].x - pts[0].x);
    const dy = Math.abs(pts[1].y - pts[0].y);
    expect(dy).toBeGreaterThan(dx);
  });

  it('拉线补偿:轮廓外扩', () => {
    const base = createRegion({ outline: square(0, 0, 10), stitchType: 'run', stitchLength: 2, pullComp: 0 });
    const comp = createRegion({ outline: square(0, 0, 10), stitchType: 'run', stitchLength: 2, pullComp: 0.5 });
    const p0 = generateRegionStitches(base);
    const p1 = generateRegionStitches(comp);
    const maxX0 = Math.max(...p0.map(p => p.x));
    const maxX1 = Math.max(...p1.map(p => p.x));
    expect(maxX1).toBeGreaterThan(maxX0 + 0.3);
  });

  it('整版拼装:顺序=分区顺序,换色与跳针插入正确', () => {
    const pat = createPattern('t');
    pat.regions = [
      createRegion({ outline: square(0, 0, 10), colorId: 'A', stitchType: 'run', stitchLength: 2, pullComp: 0 }),
      createRegion({ outline: square(100, 0, 10), colorId: 'A', stitchType: 'run', stitchLength: 2, pullComp: 0 }),
      createRegion({ outline: square(0, 100, 10), colorId: 'B', stitchType: 'run', stitchLength: 2, pullComp: 0 }),
    ];
    const stitches = buildPatternStitches(pat);

    // 恰好 1 次换色(A→B),远距离分区之间是跳针
    const colors = stitches.filter(s => s.flag === Flag.Color);
    expect(colors.length).toBe(1);
    const jumps = stitches.filter(s => s.flag === Flag.Jump);
    expect(jumps.length).toBeGreaterThanOrEqual(2);

    // 换色必须出现在第二个分区(远处同色)绣完之后:
    // 换色记录前的针迹不应包含第三个分区的 y≈100 区域的点
    const colorIdx = stitches.findIndex(s => s.flag === Flag.Color);
    const before = stitches.slice(0, colorIdx).filter(s => s.flag === Flag.Stitch);
    const after = stitches.slice(colorIdx).filter(s => s.flag === Flag.Stitch);
    expect(Math.max(...before.map(s => s.y))).toBeLessThan(50);
    expect(Math.max(...after.map(s => s.y))).toBeGreaterThan(90);

    // 最后一条是 End
    expect(stitches[stitches.length - 1].flag).toBe(Flag.End);
  });

  it('孔洞:榻榻米针迹避开孔洞', () => {
    const r = createRegion({
      outline: square(0, 0, 20),
      holes: [square(0, 0, 8)],
      stitchType: 'tatami', angle: 0, density: 0.5, stitchLength: 3, pullComp: 0,
    });
    const pts = generateRegionStitches(r);
    for (const p of pts) {
      const inHole = Math.abs(p.x) < 3.9 && Math.abs(p.y) < 3.9;
      expect(inHole).toBe(false);
    }
  });
});
