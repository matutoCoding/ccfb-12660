// 制版编辑页:位图描边、手动画轮廓、分区针法参数、实时重算针迹、顺序调整。

import { el, pickFile, download, fmtTime } from './dom';
import { createRegion, Pattern, Region, STITCH_TYPE_NAMES, StitchType, Vec2 } from '../core/types';
import { regenerate } from '../core/stitchgen';
import { computeStats, optimizeSequence } from '../core/sequence';
import { traceBitmap } from '../core/trace';
import { pointInPolygon } from '../core/geometry';
import { THREAD_PALETTE, threadColor } from '../core/palette';
import { writeDst } from '../core/dst';
import * as db from '../core/db';

interface View { cx: number; cy: number; ppm: number }

export function renderEditor(container: HTMLElement, patternId: string | null): () => void {
  const page = el('div', { class: 'page-noscroll' });
  container.append(page);

  let pattern: Pattern | null = null;
  let selected: Region | null = null;
  let mode: 'select' | 'draw' = 'select';
  let drawPts: Vec2[] = [];
  let mouse: Vec2 | null = null;
  let view: View = { cx: 0, cy: 0, ppm: 6 };
  let disposed = false;
  let regenTimer: number | undefined;
  let bgImage: HTMLImageElement | null = null;
  let bgScaleMm = 100; // 位图导入时的目标宽度

  // ---------- 布局 ----------
  const canvas = el('canvas', {});
  const ctx = canvas.getContext('2d')!;
  const canvasWrap = el('div', { class: 'canvas-wrap' }, [canvas]);
  const leftBar = el('div', { class: 'sidebar left' });
  const rightBar = el('div', { class: 'sidebar' });
  page.append(leftBar, canvasWrap, rightBar);

  function toScreen(p: Vec2): Vec2 {
    return {
      x: (p.x - view.cx) * view.ppm + canvas.clientWidth / 2,
      y: (view.cy - p.y) * view.ppm + canvas.clientHeight / 2,
    };
  }
  function toWorld(sx: number, sy: number): Vec2 {
    return {
      x: (sx - canvas.clientWidth / 2) / view.ppm + view.cx,
      y: view.cy - (sy - canvas.clientHeight / 2) / view.ppm,
    };
  }

  // ---------- 数据 ----------
  async function load(): Promise<void> {
    if (!patternId) { location.hash = '#/library'; return; }
    const all = await db.listPatterns();
    pattern = all.find(p => p.id === patternId) ?? null;
    if (!pattern) { location.hash = '#/library'; return; }
    if (pattern.regions.length) {
      // 视野适配所有轮廓
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const r of pattern.regions) for (const p of r.outline) {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      }
      view.cx = (minX + maxX) / 2;
      view.cy = (minY + maxY) / 2;
      view.ppm = Math.min(canvas.clientWidth / Math.max(1, maxX - minX), canvas.clientHeight / Math.max(1, maxY - minY)) * 0.8;
    }
    rebuildLeft();
    rebuildRight();
    scheduleRegen(0);
  }

  function scheduleRegen(delay = 250): void {
    clearTimeout(regenTimer);
    regenTimer = window.setTimeout(async () => {
      if (!pattern || disposed) return;
      regenerate(pattern);
      await db.savePattern(pattern); // 自动保存
      draw();
      updateStats();
    }, delay);
  }

  let regionListBox: HTMLElement | null = null;

  // ---------- 左侧:工具 ----------
  function rebuildLeft(): void {
    leftBar.innerHTML = '';
    const selBtn = el('button', { class: mode === 'select' ? 'primary' : '' }, ['选择/移动']);
    selBtn.onclick = () => { mode = 'select'; drawPts = []; rebuildLeft(); draw(); };
    const drawBtn = el('button', { class: mode === 'draw' ? 'primary' : '' }, ['画轮廓']);
    drawBtn.onclick = () => { mode = 'draw'; rebuildLeft(); draw(); };
    const imgBtn = el('button', {}, ['导入位图描边']);
    imgBtn.onclick = importBitmap;

    leftBar.append(
      el('h4', {}, ['工具']),
      selBtn, drawBtn, imgBtn,
      el('div', { class: 'hint' }, [
        mode === 'draw'
          ? '单击加点,双击或回车闭合,Esc 取消'
          : '拖动顶点修形,拖动内部移动分区,滚轮缩放,空白处拖动平移',
      ]),
      el('h4', {}, ['顺序(先绣在上)']),
    );
    regionListBox = el('div', {});
    leftBar.append(regionListBox);
    rebuildRegionList();
    const autoBtn = el('button', {}, ['自动排序(减换色/跳针)']);
    autoBtn.onclick = () => {
      if (!pattern) return;
      pattern.regions = optimizeSequence(pattern.regions);
      rebuildRegionList();
      scheduleRegen(0);
    };
    leftBar.append(autoBtn);
  }

  function rebuildRegionList(): void {
    const target = regionListBox;
    if (!target || !pattern) return;
    target.innerHTML = '';
    pattern.regions.forEach((r, i) => {
      const c = threadColor(r.colorId);
      const up = el('button', {}, ['▲']);
      up.onclick = e => { e.stopPropagation(); moveRegion(i, -1); };
      const down = el('button', {}, ['▼']);
      down.onclick = e => { e.stopPropagation(); moveRegion(i, 1); };
      const item = el('div', { class: 'region-item' + (selected === r ? ' sel' : '') }, [
        el('span', { class: 'dot', style: `background:rgb(${c.rgb.map(v => v * 255).join(',')})` }),
        el('span', { class: 'nm' }, [`${i + 1}. ${r.name} · ${STITCH_TYPE_NAMES[r.stitchType]}`]),
        el('span', { class: 'ord' }, [up, down]),
      ]);
      item.onclick = () => { selected = r; rebuildRight(); rebuildRegionList(); draw(); };
      target.append(item);
    });
  }

  function moveRegion(i: number, dir: number): void {
    if (!pattern) return;
    const j = i + dir;
    if (j < 0 || j >= pattern.regions.length) return;
    [pattern.regions[i], pattern.regions[j]] = [pattern.regions[j], pattern.regions[i]];
    rebuildLeft();
    scheduleRegen(0);
  }

  // ---------- 右侧:参数 ----------
  function rebuildRight(): void {
    rightBar.innerHTML = '';
    if (!pattern) return;
    const nameInput = el('input', { type: 'text', value: pattern.name, style: 'width:100%' });
    nameInput.onchange = () => { pattern!.name = nameInput.value; scheduleRegen(0); };
    rightBar.append(el('h4', {}, ['花版']), nameInput, statsBox);

    if (!selected) {
      rightBar.append(el('p', { class: 'hint' }, ['选中一个分区编辑参数']));
    } else {
      const r = selected;
      rightBar.append(el('h4', {}, ['分区参数']));

      const nm = el('input', { type: 'text', value: r.name });
      nm.onchange = () => { r.name = nm.value; rebuildLeft(); scheduleRegen(); };
      rightBar.append(field('名称', nm));

      const typeSel = el('select', {});
      for (const t of Object.keys(STITCH_TYPE_NAMES) as StitchType[]) {
        typeSel.append(el('option', { value: t, ...(t === r.stitchType ? { selected: '' } : {}) }, [STITCH_TYPE_NAMES[t]]));
      }
      typeSel.onchange = () => { r.stitchType = typeSel.value as StitchType; scheduleRegen(); };
      rightBar.append(field('针法', typeSel));

      rightBar.append(
        slider('方向°', 0, 180, 1, r.angle, v => { r.angle = v; }),
        slider('密度mm', 0.2, 1.2, 0.05, r.density, v => { r.density = v; }),
        slider('针迹长mm', 1, 6, 0.5, r.stitchLength, v => { r.stitchLength = v; }),
        slider('拉线补偿', 0, 1, 0.05, r.pullComp, v => { r.pullComp = v; }),
      );

      const colorSel = el('select', {});
      for (const c of THREAD_PALETTE) {
        colorSel.append(el('option', { value: c.id, ...(c.id === r.colorId ? { selected: '' } : {}) }, [c.name]));
      }
      colorSel.onchange = () => { r.colorId = colorSel.value; rebuildLeft(); scheduleRegen(); };
      rightBar.append(field('绣线', colorSel));

      const delBtn = el('button', { class: 'danger' }, ['删除分区']);
      delBtn.onclick = () => {
        pattern!.regions = pattern!.regions.filter(x => x !== r);
        selected = null;
        rebuildLeft(); rebuildRight();
        scheduleRegen(0);
      };
      rightBar.append(delBtn);
    }

    const saveVerBtn = el('button', {}, ['保存版本']);
    saveVerBtn.onclick = async () => {
      if (!pattern) return;
      const note = prompt('版本备注', `手动保存 ${pattern.regions.length} 个分区`);
      await db.saveVersion(pattern, note ?? '');
      toast('版本已保存');
    };
    const expBtn = el('button', {}, ['导出 DST']);
    expBtn.onclick = () => {
      if (!pattern?.stitches.length) { toast('还没有针迹可导出'); return; }
      download(`${pattern.name}.dst`, writeDst(pattern.name, pattern.stitches));
    };
    const simBtn = el('button', { class: 'primary' }, ['去仿真 →']);
    simBtn.onclick = () => { if (pattern) location.hash = `#/sim/${pattern.id}`; };
    rightBar.append(el('h4', {}, ['操作']), saveVerBtn, expBtn, simBtn);
  }

  function field(label: string, input: HTMLElement): HTMLElement {
    return el('div', { class: 'field' }, [el('label', {}, [label]), input]);
  }

  function slider(label: string, min: number, max: number, step: number, val: number, set: (v: number) => void): HTMLElement {
    const input = el('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(val) });
    const valSpan = el('span', { class: 'val' }, [String(val)]);
    input.oninput = () => {
      const v = parseFloat(input.value);
      valSpan.textContent = String(v);
      set(v);
      scheduleRegen();
    };
    return el('div', { class: 'field' }, [el('label', {}, [label]), input, valSpan]);
  }

  const statsBox = el('div', { class: 'stat-grid' });
  function updateStats(): void {
    if (!pattern) return;
    const s = computeStats(pattern.stitches);
    statsBox.innerHTML = '';
    const items: Array<[string, string]> = [
      [String(s.stitchCount), '总针数'],
      [String(s.jumpCount), '跳针'],
      [String(s.colorChanges), '换色次数'],
      [fmtTime(s.estimatedSeconds), '预计工时'],
    ];
    for (const [v, k] of items) {
      statsBox.append(el('div', { class: 'stat' }, [el('div', { class: 'v' }, [v]), el('div', { class: 'k' }, [k])]));
    }
  }

  // ---------- 位图导入 ----------
  async function importBitmap(): Promise<void> {
    if (!pattern) return;
    const file = await pickFile('image/*');
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    bgImage = img;

    const widthStr = prompt('图案实际宽度(mm)?', String(bgScaleMm));
    if (widthStr) bgScaleMm = Math.max(10, parseFloat(widthStr) || 100);

    // 降采样到 240px 宽再描边
    const maxW = 240;
    const scale = Math.min(1, maxW / img.width);
    const off = document.createElement('canvas');
    off.width = Math.round(img.width * scale);
    off.height = Math.round(img.height * scale);
    const octx = off.getContext('2d')!;
    octx.drawImage(img, 0, 0, off.width, off.height);
    const imageData = octx.getImageData(0, 0, off.width, off.height);

    const colorStr = prompt('分几个颜色?', '5');
    const maxColors = Math.min(10, Math.max(2, parseInt(colorStr ?? '5', 10) || 5));
    const traced = traceBitmap(imageData, bgScaleMm, maxColors);
    if (!traced.length) { toast('没有描出有效区域,试试调整颜色数'); return; }
    for (const t of traced) {
      pattern.regions.push(createRegion({
        name: `描边${pattern.regions.length + 1}`,
        outline: t.outline,
        holes: t.holes,
        colorId: t.colorId,
      }));
    }
    toast(`描边完成:${traced.length} 个分区`);
    rebuildLeft();
    scheduleRegen(0);
  }

  function toast(msg: string): void {
    const t = el('div', { class: 'toast' }, [msg]);
    document.body.append(t);
    setTimeout(() => t.remove(), 2200);
  }

  // ---------- 画布绘制 ----------
  function draw(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // 背景位图(半透明)
    if (bgImage) {
      ctx.save();
      ctx.globalAlpha = 0.35;
      const iw = bgScaleMm, ih = (bgScaleMm * bgImage.height) / bgImage.width;
      const p0 = toScreen({ x: -iw / 2, y: ih / 2 });
      ctx.drawImage(bgImage, p0.x, p0.y, iw * view.ppm, ih * view.ppm);
      ctx.restore();
    }

    if (!pattern) return;

    // 针迹(细线)
    ctx.lineWidth = 1;
    let prevColor = '';
    ctx.beginPath();
    let started = false;
    for (const s of pattern.stitches) {
      if (s.flag === 3) break;
      if (s.flag === 2) { ctx.stroke(); ctx.beginPath(); prevColor = ''; }
      const region = pattern.regions[s.region];
      const cid = region?.colorId ?? 'T1801';
      if (cid !== prevColor) {
        ctx.stroke(); ctx.beginPath();
        const c = threadColor(cid);
        ctx.strokeStyle = `rgb(${c.rgb.map(v => Math.round(v * 255)).join(',')})`;
        prevColor = cid;
      }
      const sp = toScreen(s);
      if (!started || s.flag === 1) { ctx.moveTo(sp.x, sp.y); }
      else ctx.lineTo(sp.x, sp.y);
      started = true;
    }
    ctx.stroke();

    // 分区轮廓
    for (const r of pattern.regions) {
      const c = threadColor(r.colorId);
      const rgb = c.rgb.map(v => Math.round(v * 255)).join(',');
      ctx.beginPath();
      r.outline.forEach((p, i) => {
        const sp = toScreen(p);
        i ? ctx.lineTo(sp.x, sp.y) : ctx.moveTo(sp.x, sp.y);
      });
      ctx.closePath();
      for (const hole of r.holes) {
        hole.forEach((p, i) => {
          const sp = toScreen(p);
          i ? ctx.lineTo(sp.x, sp.y) : ctx.moveTo(sp.x, sp.y);
        });
        ctx.closePath();
      }
      ctx.fillStyle = `rgba(${rgb},0.10)`;
      ctx.fill();
      ctx.strokeStyle = selected === r ? '#4a9eff' : `rgba(${rgb},0.85)`;
      ctx.lineWidth = selected === r ? 2 : 1;
      ctx.stroke();

      // 顶点手柄(选中时)
      if (selected === r) {
        ctx.fillStyle = '#4a9eff';
        for (const p of r.outline) {
          const sp = toScreen(p);
          ctx.fillRect(sp.x - 3, sp.y - 3, 6, 6);
        }
      }
    }

    // 正在画的轮廓
    if (drawPts.length) {
      ctx.beginPath();
      drawPts.forEach((p, i) => {
        const sp = toScreen(p);
        i ? ctx.lineTo(sp.x, sp.y) : ctx.moveTo(sp.x, sp.y);
      });
      if (mouse) {
        const sp = toScreen(mouse);
        ctx.lineTo(sp.x, sp.y);
      }
      ctx.strokeStyle = '#e0533d';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = '#e0533d';
      for (const p of drawPts) {
        const sp = toScreen(p);
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // ---------- 交互 ----------
  let dragVertex = -1;
  let dragRegion: Region | null = null;
  let panning = false;
  let lastMouse = { x: 0, y: 0 };

  canvas.addEventListener('mousedown', e => {
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    lastMouse = { x: sx, y: sy };
    const wp = toWorld(sx, sy);

    if (mode === 'draw') {
      drawPts.push(wp);
      draw();
      return;
    }
    // 选择模式:先测顶点,再测分区内部,否则平移
    if (selected) {
      for (let i = 0; i < selected.outline.length; i++) {
        const sp = toScreen(selected.outline[i]);
        if (Math.hypot(sp.x - sx, sp.y - sy) < 8) { dragVertex = i; return; }
      }
    }
    if (pattern) {
      for (let i = pattern.regions.length - 1; i >= 0; i--) {
        const r = pattern.regions[i];
        if (r.outline.length >= 3 && pointInPolygon(wp, r.outline)) {
          if (selected !== r) { selected = r; rebuildRight(); rebuildLeft(); }
          dragRegion = r;
          draw();
          return;
        }
      }
    }
    panning = true;
  });

  canvas.addEventListener('mousemove', e => {
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    mouse = toWorld(sx, sy);
    const dx = sx - lastMouse.x, dy = sy - lastMouse.y;
    lastMouse = { x: sx, y: sy };

    if (dragVertex >= 0 && selected) {
      selected.outline[dragVertex] = mouse;
      scheduleRegen();
      draw();
    } else if (dragRegion) {
      const wx = dx / view.ppm, wy = -dy / view.ppm;
      dragRegion.outline = dragRegion.outline.map(p => ({ x: p.x + wx, y: p.y + wy }));
      dragRegion.holes = dragRegion.holes.map(h => h.map(p => ({ x: p.x + wx, y: p.y + wy })));
      scheduleRegen();
      draw();
    } else if (panning) {
      view.cx -= dx / view.ppm;
      view.cy += dy / view.ppm;
      draw();
    } else if (mode === 'draw') {
      draw();
    }
  });

  window.addEventListener('mouseup', onUp);
  function onUp(): void {
    if ((dragVertex >= 0 || dragRegion) && pattern) scheduleRegen(0);
    dragVertex = -1;
    dragRegion = null;
    panning = false;
  }

  canvas.addEventListener('dblclick', () => { if (mode === 'draw') closeDraw(); });
  window.addEventListener('keydown', onKey);
  function onKey(e: KeyboardEvent): void {
    if (disposed) return;
    if (mode === 'draw' && e.key === 'Enter') closeDraw();
    if (mode === 'draw' && e.key === 'Escape') { drawPts = []; draw(); }
  }

  function closeDraw(): void {
    if (!pattern || drawPts.length < 3) { drawPts = []; draw(); return; }
    const r = createRegion({
      name: `手绘${pattern.regions.length + 1}`,
      outline: drawPts.slice(),
    });
    pattern.regions.push(r);
    selected = r;
    drawPts = [];
    mode = 'select';
    rebuildLeft(); rebuildRight();
    scheduleRegen(0);
  }

  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const before = toWorld(sx, sy);
    view.ppm *= e.deltaY < 0 ? 1.15 : 1 / 1.15;
    view.ppm = Math.max(0.5, Math.min(200, view.ppm));
    const after = toWorld(sx, sy);
    view.cx += before.x - after.x;
    view.cy += before.y - after.y;
    draw();
  }, { passive: false });

  const resizeObs = new ResizeObserver(() => draw());
  resizeObs.observe(canvasWrap);

  rebuildLeft();
  rebuildRight();
  load();

  return () => {
    disposed = true;
    clearTimeout(regenTimer);
    window.removeEventListener('mouseup', onUp);
    window.removeEventListener('keydown', onKey);
    resizeObs.disconnect();
  };
}
