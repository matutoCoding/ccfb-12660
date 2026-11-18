import { describe, it, expect } from 'vitest';
import {
  decodeRecord,
  encodeRecord,
  balancedTernary,
  parseDst,
  writeDst,
  splitMove,
  DST_END_BYTE,
  DST_MAX_MOVE
} from '../src/dst/dst';
import { StitchFlag, type Stitch } from '../src/core/types';

describe('平衡三进制编码', () => {
  it('覆盖 [-121,121] 全部整数可无损表示', () => {
    for (let n = -DST_MAX_MOVE; n <= DST_MAX_MOVE; n++) {
      const d = balancedTernary(n);
      const coins = [1, 3, 9, 27, 81];
      const back = d.reduce<number>((acc, digit, k) => acc + digit * coins[k], 0);
      expect(back).toBe(n);
    }
  });

  it('边界值 ±121 正确', () => {
    const coins = [1, 3, 9, 27, 81];
    const back1 = balancedTernary(121).reduce<number>((a, d, k) => a + d * coins[k], 0);
    const back2 = balancedTernary(-121).reduce<number>((a, d, k) => a + d * coins[k], 0);
    expect(back1).toBe(121);
    expect(back2).toBe(-121);
  });
});

describe('单条记录编解码互逆', () => {
  it('全位移空间 encode→decode 无损', () => {
    for (let dx = -DST_MAX_MOVE; dx <= DST_MAX_MOVE; dx += 7) {
      for (let dy = -DST_MAX_MOVE; dy <= DST_MAX_MOVE; dy += 11) {
        const rec = encodeRecord(dx, dy);
        const dec = decodeRecord(rec[0], rec[1], rec[2]);
        expect(dec.dx).toBe(dx);
        expect(dec.dy).toBe(dy);
        expect(dec.jump).toBe(false);
        expect(dec.colorChange).toBe(false);
        expect(dec.end).toBe(false);
      }
    }
  });

  it('跳针与换色标志位保留', () => {
    const rec = encodeRecord(12, -8, { jump: true, colorChange: true });
    const dec = decodeRecord(rec[0], rec[1], rec[2]);
    expect(dec.dx).toBe(12);
    expect(dec.dy).toBe(-8);
    expect(dec.jump).toBe(true);
    expect(dec.colorChange).toBe(true);
  });

  it('已知位模式手工核对：dx=0,dy=0 + 跳针', () => {
    // 仅 B1 的 jump 位 (0x02)
    const dec = decodeRecord(0x00, 0x02, 0x00);
    expect(dec).toMatchObject({ dx: 0, dy: 0, jump: true });
  });

  it('结束记录识别', () => {
    const dec = decodeRecord(DST_END_BYTE, DST_END_BYTE, DST_END_BYTE);
    expect(dec.end).toBe(true);
  });

  it('每条记录 bit0 保留为 0', () => {
    for (let n = -DST_MAX_MOVE; n <= DST_MAX_MOVE; n += 13) {
      const r1 = encodeRecord(n, 0);
      const r2 = encodeRecord(0, n);
      expect(r1[0] & 1).toBe(0);
      expect(r1[1] & 1).toBe(0);
      expect(r2[0] & 1).toBe(0);
      expect(r2[1] & 1).toBe(0);
    }
  });
});

describe('长移动拆分', () => {
  it('拆分后各段不超 121 且总和不变', () => {
    const parts = splitMove(300, -260);
    let sx = 0;
    let sy = 0;
    for (const p of parts) {
      expect(Math.abs(p.dx)).toBeLessThanOrEqual(DST_MAX_MOVE);
      expect(Math.abs(p.dy)).toBeLessThanOrEqual(DST_MAX_MOVE);
      sx += p.dx;
      sy += p.dy;
    }
    expect(sx).toBe(300);
    expect(sy).toBe(-260);
  });
});

function makeStitches(): Stitch[] {
  // 手工设计一段：普通针 → 跳针 → 换色 → 普通针，含负坐标
  return [
    { x: 0, y: 0, flags: StitchFlag.Normal, regionId: null, threadId: null },
    { x: 30, y: 0, flags: StitchFlag.Normal, regionId: null, threadId: null },
    { x: 60, y: 20, flags: StitchFlag.Normal, regionId: null, threadId: null },
    { x: 200, y: 20, flags: StitchFlag.Jump, regionId: null, threadId: null },
    { x: 200, y: 50, flags: StitchFlag.ColorChange, regionId: null, threadId: null },
    { x: 160, y: 50, flags: StitchFlag.Normal, regionId: null, threadId: null },
    { x: -40, y: -30, flags: StitchFlag.Normal, regionId: null, threadId: null }
  ];
}

/**
 * 校验写回后每个原始目标点都按顺序、零坐标误差出现，
 * 且该点记录上保留原始标志位（长移动拆出的中间记录允许跳过）。
 * 要求原始点坐标唯一；命中点必须严格按序匹配，不允许错序。
 */
function expectTargetsPreserved(original: Stitch[], parsed: Stitch[]) {
  const targetKey = new Set(original.map((s) => `${s.x},${s.y}`));
  expect(new Set(targetKey).size).toBe(original.length); // 坐标必须唯一
  const hits = parsed.filter((s) => targetKey.has(`${s.x},${s.y}`));
  expect(hits.length).toBeGreaterThanOrEqual(original.length);
  let pi = 0;
  for (const s of hits) {
    if (pi >= original.length) break;
    const want = original[pi];
    expect(s.x).toBe(want.x);
    expect(s.y).toBe(want.y);
    expect(s.flags & want.flags).toBe(want.flags);
    pi++;
  }
  expect(pi).toBe(original.length);
}

describe('DST 文件 round-trip（最高优先级正确性）', () => {
  it('解析→写回→再解析：坐标、顺序、标志逐针一致', () => {
    const original = makeStitches();
    const file = writeDst(original, { designName: '测试花版' });
    const parsed1 = parseDst(file);
    expect(parsed1.stitches.length).toBeGreaterThanOrEqual(original.length);

    // 第二次写回应稳定（幂等）
    const file2 = writeDst(parsed1.stitches, { designName: '测试花版' });
    const parsed2 = parseDst(file2);
    expect(parsed2.stitches).toEqual(parsed1.stitches);
  });

  it('原始点坐标与顺序完全保留（含换色/跳针语义）', () => {
    const original = makeStitches();
    const file = writeDst(original);
    const parsed = parseDst(file);
    expectTargetsPreserved(original, parsed.stitches);
  });

  it('无头部文件也能解析（裸记录流）', () => {
    const recs: number[] = [];
    let px = 0;
    let py = 0;
    const pts = [
      [10, 10],
      [20, 10],
      [20, 20]
    ];
    for (const [x, y] of pts) {
      const r = encodeRecord(x - px, y - py);
      recs.push(r[0], r[1], r[2]);
      px = x;
      py = y;
    }
    recs.push(0x1a, 0x1a, 0x1a);
    const parsed = parseDst(Uint8Array.from(recs));
    expect(parsed.header.hasHeader).toBe(false);
    expect(parsed.stitches.map((s) => [s.x, s.y])).toEqual(pts);
  });

  it('头部针数与实际不符时产生告警但不阻断', () => {
    const file = writeDst(makeStitches());
    // 定位 ST: 行并篡改其数值字段
    const head = file.subarray(0, 512);
    const marker = new TextEncoder().encode('ST:');
    let idx = -1;
    for (let i = 0; i < head.length - 3; i++) {
      if (head[i] === marker[0] && head[i + 1] === marker[1] && head[i + 2] === marker[2]) {
        idx = i;
        break;
      }
    }
    expect(idx).toBeGreaterThanOrEqual(0);
    head.set(new TextEncoder().encode('  99999'), idx + 3);
    const parsed = parseDst(file);
    expect(parsed.warnings.some((w) => w.includes('针数'))).toBe(true);
    expect(parsed.stitches.length).toBeGreaterThan(0);
  });

  it('头部字段正确写入并读回', () => {
    const file = writeDst(makeStitches(), { designName: 'ABC' });
    const parsed = parseDst(file);
    expect(parsed.header.hasHeader).toBe(true);
    expect(parsed.header.designName).toBe('ABC');
    // 普通针数 = 不含 jump/cc 的记录数
    const normal = makeStitches().filter((s) => s.flags === StitchFlag.Normal).length;
    expect(parsed.header.stitchCount).toBe(normal);
  });

  it('中文设计名净化为合法 ASCII，不破坏头部结构', () => {
    const file = writeDst(makeStitches(), { designName: '牡丹花版-01' });
    const parsed = parseDst(file);
    expect(parsed.header.hasHeader).toBe(true);
    expect(/^[\x20-\x7e]+$/.test(parsed.header.designName)).toBe(true);
    expect(parsed.header.designName.length).toBeLessThanOrEqual(16);
    // 头部仍是规整 512 字节，记录照常解析
    expect(parsed.stitches.length).toBeGreaterThan(0);
  });

  it('随机针迹模糊测试：1000 组单记录步长路径，逐针 toEqual 零误差', () => {
    for (let trial = 0; trial < 1000; trial++) {
      const n = 1 + Math.floor(Math.random() * 30);
      const stitches: Stitch[] = [
        { x: 0, y: 0, flags: StitchFlag.Normal, regionId: null, threadId: null }
      ];
      const seen = new Set<string>(['0,0']);
      let x = 0;
      let y = 0;
      for (let i = 0; i < n; i++) {
        // 单轴位移限制在 ±120，保证每条移动恰好编码为 1 条记录
        let nx = x;
        let ny = y;
        let key = '';
        do {
          nx = x + Math.floor(Math.random() * 241) - 120;
          ny = y + Math.floor(Math.random() * 241) - 120;
          key = `${nx},${ny}`;
        } while (seen.has(key) || (nx === x && ny === y));
        seen.add(key);
        x = nx;
        y = ny;
        const r = Math.random();
        const flags =
          r < 0.1 ? StitchFlag.Jump : r < 0.15 ? StitchFlag.ColorChange : StitchFlag.Normal;
        stitches.push({ x, y, flags, regionId: null, threadId: null });
      }
      const file = writeDst(stitches);
      const parsed = parseDst(file);
      // 无拆分：记录数与针数相等，逐针精确一致
      expect(parsed.stitches.length).toBe(stitches.length);
      parsed.stitches.forEach((s, i) => {
        expect(s.x).toBe(stitches[i].x);
        expect(s.y).toBe(stitches[i].y);
        expect(s.flags).toBe(stitches[i].flags);
      });
    }
  });

  it('超长移动拆分后路径总位移与终点正确，中间记录均为跳针', () => {
    // 显式跳针长移动：整条移动抬针，所有拆分段（含终点）都带 jump
    const jumpPath: Stitch[] = [
      { x: 0, y: 0, flags: StitchFlag.Normal, regionId: null, threadId: null },
      { x: 300, y: 0, flags: StitchFlag.Jump, regionId: null, threadId: null }
    ];
    const parsed = parseDst(writeDst(jumpPath));
    expect(parsed.stitches.length).toBeGreaterThan(1);
    const last = parsed.stitches[parsed.stitches.length - 1];
    expect([last.x, last.y]).toEqual([300, 0]);
    for (const s of parsed.stitches.slice(1)) {
      expect(s.flags & StitchFlag.Jump).toBe(StitchFlag.Jump);
    }
    let sx = 0;
    let sy = 0;
    let px = 0;
    let py = 0;
    for (const s of parsed.stitches) {
      sx += s.x - px;
      sy += s.y - py;
      px = s.x;
      py = s.y;
    }
    expect([sx, sy]).toEqual([300, 0]);

    // 普通针长移动：中间过渡抬针，最终落点回到普通针
    const normalPath: Stitch[] = [
      { x: 0, y: 0, flags: StitchFlag.Normal, regionId: null, threadId: null },
      { x: 300, y: 0, flags: StitchFlag.Normal, regionId: null, threadId: null }
    ];
    const p2 = parseDst(writeDst(normalPath));
    const endStitch = p2.stitches[p2.stitches.length - 1];
    expect(endStitch.flags & (StitchFlag.Jump | StitchFlag.ColorChange)).toBe(0);
    for (const s of p2.stitches.slice(1, -1)) {
      expect(s.flags & StitchFlag.Jump).toBe(StitchFlag.Jump);
    }
  });
});

