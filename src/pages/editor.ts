// 制版编辑页面：位图描边、手绘轮廓、分区参数、实时重算、历史版本与对比

import type { Region, Vec2 } from '../core/types';
import { uid, STITCH_TYPE_NAMES } from '../core/types';
import type { StitchType } from '../core/types';
import { el, clear, pickFile } from '../ui/dom';
import { toast } from '../ui/toast';
import { store } from '../store/store';
import { StitchGL } from '../render/gl';
import { traceImage } from '../core/imaging';
import { optimizeRegionOrder, buildPlan } from '../core/stitchgen';
import { diffRecords, type StitchDiff } from '../core/diff';
import { pointInPolygon, boundsOf, ensureCCW } from '../core/geometry';
import { THREADS, threadById, threadCss } from '../core/threadlib';

type Mode = 'select' | 'draw';

export function mountEditor(root: HTMLElement): () => void {
  const page = el('div', { className: 'page editor-page' });
  root.append(page);

  // ---------- 画布区 ----------
  const main = el('div', { className: 'editor-main' });
  const stack = el('div', { className: 'canvas-stack' });
  const glCanvas = el('canvas', {});
  const overlay = el('canvas', {});
  stack.append(glCanvas, overlay);
  const statusbar = el('div', { className: 'editor-statusbar' });
  main.append(stack, statusbar);

  const side = el('div', { className: 'editor-side' });
  page.append(side, main);

  let gl: StitchGL;
  try {
    gl = new StitchGL(glCanvas);
  } catch (err) {
    main.append(el('div', { className: 'empty-hint' }, (err as Error).message));
    page.append(main);
    return () => page.remove();
  }

  let mode: Mode = 'select';
  let selectedId: string | null = null;
  let drawing: Vec2[] = [];
  let mouseWorld: Vec2 | null = null;
  let diffView: { diff: StitchDiff; labelA: string; labelB: string } | null = null;
  let showHotspots = true;
  let dragState: { kind: 'pan' | 'move'; startX: number; startY: number; lastX: number; lastY: number } | null = null;

  const octx = overlay.getContext('2d')!;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  // ---------- 视图 ----------

  function fitCurrent() {
    const p = store.current;
    if (!p || p.regions.length === 0) {
      gl.view = { cx: 0, cy: 0, ppm: 6 };
      return;
    }
    const all = p.regions.flatMap((r) => (r.source === 'dst' && r.points ? r.points : r.polygon));
    if (all.length > 0) gl.fitBounds(boundsOf(all));
  }

  function resizeOverlay() {
    const w = overlay.clientWidth;
    const h = overlay.clientHeight;
    if (w === 0 || h === 0) return;
    overlay.width = Math.round(w * dpr);
    overlay.height = Math.round(h * dpr);
  }

  // ---------- 覆盖层绘制 ----------

  function drawOverlay() {
    resizeOverlay();
    const w = overlay.clientWidth;
    const h = overlay.clientHeight;
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    octx.clearRect(0, 0, w, h);
    const p = store.current;
    if (!p) return;

    const toS = (pt: Vec2) => gl.worldToScreen(pt);

    // 分区轮廓
    for (const r of p.regions) {
      const selected = r.id === selectedId;
      const color = threadCss(r.colorId);
      octx.beginPath();
      r.polygon.forEach((pt, i) => {
        const s = toS(pt);
        if (i === 0) octx.moveTo(s.x, s.y);
        else octx.lineTo(s.x, s.y);
      });
      octx.closePath();
      octx.fillStyle = color.replace('rgb', 'rgba').replace(')', ',0.08)');
      octx.fill();
      octx.strokeStyle = selected ? '#fff' : color;
      octx.lineWidth = selected ? 2 : 1;
      octx.stroke();
      if (selected) {
        octx.fillStyle = '#fff';
        for (const pt of r.polygon) {
          const s = toS(pt);
          octx.fillRect(s.x - 3, s.y - 3, 6, 6);
        }
      }
    }

    // 正在绘制的轮廓
    if (drawing.length > 0) {
      octx.beginPath();
      drawing.forEach((pt, i) => {
        const s = toS(pt);
        if (i === 0) octx.moveTo(s.x, s.y);
        else octx.lineTo(s.x, s.y);
      });
      if (mouseWorld) {
        const s = toS(mouseWorld);
        octx.lineTo(s.x, s.y);
      }
      octx.strokeStyle = '#e0632f';
      octx.lineWidth = 1.5;
      octx.setLineDash([5, 4]);
      octx.stroke();
      octx.setLineDash([]);
      octx.fillStyle = '#e0632f';
      for (const pt of drawing) {
        const s = toS(pt);
        octx.beginPath();
        octx.arc(s.x, s.y, 3, 0, Math.PI * 2);
        octx.fill();
      }
    }

    // 起坨警告
    if (showHotspots && store.plan) {
      octx.strokeStyle = '#ff5b5b';
      octx.lineWidth = 2;
      for (const hp of store.plan.hotspots) {
        const s = toS(hp);
        octx.beginPath();
        octx.arc(s.x, s.y, 8, 0, Math.PI * 2);
        octx.stroke();
        octx.beginPath();
        octx.moveTo(s.x - 5, s.y - 5);
        octx.lineTo(s.x + 5, s.y + 5);
        octx.moveTo(s.x + 5, s.y - 5);
        octx.lineTo(s.x - 5, s.y + 5);
        octx.stroke();
      }
    }

    // 版本对比
    if (diffView) {
      const draw = (pts: { x: number; y: number }[], color: string) => {
        octx.fillStyle = color;
        for (const pt of pts) {
          const s = toS(pt);
          octx.fillRect(s.x - 1.5, s.y - 1.5, 3, 3);
        }
      };
      draw(diffView.diff.onlyA, 'rgba(255,80,80,0.9)');
      draw(diffView.diff.onlyB, 'rgba(80,220,120,0.9)');
    }
  }

  function renderGl() {
    gl.setPlan(store.plan);
    gl.render();
  }

  function refreshStatus() {
    const plan = store.plan;
    const p = store.current;
    if (!plan || !p) {
      statusbar.textContent = '暂无花版';
      return;
    }
    const s = plan.stats;
    let size = '';
    if (plan.records.length > 0) {
      const b = boundsOf(plan.records);
      size = ` · 尺寸 ${(b.maxX - b.minX).toFixed(1)}×${(b.maxY - b.minY).toFixed(1)} mm`;
    }
    const hot = plan.hotspots.length > 0 ? ` · ⚠ 起坨风险 ${plan.hotspots.length} 处` : '';
    const diff = diffView
      ? ` · 对比[${diffView.labelA}↔${diffView.labelB}] 仅A ${diffView.diff.onlyA.length} 仅B ${diffView.diff.onlyB.length} 共同 ${diffView.diff.common}`
      : '';
    statusbar.textContent =
      `${s.stitches} 针 · 跳针 ${s.jumps} · 换色 ${s.colorChanges}${size}${hot}${diff}` +
      (mode === 'draw' ? ' · 单击加点，双击/回车闭合，Esc 取消' : '');
  }

  function refreshAll() {
    renderGl();
    drawOverlay();
    refreshStatus();
    renderSide();
  }

  // ---------- 交互 ----------

  function eventPos(e: MouseEvent): { x: number; y: number } {
    const rect = overlay.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function regionAt(world: Vec2): Region | null {
    const p = store.current;
    if (!p) return null;
    for (let i = p.regions.length - 1; i >= 0; i--) {
      if (pointInPolygon(p.regions[i].polygon, world)) return p.regions[i];
    }
    return null;
  }

  const onMouseDown = (e: MouseEvent) => {
    const pos = eventPos(e);
    if (e.button === 1 || e.button === 2) {
      dragState = { kind: 'pan', startX: pos.x, startY: pos.y, lastX: pos.x, lastY: pos.y };
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;
    if (mode === 'draw') {
      drawing.push(gl.screenToWorld(pos.x, pos.y));
      drawOverlay();
      return;
    }
    // select 模式
    const world = gl.screenToWorld(pos.x, pos.y);
    const hit = regionAt(world);
    selectedId = hit ? hit.id : null;
    if (hit) {
      dragState = { kind: 'move', startX: world.x, startY: world.y, lastX: world.x, lastY: world.y };
    }
    refreshAll();
  };

  const onMouseMove = (e: MouseEvent) => {
    const pos = eventPos(e);
    mouseWorld = gl.screenToWorld(pos.x, pos.y);
    if (dragState) {
      if (dragState.kind === 'pan') {
        gl.panBy(pos.x - dragState.lastX, pos.y - dragState.lastY);
        dragState.lastX = pos.x;
        dragState.lastY = pos.y;
        renderGl();
        drawOverlay();
      } else if (selectedId) {
        const dx = mouseWorld.x - dragState.lastX;
        const dy = mouseWorld.y - dragState.lastY;
        dragState.lastX = mouseWorld.x;
        dragState.lastY = mouseWorld.y;
        const id = selectedId;
        store.updateCurrent((p) => {
          const r = p.regions.find((x) => x.id === id);
          if (!r) return;
          r.polygon = r.polygon.map((pt) => ({ x: pt.x + dx, y: pt.y + dy }));
          if (r.points) r.points = r.points.map((pt) => ({ x: pt.x + dx, y: pt.y + dy }));
        });
      }
      return;
    }
    if (mode === 'draw') drawOverlay();
  };

  const onMouseUp = () => {
    dragState = null;
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const pos = eventPos(e as unknown as MouseEvent);
    gl.zoomAt(pos.x, pos.y, e.deltaY < 0 ? 1.15 : 1 / 1.15);
    renderGl();
    drawOverlay();
  };

  const finishDrawing = () => {
    if (drawing.length >= 3) {
      const p = store.current;
      const usedColors = new Set(p?.regions.map((r) => r.colorId));
      const freeColor = THREADS.find((t) => !usedColors.has(t.id)) ?? THREADS[(p?.regions.length ?? 0) % THREADS.length];
      const region: Region = {
        id: uid(),
        name: `分区 ${(p?.regions.length ?? 0) + 1}`,
        polygon: ensureCCW(drawing),
        source: 'drawn',
        stitchType: 'satin',
        angle: 45,
        spacing: 0.4,
        stitchLength: 3.5,
        pullComp: 0,
        colorId: freeColor.id,
      };
      store.addRegions([region]);
      selectedId = region.id;
      toast('分区已创建，可在左侧调整针法和参数');
    }
    drawing = [];
    refreshAll();
  };

  const onDblClick = () => {
    if (mode === 'draw') finishDrawing();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement) return;
    if (e.key === 'Escape') {
      if (mode === 'draw') {
        drawing = [];
        drawOverlay();
      }
      diffView = null;
      refreshAll();
    } else if (e.key === 'Enter' && mode === 'draw') {
      finishDrawing();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
      const id = selectedId;
      store.updateCurrent((p) => {
        p.regions = p.regions.filter((r) => r.id !== id);
      }, { immediatePlan: true });
      selectedId = null;
    }
  };

  const onContextMenu = (e: Event) => e.preventDefault();

  overlay.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
  overlay.addEventListener('wheel', onWheel, { passive: false });
  overlay.addEventListener('dblclick', onDblClick);
  overlay.addEventListener('contextmenu', onContextMenu);
  window.addEventListener('keydown', onKeyDown);

  // ---------- 侧栏 ----------

  function numField(label: string, value: number, step: number, onChange: (v: number) => void): HTMLElement {
    const input = el('input', { type: 'number', value: String(value), step: String(step) });
    input.addEventListener('change', () => {
      const v = parseFloat(input.value);
      if (isFinite(v)) onChange(v);
    });
    return el('label', { className: 'field' }, el('span', {}, label), input);
  }

  function renderSide() {
    clear(side);
    const p = store.current;
    if (!p) {
      side.append(el('div', { className: 'empty-hint' }, '请先在花版库选择或新建花版'));
      return;
    }

    // 花版名
    const nameInput = el('input', { value: p.name, style: 'width:100%' });
    nameInput.addEventListener('change', () => {
      store.updateCurrent((pat) => {
        pat.name = nameInput.value.trim() || pat.name;
      });
    });
    side.append(el('div', { className: 'panel' }, el('h3', {}, '花版'), nameInput));

    // 工具
    const btnSelect = el('button', {
      className: mode === 'select' ? 'active' : '',
      onclick: () => { mode = 'select'; drawing = []; renderSide(); drawOverlay(); refreshStatus(); },
    }, '选择/移动');
    const btnDraw = el('button', {
      className: mode === 'draw' ? 'active' : '',
      onclick: () => { mode = 'draw'; renderSide(); refreshStatus(); },
    }, '画轮廓');
    const btnTrace = el('button', { onclick: () => void importImageFlow() }, '导入图片描边');
    const btnHot = el('button', {
      className: showHotspots ? 'active' : '',
      onclick: () => { showHotspots = !showHotspots; renderSide(); drawOverlay(); },
    }, '起坨警告');
    side.append(
      el('div', { className: 'panel' },
        el('h3', {}, '工具'),
        el('div', { className: 'tool-row' }, btnSelect, btnDraw, btnTrace, btnHot),
        el('div', { className: 'tool-row', style: 'margin-top:6px' },
          el('button', { onclick: () => { fitCurrent(); renderGl(); drawOverlay(); } }, '复位视图'),
          el('button', {
            onclick: () => {
              store.updateCurrent((pat) => {
                pat.regions = optimizeRegionOrder(pat.regions);
              }, { immediatePlan: true });
              toast('已按减少换色和跳针重新排序');
            },
          }, '自动排序'))
      )
    );

    // 分区列表
    const listPanel = el('div', { className: 'panel' }, el('h3', {}, `分区（${p.regions.length}）— 绣制顺序`));
    p.regions.forEach((r, i) => {
      const item = el(
        'div',
        {
          className: 'region-item' + (r.id === selectedId ? ' selected' : ''),
          onclick: () => { selectedId = r.id; refreshAll(); },
        },
        el('span', { className: 'swatch', style: `background:${threadCss(r.colorId)}` }),
        el('span', { className: 'rname' }, `${i + 1}. ${r.name}`),
        el('span', { style: 'color:var(--fg-dim);font-size:11px' }, r.source === 'dst' ? 'DST' : STITCH_TYPE_NAMES[r.stitchType]),
        el('button', {
          className: 'mini', title: '上移',
          onclick: (e: Event) => {
            e.stopPropagation();
            store.updateCurrent((pat) => {
              if (i > 0) [pat.regions[i - 1], pat.regions[i]] = [pat.regions[i], pat.regions[i - 1]];
            }, { immediatePlan: true });
          },
        }, '↑'),
        el('button', {
          className: 'mini', title: '下移',
          onclick: (e: Event) => {
            e.stopPropagation();
            store.updateCurrent((pat) => {
              if (i < pat.regions.length - 1) [pat.regions[i + 1], pat.regions[i]] = [pat.regions[i], pat.regions[i + 1]];
            }, { immediatePlan: true });
          },
        }, '↓'),
        el('button', {
          className: 'mini danger', title: '删除',
          onclick: (e: Event) => {
            e.stopPropagation();
            store.updateCurrent((pat) => {
              pat.regions = pat.regions.filter((x) => x.id !== r.id);
            }, { immediatePlan: true });
            if (selectedId === r.id) selectedId = null;
          },
        }, '✕')
      );
      listPanel.append(item);
    });
    side.append(listPanel);

    // 选中分区参数
    const sel = p.regions.find((r) => r.id === selectedId);
    if (sel) {
      const paramPanel = el('div', { className: 'panel' }, el('h3', {}, `参数：${sel.name}`));
      if (sel.source === 'dst') {
        paramPanel.append(el('div', { style: 'font-size:12px;color:var(--fg-dim)' },
          'DST 导入的针迹块：针迹与文件保持一致，不参与参数重算。可整体移动、改线色。'));
      } else {
        const typeSel = el('select', {},
          ...(['run', 'satin', 'tatami'] as StitchType[]).map((tp) =>
            el('option', { value: tp, ...(tp === sel.stitchType ? { selected: true } : {}) }, STITCH_TYPE_NAMES[tp])
          )
        );
        typeSel.addEventListener('change', () => {
          store.updateCurrent(() => {
            sel.stitchType = typeSel.value as StitchType;
          });
        });
        paramPanel.append(
          el('label', { className: 'field' }, el('span', {}, '针法'), typeSel),
          numField('针迹方向°', sel.angle, 5, (v) => store.updateCurrent(() => { sel.angle = v; })),
          numField('密度行距mm', sel.spacing, 0.05, (v) => store.updateCurrent(() => { sel.spacing = Math.max(0.2, v); })),
          numField('针迹长度mm', sel.stitchLength, 0.5, (v) => store.updateCurrent(() => { sel.stitchLength = Math.max(0.5, v); })),
          numField('拉线补偿mm', sel.pullComp, 0.1, (v) => store.updateCurrent(() => { sel.pullComp = Math.max(0, v); }))
        );
      }
      // 线色
      const grid = el('div', { className: 'thread-grid' });
      for (const t of THREADS) {
        grid.append(el('button', {
          className: 'thread-chip' + (t.id === sel.colorId ? ' selected' : ''),
          style: `background:rgb(${t.rgb[0]},${t.rgb[1]},${t.rgb[2]})`,
          title: `${t.code} ${t.name}`,
          onclick: () => store.updateCurrent(() => { sel.colorId = t.id; }),
        }));
      }
      paramPanel.append(el('h3', { style: 'margin-top:10px' }, `线色：${threadById(sel.colorId).code} ${threadById(sel.colorId).name}`), grid);
      side.append(paramPanel);
    }

    // 历史版本
    const verPanel = el('div', { className: 'panel' }, el('h3', {}, `历史版本（${p.versions.length}）`));
    verPanel.append(el('button', {
      onclick: () => {
        const label = prompt('版本说明（可留空）') ?? undefined;
        store.saveVersion(label || undefined);
        toast('已保存版本快照');
      },
    }, '保存当前为版本'));
    const selA = el('select', { style: 'width:48%' });
    const selB = el('select', { style: 'width:48%' });
    const opts: { id: string; label: string }[] = [{ id: 'current', label: '当前' }, ...p.versions.map((v) => ({ id: v.id, label: v.label }))];
    for (const o of opts) {
      selA.append(el('option', { value: o.id }, o.label));
      selB.append(el('option', { value: o.id }, o.label));
    }
    if (opts.length > 1) selB.value = opts[1].id;
    const doCompare = () => {
      const getRegions = (id: string): Region[] => {
        if (id === 'current') return p.regions;
        return p.versions.find((v) => v.id === id)?.regions ?? [];
      };
      const labelOf = (id: string) => (id === 'current' ? '当前' : p.versions.find((v) => v.id === id)?.label ?? id);
      const planA = buildPlan(getRegions(selA.value));
      const planB = buildPlan(getRegions(selB.value));
      diffView = { diff: diffRecords(planA.records, planB.records), labelA: labelOf(selA.value), labelB: labelOf(selB.value) };
      refreshAll();
      toast(`对比完成：红=仅${diffView.labelA}，绿=仅${diffView.labelB}`);
    };
    verPanel.append(
      el('div', { style: 'display:flex;gap:6px;margin-top:8px;align-items:center' }, selA, selB),
      el('div', { style: 'display:flex;gap:6px;margin-top:6px' },
        el('button', { onclick: doCompare }, '对比针迹差异'),
        el('button', { onclick: () => { diffView = null; refreshAll(); } }, '清除对比'))
    );
    for (const v of [...p.versions].reverse()) {
      verPanel.append(el(
        'div',
        { className: 'version-item' },
        el('span', { className: 'vlabel' }, `${v.label} · ${new Date(v.time).toLocaleString()}`),
        el('button', { className: 'mini', onclick: () => { store.restoreVersion(v.id); toast('已恢复到该版本'); } }, '恢复'),
        el('button', { className: 'mini danger', onclick: () => store.deleteVersion(v.id) }, '✕')
      ));
    }
    side.append(verPanel);
  }

  // ---------- 图片描边 ----------

  async function importImageFlow() {
    const file = await pickFile('image/*');
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('图片加载失败'));
      img.src = url;
    });

    const colorsInput = el('input', { type: 'number', value: '6', min: '2', max: '12' });
    const widthInput = el('input', { type: 'number', value: '100', min: '10', max: '1200' });
    const preview = el('img', { src: url, style: 'max-width:100%;border-radius:6px;background:#fff' });
    const mask = el('div', { className: 'dialog-mask' });
    const close = () => { mask.remove(); URL.revokeObjectURL(url); };
    const dialog = el(
      'div',
      { className: 'dialog' },
      el('h3', {}, '导入图片 · 自动描边分区'),
      preview,
      el('label', { className: 'field' }, el('span', {}, '颜色数'), colorsInput),
      el('label', { className: 'field' }, el('span', {}, '成品宽度mm'), widthInput),
      el('div', { style: 'font-size:12px;color:var(--fg-dim)' }, '四角占比最多的颜色视为背景跳过；每个色块生成一个榻榻米分区，可再逐个改针法。'),
      el('div', { className: 'dialog-actions' },
        el('button', { onclick: close }, '取消'),
        el('button', {
          className: 'primary',
          onclick: () => {
            try {
              const result = traceImage(img, {
                colors: Math.max(2, Math.min(12, parseInt(colorsInput.value) || 6)),
                widthMm: Math.max(10, parseFloat(widthInput.value) || 100),
                minAreaPx: 30,
              });
              if (result.regions.length === 0) {
                toast('没有识别到有效色块，试试增加颜色数');
              } else {
                store.addRegions(result.regions);
                fitCurrent();
                toast(`描边完成：${result.regions.length} 个分区`);
              }
              close();
            } catch (err) {
              toast('描边失败：' + (err as Error).message);
            }
          },
        }, '开始描边'))
    );
    mask.append(dialog);
    mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(); });
    document.body.append(mask);
  }

  // ---------- 订阅与生命周期 ----------

  const offPlan = store.on('plan', () => {
    renderGl();
    drawOverlay();
    refreshStatus();
  });
  const offCurrent = store.on('current', () => {
    if (selectedId && !store.current?.regions.some((r) => r.id === selectedId)) selectedId = null;
    refreshAll();
  });

  fitCurrent();
  refreshAll();

  const resizeObs = new ResizeObserver(() => {
    renderGl();
    drawOverlay();
  });
  resizeObs.observe(main);

  return () => {
    offPlan();
    offCurrent();
    resizeObs.disconnect();
    overlay.removeEventListener('mousedown', onMouseDown);
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
    overlay.removeEventListener('wheel', onWheel);
    overlay.removeEventListener('dblclick', onDblClick);
    overlay.removeEventListener('contextmenu', onContextMenu);
    window.removeEventListener('keydown', onKeyDown);
    page.remove();
  };
}
