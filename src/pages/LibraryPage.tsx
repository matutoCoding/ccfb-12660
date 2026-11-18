import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  createDesign,
  importDstFile,
  removeDesign,
  duplicateCurrent,
  selectDesign,
  useStore,
  getCompiled
} from '../store';
import type { Design } from '../core/types';
import { unitToMm, fmtMeters } from '../core/units';

function DesignCard({ design }: { design: Design }) {
  const navigate = useNavigate();
  const { stats } = getCompiled(design);
  const open = () => {
    selectDesign(design.id);
    navigate('/editor');
  };
  return (
    <div className="card design-card" onClick={open}>
      <div className="thumb">
        <MiniPreview design={design} />
      </div>
      <h3>{design.name}</h3>
      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
        {unitToMm(design.width).toFixed(0)} × {unitToMm(design.height).toFixed(0)} mm ·{' '}
        {stats.stitchCount} 针 · v{design.version}
      </div>
      <div className="row">
        <button
          onClick={(e) => {
            e.stopPropagation();
            selectDesign(design.id);
            void duplicateCurrent();
          }}
        >
          复制
        </button>
        <button
          className="danger"
          onClick={(e) => {
            e.stopPropagation();
            if (confirm(`确定删除花版「${design.name}」？其历史版本会一并删除。`)) {
              void removeDesign(design.id);
            }
          }}
        >
          删除
        </button>
      </div>
    </div>
  );
}

/** 轻量 2D 缩略图，避免为每个卡片建 WebGL 上下文 */
function MiniPreview({ design }: { design: Design }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const threads = useStore((s) => s.threads);
  const canvas = ref.current;
  if (canvas) {
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const dpr = Math.min(window.devicePixelRatio, 2);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== w * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const { stitches } = getCompiled(design);
      if (!stitches.length) {
        ctx.fillStyle = '#5a6472';
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('空花版', w / 2, h / 2);
      } else {
        const bbox = stitches.reduce(
          (b, s) => ({
            minX: Math.min(b.minX, s.x),
            minY: Math.min(b.minY, s.y),
            maxX: Math.max(b.maxX, s.x),
            maxY: Math.max(b.maxY, s.y)
          }),
          { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
        );
        const scale = Math.min(w / Math.max(1, bbox.maxX - bbox.minX), h / Math.max(1, bbox.maxY - bbox.minY)) * 0.85;
        const toX = (x: number) => (x - (bbox.minX + bbox.maxX) / 2) * scale + w / 2;
        const toY = (y: number) => h / 2 - (y - (bbox.minY + bbox.maxY) / 2) * scale;
        ctx.lineWidth = 1;
        for (let i = 1; i < stitches.length; i++) {
          const a = stitches[i - 1];
          const b = stitches[i];
          const t = threads.find((x) => x.id === b.threadId);
          ctx.strokeStyle = t?.color ?? '#c8c8c8';
          ctx.globalAlpha = b.flags ? 0.35 : 0.9;
          ctx.beginPath();
          ctx.moveTo(toX(a.x), toY(a.y));
          ctx.lineTo(toX(b.x), toY(b.y));
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
    }
  }
  return <canvas ref={ref} style={{ width: '100%', height: '100%' }} />;
}

export default function LibraryPage() {
  const designs = useStore((s) => s.designs);
  const fileRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const navigate = useNavigate();

  const onFile = async (file: File) => {
    setImporting(true);
    try {
      const id = await importDstFile(file);
      selectDesign(id);
      navigate('/editor');
    } catch (e) {
      alert('DST 导入失败：' + (e as Error).message);
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="page">
      <div className="row" style={{ marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>花版库</h2>
        <span className="spacer" />
        <button
          className="primary"
          onClick={() => {
            const id = createDesign();
            selectDesign(id);
            navigate('/editor');
          }}
        >
          ＋ 新建花版
        </button>
        <button onClick={() => fileRef.current?.click()} disabled={importing}>
          {importing ? '导入中…' : '导入 DST'}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".dst,application/octet-stream"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onFile(f);
            e.target.value = '';
          }}
        />
      </div>
      {designs.length === 0 ? (
        <div className="card muted">还没有花版。新建一个，或导入客户给的 DST 文件。</div>
      ) : (
        <div className="design-grid">
          {designs.map((d) => (
            <DesignCard key={d.id} design={d} />
          ))}
        </div>
      )}
      <div className="card" style={{ marginTop: 16 }}>
        <h3 style={{ marginTop: 0 }}>库统计</h3>
        <div className="stats-strip">
          <div>
            花版数
            <b>{designs.length}</b>
          </div>
          <div>
            总针数
            <b>{designs.reduce((sum, d) => sum + getCompiled(d).stats.stitchCount, 0)}</b>
          </div>
          <div>
            总用线
            <b>{fmtMeters(designs.reduce((sum, d) => sum + getCompiled(d).stats.sewingLength, 0))}</b>
          </div>
        </div>
      </div>
    </div>
  );
}
