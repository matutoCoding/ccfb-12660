// DST (Tajima) 编解码。
// 格式要点:
//  - 512 字节文本头:LA/ST/CO/+X/-X/+Y/-Y/AX/AY/MX/MY/PD 等定长字段,0x0D 结尾,空格补齐。
//  - 之后每条记录 3 字节,编码相对位移(单位 0.1mm)与标志。
//  - 位移分解为 ±1/±3/±9/±27/±81 的加权和,单条记录最大 ±121(0.1mm)= ±12.1mm,超出需拆分。
//  - 第 3 字节 bit0/bit1 恒为 1;bit7=跳针;bit6=换色;结束记录为 00 00 F3。
//  - DST 的 X 轴正方向朝左(绣机视角),读写时对 X 取反,内部坐标系 Y 向上、X 向右。

import { Flag, StitchRec } from './types';

const HEADER_LEN = 512;
/** 单条记录允许的最大位移(0.1mm 单位) */
const MAX_DELTA = 121;

export interface DstData {
  name: string;
  stitches: StitchRec[]; // 绝对坐标(mm),含 Jump/Color/End 记录,顺序与文件一致
  colorChanges: number;
}

// ---------- 解码 ----------

function decodeDelta(b0: number, b1: number, b2: number): { dx: number; dy: number } {
  let x = 0, y = 0;
  if (b0 & 0x01) y += 1;
  if (b0 & 0x02) y -= 1;
  if (b0 & 0x04) y += 9;
  if (b0 & 0x08) y -= 9;
  if (b0 & 0x10) x -= 9;
  if (b0 & 0x20) x += 9;
  if (b0 & 0x40) x += 1;
  if (b0 & 0x80) x -= 1;

  if (b1 & 0x01) y += 3;
  if (b1 & 0x02) y -= 3;
  if (b1 & 0x04) y += 27;
  if (b1 & 0x08) y -= 27;
  if (b1 & 0x10) x -= 27;
  if (b1 & 0x20) x += 27;
  if (b1 & 0x40) x += 3;
  if (b1 & 0x80) x -= 3;

  if (b2 & 0x04) y += 81;
  if (b2 & 0x08) y -= 81;
  if (b2 & 0x10) x -= 81;
  if (b2 & 0x20) x += 81;
  return { dx: x, dy: y };
}

function decodeFlag(b2: number): Flag {
  if (b2 === 0xf3) return Flag.End;
  if ((b2 & 0xc3) === 0xc3) return Flag.Color;
  if ((b2 & 0x80) === 0x80) return Flag.Jump;
  return Flag.Stitch;
}

/** 解析 DST 文件。针数与坐标严格按记录累加,不做任何简化,保证与文件一致。 */
export function parseDst(buf: ArrayBuffer): DstData {
  const bytes = new Uint8Array(buf);
  if (bytes.length < HEADER_LEN) throw new Error('文件太小,不是有效的 DST');

  // 头部文本字段
  const headerText = new TextDecoder('latin1').decode(bytes.subarray(0, HEADER_LEN));
  const name = (headerText.match(/LA:([^\r]*)/)?.[1] ?? '').trim() || '未命名';
  const coMatch = headerText.match(/CO:\s*(\d+)/);
  const colorChanges = coMatch ? parseInt(coMatch[1], 10) : 0;

  const stitches: StitchRec[] = [];
  // 内部坐标系:DST 的 +X 朝左,因此取反;单位 0.1mm → mm
  let x = 0, y = 0;
  let actualColors = 0;
  for (let i = HEADER_LEN; i + 2 < bytes.length; i += 3) {
    const b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];
    const flag = decodeFlag(b2);
    if (flag === Flag.End) {
      stitches.push({ x, y, flag: Flag.End, region: -1 });
      break;
    }
    const { dx, dy } = decodeDelta(b0, b1, b2);
    x += dx;
    y += dy;
    if (flag === Flag.Color) actualColors++;
    stitches.push({ x: -x / 10, y: y / 10, flag, region: -1 });
  }
  return { name, stitches, colorChanges: colorChanges || actualColors };
}

// ---------- 编码 ----------

/** 把单个位移(0.1mm 整数,|d|<=121)编码进 3 字节 */
function encodeRecord(dx: number, dy: number, flag: Flag): [number, number, number] {
  const bytes = [0, 0, 0x03]; // 第3字节 bit0/bit1 恒置 1
  // Y: 位 (b0.0 +1, b0.1 -1, b1.0 +3, b1.1 -3, b0.2 +9, b0.3 -9, b1.2 +27, b1.3 -27, b2.2 +81, b2.3 -81)
  const yWeights: Array<[number, number, number]> = [
    // [权重, 正方向位, 负方向位],位编号 = byte*8+bit
    [1, 0, 1],
    [3, 8, 9],
    [9, 2, 3],
    [27, 10, 11],
    [81, 18, 19],
  ];
  let rem = dy;
  for (let i = yWeights.length - 1; i >= 0; i--) {
    const w = yWeights[i][0];
    const q = Math.round(rem / w);
    if (q !== 0) {
      const bit = q > 0 ? yWeights[i][1] : yWeights[i][2];
      bytes[bit >> 3] |= 1 << (bit & 7);
      rem -= q * w;
    }
  }
  // X: 位 (b0.6 +1, b0.7 -1, b1.6 +3, b1.7 -3, b0.5 +9, b0.4 -9, b1.5 +27, b1.4 -27, b2.5 +81, b2.4 -81)
  const xWeights: Array<[number, number, number]> = [
    [1, 6, 7],
    [3, 14, 15],
    [9, 5, 4],
    [27, 13, 12],
    [81, 21, 20],
  ];
  rem = dx;
  for (let i = xWeights.length - 1; i >= 0; i--) {
    const w = xWeights[i][0];
    const q = Math.round(rem / w);
    if (q !== 0) {
      const bit = q > 0 ? xWeights[i][1] : xWeights[i][2];
      bytes[bit >> 3] |= 1 << (bit & 7);
      rem -= q * w;
    }
  }
  if (flag === Flag.Jump || flag === Flag.Color) bytes[2] |= 0x80;
  if (flag === Flag.Color) bytes[2] |= 0x40;
  return [bytes[0], bytes[1], bytes[2]];
}

function headerField(label: string, value: string, width: number): string {
  return label + value.padStart(width, ' ').slice(-width) + '\r';
}

/** 序列化为 DST。长位移自动拆分为多条记录;ST/CO/尺寸字段按实际记录统计。 */
export function writeDst(name: string, stitches: StitchRec[]): ArrayBuffer {
  // 先展开成记录流(拆分长位移),同时统计
  const recs: number[] = [];
  let cx = 0, cy = 0; // 当前位置(0.1mm, DST 坐标系)
  let minX = 0, maxX = 0, minY = 0, maxY = 0;
  let stitchCount = 0, colorCount = 0;

  const emit = (dx: number, dy: number, flag: Flag) => {
    const [b0, b1, b2] = encodeRecord(dx, dy, flag);
    recs.push(b0, b1, b2);
    cx += dx; cy += dy;
    if (flag === Flag.Stitch || flag === Flag.Jump) stitchCount++;
    if (flag === Flag.Color) colorCount++;
    if (flag !== Flag.Color) {
      if (cx > maxX) maxX = cx;
      if (cx < minX) minX = cx;
      if (cy > maxY) maxY = cy;
      if (cy < minY) minY = cy;
    }
  };

  for (const s of stitches) {
    if (s.flag === Flag.End) continue;
    // 内部坐标 → DST 坐标:X 取反,单位 0.1mm
    const tx = Math.round(-s.x * 10);
    const ty = Math.round(s.y * 10);
    let dx = tx - cx, dy = ty - cy;
    if (s.flag === Flag.Color) {
      // 换色记录:位移编码在记录内(通常机器忽略,但保留以兼容)
      const cdx = Math.max(-MAX_DELTA, Math.min(MAX_DELTA, dx));
      const cdy = Math.max(-MAX_DELTA, Math.min(MAX_DELTA, dy));
      emit(cdx, cdy, Flag.Color);
      dx -= cdx; dy -= cdy;
      // 剩余位移用跳针补齐
      while (dx !== 0 || dy !== 0) {
        const jx = Math.max(-MAX_DELTA, Math.min(MAX_DELTA, dx));
        const jy = Math.max(-MAX_DELTA, Math.min(MAX_DELTA, dy));
        emit(jx, jy, Flag.Jump);
        dx -= jx; dy -= jy;
      }
      continue;
    }
    const flag = s.flag === Flag.Jump ? Flag.Jump : Flag.Stitch;
    if (dx === 0 && dy === 0) {
      // 原地针(锁针)也必须产生一条记录
      emit(0, 0, flag);
      continue;
    }
    while (dx !== 0 || dy !== 0) {
      const sx = Math.max(-MAX_DELTA, Math.min(MAX_DELTA, dx));
      const sy = Math.max(-MAX_DELTA, Math.min(MAX_DELTA, dy));
      emit(sx, sy, flag);
      dx -= sx; dy -= sy;
    }
  }
  // 结束记录
  recs.push(0x00, 0x00, 0xf3);

  // 头部
  let header = '';
  header += headerField('LA:', name.slice(0, 16), 16);
  header += headerField('ST:', String(stitchCount), 7);
  header += headerField('CO:', String(colorCount), 3);
  header += headerField('+X:', String(Math.abs(maxX)), 5);
  header += headerField('-X:', String(Math.abs(minX)), 5);
  header += headerField('+Y:', String(Math.abs(maxY)), 5);
  header += headerField('-Y:', String(Math.abs(minY)), 5);
  header += headerField('AX:', (maxX - minX >= 0 ? '+' : '-') + String(Math.abs(maxX - minX)), 6);
  header += headerField('AY:', (maxY - minY >= 0 ? '+' : '-') + String(Math.abs(maxY - minY)), 6);
  header += headerField('MX:', '+     0', 6);
  header += headerField('PD:', '******', 6);

  const out = new Uint8Array(HEADER_LEN + recs.length);
  out.fill(0x20, 0, HEADER_LEN);
  for (let i = 0; i < header.length && i < HEADER_LEN; i++) out[i] = header.charCodeAt(i);
  out.set(recs, HEADER_LEN);
  return out.buffer;
}
