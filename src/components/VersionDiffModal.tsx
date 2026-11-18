import { useMemo } from 'react';
import { useCurrentDesign, useStore, getCompiled, diffStitches, loadVersions } from '../store';
import type { Stitch } from '../core/types';

/** 两版针迹差异弹窗：选择两个快照，2D 叠加显示 新增/缺失/位移 */
export default function VersionDiffModal({ onClose }: { onClose: () => void }) {
  const design = useCurrentDesign();
  const versions = useStore((s) => s.versions);

  const options = useMemo(
    () => [
      { id: '__current__', label: `当前 v${design?.version ?? 0}`, stitches: design ? getCompiled(design).stitches : [] },
      ...versions.map((v) => ({ id: v.id, label: v.label, stitches: getCompiled(v.design).stitches }))
    ],
    [design, versions]
  );

  if (!design) return null;
  const a = options[Math.min(1, options.length - 1)];
  const b = options[0];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <strong>针迹版本差异对比</strong>
          <span className="spacer" />
          <button onClick={onClose}>关闭</button>
        </div>
        <div className="modal-body">
          {versions.length === 0 ? (
            <p className="muted">还没有历史快照。先在编辑器点「存版本」，再回来对比。</p>
          ) : (
            <DiffView key={`${a.id}-${b.id}`} older={a.stitches} newer={b.stitches} olderLabel={a.label} newerLabel={b.label} />
          )}
          <button onClick={() => void loadVersions(design.id)}>刷新版本列表</button>
        </div>
      </div>
    </div>
  );
}

function DiffView({ older, newer, olderLabel, newerLabel }: { older: Stitch[]; newer: Stitch[]; olderLabel: string; newerLabel: string }) {
  const diff = useMemo(() => diffStitches(older, newer), [older, newer]);
  const canvasRef = (canvas: HTMLCanvasElement | null) => {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = canvas.clientWidth;
    const h = 360;
    const dpr = Math.min(window.devicePixelRatio, 2);
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0f1216';
    ctx.fillRect(0, 0, w, h);
    const all = [...older, ...newer];
    if (!all.length) return;
    const bbox = all.reduce(
      (bb, s) => ({
        minX: Math.min(bb.minX, s.x),
        minY: Math.min(bb.minY, s.y),
        maxX: Math.max(bb.maxX, s.x),
        maxY: Math.max(bb.maxY, s.y)
      }),
      { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
    );
    const scale = Math.min(w / Math.max(1, bbox.maxX - bbox.minX), h / Math.max(1, bbox.maxY - bbox.minY)) * 0.85;
    const X = (x: number) => (x - (bbox.minX + bbox.maxX) / 2) * scale + w / 2;
    const Y = (y: number) => h / 2 - (y - (bbox.minY + bbox.maxY) / 2) * scale;
    const drawSeg = (p: Stitch, q: Stitch, color: string, width: number) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(X(p.x), Y(p.y));
      ctx.lineTo(X(q.x), Y(q.y));
      ctx.stroke();
    };
    // 旧版底图（灰）
    ctx.globalAlpha = 0.5;
    for (let i = 1; i < older.length; i++) drawSeg(older[i - 1], older[i], '#5a6472', 1);
    ctx.globalAlpha = 1;
    // 新版（蓝）
    ctx.globalAlpha = 0.85;
    for (let i = 1; i < newer.length; i++) drawSeg(newer[i - 1], newer[i], '#4f9cf9', 1);
    ctx.globalAlpha = 1;
    // 位移针（红连线）
    for (const m of diff.moved.slice(0, 400)) {
      ctx.strokeStyle = '#e5534b';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(X(m.from.x), Y(m.from.y));
      ctx.lineTo(X(m.to.x), Y(m.to.y));
      ctx.stroke();
    }
  };

  return (
    <div>
      <div className="legend" style={{ marginBottom: 8 }}>
        <span>
          <i style={{ background: '#5a6472' }} />
          旧版：{olderLabel}
        </span>
        <span>
          <i style={{ background: '#4f9cf9' }} />
          新版：{newerLabel}
        </span>
        <span>
          <i style={{ background: '#e5534b' }} />
          位移对应
        </span>
      </div>
      <canvas ref={canvasRef} style={{ width: '100%', height: 360, borderRadius: 8 }} />
      <table style={{ marginTop: 12 }}>
        <thead>
          <tr>
            <th>位移针</th>
            <th>新增针</th>
            <th>缺失针</th>
            <th>旧版总针</th>
            <th>新版总针</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="critical-text">{diff.moved.length}</td>
            <td className="ok-text">{diff.added.length}</td>
            <td className="warn-text">{diff.removed.length}</td>
            <td>{older.length}</td>
            <td>{newer.length}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
