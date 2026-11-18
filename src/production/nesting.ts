/**
 * 拼版布局与纸样导出（纯计算，便于测试与离线复用）。
 */

import type { Design, ProductionItem, Stitch } from '../core/types';
import { StitchFlag } from '../core/types';
import { mmToUnit } from '../core/units';
import { compileDesign } from '../stitches/compiler';
import { threadUsageByColor } from '../core/stats';

export interface PlacedDesign {
  item: ProductionItem;
  design: Design;
  stitches: Stitch[];
}

/** 简单行列拼版：按份数自动排网格，留 10mm 间距 */
export function autoNest(
  designs: Design[],
  entries: Array<{ design: Design; copies: number }>,
  gapMm = 10
): { items: ProductionItem[]; sheetWidth: number; sheetHeight: number } {
  const gap = mmToUnit(gapMm);
  const items: ProductionItem[] = [];
  let cursorX = 0;
  let cursorY = 0;
  let rowHeight = 0;
  let sheetWidth = 0;

  for (const { design, copies } of entries) {
    const w = design.width;
    const h = design.height;
    for (let i = 0; i < copies; i++) {
      items.push({
        designId: design.id,
        designName: design.name,
        copies,
        x: cursorX,
        y: cursorY,
        rotation: 0
      });
      cursorX += w + gap;
      rowHeight = Math.max(rowHeight, h);
      sheetWidth = Math.max(sheetWidth, cursorX);
    }
  }
  sheetWidth = Math.max(sheetWidth - gap, 0);
  const rows = Math.max(1, Math.ceil(items.length / Math.max(1, estimateColumns(entries))));
  void rows;
  // 单行排满后换行（按总宽 800mm 限宽）
  const maxWidth = mmToUnit(800);
  const wrapped: ProductionItem[] = [];
  let x = 0;
  let y = 0;
  let rh = 0;
  for (const it of items) {
    const d = designs.find((dd) => dd.id === it.designId)!;
    if (x + d.width > maxWidth && x > 0) {
      x = 0;
      y += rh + gap;
      rh = 0;
    }
    wrapped.push({ ...it, x, y });
    x += d.width + gap;
    rh = Math.max(rh, d.height);
  }
  const sheetHeight = wrapped.length ? y + rh : 0;
  const finalWidth = Math.min(sheetWidth, maxWidth);
  return { items: wrapped, sheetWidth: finalWidth, sheetHeight };
}

function estimateColumns(entries: Array<{ copies: number }>): number {
  return Math.max(1, entries.reduce((s, e) => s + e.copies, 0));
}

/** 把各花版针迹平移/旋转到拼版坐标，返回合并后的大版针迹 */
export function composeSheet(placed: PlacedDesign[]): Stitch[] {
  const out: Stitch[] = [];
  for (const p of placed) {
    const cos = Math.cos(p.item.rotation);
    const sin = Math.sin(p.item.rotation);
    for (const s of p.stitches) {
      const rx = s.x * cos - s.y * sin;
      const ry = s.x * sin + s.y * cos;
      out.push({
        ...s,
        x: Math.round(rx + p.item.x),
        y: Math.round(ry + p.item.y)
      });
    }
  }
  return out;
}

export interface SheetUsage {
  threadId: string | null;
  length: number;
  stitchCount: number;
}

/** 汇总整单用线量（跳针不计） */
export function computeSheetUsage(allStitches: Stitch[]): SheetUsage[] {
  const usage = threadUsageByColor(allStitches);
  const counts = new Map<string | null, number>();
  for (const s of allStitches) {
    if (s.flags & StitchFlag.Jump) continue;
    counts.set(s.threadId, (counts.get(s.threadId) ?? 0) + 1);
  }
  return [...usage.entries()]
    .map(([threadId, length]) => ({ threadId, length, stitchCount: counts.get(threadId) ?? 0 }))
    .sort((a, b) => b.length - a.length);
}

export function stitchesOf(d: Design): Stitch[] {
  return d.importedStitches ?? compileDesign(d.regions, d.stitchOrder);
}

/** 导出车间纸样：SVG 矢量图，含针迹、边框、尺寸标注、色号表 */
export function buildPatternSvg(
  allStitches: Stitch[],
  sheetWidth: number,
  sheetHeight: number,
  colorOf: (id: string | null) => string | undefined,
  threadNames: Map<string, string>
): string {
  const pad = 80;
  const scale = 6; // 6px per DST unit = 60px/mm
  const w = sheetWidth * scale + pad * 2;
  const h = sheetHeight * scale + pad * 2 + 120;
  const X = (x: number) => x * scale + pad;
  const Y = (y: number) => sheetHeight * scale - y * scale + pad;

  const lines: string[] = [];
  for (let i = 1; i < allStitches.length; i++) {
    const a = allStitches[i - 1];
    const b = allStitches[i];
    if (b.flags & StitchFlag.Jump) continue;
    const color = colorOf(b.threadId) ?? '#888';
    const width = b.flags & StitchFlag.ColorChange ? 1.4 : 0.8;
    lines.push(
      `<line x1="${X(a.x).toFixed(1)}" y1="${Y(a.y).toFixed(1)}" x2="${X(b.x).toFixed(1)}" y2="${Y(b.y).toFixed(1)}" stroke="${color}" stroke-width="${width}" />`
    );
  }
  // 边框与尺寸
  const frame = `<rect x="${pad}" y="${pad}" width="${(sheetWidth * scale).toFixed(1)}" height="${(sheetHeight * scale).toFixed(1)}" fill="none" stroke="#333" stroke-dasharray="6 4" />`;
  const dim = `<text x="${pad}" y="${h - 70}" font-size="20" fill="#333">幅宽 ${(sheetWidth / 10).toFixed(1)} mm　×　幅高 ${(sheetHeight / 10).toFixed(1)} mm　总针数 ${allStitches.length}</text>`;
  const legendY = h - 36;
  const legend = [...threadNames.entries()]
    .map(([id, name], i) => {
      const c = colorOf(id) ?? '#888';
      return `<rect x="${pad + i * 170}" y="${legendY - 16}" width="14" height="14" fill="${c}" stroke="#333"/><text x="${pad + i * 170 + 20}" y="${legendY - 4}" font-size="16" fill="#333">${name}</text>`;
    })
    .join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<rect width="100%" height="100%" fill="#ffffff"/>
${frame}
<g>${lines.join('\n')}</g>
${dim}
${legend}
</svg>`;
}

export function downloadSvg(svg: string, filename: string) {
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
