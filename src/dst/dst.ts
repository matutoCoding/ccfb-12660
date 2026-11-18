/**
 * Tajima DST 二进制解析与写回。
 *
 * 格式要点（Tajima 工业标准）：
 * - 文件 = 512 字节文本头（可缺省）+ 连续 3 字节记录
 * - 每条记录 3 字节，每字节 bit0 保留为 0
 * - 字节1/2/3 的位定义见下方 BIT 表；位移单位 0.1mm，单轴单条 ±121
 * - 结束记录固定 0x1A 0x1A 0x1A
 * - 坐标系：内部 y 轴向上为正，与 DST 位移符号一致（渲染层负责屏幕翻转）
 *
 * 正确性策略：
 * - 位移解码用查表法，不做任何浮点运算
 * - 编码用平衡三进制（1,3,9,27,81），保证 [-121,121] 内整数位移可精确表示
 * - 语义 round-trip：解析→写回→再解析，坐标与标志必须逐针一致
 */

import { StitchFlag, type Stitch } from '../core/types';

export const DST_HEADER_SIZE = 512;
export const DST_END_BYTE = 0x1a;
/** 单条记录单轴最大位移 */
export const DST_MAX_MOVE = 121;

/* ---------- 位定义 ---------- */

// 字节 0（Y 轴 + 换色）
const B0_Y_PLUS_81 = 0x80;
const B0_Y_MINUS_81 = 0x40;
const B0_Y_PLUS_27 = 0x20;
const B0_Y_MINUS_27 = 0x10;
const B0_Y_PLUS_9 = 0x08;
const B0_Y_MINUS_9 = 0x04;
const B0_COLOR_CHANGE = 0x02;

// 字节 1（X 轴高位 + 跳针）
const B1_X_PLUS_81 = 0x80;
const B1_X_MINUS_81 = 0x40;
const B1_X_PLUS_27 = 0x20;
const B1_X_MINUS_27 = 0x10;
const B1_X_PLUS_9 = 0x08;
const B1_X_MINUS_9 = 0x04;
const B1_JUMP = 0x02;

// 字节 2（X/Y 低位）
const B2_X_PLUS_3 = 0x80;
const B2_X_MINUS_3 = 0x40;
const B2_Y_PLUS_3 = 0x20;
const B2_Y_MINUS_3 = 0x10;
const B2_X_PLUS_1 = 0x08;
const B2_X_MINUS_1 = 0x04;
const B2_Y_PLUS_1 = 0x02;
const B2_Y_MINUS_1 = 0x01;

const VALID_RECORD_MASK = 0xfe; // bit0 必须为 0

/* ---------- 单条记录解码 ---------- */

export interface RawRecord {
  dx: number;
  dy: number;
  jump: boolean;
  colorChange: boolean;
  end: boolean;
}

export function decodeRecord(b0: number, b1: number, b2: number): RawRecord {
  const end = b0 === DST_END_BYTE && b1 === DST_END_BYTE && b2 === DST_END_BYTE;
  const dx =
    (b1 & B1_X_PLUS_81 ? 81 : 0) -
    (b1 & B1_X_MINUS_81 ? 81 : 0) +
    (b1 & B1_X_PLUS_27 ? 27 : 0) -
    (b1 & B1_X_MINUS_27 ? 27 : 0) +
    (b1 & B1_X_PLUS_9 ? 9 : 0) -
    (b1 & B1_X_MINUS_9 ? 9 : 0) +
    (b2 & B2_X_PLUS_3 ? 3 : 0) -
    (b2 & B2_X_MINUS_3 ? 3 : 0) +
    (b2 & B2_X_PLUS_1 ? 1 : 0) -
    (b2 & B2_X_MINUS_1 ? 1 : 0);
  const dy =
    (b0 & B0_Y_PLUS_81 ? 81 : 0) -
    (b0 & B0_Y_MINUS_81 ? 81 : 0) +
    (b0 & B0_Y_PLUS_27 ? 27 : 0) -
    (b0 & B0_Y_MINUS_27 ? 27 : 0) +
    (b0 & B0_Y_PLUS_9 ? 9 : 0) -
    (b0 & B0_Y_MINUS_9 ? 9 : 0) +
    (b2 & B2_Y_PLUS_3 ? 3 : 0) -
    (b2 & B2_Y_MINUS_3 ? 3 : 0) +
    (b2 & B2_Y_PLUS_1 ? 1 : 0) -
    (b2 & B2_Y_MINUS_1 ? 1 : 0);
  return {
    dx,
    dy,
    jump: (b1 & B1_JUMP) !== 0,
    colorChange: (b0 & B0_COLOR_CHANGE) !== 0,
    end
  };
}

/* ---------- 单条记录编码（平衡三进制） ---------- */

/** 平衡三进制数位 → 位掩码；coins[k] = 3^k */
const AXIS_COINS = [1, 3, 9, 27, 81] as const;

interface AxisMasks {
  plus: number[];
  minus: number[];
}

/**
 * 把 [-121,121] 的整数分解为 {1,3,9,27,81} 的带符号子集（平衡三进制）。
 * 返回每个 coin 的符号位。
 */
export function balancedTernary(n: number): Array<-1 | 0 | 1> {
  if (n < -DST_MAX_MOVE || n > DST_MAX_MOVE || !Number.isInteger(n)) {
    throw new Error(`DST 位移超出单条记录范围: ${n}`);
  }
  const digits: Array<-1 | 0 | 1> = [];
  let v = n;
  while (v !== 0) {
    const r = ((v % 3) + 3) % 3; // 0,1,2
    if (r === 0) {
      digits.push(0);
    } else if (r === 1) {
      digits.push(1);
      v -= 1;
    } else {
      digits.push(-1);
      v += 1;
    }
    v /= 3;
  }
  while (digits.length < AXIS_COINS.length) digits.push(0);
  return digits;
}

// 各 coin 对应的字节掩码（X 轴）
const X_PLUS_MASKS = [B2_X_PLUS_1, B2_X_PLUS_3, B1_X_PLUS_9, B1_X_PLUS_27, B1_X_PLUS_81];
const X_MINUS_MASKS = [B2_X_MINUS_1, B2_X_MINUS_3, B1_X_MINUS_9, B1_X_MINUS_27, B1_X_MINUS_81];
// Y 轴
const Y_PLUS_MASKS = [B2_Y_PLUS_1, B2_Y_PLUS_3, B0_Y_PLUS_9, B0_Y_PLUS_27, B0_Y_PLUS_81];
const Y_MINUS_MASKS = [B2_Y_MINUS_1, B2_Y_MINUS_3, B0_Y_MINUS_9, B0_Y_MINUS_27, B0_Y_MINUS_81];

/** 直接按平衡三进制数位生成两个字节的掩码，避免数组拼接错位 */
function axisBytes(n: number, masks: AxisMasks): { low: number; high: number } {
  const digits = balancedTernary(n);
  let low = 0;
  let high = 0;
  digits.forEach((d, k) => {
    if (d === 0) return;
    const m = d === 1 ? masks.plus[k] : masks.minus[k];
    if (k < 2) low |= m;
    else high |= m;
  });
  return { low, high };
}

export interface EncodeOptions {
  jump?: boolean;
  colorChange?: boolean;
}

export function encodeRecord(dx: number, dy: number, opts: EncodeOptions = {}): Uint8Array {
  const x = axisBytes(dx, { plus: X_PLUS_MASKS, minus: X_MINUS_MASKS });
  const y = axisBytes(dy, { plus: Y_PLUS_MASKS, minus: Y_MINUS_MASKS });
  const b0 = y.high | (opts.colorChange ? B0_COLOR_CHANGE : 0);
  const b1 = x.high | (opts.jump ? B1_JUMP : 0);
  const b2 = x.low | y.low;
  return Uint8Array.from([b0, b1, b2]);
}

export function encodeEndRecord(): Uint8Array {
  return Uint8Array.from([DST_END_BYTE, DST_END_BYTE, DST_END_BYTE]);
}

/* ---------- 文件头检测与解析 ---------- */

export interface DstHeader {
  designName: string;
  stitchCount: number;
  colorChanges: number;
  extents: { xPlus: number; xMinus: number; yPlus: number; yMinus: number };
  lastPoint: { ax: number; ay: number };
  rawLines: string[];
  hasHeader: boolean;
}

function isPlausibleRecord(b0: number, b1: number, b2: number): boolean {
  return (
    (b0 & ~VALID_RECORD_MASK) === 0 &&
    (b1 & ~VALID_RECORD_MASK) === 0 &&
    (b2 & 0xfe) === b2 // 字节2 的 bit0 也是有效位（Y-1），所以 8 位都可能出现
  );
}

/**
 * 判定是否带 512 字节文本头：
 * 头部区域以可打印 ASCII/CR 为主，且偏移 512 处是合法记录。
 */
export function detectHeader(bytes: Uint8Array): boolean {
  if (bytes.length < DST_HEADER_SIZE + 3) return false;
  let printable = 0;
  let cr = 0;
  for (let i = 0; i < DST_HEADER_SIZE; i++) {
    const c = bytes[i];
    if (c === 0x0d || c === 0x1a || c === 0x20) {
      if (c === 0x0d) cr++;
      printable++;
    } else if (c >= 0x20 && c < 0x7f) {
      printable++;
    }
  }
  const mostlyText = printable / DST_HEADER_SIZE > 0.9 && cr > 0;
  const rec = isPlausibleRecord(bytes[512], bytes[513], bytes[514]);
  return mostlyText && rec;
}

const EMPTY_HEADER: DstHeader = {
  designName: '',
  stitchCount: 0,
  colorChanges: 0,
  extents: { xPlus: 0, xMinus: 0, yPlus: 0, yMinus: 0 },
  lastPoint: { ax: 0, ay: 0 },
  rawLines: [],
  hasHeader: false
};

function parseHeaderBlock(block: Uint8Array): DstHeader {
  const text = new TextDecoder('ascii').decode(block);
  const lines = text
    .split(/\r|\n/)
    .map((l) => l.replace(/\x1a/g, '').trimEnd())
    .filter((l) => l.trim().length > 0);

  const h: DstHeader = { ...EMPTY_HEADER, rawLines: lines, hasHeader: true };
  const num = (label: string): number | null => {
    const line = lines.find((l) => l.startsWith(label));
    if (!line) return null;
    const m = line.slice(label.length).match(/-?\d+/);
    return m ? parseInt(m[0], 10) : null;
  };
  const str = (label: string): string | null => {
    const line = lines.find((l) => l.startsWith(label));
    return line ? line.slice(label.length).trim() : null;
  };

  h.designName = str('LA:') ?? '';
  h.stitchCount = num('ST:') ?? 0;
  h.colorChanges = num('CO:') ?? 0;
  h.extents = {
    xPlus: num('X+:') ?? 0,
    xMinus: num('X-:') ?? 0,
    yPlus: num('Y+:') ?? 0,
    yMinus: num('Y-:') ?? 0
  };
  h.lastPoint = { ax: num('AX:') ?? 0, ay: num('AY:') ?? 0 };
  return h;
}

/* ---------- 文件解析 ---------- */

export interface ParsedDst {
  header: DstHeader;
  /** 绝对坐标针迹（从第一条记录开始累加，不含合成原点） */
  stitches: Stitch[];
  /** 解析过程中的告警（不阻断，便于排查异常文件） */
  warnings: string[];
}

export function parseDst(buffer: ArrayBuffer | Uint8Array): ParsedDst {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const warnings: string[] = [];
  const hasHeader = detectHeader(bytes);
  const header = hasHeader
    ? parseHeaderBlock(bytes.subarray(0, DST_HEADER_SIZE))
    : { ...EMPTY_HEADER };

  const stitches: Stitch[] = [];
  let x = 0;
  let y = 0;
  const start = hasHeader ? DST_HEADER_SIZE : 0;

  for (let off = start; off + 2 < bytes.length; off += 3) {
    const b0 = bytes[off];
    const b1 = bytes[off + 1];
    const b2 = bytes[off + 2];
    const rec = decodeRecord(b0, b1, b2);
    if (rec.end) break;
    if (!isPlausibleRecord(b0, b1, b2)) {
      warnings.push(`偏移 ${off} 处存在保留位为 1 的异常记录，已按原始位继续解码`);
    }
    x += rec.dx;
    y += rec.dy;
    let flags = StitchFlag.Normal;
    if (rec.jump) flags |= StitchFlag.Jump;
    if (rec.colorChange) flags |= StitchFlag.ColorChange;
    stitches.push({ x, y, flags, regionId: null, threadId: null });
  }

  if (header.stitchCount > 0) {
    const actualNormal = stitches.filter((s) => s.flags === StitchFlag.Normal).length;
    if (actualNormal !== header.stitchCount) {
      warnings.push(
        `头部声明针数 ${header.stitchCount}，实际普通针记录 ${actualNormal}，以实际记录为准`
      );
    }
  }
  return { header, stitches, warnings };
}

/* ---------- 文件写回 ---------- */

export interface WriteDstOptions {
  designName?: string;
}

/** 把一条任意长度的移动拆成若干 ≤121 的记录位移 */
export function splitMove(dx: number, dy: number): Array<{ dx: number; dy: number }> {
  const parts: Array<{ dx: number; dy: number }> = [];
  let rx = dx;
  let ry = dy;
  while (Math.abs(rx) > DST_MAX_MOVE || Math.abs(ry) > DST_MAX_MOVE) {
    const sx = Math.max(-DST_MAX_MOVE, Math.min(DST_MAX_MOVE, rx));
    const sy = Math.max(-DST_MAX_MOVE, Math.min(DST_MAX_MOVE, ry));
    parts.push({ dx: sx, dy: sy });
    rx -= sx;
    ry -= sy;
  }
  parts.push({ dx: rx, dy: ry });
  return parts;
}

function padField(n: number): string {
  const sign = n < 0 ? '-' : '+';
  return sign + Math.abs(n).toString().padStart(5, '0');
}

/** DST 头部只支持 ASCII，中文名净化为合法字符（保留字母数字与常见符号） */
function sanitizeHeaderName(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/\s+/g, ' ').trim();
  return (ascii || 'design').slice(0, 16);
}

function buildHeader(stitches: Stitch[], name: string): Uint8Array {
  let xPlus = 0;
  let xMinus = 0;
  let yPlus = 0;
  let yMinus = 0;
  let normalCount = 0;
  let colorChanges = 0;
  for (const s of stitches) {
    xPlus = Math.max(xPlus, s.x);
    xMinus = Math.min(xMinus, s.x);
    yPlus = Math.max(yPlus, s.y);
    yMinus = Math.min(yMinus, s.y);
    if (s.flags === StitchFlag.Normal) normalCount++;
    if (s.flags & StitchFlag.ColorChange) colorChanges++;
  }
  const last = stitches[stitches.length - 1];
  const lines = [
    `LA:${sanitizeHeaderName(name)}`,
    `ST:${normalCount.toString().padStart(7, ' ')}`,
    `CO:${colorChanges.toString().padStart(3, ' ')}`,
    `X+:${padField(xPlus)}`,
    `X-:${padField(xMinus)}`,
    `Y+:${padField(yPlus)}`,
    `Y-:${padField(yMinus)}`,
    `AX:${padField(last ? last.x : 0)}`,
    `AY:${padField(last ? last.y : 0)}`,
    'PD:******'
  ];
  const out = new Uint8Array(DST_HEADER_SIZE).fill(0x20);
  let pos = 0;
  for (const line of lines) {
    const payload = line + '\r';
    out.set(new TextEncoder().encode(payload), pos);
    pos += payload.length;
  }
  out[DST_HEADER_SIZE - 1] = DST_END_BYTE;
  return out;
}

/**
 * 写 DST。输入为绝对坐标针迹序列（与 parseDst 输出同构）。
 * 超长移动自动拆条；跳针/换色标志挂在最后一条拆分记录上。
 */
export function writeDst(stitches: Stitch[], opts: WriteDstOptions = {}): Uint8Array {
  const header = buildHeader(stitches, opts.designName ?? 'design');
  const records: number[] = [];
  let px = 0;
  let py = 0;

  for (const s of stitches) {
    const dx = s.x - px;
    const dy = s.y - py;
    const isJump = (s.flags & StitchFlag.Jump) !== 0;
    const isCC = (s.flags & StitchFlag.ColorChange) !== 0;
    const parts = splitMove(dx, dy);
    parts.forEach((p, idx) => {
      const isLast = idx === parts.length - 1;
      const rec = encodeRecord(p.dx, p.dy, {
        jump: isJump || !isLast, // 长移动的中间过渡记录一律抬针
        colorChange: isCC && isLast
      });
      records.push(rec[0], rec[1], rec[2]);
    });
    px = s.x;
    py = s.y;
  }
  const end = encodeEndRecord();
  const total = header.length + records.length + 3;
  const out = new Uint8Array(total);
  out.set(header, 0);
  out.set(records, header.length);
  out.set(end, header.length + records.length);
  return out;
}

/** 浏览器下载辅助 */
export function downloadBytes(bytes: Uint8Array, filename: string): void {
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
  const blob = new Blob([buf], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
