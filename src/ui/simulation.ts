// 针迹仿真页:按绣制顺序动画走针,调速/拖进度,跳针换色标记,光泽,起坨警告,布面拉伸。

import { el, fmtTime } from './dom';
import { Flag, Pattern } from '../core/types';
import { StitchRenderer, ViewState, Marker } from '../render/gl';
import { computeStats } from '../core/sequence';
import { detectDensityWarnings, detectShortStitches, computeDisplacementField, DensityWarning } from '../core/analysis';
import { threadColor } from '../core/palette';
import * as db from '../core/db';

export function renderSimulation(container: HTMLElement, patternId: string | null): () => void {
  const page = el('div', { class: 'page-noscroll', style: 'flex-direction:column' });
  container.append(page);

  let pattern: Pattern | null = null;
  let renderer: StitchRenderer | null = null;
  let view: ViewState = { centerX: 0, centerY: 0, ppm: 6 };
  let disposed = false;
  let rafId = 0;

  // 仿真状态
  let playing = false;
  let speed = 300;          // 针/秒
  let progress = 0;         // 当前实例数(浮点,按速度累加)
  let stitchWidth = 0.35;   // mm
  let sheen = 0.8;
  let lightAngle = 60;
  let dispAmount = 0;
  let showWarnings = true;
  let showMarkers = true;
  let warnings: DensityWarning[] = [];
  let lastTime = 0;

  const canvas = el('canvas', {});
  const canvasWrap = el('div', { class: 'canvas-wrap' }, [canvas]);

  // ---------- 控制条 ----------
  const playBtn = el('button', { class: 'primary', style: 'width:70px' }, ['▶ 播放']);
  const progressSlider = el('input', { type: 'range', id: 'sim-progress', min: '0', max: '1', step: '1', value: '0' });
  const posLabel = el('span', { class: 'hint', style: 'min-width:110px' }, ['0 / 0']);
  const speedSlider = el('input', { type: 'range', min: '30', max: '1200', step: '10', value: String(speed) });
  const speedLabel = el('span', { class: 'hint', style: 'min-width:76px' }, [`${speed} 针/秒`]);

  playBtn.onclick = () => {
    playing = !playing;
    playBtn.textContent = playing ? '⏸ 暂停' : '▶ 播放';
    if (playing && renderer && progress >= renderer.totalInstances) progress = 0;
  };
  progressSlider.oninput = () => {
    progress = parseFloat(progressSlider.value);
    playing = false;
    playBtn.textContent = '▶ 播放';
  };
  speedSlider.oninput = () => {
    speed = parseInt(speedSlider.value, 10);
    speedLabel.textContent = `${speed} 针/秒`;
  };

  const controls = el('div', { class: 'sim-controls' }, [
    playBtn,
    el('div', { class: 'group' }, [progressSlider]),
    posLabel,
    el('div', { class: 'group' }, [el('span', {}, ['速度']), speedSlider, speedLabel]),
  ]);

  // ---------- 右侧栏 ----------
  const sidebar = el('div', { class: 'sidebar' });
  const mainRow = el('div', { style: 'flex:1;display:flex;overflow:hidden' }, [canvasWrap, sidebar]);
  page.append(mainRow, controls);

  function sliderRow(label: string, min: number, max: number, step: number, val: number, fmt: (v: number) => string, set: (v: number) => void): HTMLElement {
    const input = el('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(val) });
    const valSpan = el('span', { class: 'val' }, [fmt(val)]);
    input.oninput = () => {
      const v = parseFloat(input.value);
      valSpan.textContent = fmt(v);
      set(v);
    };
    return el('div', { class: 'field' }, [el('label', {}, [label]), input, valSpan]);
  }

  const statsBox = el('div', { class: 'stat-grid' });
  const warnBox = el('div', { class: 'warn-list' });
  const markerBox = el('div', { class: 'warn-list' });

  function buildSidebar(): void {
    sidebar.innerHTML = '';
    sidebar.append(el('h4', {}, ['统计']), statsBox);

    sidebar.append(el('h4', {}, ['显示']));
    sidebar.append(
      sliderRow('线宽mm', 0.15, 0.8, 0.05, stitchWidth, v => v.toFixed(2), v => { stitchWidth = v; }),
      sliderRow('光泽', 0, 1, 0.05, sheen, v => v.toFixed(2), v => { sheen = v; }),
      sliderRow('光源°', 0, 180, 5, lightAngle, v => `${v}°`, v => { lightAngle = v; }),
      sliderRow('布面拉伸', 0, 1, 0.05, dispAmount, v => v.toFixed(2), v => { dispAmount = v; }),
    );
    const warnToggle = el('input', { type: 'checkbox', checked: '' });
    warnToggle.onchange = () => { showWarnings = warnToggle.checked; };
    const markerToggle = el('input', { type: 'checkbox', checked: '' });
    markerToggle.onchange = () => { showMarkers = markerToggle.checked; };
    sidebar.append(
      el('div', { class: 'field' }, [warnToggle, el('label', { style: 'width:auto' }, ['起坨警告'])]),
      el('div', { class: 'field' }, [markerToggle, el('label', { style: 'width:auto' }, ['跳针/换色标记'])]),
    );

    sidebar.append(el('h4', {}, [`起坨警告 (${warnings.length})`]), warnBox);
    sidebar.append(el('h4', {}, ['换色/跳针点']), markerBox);
  }

  // ---------- 数据加载 ----------
  async function load(): Promise<void> {
    if (!patternId) { location.hash = '#/library'; return; }
    const all = await db.listPatterns();
    pattern = all.find(p => p.id === patternId) ?? null;
    if (!pattern) { location.hash = '#/library'; return; }

    renderer = new StitchRenderer(canvas);
    // 颜色:优先分区配色;DST 导入版按换色段轮流取色
    const colorSegments: string[] = [];
    const paletteIds = ['T1800', 'T1410', 'T1067', 'T1250', 'T1533', 'T1023', 'T1801', 'T1802'];
    let segIdx = 0;
    const recColor = new Map<number, string>();
    for (let i = 0; i < pattern.stitches.length; i++) {
      const s = pattern.stitches[i];
      if (s.flag === Flag.Color) { segIdx++; continue; }
      const region = pattern.regions[s.region];
      const cid = region?.colorId ?? paletteIds[segIdx % paletteIds.length];
      recColor.set(i, cid);
      if (!colorSegments.includes(cid)) colorSegments.push(cid);
    }
    renderer.setStitches(pattern.stitches, i => threadColor(recColor.get(i) ?? 'T1801').rgb);
    view = renderer.fitView();

    // 位移场
    renderer.setDisplacement(computeDisplacementField(pattern.stitches));

    // 进度条范围
    progressSlider.max = String(renderer.totalInstances);
    progress = renderer.totalInstances; // 默认显示完整
    progressSlider.value = String(progress);

    // 分析
    warnings = detectDensityWarnings(pattern.stitches);
    const shortN = detectShortStitches(pattern.stitches);

    // 统计
    const s = computeStats(pattern.stitches);
    statsBox.innerHTML = '';
    const items: Array<[string, string]> = [
      [String(s.stitchCount), '总针数'],
      [String(s.jumpCount), '跳针'],
      [String(s.colorChanges), '换色'],
      [fmtTime(s.estimatedSeconds), '预计工时'],
      [warnings.length ? String(warnings.length) : '无', '过密区域'],
      [shortN ? String(shortN) : '无', '过短针迹'],
    ];
    for (const [v, k] of items) {
      statsBox.append(el('div', { class: 'stat' }, [el('div', { class: 'v' }, [v]), el('div', { class: 'k' }, [k])]));
    }

    // 警告列表:点击定位
    warnBox.innerHTML = '';
    for (const w of warnings.slice(0, 30)) {
      const item = el('div', { class: 'warn-item' }, [
        `(${w.x.toFixed(0)}, ${w.y.toFixed(0)}) 附近 ${w.count} 针/格,过密 ${w.severity.toFixed(1)}×`,
      ]);
      item.onclick = () => { view.centerX = w.x; view.centerY = w.y; view.ppm = Math.max(view.ppm, 20); };
      warnBox.append(item);
    }
    if (!warnings.length) warnBox.append(el('div', { class: 'hint' }, ['密度正常,无起坨风险']));

    // 换色/跳针标记列表
    markerBox.innerHTML = '';
    let jumpIdx = 0, colorIdx = 0;
    pattern.stitches.forEach((s, i) => {
      if (s.flag === Flag.Jump || s.flag === Flag.Color) {
        const label = s.flag === Flag.Color ? `换色 #${++colorIdx}` : `跳针 #${++jumpIdx}`;
        const item = el('div', { class: 'warn-item', style: 'color:var(--dim)' }, [
          `${label} @ (${s.x.toFixed(1)}, ${s.y.toFixed(1)})`,
        ]);
        item.onclick = () => {
          const inst = renderer!.recordToInstance[i];
          if (inst >= 0) { progress = inst; progressSlider.value = String(inst); }
          view.centerX = s.x; view.centerY = s.y;
        };
        markerBox.append(item);
      }
    });

    buildSidebar();
  }

  // ---------- 渲染循环 ----------
  function frame(t: number): void {
    if (disposed || !renderer) return;
    const dt = lastTime ? (t - lastTime) / 1000 : 0;
    lastTime = t;
    if (playing) {
      progress = Math.min(renderer.totalInstances, progress + speed * dt);
      progressSlider.value = String(Math.floor(progress));
      if (progress >= renderer.totalInstances) {
        playing = false;
        playBtn.textContent = '▶ 播放';
      }
    }
    posLabel.textContent = `${Math.floor(progress)} / ${renderer.totalInstances}`;

    // 标记:换色点(黄)、跳针点(蓝)、起坨警告(红)、当前针位(白)
    const markers: Marker[] = [];
    if (pattern) {
      if (showMarkers) {
        for (const s of pattern.stitches) {
          if (s.flag === Flag.Color) markers.push({ x: s.x, y: s.y, color: [1, 0.85, 0.1], size: 14 });
        }
      }
      if (showWarnings) {
        for (const w of warnings) {
          markers.push({ x: w.x, y: w.y, color: [1, 0.15, 0.1], size: 10 + Math.min(14, w.severity * 4) });
        }
      }
      // 当前针位
      const inst = Math.floor(progress);
      if (inst > 0 && inst <= renderer.totalInstances) {
        const recIdx = renderer.instanceToRecord[inst - 1];
        const s = pattern.stitches[recIdx];
        markers.push({ x: s.x, y: s.y, color: [1, 1, 1], size: 10 });
      }
    }
    renderer.setMarkers(markers);
    renderer.render({
      view,
      progress: Math.floor(progress),
      stitchWidthMm: stitchWidth,
      sheen,
      lightAngleDeg: lightAngle,
      dispAmount,
    });
    rafId = requestAnimationFrame(frame);
  }

  // 平移缩放
  let panning = false;
  let lastMouse = { x: 0, y: 0 };
  canvas.addEventListener('mousedown', e => { panning = true; lastMouse = { x: e.clientX, y: e.clientY }; });
  window.addEventListener('mouseup', onUp);
  function onUp(): void { panning = false; }
  window.addEventListener('mousemove', onMove);
  function onMove(e: MouseEvent): void {
    if (!panning || disposed) return;
    view.centerX -= (e.clientX - lastMouse.x) / view.ppm;
    view.centerY += (e.clientY - lastMouse.y) / view.ppm;
    lastMouse = { x: e.clientX, y: e.clientY };
  }
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    view.ppm *= e.deltaY < 0 ? 1.15 : 1 / 1.15;
    view.ppm = Math.max(0.5, Math.min(300, view.ppm));
  }, { passive: false });

  buildSidebar();
  load().then(() => { rafId = requestAnimationFrame(frame); });

  return () => {
    disposed = true;
    cancelAnimationFrame(rafId);
    window.removeEventListener('mouseup', onUp);
    window.removeEventListener('mousemove', onMove);
  };
}
