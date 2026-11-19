// 生产单页:用线量核算、多花版拼版、车间纸样图导出。

import { el, download, fmtTime } from './dom';
import { Flag, Pattern, patternBounds } from '../core/types';
import { computeStats } from '../core/sequence';
import { threadUsagePerColor } from '../core/analysis';
import { threadColor } from '../core/palette';
import * as db from '../core/db';

interface SheetItem {
  pattern: Pattern;
  qty: number;
}

export function renderProduction(container: HTMLElement): () => void {
  const page = el('div', { class: 'page' });
  container.append(page);
  let disposed = false;
  const items = new Map<string, SheetItem>();

  async function refresh(): Promise<void> {
    if (disposed) return;
    const patterns = await db.listPatterns();
    page.innerHTML = '';

    page.append(el('h3', { style: 'margin-top:0' }, ['生产单']));

    // ---- 花版选择 ----
    const picker = el('div', { class: 'toolbar-row' });
    for (const p of patterns) {
      const cb = el('input', { type: 'checkbox', ...(items.has(p.id) ? { checked: '' } : {}) });
      cb.onchange = () => {
        if (cb.checked) items.set(p.id, { pattern: p, qty: 1 });
        else items.delete(p.id);
        refresh();
      };
      picker.append(el('label', { style: 'display:flex;gap:4px;align-items:center' }, [cb, p.name]));
    }
    page.append(el('div', { class: 'card' }, [
      el('h4', { style: 'margin:0 0 8px' }, ['选择花版']),
      patterns.length ? picker : el('span', { class: 'hint' }, ['花版库为空']),
    ]));

    const selected = [...items.values()];
    if (!selected.length) return;

    // ---- 数量 ----
    const qtyCard = el('div', { class: 'card', style: 'margin-top:14px' }, [el('h4', { style: 'margin:0 0 8px' }, ['数量'])]);
    for (const it of selected) {
      const input = el('input', { type: 'number', min: '1', value: String(it.qty), style: 'width:80px' });
      input.onchange = () => { it.qty = Math.max(1, parseInt(input.value, 10) || 1); refresh(); };
      qtyCard.append(el('div', { class: 'field' }, [el('label', { style: 'width:160px' }, [it.pattern.name]), input, el('span', { class: 'hint' }, ['件'])]));
    }
    page.append(qtyCard);

    // ---- 用线量汇总 ----
    const totals = new Map<string, { lengthM: number; stitches: number }>();
    let totalStitches = 0, totalSeconds = 0;
    for (const it of selected) {
      const usage = threadUsagePerColor(it.pattern.stitches, ri => it.pattern.regions[ri]?.colorId ?? 'T1801');
      for (const [cid, u] of usage) {
        const t = totals.get(cid) ?? { lengthM: 0, stitches: 0 };
        t.lengthM += u.lengthM * it.qty;
        t.stitches += u.stitches * it.qty;
        totals.set(cid, t);
      }
      const s = computeStats(it.pattern.stitches);
      totalStitches += s.stitchCount * it.qty;
      totalSeconds += s.estimatedSeconds * it.qty;
    }

    const table = el('table', { class: 'sheet' }, [
      el('tr', {}, [el('th', {}, ['绣线']), el('th', {}, ['色号']), el('th', {}, ['针数']), el('th', {}, ['用线量(面线)']), el('th', {}, ['底线(约1/3)'])]),
    ]);
    for (const [cid, u] of [...totals.entries()].sort((a, b) => b[1].lengthM - a[1].lengthM)) {
      const c = threadColor(cid);
      table.append(el('tr', {}, [
        el('td', {}, [el('span', { class: 'color-chip', style: `background:rgb(${c.rgb.map(v => v * 255).join(',')})` }), c.name]),
        el('td', {}, [cid]),
        el('td', {}, [String(u.stitches)]),
        el('td', {}, [`${u.lengthM.toFixed(1)} m`]),
        el('td', {}, [`${(u.lengthM / 3).toFixed(1)} m`]),
      ]));
    }
    page.append(el('div', { class: 'card', style: 'margin-top:14px' }, [
      el('h4', { style: 'margin:0 0 8px' }, [`用线量汇总 — 共 ${totalStitches} 针,预计总工时 ${fmtTime(totalSeconds)}`]),
      table,
    ]));

    // ---- 拼版 ----
    const sheetW = 1200, sheetH = 800; // mm
    const layoutCard = el('div', { class: 'card', style: 'margin-top:14px' }, [
      el('h4', { style: 'margin:0 0 8px' }, [`拼版(${sheetW}×${sheetH}mm 裁片)与纸样图`]),
    ]);
    const layoutCanvas = el('canvas', { style: 'width:100%;background:#f5f2ec;border-radius:8px' });
    layoutCard.append(layoutCanvas);
    const expBtn = el('button', { class: 'primary' }, ['导出纸样图 PNG']);
    expBtn.onclick = () => exportTemplate(selected, sheetW, sheetH);
    const csvBtn = el('button', {}, ['导出生产单 CSV']);
    csvBtn.onclick = () => exportCsv(selected, totals, totalStitches, totalSeconds);
    layoutCard.append(el('div', { class: 'toolbar-row', style: 'margin-top:10px' }, [expBtn, csvBtn]));
    page.append(layoutCard);

    drawLayout(layoutCanvas, selected, sheetW, sheetH);
  }

  /** 简单网格拼版:按花版外接框排列 */
  function layoutPositions(selected: SheetItem[], sheetW: number, sheetH: number) {
    const placed: Array<{ p: Pattern; x: number; y: number; w: number; h: number }> = [];
    const margin = 15, gap = 10;
    let cx = margin, cy = margin, rowH = 0;
    for (const it of selected) {
      for (let q = 0; q < it.qty; q++) {
        const b = patternBounds(it.pattern.stitches);
        const w = Math.max(10, b.maxX - b.minX), h = Math.max(10, b.maxY - b.minY);
        if (cx + w > sheetW - margin) { cx = margin; cy += rowH + gap; rowH = 0; }
        if (cy + h > sheetH - margin) break; // 放不下的跳过
        placed.push({ p: it.pattern, x: cx - b.minX, y: cy - b.minY, w, h });
        cx += w + gap;
        rowH = Math.max(rowH, h);
      }
    }
    return placed;
  }

  function drawLayout(canvas: HTMLCanvasElement, selected: SheetItem[], sheetW: number, sheetH: number): void {
    const W = 1100, H = Math.round((W * sheetH) / sheetW);
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d')!;
    const k = W / sheetW;
    ctx.fillStyle = '#f5f2ec';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = '#999';
    ctx.strokeRect(0.5, 0.5, W - 1, H - 1);

    const placed = layoutPositions(selected, sheetW, sheetH);
    for (const pl of placed) {
      drawPatternOutline(ctx, pl.p, pl.x * k, pl.y * k, k);
    }
  }

  /** 画单个花版纸样:外轮廓点线 + 原点十字 + 名称 */
  function drawPatternOutline(ctx: CanvasRenderingContext2D, p: Pattern, ox: number, oy: number, k: number): void {
    ctx.save();
    ctx.translate(ox, oy);
    // 针迹点(稀疏)
    ctx.fillStyle = 'rgba(60,60,60,0.5)';
    const step = Math.max(1, Math.floor(p.stitches.length / 400));
    for (let i = 0; i < p.stitches.length; i += step) {
      const s = p.stitches[i];
      if (s.flag !== Flag.Stitch) continue;
      ctx.fillRect(s.x * k - 0.5, s.y * k - 0.5, 1, 1);
    }
    // 外接框
    const b = patternBounds(p.stitches);
    ctx.strokeStyle = '#c00';
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(b.minX * k, b.minY * k, (b.maxX - b.minX) * k, (b.maxY - b.minY) * k);
    ctx.setLineDash([]);
    // 原点十字(相对花版中心)
    const cx0 = ((b.minX + b.maxX) / 2) * k, cy0 = ((b.minY + b.maxY) / 2) * k;
    ctx.strokeStyle = '#06c';
    ctx.beginPath();
    ctx.moveTo(cx0 - 6, cy0); ctx.lineTo(cx0 + 6, cy0);
    ctx.moveTo(cx0, cy0 - 6); ctx.lineTo(cx0, cy0 + 6);
    ctx.stroke();
    // 标注
    ctx.fillStyle = '#333';
    ctx.font = '11px sans-serif';
    ctx.fillText(`${p.name} ${(b.maxX - b.minX).toFixed(0)}×${(b.maxY - b.minY).toFixed(0)}mm`, b.minX * k, b.minY * k - 3);
    ctx.restore();
  }

  function exportTemplate(selected: SheetItem[], sheetW: number, sheetH: number): void {
    // 高清导出:2px/mm
    const k = 2;
    const canvas = document.createElement('canvas');
    canvas.width = sheetW * k;
    canvas.height = sheetH * k;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = '#000';
    ctx.strokeRect(1, 1, canvas.width - 2, canvas.height - 2);
    // 毫米网格(每 100mm 一道)
    ctx.strokeStyle = '#ddd';
    for (let x = 100; x < sheetW; x += 100) {
      ctx.beginPath(); ctx.moveTo(x * k, 0); ctx.lineTo(x * k, canvas.height); ctx.stroke();
    }
    for (let y = 100; y < sheetH; y += 100) {
      ctx.beginPath(); ctx.moveTo(0, y * k); ctx.lineTo(canvas.width, y * k); ctx.stroke();
    }
    // 纸样(y 翻转:纸样图上方为 +Y)
    const placed = layoutPositions(selected, sheetW, sheetH);
    ctx.save();
    ctx.translate(0, canvas.height);
    ctx.scale(1, -1);
    for (const pl of placed) {
      drawPatternOutline(ctx, pl.p, pl.x * k, pl.y * k, k);
    }
    ctx.restore();
    // 标题
    ctx.fillStyle = '#000';
    ctx.font = '28px sans-serif';
    ctx.fillText(`纸样图 ${sheetW}×${sheetH}mm · ${placed.length} 件 · ${new Date().toLocaleDateString('zh-CN')}`, 20, 40);
    canvas.toBlob(blob => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = el('a', { href: url, download: '纸样图.png' });
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }, 'image/png');
  }

  function exportCsv(selected: SheetItem[], totals: Map<string, { lengthM: number; stitches: number }>, totalStitches: number, totalSeconds: number): void {
    const lines: string[] = ['生产单,' + new Date().toLocaleString('zh-CN')];
    lines.push('');
    lines.push('花版,数量,针数(单件)');
    for (const it of selected) {
      const s = computeStats(it.pattern.stitches);
      lines.push(`${it.pattern.name},${it.qty},${s.stitchCount}`);
    }
    lines.push('');
    lines.push('绣线色号,名称,针数,面线用量(m),底线用量(m)');
    for (const [cid, u] of totals) {
      lines.push(`${cid},${threadColor(cid).name},${u.stitches},${u.lengthM.toFixed(1)},${(u.lengthM / 3).toFixed(1)}`);
    }
    lines.push('');
    lines.push(`总针数,${totalStitches}`);
    lines.push(`预计总工时(秒),${Math.round(totalSeconds)}`);
    download('生产单.csv', '﻿' + lines.join('\n'), 'text/csv');
  }

  refresh();
  return () => { disposed = true; };
}
