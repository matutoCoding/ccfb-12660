// 生产单页面：针数/工时/用线量统计，多花版拼版，导出拼版 DST 和车间纸样图

import { el, clear, fmtTime, downloadBlob } from '../ui/dom';
import { toast } from '../ui/toast';
import { store } from '../store/store';
import { buildPlan } from '../core/stitchgen';
import { writeDst } from '../core/dst';
import { threadById, threadCss } from '../core/threadlib';
import { boundsOf } from '../core/geometry';
import type { SimRecord, StitchPlan } from '../core/types';

interface Placement {
  patternId: string;
  rows: number;
  cols: number;
  gapX: number; // mm
  gapY: number;
}

/** 面线用量估算：针迹长度 × 1.25（含反面回绕）+ 每次跳针 5cm 修线损耗 */
function threadMeters(plan: StitchPlan): Map<string, number> {
  const map = new Map<string, number>();
  for (const c of plan.stats.perColor) {
    map.set(c.colorId, (c.lengthMm * 1.25) / 1000 + plan.stats.jumps * 0.05);
  }
  return map;
}

export function mountProduction(root: HTMLElement): () => void {
  const page = el('div', { className: 'page prod-page' });
  root.append(page);

  const placements: Placement[] = [];
  let selectedPatternId = store.currentId;

  const colLeft = el('div', { className: 'prod-col' });
  const colRight = el('div', { className: 'prod-col' });
  page.append(colLeft, colRight);

  function getPlanFor(patternId: string | null): StitchPlan | null {
    const p = store.patterns.find((x) => x.id === patternId);
    if (!p) return null;
    return buildPlan(p.regions, { spm: store.spm });
  }

  function combinedRecords(): SimRecord[] {
    const out: SimRecord[] = [];
    let offsetBlock = 0;
    for (const pl of placements) {
      const p = store.patterns.find((x) => x.id === pl.patternId);
      if (!p) continue;
      const plan = buildPlan(p.regions, { spm: store.spm });
      if (plan.records.length === 0) continue;
      const b = boundsOf(plan.records);
      const w = b.maxX - b.minX;
      const h = b.maxY - b.minY;
      for (let r = 0; r < pl.rows; r++) {
        for (let c = 0; c < pl.cols; c++) {
          const dx = c * (w + pl.gapX);
          const dy = r * (h + pl.gapY);
          for (const rec of plan.records) {
            out.push({ x: rec.x + dx, y: rec.y + dy, flag: rec.flag, block: rec.block + offsetBlock });
          }
          offsetBlock += plan.blocks.length;
        }
      }
    }
    return out;
  }

  function render() {
    clear(colLeft);
    clear(colRight);
    const plan = getPlanFor(selectedPatternId);

    // ---- 花版选择 + 机器速度 ----
    const sel = el('select', {});
    for (const p of store.patterns) {
      sel.append(el('option', { value: p.id, ...(p.id === selectedPatternId ? { selected: true } : {}) }, p.name));
    }
    sel.addEventListener('change', () => {
      selectedPatternId = sel.value;
      render();
    });
    const spmInput = el('input', { type: 'number', value: String(store.spm), step: '50', min: '100', max: '1500' });
    spmInput.addEventListener('change', () => {
      const v = parseInt(spmInput.value);
      if (isFinite(v) && v > 0) store.setSpm(v);
    });
    colLeft.append(
      el('div', { className: 'panel' },
        el('h3', {}, '生产对象'),
        el('label', { className: 'field' }, el('span', {}, '花版'), sel),
        el('label', { className: 'field' }, el('span', {}, '机速 针/分'), spmInput))
    );

    if (!plan || plan.records.length === 0) {
      colLeft.append(el('div', { className: 'empty-hint' }, '当前花版没有针迹，请先到制版页编辑'));
    } else {
      const s = plan.stats;
      const b = boundsOf(plan.records);
      // ---- 统计卡片 ----
      colLeft.append(
        el('div', { className: 'panel' },
          el('h3', {}, '生产统计'),
          el('div', { className: 'stat-cards' },
            statCard(String(s.stitches), '总针数'),
            statCard(String(s.jumps), '跳针'),
            statCard(String(s.colorChanges), '换色次数'),
            statCard(`${(b.maxX - b.minX).toFixed(0)}×${(b.maxY - b.minY).toFixed(0)}`, '尺寸 mm'),
            statCard(fmtTime(s.estSeconds), '预计工时')))
      );
      // ---- 用线量 ----
      const meters = threadMeters(plan);
      const table = el('table', { className: 'table' },
        el('tr', {}, el('th', {}, '线色'), el('th', {}, '针数'), el('th', {}, '针迹长度'), el('th', {}, '面线用量')));
      for (const c of s.perColor) {
        const t = threadById(c.colorId);
        table.append(el('tr', {},
          el('td', {}, el('span', { className: 'swatch', style: `background:${threadCss(c.colorId)}` }), `${t.code} ${t.name}`),
          el('td', {}, String(c.stitches)),
          el('td', {}, `${(c.lengthMm / 1000).toFixed(2)} m`),
          el('td', {}, `${(meters.get(c.colorId) ?? 0).toFixed(2)} m`)));
      }
      colLeft.append(el('div', { className: 'panel' }, el('h3', {}, '用线量（面线，含损耗系数 1.25）'), table,
        el('div', { style: 'font-size:12px;color:var(--fg-dim);margin-top:6px' },
          `底线约 ${(s.lengthMm * 0.9 / 1000).toFixed(2)} m · 起坨风险点 ${plan.hotspots.length} 处`)));
    }

    // ---- 拼版 ----
    const rowsInput = el('input', { type: 'number', value: '2', min: '1', max: '20' });
    const colsInput = el('input', { type: 'number', value: '3', min: '1', max: '20' });
    const gapXInput = el('input', { type: 'number', value: '10', min: '0' });
    const gapYInput = el('input', { type: 'number', value: '10', min: '0' });
    const placeList = el('div', {});

    const renderPlacements = () => {
      clear(placeList);
      placements.forEach((pl, i) => {
        const p = store.patterns.find((x) => x.id === pl.patternId);
        placeList.append(el('div', { className: 'version-item' },
          el('span', { className: 'vlabel' }, `${p?.name ?? '?'} · ${pl.rows}×${pl.cols} · 间距 ${pl.gapX}/${pl.gapY}mm`),
          el('button', { className: 'mini danger', onclick: () => { placements.splice(i, 1); render(); } }, '✕')));
      });
      const recs = combinedRecords();
      const stitchCount = recs.filter((r) => r.flag === 'stitch').length;
      const colorCount = recs.filter((r) => r.flag === 'color').length;
      placeList.append(el('div', { style: 'font-size:12px;color:var(--fg-dim);margin-top:6px' },
        placements.length === 0 ? '尚未添加拼版' : `拼版合计：${stitchCount} 针 · 换色 ${colorCount} 次`));
    };

    colRight.append(
      el('div', { className: 'panel' },
        el('h3', {}, '拼版（多个拷贝/花版一起绣）'),
        el('label', { className: 'field' }, el('span', {}, '行数'), rowsInput),
        el('label', { className: 'field' }, el('span', {}, '列数'), colsInput),
        el('label', { className: 'field' }, el('span', {}, '横向间距mm'), gapXInput),
        el('label', { className: 'field' }, el('span', {}, '纵向间距mm'), gapYInput),
        el('button', {
          onclick: () => {
            if (!selectedPatternId) return;
            placements.push({
              patternId: selectedPatternId,
              rows: Math.max(1, parseInt(rowsInput.value) || 1),
              cols: Math.max(1, parseInt(colsInput.value) || 1),
              gapX: Math.max(0, parseFloat(gapXInput.value) || 0),
              gapY: Math.max(0, parseFloat(gapYInput.value) || 0),
            });
            render();
          },
        }, '＋ 添加当前花版到拼版'),
        el('div', { style: 'margin-top:8px' }, placeList),
        el('div', { style: 'display:flex;gap:8px;margin-top:10px;flex-wrap:wrap' },
          el('button', {
            className: 'primary',
            onclick: () => {
              const recs = combinedRecords();
              if (recs.length === 0) { toast('拼版为空'); return; }
              const buf = writeDst('layout', recs);
              downloadBlob('拼版.dst', new Blob([buf], { type: 'application/octet-stream' }));
              toast('已导出拼版 DST');
            },
          }, '导出拼版 DST'),
          el('button', { onclick: () => exportPaper() }, '导出纸样图 PNG'),
          el('button', {
            onclick: () => {
              if (!plan) return;
              const p = store.patterns.find((x) => x.id === selectedPatternId);
              const buf = writeDst(p?.name ?? 'design', plan.records);
              downloadBlob(`${p?.name ?? '花版'}.dst`, new Blob([buf], { type: 'application/octet-stream' }));
              toast('已导出单版 DST');
            },
          }, '导出单版 DST'))
      )
    );
    renderPlacements();
  }

  function statCard(v: string, k: string): HTMLElement {
    return el('div', { className: 'stat-card' }, el('div', { className: 'v' }, v), el('div', { className: 'k' }, k));
  }

  /** 车间纸样图：白底，每个拷贝画外框 + 十字定位 + 起针点 + 序号尺寸 */
  function exportPaper() {
    const recs = combinedRecords();
    if (recs.length === 0) { toast('拼版为空，无法生成纸样'); return; }
    const b = boundsOf(recs);
    const margin = 20; // mm
    const wMm = b.maxX - b.minX + margin * 2;
    const hMm = b.maxY - b.minY + margin * 2;
    const ppm = 4; // ≈100dpi
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(wMm * ppm);
    canvas.height = Math.round(hMm * ppm);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const toS = (x: number, y: number) => ({
      x: (x - b.minX + margin) * ppm,
      y: (b.maxY - y + margin) * ppm,
    });
    ctx.strokeStyle = '#000';
    ctx.fillStyle = '#000';
    ctx.lineWidth = 1;

    // 每个拷贝的外框与定位
    let idx = 0;
    for (const pl of placements) {
      const p = store.patterns.find((x) => x.id === pl.patternId);
      if (!p) continue;
      const plan = buildPlan(p.regions);
      if (plan.records.length === 0) continue;
      const pb = boundsOf(plan.records);
      const w = pb.maxX - pb.minX;
      const h = pb.maxY - pb.minY;
      for (let r = 0; r < pl.rows; r++) {
        for (let c = 0; c < pl.cols; c++) {
          idx++;
          const ox = c * (w + pl.gapX);
          const oy = r * (h + pl.gapY);
          const tl = toS(pb.minX + ox, pb.maxY + oy);
          const br = toS(pb.maxX + ox, pb.minY + oy);
          ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
          // 中心十字
          const cx = (tl.x + br.x) / 2;
          const cy = (tl.y + br.y) / 2;
          ctx.beginPath();
          ctx.moveTo(cx - 12, cy); ctx.lineTo(cx + 12, cy);
          ctx.moveTo(cx, cy - 12); ctx.lineTo(cx, cy + 12);
          ctx.stroke();
          // 起针点
          const first = plan.records.find((x) => x.flag === 'stitch');
          if (first) {
            const s = toS(first.x + ox, first.y + oy);
            ctx.beginPath();
            ctx.arc(s.x, s.y, 4, 0, Math.PI * 2);
            ctx.stroke();
          }
          ctx.font = '12px sans-serif';
          ctx.fillText(`#${idx} ${p.name} ${w.toFixed(0)}×${h.toFixed(0)}mm`, tl.x, tl.y - 4);
        }
      }
    }
    // 总尺寸标注
    ctx.font = '14px sans-serif';
    ctx.fillText(`总尺寸 ${(b.maxX - b.minX).toFixed(0)} × ${(b.maxY - b.minY).toFixed(0)} mm · 共 ${idx} 个 · ${new Date().toLocaleDateString()}`, 10, canvas.height - 10);
    canvas.toBlob((blob) => {
      if (blob) {
        downloadBlob('纸样图.png', blob);
        toast('已导出纸样图 PNG（A 纸打印时按实际尺寸缩放）');
      }
    });
  }

  const offPatterns = store.on('patterns', render);
  const offCurrent = store.on('current', () => {
    if (!selectedPatternId) selectedPatternId = store.currentId;
  });
  render();
  return () => {
    offPatterns();
    offCurrent();
    page.remove();
  };
}
