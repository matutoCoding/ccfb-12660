import { describe, it, expect } from 'vitest';
import { compileRegion, compileDesign } from '../src/stitches/compiler';
import { defaultParams } from '../src/core/params';
import { StitchFlag, type Pt, type Region } from '../src/core/types';
import { mmToUnit } from '../src/core/units';

function rectRegion(overrides: Partial<Region> = {}): Region {
  const w = mmToUnit(20);
  const h = mmToUnit(10);
  return {
    id: 'r1',
    name: '矩形',
    polygon: [
      { x: 0, y: 0 },
      { x: w, y: 0 },
      { x: w, y: h },
      { x: 0, y: h }
    ],
    holes: [],
    threadId: 't1',
    params: defaultParams('satin'),
    visible: true,
    ...overrides
  };
}

describe('分区针法编译', () => {
  it('平针：沿轮廓产生针迹，全部为普通针，且带分区与线色归属', () => {
    const r = rectRegion({ params: defaultParams('running') });
    const out = compileRegion(r);
    expect(out.stitches.length).toBeGreaterThan(4);
    for (const s of out.stitches) {
      expect(s.flags).toBe(StitchFlag.Normal);
    }
    expect(out.stitches.every((s) => s.regionId === 'r1' && s.threadId === 't1')).toBe(true);
  });

  it('缎纹：针迹行数与行距成反比，密度调密针数变多', () => {
    const sparse = compileRegion(rectRegion({ params: { ...defaultParams('satin'), rowSpacing: mmToUnit(1) } }));
    const dense = compileRegion(rectRegion({ params: { ...defaultParams('satin'), rowSpacing: mmToUnit(0.3) } }));
    expect(dense.stitches.length).toBeGreaterThan(sparse.stitches.length);
  });

  it('榻榻米：针距变大针数变少', () => {
    const fine = compileRegion(rectRegion({ params: { ...defaultParams('tatami'), tatamiStitchLength: mmToUnit(2) } }));
    const coarse = compileRegion(rectRegion({ params: { ...defaultParams('tatami'), tatamiStitchLength: mmToUnit(6) } }));
    expect(fine.stitches.length).toBeGreaterThan(coarse.stitches.length);
  });

  it('所有输出坐标为整数（DST 单位）', () => {
    for (const kind of ['running', 'satin', 'tatami'] as const) {
      const r = rectRegion({
        id: kind,
        params: { ...defaultParams(kind), angle: 0.37 } // 非正交角度强制浮点中间量
      });
      const out = compileRegion(r);
      for (const s of out.stitches) {
        expect(Number.isInteger(s.x)).toBe(true);
        expect(Number.isInteger(s.y)).toBe(true);
      }
    }
  });

  it('旋转针迹方向后针点仍全部落在多边形内', () => {
    const r = rectRegion({ params: { ...defaultParams('satin'), angle: Math.PI / 3 } });
    const out = compileRegion(r);
    const poly = r.polygon;
    for (const s of out.stitches) {
      // 矩形范围判定（含拉线补偿余量 1mm）
      const margin = mmToUnit(1);
      expect(s.x).toBeGreaterThanOrEqual(-margin);
      expect(s.x).toBeLessThanOrEqual(mmToUnit(20) + margin);
      expect(s.y).toBeGreaterThanOrEqual(-margin);
      expect(s.y).toBeLessThanOrEqual(mmToUnit(10) + margin);
    }
    expect(out.stitches.length).toBeGreaterThan(0);
    void poly;
  });

  it('孔洞区域不产生针迹、实际缝制线长更短，且跨孔走跳针', () => {
    const outer = rectRegion();
    const hole: Pt[] = [
      { x: mmToUnit(8), y: mmToUnit(3) },
      { x: mmToUnit(12), y: mmToUnit(3) },
      { x: mmToUnit(12), y: mmToUnit(7) },
      { x: mmToUnit(8), y: mmToUnit(7) }
    ];
    const withHole = rectRegion({ holes: [hole] });
    const a = compileRegion(outer).stitches;
    const b = compileRegion(withHole).stitches;
    // 实际缝制线长（排除跳针空走）
    const sewingLen = (sts: { x: number; y: number; flags: StitchFlag }[]) => {
      let total = 0;
      for (let i = 1; i < sts.length; i++) {
        if (sts[i].flags & StitchFlag.Jump) continue;
        total += Math.hypot(sts[i].x - sts[i - 1].x, sts[i].y - sts[i - 1].y);
      }
      return total;
    };
    expect(sewingLen(b)).toBeLessThan(sewingLen(a));
    // 孔内无普通针
    const insideHole = b.filter(
      (s) =>
        s.x > hole[0].x &&
        s.x < hole[1].x &&
        s.y > hole[0].y &&
        s.y < hole[2].y &&
        !(s.flags & StitchFlag.Jump)
    );
    expect(insideHole.length).toBe(0);
    // 存在跨孔跳针
    expect(b.some((s) => s.flags & StitchFlag.Jump)).toBe(true);
  });

  it('底衬针开启后针数增加', () => {
    const noUl = compileRegion(rectRegion({ params: { ...defaultParams('satin'), underlay: false } }));
    const ul = compileRegion(rectRegion({ params: { ...defaultParams('satin'), underlay: true } }));
    expect(ul.stitches.length).toBeGreaterThan(noUl.stitches.length);
  });

  it('回归：完全位于负坐标区的多边形也能生成针迹', () => {
    const off = mmToUnit(-50);
    const negative = rectRegion({
      id: 'neg',
      polygon: rectRegion().polygon.map((p) => ({ x: p.x + off, y: p.y + off }))
    });
    for (const kind of ['running', 'satin', 'tatami'] as const) {
      const out = compileRegion({ ...negative, params: defaultParams(kind) });
      expect(out.stitches.length, `针法 ${kind} 在负坐标区不应为空`).toBeGreaterThan(0);
      expect(out.stitches.every((s) => s.x < 0 && s.y < 0)).toBe(true);
    }
  });

  it('回归：包围原点的多边形针迹覆盖正负两侧', () => {
    const half = mmToUnit(10);
    const centered = rectRegion({
      id: 'center',
      polygon: [
        { x: -half, y: -half },
        { x: half, y: -half },
        { x: half, y: half },
        { x: -half, y: half }
      ]
    });
    const out = compileRegion(centered);
    const xs = out.stitches.map((s) => s.x);
    expect(Math.min(...xs)).toBeLessThan(0);
    expect(Math.max(...xs)).toBeGreaterThan(0);
    expect(xs.filter((x) => x < 0).length).toBeGreaterThan(5);
    expect(xs.filter((x) => x > 0).length).toBeGreaterThan(5);
  });
});

describe('整版编译与绣制顺序', () => {
  it('跨色分区插入换色点，同色分区只跳针', () => {
    const r1 = rectRegion({ id: 'a', threadId: 'red' });
    const r2 = rectRegion({
      id: 'b',
      threadId: 'blue',
      polygon: rectRegion().polygon.map((p) => ({ x: p.x + mmToUnit(40), y: p.y }))
    });
    const r3 = rectRegion({
      id: 'c',
      threadId: 'red',
      polygon: rectRegion().polygon.map((p) => ({ x: p.x + mmToUnit(80), y: p.y }))
    });
    const sts = compileDesign([r1, r2, r3], ['a', 'b', 'c']);
    const cc = sts.filter((s) => s.flags & StitchFlag.ColorChange);
    // red→blue 一次，blue→red 一次
    expect(cc.length).toBe(2);
    expect(cc.every((s) => s.flags & StitchFlag.Jump)).toBe(true);
  });

  it('不可见分区被跳过', () => {
    const r1 = rectRegion({ id: 'a' });
    const r2 = rectRegion({ id: 'b', visible: false });
    const sts = compileDesign([r1, r2], ['a', 'b']);
    expect(sts.every((s) => s.regionId !== 'b')).toBe(true);
  });

  it('针迹顺序严格跟随 stitchOrder', () => {
    const r1 = rectRegion({ id: 'a', threadId: 't' });
    const r2 = rectRegion({
      id: 'b',
      threadId: 't',
      polygon: rectRegion().polygon.map((p) => ({ x: p.x + mmToUnit(40), y: p.y }))
    });
    const order1 = compileDesign([r1, r2], ['a', 'b'])
      .filter((s) => s.regionId)
      .map((s) => s.regionId);
    const order2 = compileDesign([r1, r2], ['b', 'a'])
      .filter((s) => s.regionId)
      .map((s) => s.regionId);
    // 各自序列中首次出现的分区顺序
    expect([...new Set(order1)]).toEqual(['a', 'b']);
    expect([...new Set(order2)]).toEqual(['b', 'a']);
  });
});
