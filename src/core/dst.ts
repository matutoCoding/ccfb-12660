// DST (Tajima) 文件精确解析与生成。
// 格式要点：
//  - 512 字节文本头（LA/ST/CO/+X/-X/+Y/-Y/AX/AY/MX/MY/PD 等记录，\r 分隔，空格补齐）
//  - 之后每条针迹记录 3 字节，编码 dx/dy（单位 0.1mm，按 1/3/9/27/81 位分解）和类型标志
//  - 类型：普通针 0xC0，跳针 0xC2，换色 0xC3，结束 0x00 0x00 0xF3
//  - 单条记录 dx/dy 最大 ±121（0.1mm 单位），超出必须拆成多条
// 内部坐标：mm，Y 向上。DST 文件坐标与内部坐标 Y 轴相反，读写两侧都做翻转，保证往返一致。

import type { SimRecord, RecordFlag } from './types';

export interface DstParsed {
  name: string;
  headerStitchCount: number;
  records: SimRecord[]; // 绝对坐标(mm)，顺序与文件完全一致
}

const MAX_DELTA = 121; // 0.1mm 单位

function decodeAxis(b0: number, b1: number, b2: number): { x: number; y: number } {
  let x = 0;
  let y = 0;
  if (b0 & 0x01) x += 1;
  if (b0 & 0x02) x -= 1;
  if (b0 & 0x04) x += 9;
  if (b0 & 0x08) x -= 9;
  if (b1 & 0x01) x += 3;
  if (b1 & 0x02) x -= 3;
  if (b1 & 0x04) x += 27;
  if (b1 & 0x08) x -= 27;
  if (b2 & 0x04) x += 81;
  if (b2 & 0x08) x -= 81;

  if (b0 & 0x80) y += 1;
  if (b0 & 0x40) y -= 1;
  if (b0 & 0x20) y += 9;
  if (b0 & 0x10) y -= 9;
  if (b1 & 0x80) y += 3;
  if (b1 & 0x40) y -= 3;
  if (b1 & 0x20) y += 27;
  if (b1 & 0x10) y -= 27;
  if (b2 & 0x20) y += 81;
  if (b2 & 0x10) y -= 81;
  return { x, y };
}

/**
 * 平衡三进制分解：DST 的 dx/dy 用 ±1/±3/±9/±27/±81 各一位表示，
 * 可精确表示 [-121,121] 内任意整数（如 87 = 81+9-3）。
 * 贪心单遍分解会丢余数，必须用模 3 余数法。
 */
function balancedTernary(v: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < 5; i++) {
    let m = ((v % 3) + 3) % 3;
    if (m === 2) m = -1;
    out.push(m);
    v = (v - m) / 3;
  }
  return out;
}

function encodeAxis(dx: number, dy: number): [number, number, number] {
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  const xd = balancedTernary(dx); // [±1, ±3, ±9, ±27, ±81]
  const yd = balancedTernary(dy);
  if (xd[0] === 1) b0 |= 0x01; else if (xd[0] === -1) b0 |= 0x02;
  if (xd[1] === 1) b1 |= 0x01; else if (xd[1] === -1) b1 |= 0x02;
  if (xd[2] === 1) b0 |= 0x04; else if (xd[2] === -1) b0 |= 0x08;
  if (xd[3] === 1) b1 |= 0x04; else if (xd[3] === -1) b1 |= 0x08;
  if (xd[4] === 1) b2 |= 0x04; else if (xd[4] === -1) b2 |= 0x08;

  if (yd[0] === 1) b0 |= 0x80; else if (yd[0] === -1) b0 |= 0x40;
  if (yd[1] === 1) b1 |= 0x80; else if (yd[1] === -1) b1 |= 0x40;
  if (yd[2] === 1) b0 |= 0x20; else if (yd[2] === -1) b0 |= 0x10;
  if (yd[3] === 1) b1 |= 0x20; else if (yd[3] === -1) b1 |= 0x10;
  if (yd[4] === 1) b2 |= 0x20; else if (yd[4] === -1) b2 |= 0x10;
  return [b0, b1, b2];
}

function encodeRecord(dx: number, dy: number, flag: RecordFlag): [number, number, number] {
  const [b0, b1, b2] = encodeAxis(dx, dy);
  let ctrl = 0;
  if (flag === 'stitch') ctrl = 0xc0;
  else if (flag === 'jump') ctrl = 0xc2;
  else ctrl = 0xc3; // color
  return [b0, b1, b2 | ctrl];
}

export function parseDst(buf: ArrayBuffer): DstParsed {
  const u8 = new Uint8Array(buf);
  if (u8.length < 512 + 3) {
    throw new Error('文件太小，不是有效的 DST 文件');
  }
  // 头部（容错：有的文件头不足 512 字节，但标准文件都是 512）
  const headerBytes = u8.subarray(0, 512);
  let headerText = '';
  for (let i = 0; i < headerBytes.length; i++) {
    headerText += String.fromCharCode(headerBytes[i]);
  }
  const laMatch = /LA:([^\r]*)/.exec(headerText);
  const stMatch = /ST:\s*(\d+)/.exec(headerText);
  const name = laMatch ? laMatch[1].trim() : 'DST 花版';
  const headerStitchCount = stMatch ? parseInt(stMatch[1], 10) : 0;

  const records: SimRecord[] = [];
  let ux = 0; // 0.1mm 单位整数累积，避免浮点漂移
  let uy = 0;
  let pos = 512;
  let block = 0;
  while (pos + 3 <= u8.length) {
    const b0 = u8[pos];
    const b1 = u8[pos + 1];
    const b2 = u8[pos + 2];
    pos += 3;
    if (b2 === 0xf3) break; // 结束记录
    if (b0 === 0 && b1 === 0 && b2 === 0) continue; // 尾部填充
    if (b0 === 0x1a && b1 === 0x1a && b2 === 0x1a) continue; // EOF 填充
    const d = decodeAxis(b0, b1, b2);
    ux += d.x;
    uy += d.y;
    let flag: RecordFlag;
    if ((b2 & 0x03) === 0x03) flag = 'color';
    else if (b2 & 0x02) flag = 'jump';
    else flag = 'stitch';
    if (flag !== 'stitch') block++;
    records.push({ x: ux / 10, y: -uy / 10, flag, block });
  }
  return { name, headerStitchCount, records };
}

function padNum(n: number, width: number): string {
  return String(Math.abs(Math.round(n))).padStart(width, '0');
}

function signedNum(n: number, width: number): string {
  const v = Math.round(n);
  return (v < 0 ? '-' : '+') + padNum(v, width);
}

export function writeDst(name: string, records: SimRecord[]): ArrayBuffer {
  // 先展开成 0.1mm 整数记录（拆分超程），同时统计
  const out: number[] = [];
  let ux = 0;
  let uy = 0;
  let stitchCount = 0;
  let colorCount = 0;
  let minX = 0, maxX = 0, minY = 0, maxY = 0;

  const emit = (dx: number, dy: number, flag: RecordFlag) => {
    const [b0, b1, b2] = encodeRecord(dx, dy, flag);
    out.push(b0, b1, b2);
  };

  for (const r of records) {
    if (r.flag === 'color') {
      emit(0, 0, 'color');
      colorCount++;
      continue;
    }
    const tx = Math.round(r.x * 10);
    const ty = Math.round(-r.y * 10); // 内部 y-up → 文件 y-down
    let dx = tx - ux;
    let dy = ty - uy;
    // 拆成不超过 ±121 的多段；零位移的针迹也必须写出（否则针数对不上）
    if (dx === 0 && dy === 0) {
      if (r.flag === 'stitch') {
        emit(0, 0, 'stitch');
        stitchCount++;
      }
      continue;
    }
    while (dx !== 0 || dy !== 0) {
      const cx = Math.max(-MAX_DELTA, Math.min(MAX_DELTA, dx));
      const cy = Math.max(-MAX_DELTA, Math.min(MAX_DELTA, dy));
      emit(cx, cy, r.flag);
      if (r.flag === 'stitch') stitchCount++;
      dx -= cx;
      dy -= cy;
    }
    ux = tx;
    uy = ty;
    if (ux < minX) minX = ux;
    if (ux > maxX) maxX = ux;
    if (uy < minY) minY = uy;
    if (uy > maxY) maxY = uy;
  }
  // 结束记录
  out.push(0x00, 0x00, 0xf3);

  // 头部
  const safeName = (name || 'DESIGN').replace(/[^\x20-\x7e]/g, '?').slice(0, 16);
  let header = '';
  header += `LA:${safeName.padEnd(16, ' ')}\r`;
  header += `ST:${padNum(stitchCount, 7)}\r`;
  header += `CO:${padNum(colorCount, 3)}\r`;
  header += `+X:${padNum(maxX, 5)}\r`;
  header += `-X:${padNum(minX, 5)}\r`;
  header += `+Y:${padNum(maxY, 5)}\r`;
  header += `-Y:${padNum(minY, 5)}\r`;
  header += `AX:${signedNum(ux, 5)}\r`;
  header += `AY:${signedNum(uy, 5)}\r`;
  header += `MX:${signedNum(0, 5)}\r`;
  header += `MY:${signedNum(0, 5)}\r`;
  header += `PD:******\r`;
  const headerBytes = new Uint8Array(512);
  for (let i = 0; i < 512; i++) {
    headerBytes[i] = i < header.length ? header.charCodeAt(i) : 0x20;
  }

  const result = new Uint8Array(512 + out.length);
  result.set(headerBytes, 0);
  result.set(out, 512);
  return result.buffer;
}

/** 解析结果 → 校验信息（用于导入后向用户确认针数一致） */
export function dstSummary(p: DstParsed): string {
  const stitches = p.records.filter((r) => r.flag === 'stitch').length;
  const jumps = p.records.filter((r) => r.flag === 'jump').length;
  const colors = p.records.filter((r) => r.flag === 'color').length;
  return `针数 ${stitches}（文件头标称 ${p.headerStitchCount}），跳针 ${jumps}，换色 ${colors}`;
}
