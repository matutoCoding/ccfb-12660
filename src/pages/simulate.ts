// 针迹仿真页面：按绣制顺序动画走针，可调速、拖进度，跳针/换色/起坨标记

import { el, fmtTime } from '../ui/dom';
import { store } from '../store/store';
import { StitchGL } from '../render/gl';
import { boundsOf } from '../core/geometry';
import { threadById } from '../core/threadlib';

export function mountSimulate(root: HTMLElement): () => void {
  const page = el('div', { className: 'page sim-page' });
  root.append(page);

  const wrap = el('div', { className: 'sim-canvas-wrap' });
  const stack = el('div', { className: 'canvas-stack' });
  const glCanvas = el('canvas', {});
  const overlay = el('canvas', {});
  stack.append(glCanvas, overlay);
  wrap.append(stack);

  // 控制条
  const btnPlay = el('button', { className: 'primary', style: 'min-width:70px' }, '▶ 播放');
  const speedInput = el('input', { type: 'range', min: '10', max: '1500', value: '300', step: '10', style: 'width:120px' });
  const speedLabel = el('span', {}, '300 针/秒');
  const progressInput = el('input', { type: 'range', min: '0', max: '1000', value: '0', className: 'sim-progress' });
  const timeline = el('div', { className: 'timeline' });
  const info = el('span', { className: 'sim-info' }, '');
  const chkJumps = el('input', { type: 'checkbox', checked: true });
  const chkHot = el('input', { type: 'checkbox', checked: true });
  const wrinkleInput = el('input', { type: 'range', min: '0', max: '100', value: '0', style: 'width:90px' });

  const controls = el(
    'div',
    { className: 'sim-controls' },
    btnPlay,
    el('div', { className: 'group' }, '速度', speedInput, speedLabel),
    el('div', { className: 'group', style: 'flex:1;min-width:220px' }, timeline),
    progressInput,
    el('label', { className: 'group' }, chkJumps, '跳针'),
    el('label', { className: 'group' }, chkHot, '起坨'),
    el('div', { className: 'group' }, '起皱', wrinkleInput),
    info
  );
  page.append(wrap, controls);

  let gl: StitchGL;
  try {
    gl = new StitchGL(glCanvas);
  } catch (err) {
    wrap.append(el('div', { className: 'empty-hint' }, (err as Error).message));
    return () => page.remove();
  }

  const octx = overlay.getContext('2d')!;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  let playing = false;
  let progress = 0; // 浮点记录序号
  let rafId = 0;
  let lastTs = 0;
  let fitted = false;
  let stitchPrefix: number[] = []; // stitchPrefix[i] = 前 i 条记录中的针数

  const total = () => store.plan?.records.length ?? 0;

  function currentRecordIndex(): number {
    return Math.min(total() - 1, Math.floor(progress));
  }

  function resizeOverlay() {
    const w = overlay.clientWidth;
    const h = overlay.clientHeight;
    if (w === 0 || h === 0) return;
    overlay.width = Math.round(w * dpr);
    overlay.height = Math.round(h * dpr);
  }

  function drawOverlay() {
    resizeOverlay();
    const w = overlay.clientWidth;
    const h = overlay.clientHeight;
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    octx.clearRect(0, 0, w, h);
    const plan = store.plan;
    if (!plan) return;

    // 起坨警告
    if (chkHot.checked) {
      octx.strokeStyle = '#ff5b5b';
      octx.lineWidth = 2;
      for (const hp of plan.hotspots) {
        const s = gl.worldToScreen(hp);
        octx.beginPath();
        octx.arc(s.x, s.y, 9, 0, Math.PI * 2);
        octx.stroke();
        octx.fillStyle = '#ff5b5b';
        octx.font = '10px sans-serif';
        octx.fillText('坨', s.x + 11, s.y + 4);
      }
    }

    // 针位十字标
    const idx = currentRecordIndex();
    if (idx >= 0 && plan.records.length > 0) {
      const r = plan.records[Math.max(0, idx)];
      const s = gl.worldToScreen(r);
      octx.strokeStyle = '#fff';
      octx.lineWidth = 1.5;
      octx.beginPath();
      octx.moveTo(s.x - 10, s.y);
      octx.lineTo(s.x + 10, s.y);
      octx.moveTo(s.x, s.y - 10);
      octx.lineTo(s.x, s.y + 10);
      octx.stroke();
      octx.beginPath();
      octx.arc(s.x, s.y, 6, 0, Math.PI * 2);
      octx.stroke();
    }
  }

  function updateInfo() {
    const plan = store.plan;
    if (!plan) {
      info.textContent = '无花版';
      return;
    }
    const idx = Math.max(0, currentRecordIndex());
    const rec = plan.records[idx];
    const block = rec ? plan.blocks[rec.block] : null;
    const t = block ? threadById(block.colorId) : null;
    const spm = store.spm;
    const done = stitchPrefix[Math.min(idx + 1, stitchPrefix.length - 1)] ?? 0;
    const estTotal = plan.stats.estSeconds;
    const estDone = (done / spm) * 60;
    info.textContent =
      `记录 ${idx + 1}/${total()} · 针 ${done}/${plan.stats.stitches}` +
      (t ? ` · 线色 ${t.code}` : '') +
      ` · ${fmtTime(estDone)} / ${fmtTime(estTotal)}`;
  }

  function renderFrame(ts: number) {
    if (playing) {
      const dt = lastTs ? (ts - lastTs) / 1000 : 0;
      const speed = parseInt(speedInput.value);
      progress += speed * dt;
      if (progress >= total()) {
        progress = total();
        playing = false;
        btnPlay.textContent = '▶ 播放';
      }
    }
    lastTs = ts;
    gl.progress = progress;
    gl.wrinkle = parseInt(wrinkleInput.value) / 100;
    gl.showJumps = chkJumps.checked;
    gl.render(ts / 1000);
    drawOverlay();
    updateInfo();
    // 进度条与播放头
    if (total() > 0) {
      progressInput.value = String(Math.round((progress / total()) * 1000));
      const head = timeline.querySelector<HTMLElement>('.playhead');
      if (head) head.style.left = `${(progress / total()) * 100}%`;
    }
    rafId = requestAnimationFrame(renderFrame);
  }

  function rebuildTimeline() {
    const plan = store.plan;
    timeline.textContent = '';
    if (!plan || plan.records.length === 0) return;
    const n = plan.records.length;
    plan.records.forEach((r, i) => {
      if (r.flag === 'stitch') return;
      const m = document.createElement('div');
      m.className = 'marker ' + (r.flag === 'color' ? 'color' : 'jump');
      m.style.left = `${(i / n) * 100}%`;
      m.title = r.flag === 'color' ? `换色 @${i}` : `跳针 @${i}`;
      timeline.append(m);
    });
    // 起坨位置（映射到最近的记录序号）
    for (const hp of plan.hotspots) {
      let best = 0;
      let bestD = Infinity;
      plan.records.forEach((r, i) => {
        const d = (r.x - hp.x) ** 2 + (r.y - hp.y) ** 2;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      });
      const m = document.createElement('div');
      m.className = 'marker hot';
      m.style.left = `${(best / n) * 100}%`;
      m.title = '起坨风险';
      timeline.append(m);
    }
    const head = document.createElement('div');
    head.className = 'playhead';
    timeline.append(head);
  }

  function fit() {
    const plan = store.plan;
    if (plan && plan.records.length > 0) {
      gl.fitBounds(boundsOf(plan.records));
      fitted = true;
    }
  }

  // 事件
  btnPlay.addEventListener('click', () => {
    if (total() === 0) return;
    playing = !playing;
    if (playing && progress >= total()) progress = 0;
    btnPlay.textContent = playing ? '⏸ 暂停' : '▶ 播放';
  });
  speedInput.addEventListener('input', () => {
    speedLabel.textContent = `${speedInput.value} 针/秒`;
  });
  progressInput.addEventListener('input', () => {
    progress = (parseInt(progressInput.value) / 1000) * total();
    playing = false;
    btnPlay.textContent = '▶ 播放';
  });
  timeline.addEventListener('click', (e) => {
    const rect = timeline.getBoundingClientRect();
    progress = ((e.clientX - rect.left) / rect.width) * total();
    playing = false;
    btnPlay.textContent = '▶ 播放';
  });

  // 视图平移缩放
  let panning: { x: number; y: number } | null = null;
  overlay.addEventListener('mousedown', (e) => {
    const rect = overlay.getBoundingClientRect();
    panning = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  });
  const onMove = (e: MouseEvent) => {
    if (!panning) return;
    const rect = overlay.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    gl.panBy(x - panning.x, y - panning.y);
    panning = { x, y };
  };
  const onUp = () => (panning = null);
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const rect = overlay.getBoundingClientRect();
    gl.zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.15 : 1 / 1.15);
  };
  const onKey = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (target instanceof HTMLInputElement) return;
    if (e.code === 'Space') {
      e.preventDefault();
      btnPlay.click();
    }
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  overlay.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('keydown', onKey);

  const offPlan = store.on('plan', () => {
    gl.setPlan(store.plan);
    rebuildTimeline();
    const recs = store.plan?.records ?? [];
    stitchPrefix = new Array(recs.length + 1).fill(0);
    recs.forEach((r, i) => {
      stitchPrefix[i + 1] = stitchPrefix[i] + (r.flag === 'stitch' ? 1 : 0);
    });
    if (!fitted) fit();
    progress = Math.min(progress, total());
  });

  gl.setPlan(store.plan);
  rebuildTimeline();
  {
    const recs = store.plan?.records ?? [];
    stitchPrefix = new Array(recs.length + 1).fill(0);
    recs.forEach((r, i) => {
      stitchPrefix[i + 1] = stitchPrefix[i] + (r.flag === 'stitch' ? 1 : 0);
    });
  }
  fit();
  rafId = requestAnimationFrame(renderFrame);

  const resizeObs = new ResizeObserver(() => {
    if (!fitted) fit();
  });
  resizeObs.observe(wrap);

  return () => {
    cancelAnimationFrame(rafId);
    offPlan();
    resizeObs.disconnect();
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    window.removeEventListener('keydown', onKey);
    page.remove();
  };
}
