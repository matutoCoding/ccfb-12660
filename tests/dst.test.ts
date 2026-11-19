import { describe, it, expect } from 'vitest';
import { parseDst, writeDst } from '../src/core/dst';
import { Flag, StitchRec } from '../src/core/types';

function seq(...pts: Array<[number, number, Flag]>): StitchRec[] {
  return pts.map(([x, y, flag]) => ({ x, y, flag, region: -1 }));
}

describe('DST 编解码', () => {
  it('往返后针数与坐标一致(0.1mm 精度)', () => {
    const stitches = seq(
      [0, 0, Flag.Stitch],
      [1.23, -4.56, Flag.Stitch],
      [12.1, 12.1, Flag.Stitch],   // 距上一点 11.0/16.7 → y 需拆分? |dy|=166>121 会拆分
      [0, 0, Flag.Color],
      [5.5, -3.3, Flag.Jump],
      [6.0, -3.3, Flag.Stitch],
      [-2.2, 8.8, Flag.Stitch],
    );
    const buf = writeDst('测试A', stitches);
    const back = parseDst(buf);
    const got = back.stitches.filter(s => s.flag !== Flag.End);

    // 解析出的位置序列必须按顺序经过每一条原始记录的目标点(子序列匹配,
    // 中间允许长位移拆分出的额外记录)
    let j = 0;
    for (const want of stitches) {
      let found = false;
      for (; j < got.length; j++) {
        if (Math.abs(got[j].x - want.x) < 0.051 && Math.abs(got[j].y - want.y) < 0.051) {
          // 换色/跳针标志必须一致(普通针迹允许拆分,只核对终点)
          if (want.flag === Flag.Stitch || got[j].flag === want.flag) { found = true; j++; break; }
        }
      }
      expect(found, `未找到目标点 (${want.x}, ${want.y}) flag=${want.flag}`).toBe(true);
    }
    // 换色次数一致
    expect(got.filter(s => s.flag === Flag.Color).length).toBe(
      stitches.filter(s => s.flag === Flag.Color).length);
  });

  it('长针迹自动拆分且终点精确', () => {
    const stitches = seq([0, 0, Flag.Stitch], [30.0, -25.4, Flag.Stitch]);
    const back = parseDst(writeDst('LONG', stitches));
    const s = back.stitches.filter(r => r.flag === Flag.Stitch);
    expect(s.length).toBeGreaterThan(2); // 被拆分
    const last = s[s.length - 1];
    expect(last.x).toBeCloseTo(30.0, 1);
    expect(last.y).toBeCloseTo(-25.4, 1);
  });

  it('头部 ST/CO 统计正确', () => {
    const stitches = seq(
      [0, 0, Flag.Stitch],
      [1, 0, Flag.Stitch],
      [0, 0, Flag.Color],
      [2, 2, Flag.Stitch],
    );
    const buf = writeDst('HDR', stitches);
    const text = new TextDecoder('latin1').decode(new Uint8Array(buf, 0, 512));
    expect(text).toMatch(/ST:\s*3\r/);   // 3 针普通针迹
    expect(text).toMatch(/CO:\s*1\r/);   // 1 次换色
    const back = parseDst(buf);
    expect(back.colorChanges).toBe(1);
  });

  it('结束记录 00 00 F3 终止解析', () => {
    const buf = writeDst('END', seq([0, 0, Flag.Stitch], [1, 1, Flag.Stitch]));
    const back = parseDst(buf);
    expect(back.stitches[back.stitches.length - 1].flag).toBe(End);
  });

  it('已知字节序列解码正确', () => {
    // 手工构造:一条 +0.1mm X 的普通针迹 = b0=0x40, b1=0x00, b2=0x03
    // DST +X 朝左 → 内部 x = -0.1
    const data = new Uint8Array(512 + 6);
    data.fill(0x20, 0, 512);
    data.set([0x40, 0x00, 0x03, 0x00, 0x00, 0xf3], 512);
    const back = parseDst(data.buffer);
    expect(back.stitches[0].x).toBeCloseTo(-0.1, 5);
    expect(back.stitches[0].y).toBeCloseTo(0, 5);
    expect(back.stitches[0].flag).toBe(Flag.Stitch);
  });

  it('跳针与换色标志位解码正确', () => {
    // 跳针: b2 = 0x83;换色: b2 = 0xC3
    const data = new Uint8Array(512 + 9);
    data.fill(0x20, 0, 512);
    data.set([0x00, 0x00, 0x83, 0x00, 0x00, 0xc3, 0x00, 0x00, 0xf3], 512);
    const back = parseDst(data.buffer);
    expect(back.stitches[0].flag).toBe(Flag.Jump);
    expect(back.stitches[1].flag).toBe(Flag.Color);
    expect(back.stitches[2].flag).toBe(Flag.End);
  });

  it('±121 边界位移单记录往返', () => {
    for (const [dx, dy] of [[121, -121], [-121, 121], [81, 40], [0, -121]] as const) {
      const stitches = seq([0, 0, Flag.Stitch], [dx / 10, dy / 10, Flag.Stitch]);
      const back = parseDst(writeDst('B', stitches));
      const s = back.stitches.filter(r => r.flag === Flag.Stitch);
      expect(s[1].x).toBeCloseTo(dx / 10, 1);
      expect(s[1].y).toBeCloseTo(dy / 10, 1);
    }
  });
});

const End = Flag.End;
