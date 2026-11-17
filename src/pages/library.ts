// 花版库页面：新建 / 复制 / 删除 / 导入导出 DST / 缩略图，自动保存

import { el, clear, pickFile, downloadBlob, fmtTime } from '../ui/dom';
import { store } from '../store/store';
import { buildPlan } from '../core/stitchgen';
import { parseDst, writeDst, dstSummary } from '../core/dst';
import { recordsToRegions } from '../core/importer';
import { threadById } from '../core/threadlib';
import { boundsOf } from '../core/geometry';
import type { Pattern } from '../core/types';
import { toast } from '../ui/toast';

function drawThumbnail(canvas: HTMLCanvasElement, pattern: Pattern) {
  const ctx = canvas.getContext('2d')!;
  const w = (canvas.width = 220);
  const h = (canvas.height = 140);
  ctx.fillStyle = '#f5f2ea';
  ctx.fillRect(0, 0, w, h);
  if (pattern.regions.length === 0) {
    ctx.fillStyle = '#bbb';
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('空花版', w / 2, h / 2);
    return;
  }
  const plan = buildPlan(pattern.regions);
  const pts = plan.records.map((r) => ({ x: r.x, y: r.y }));
  if (pts.length === 0) return;
  const b = boundsOf(pts);
  const bw = Math.max(1e-3, b.maxX - b.minX);
  const bh = Math.max(1e-3, b.maxY - b.minY);
  const ppm = Math.min((w - 16) / bw, (h - 16) / bh);
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  const toScreen = (p: { x: number; y: number }) => ({
    x: (p.x - cx) * ppm + w / 2,
    y: h / 2 - (p.y - cy) * ppm,
  });
  let prev = toScreen(pts[0]);
  for (let i = 0; i < plan.records.length; i++) {
    const r = plan.records[i];
    const cur = toScreen(r);
    if (r.flag === 'stitch') {
      const block = plan.blocks[r.block];
      const t = block ? threadById(block.colorId) : null;
      ctx.strokeStyle = t ? `rgb(${t.rgb[0]},${t.rgb[1]},${t.rgb[2]})` : '#888';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(prev.x, prev.y);
      ctx.lineTo(cur.x, cur.y);
      ctx.stroke();
    }
    prev = cur;
  }
}

export function mountLibrary(root: HTMLElement, go: (page: string) => void): () => void {
  const page = el('div', { className: 'page library-page' });
  root.append(page);

  const grid = el('div', { className: 'pattern-grid' });

  const render = () => {
    clear(grid);
    if (store.patterns.length === 0) {
      grid.append(el('div', { className: 'empty-hint' }, '还没有花版。点击「新建花版」或「导入 DST」开始。'));
      return;
    }
    for (const p of store.patterns) {
      const canvas = el('canvas', {});
      drawThumbnail(canvas, p);
      const plan = buildPlan(p.regions);
      const card = el(
        'div',
        {
          className: 'pattern-card' + (p.id === store.currentId ? ' current' : ''),
          onclick: () => {
            store.select(p.id);
            go('editor');
          },
        },
        canvas,
        el(
          'div',
          { className: 'info' },
          el('div', { className: 'name' }, p.name),
          el(
            'div',
            { className: 'meta' },
            `${plan.stats.stitches} 针 · ${p.regions.length} 个分区 · ${new Date(p.updatedAt).toLocaleString()}`
          )
        ),
        el(
          'div',
          { className: 'actions' },
          el('button', {
            onclick: (e: Event) => {
              e.stopPropagation();
              store.duplicatePattern(p.id);
            },
          }, '复制'),
          el('button', {
            onclick: (e: Event) => {
              e.stopPropagation();
              const plan2 = buildPlan(p.regions);
              const buf = writeDst(p.name, plan2.records);
              downloadBlob(`${p.name}.dst`, new Blob([buf], { type: 'application/octet-stream' }));
              toast(`已导出 ${p.name}.dst（${plan2.stats.stitches} 针）`);
            },
          }, '导出 DST'),
          el('button', {
            className: 'danger',
            onclick: (e: Event) => {
              e.stopPropagation();
              if (confirm(`删除花版「${p.name}」？此操作不可恢复。`)) store.deletePattern(p.id);
            },
          }, '删除')
        )
      );
      grid.append(card);
    }
  };

  const importDst = async () => {
    const file = await pickFile('.dst');
    if (!file) return;
    try {
      const buf = await file.arrayBuffer();
      const parsed = parseDst(buf);
      const regions = recordsToRegions(parsed.records);
      const p = store.createPattern(parsed.name || file.name.replace(/\.dst$/i, ''));
      store.updateCurrent((pat) => {
        pat.regions = regions;
      }, { immediatePlan: true });
      store.saveVersion('导入 DST 初始版');
      toast(`导入成功：${dstSummary(parsed)}，走针顺序与文件一致`);
      go('editor');
      void p;
    } catch (err) {
      toast('DST 解析失败：' + (err as Error).message);
    }
  };

  const toolbar = el(
    'div',
    { className: 'library-toolbar' },
    el('button', {
      className: 'primary',
      onclick: () => {
        store.createPattern();
        go('editor');
      },
    }, '＋ 新建花版'),
    el('button', { onclick: () => void importDst() }, '导入 DST 文件'),
    el('span', { className: 'meta', style: 'color:var(--fg-dim);font-size:13px' },
      '所有花版自动保存在本机浏览器中')
  );

  page.append(toolbar, grid);
  const off = store.on('patterns', render);
  render();
  return () => off();
}
