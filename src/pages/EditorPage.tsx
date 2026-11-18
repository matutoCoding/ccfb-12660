import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import EmbroideryCanvas, { type CanvasHandle } from '../components/EmbroideryCanvas';
import {
  useCurrentDesign,
  useStore,
  getCompiled,
  addRegion,
  updateRegionParams,
  updateRegion,
  removeRegion,
  selectRegion,
  toggleRegionVisible,
  runAutoSchedule,
  moveRegionOrder,
  exportCurrentDst,
  convertImportedToRegions,
  takeSnapshot,
  loadVersions,
  restoreSnapshot,
  diffStitches
} from '../store';
import type { Pt, StitchKind, Region, RegionParams, Thread, DensityWarning } from '../core/types';
import { mmToUnit, unitToMm, fmtMeters } from '../core/units';
import { traceImageData, pxPolygonToDst, DEFAULT_TRACE } from '../trace/bitmapTrace';
import VersionDiffModal from '../components/VersionDiffModal';

type Tool = 'select' | 'draw' | 'trace';

export default function EditorPage() {
  const design = useCurrentDesign();
  const threads = useStore((s) => s.threads);
  const selectedRegionId = useStore((s) => s.selectedRegionId);
  const versions = useStore((s) => s.versions);
  const navigate = useNavigate();
  const canvasHandle = useRef<CanvasHandle>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const [tool, setTool] = useState<Tool>('select');
  const [draft, setDraft] = useState<Pt[]>([]);
  const [fitSignal, setFitSignal] = useState(0);
  const [showVersions, setShowVersions] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);
  const [stretch, setStretch] = useState(0);
  const [showDir, setShowDir] = useState(true);

  const compiled = useMemo(
    () => (design ? getCompiled(design) : null),
    // design 是原地修改的，必须用 version 触发重算（缓存内部也按 version 失效）
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [design, design?.version]
  );
  const region = design?.regions.find((r) => r.id === selectedRegionId) ?? null;

  if (!design) {
    return (
      <div className="page">
        <div className="card">
          <p className="muted">请先从花版库选择或新建一个花版。</p>
          <button className="primary" onClick={() => navigate('/library')}>
            去花版库
          </button>
        </div>
      </div>
    );
  }

  const threadMap = new Map(threads.map((t) => [t.id, t]));
  const renderThreads = new Map(
    threads.map((t) => [t.id, { id: t.id, color: t.color, sheen: t.sheen }])
  );

  const overlays = design.regions.map((r) => ({
    polygon: r.polygon,
    selected: r.id === selectedRegionId,
    color: threadMap.get(r.threadId)?.color ?? '#888'
  }));

  const finishPolygon = (pts: Pt[]) => {
    if (pts.length >= 3) {
      addRegion(pts, 'satin');
      setFitSignal((v) => v + 1);
    }
    setDraft([]);
  };

  const onTraceImage = async (file: File) => {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = rej;
        img.src = url;
      });
      // 控制大图计算量
      const maxDim = 480;
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const w = Math.max(8, Math.round(img.width * scale));
      const h = Math.max(8, Math.round(img.height * scale));
      const cv = document.createElement('canvas');
      cv.width = w;
      cv.height = h;
      const ctx = cv.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(img, 0, 0, w, h);
      const imageData = ctx.getImageData(0, 0, w, h);
      const traced = traceImageData(imageData, DEFAULT_TRACE);
      const target = mmToUnit(80);
      let created = 0;
      for (const t of traced) {
        const poly = pxPolygonToDst(t.polygonPx, w, h, target);
        if (poly.length >= 3 && addRegion(poly, 'tatami', `描边分区 ${created + 1}`)) created++;
      }
      if (created === 0) alert('未识别到有效图案区域，可尝试换一张对比度更高的图。');
      else setFitSignal((v) => v + 1);
    } finally {
      URL.revokeObjectURL(url);
    }
  };

  const stats = compiled!.stats;

  return (
    <div className="page" style={{ overflow: 'hidden' }}>
      <div className="editor-layout">
        {/* 左：分区列表与顺序 */}
        <div className="panel">
          <div className="panel-header">分区 / 绣制顺序</div>
          <div className="panel-body">
            <div className="toolbar">
              <button
                className={tool === 'select' ? 'active' : ''}
                onClick={() => setTool('select')}
              >
                选择
              </button>
              <button className={tool === 'draw' ? 'active' : ''} onClick={() => setTool('draw')}>
                手动画轮廓
              </button>
              <button className={tool === 'trace' ? 'active' : ''} onClick={() => setTool('trace')}>
                位图描边
              </button>
            </div>
            {tool === 'draw' && (
              <div className="card" style={{ background: 'var(--panel-2)' }}>
                <div className="muted" style={{ marginBottom: 6 }}>
                  在画布单击添加顶点，≥3 点后点击「完成」或双击闭合。
                </div>
                <div className="row">
                  <span className="badge">{draft.length} 点</span>
                  <span className="spacer" />
                  <button disabled={draft.length < 3} onClick={() => finishPolygon(draft)}>
                    完成
                  </button>
                  <button onClick={() => setDraft([])}>清除</button>
                </div>
              </div>
            )}
            {tool === 'trace' && (
              <div className="card" style={{ background: 'var(--panel-2)' }}>
                <div className="muted" style={{ marginBottom: 6 }}>
                  导入位图后自动二值化、连通域分区并生成榻榻米轮廓。
                </div>
                <button className="primary" onClick={() => imageInputRef.current?.click()}>
                  选择位图…
                </button>
                <input
                  ref={imageInputRef}
                  type="file"
                  accept="image/*"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void onTraceImage(f);
                    e.target.value = '';
                  }}
                />
              </div>
            )}

            {design.importedStitches && (
              <div className="card" style={{ background: 'var(--panel-2)' }}>
                <div className="muted">当前为 DST 原始针迹模式。</div>
                <button onClick={convertImportedToRegions}>转为可编辑分区</button>
              </div>
            )}

            <div className="row">
              <button className="primary" onClick={runAutoSchedule}>
                自动排程
              </button>
              <button onClick={() => setFitSignal((v) => v + 1)}>适配视图</button>
              <button onClick={exportCurrentDst}>导出 DST</button>
            </div>

            {design.stitchOrder.map((rid, idx) => {
              const r = design.regions.find((x) => x.id === rid);
              if (!r) return null;
              const t = threadMap.get(r.threadId);
              return (
                <div
                  key={rid}
                  className={`region-item ${rid === selectedRegionId ? 'selected' : ''}`}
                  onClick={() => selectRegion(rid)}
                >
                  <div className="row">
                    <span className="badge">{idx + 1}</span>
                    <span className="swatch" style={{ background: t?.color }} />
                    <strong>{r.name}</strong>
                    <span className="spacer" />
                    <span className="badge">{r.params.kind}</span>
                  </div>
                  <div className="row">
                    <button disabled={idx === 0} onClick={(e) => { e.stopPropagation(); moveRegionOrder(rid, -1); }}>
                      ↑
                    </button>
                    <button
                      disabled={idx === design.stitchOrder.length - 1}
                      onClick={(e) => { e.stopPropagation(); moveRegionOrder(rid, 1); }}
                    >
                      ↓
                    </button>
                    <button onClick={(e) => { e.stopPropagation(); toggleRegionVisible(rid); }}>
                      {r.visible ? '隐藏' : '显示'}
                    </button>
                    <button
                      className="danger"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeRegion(rid);
                      }}
                    >
                      删
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* 中：画布 */}
        <div className="canvas-wrap">
          <EmbroideryCanvas
            ref={canvasHandle}
            stitches={compiled!.stitches}
            fitSignal={fitSignal}
            mode="design"
            options={{
              progress: compiled!.stitches.length - 1,
              playing: false,
              showJumps: true,
              showColorChanges: true,
              showStitchDirection: showDir,
              warnings: stats.warnings,
              threads: renderThreads,
              fabricStretch: stretch,
              overlays: tool === 'select' || tool === 'draw' ? overlays : undefined
            }}
            onCanvasClick={(world) => {
              if (tool === 'draw') setDraft((d) => [...d, world]);
              if (tool === 'select') {
                // 点选包含该点的最上层分区
                const hit = [...design.regions].reverse().find((r) => {
                  const poly = r.polygon;
                  let inside = false;
                  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
                    const xi = poly[i].x, yi = poly[i].y;
                    const xj = poly[j].x, yj = poly[j].y;
                    if (yi > world.y !== yj > world.y && world.x < ((xj - xi) * (world.y - yi)) / (yj - yi) + xi) {
                      inside = !inside;
                    }
                  }
                  return inside;
                });
                if (hit) selectRegion(hit.id);
              }
            }}
            onCanvasDrag={(world) => {
              if (tool === 'draw') setDraft((d) => (d.length ? [...d.slice(0, -1), world] : d));
            }}
            onCanvasUp={(world) => {
              void world;
            }}
            onCanvasDoubleClick={() => {
              if (tool === 'draw' && draft.length >= 3) finishPolygon(draft);
            }}
          />
          {draft.length > 0 && <DraftOverlay draft={draft} />}
          <div style={{ position: 'absolute', top: 10, left: 12 }} className="legend">
            <span>滚轮缩放 · Shift+拖动平移 · {tool === 'draw' ? '双击闭合多边形' : '点击分区选择'}</span>
          </div>
          <div style={{ position: 'absolute', top: 10, right: 12 }} className="row">
            <label className="muted" style={{ margin: 0 }}>
              布面拉伸 {(stretch * 100).toFixed(1)}%
            </label>
            <input
              type="range"
              min={0}
              max={0.05}
              step={0.002}
              value={stretch}
              onChange={(e) => setStretch(parseFloat(e.target.value))}
              style={{ width: 120 }}
            />
            <button onClick={() => setShowDir((v) => !v)}>{showDir ? '关方向纹' : '开方向纹'}</button>
            <button
              onClick={() => {
                void takeSnapshot();
                void loadVersions(design.id);
              }}
            >
              存版本
            </button>
            <button
              onClick={() => {
                void loadVersions(design.id);
                setShowVersions((v) => !v);
              }}
            >
              历史版本 ({versions.length})
            </button>
          </div>
          {showVersions && (
            <div className="panel" style={{ position: 'absolute', right: 12, top: 48, width: 280, maxHeight: '60%' }}>
              <div className="panel-header">历史版本</div>
              <div className="panel-body">
                {versions.length === 0 && <span className="muted">暂无快照</span>}
                {versions.map((v) => (
                  <div key={v.id} className="region-item">
                    <strong>{v.label}</strong>
                    <span className="muted">{v.stats.stitchCount} 针</span>
                    <div className="row">
                      <button onClick={() => restoreSnapshot(v)}>恢复</button>
                      <button
                        onClick={() => {
                          const cur = getCompiled(design).stitches;
                          const old = getCompiled(v.design).stitches;
                          const d = diffStitches(old, cur);
                          alert(
                            `版本差异：位移针 ${d.moved.length}，缺失 ${d.removed.length}，新增 ${d.added.length}`
                          );
                        }}
                      >
                        对比当前
                      </button>
                    </div>
                  </div>
                ))}
                <button className="primary" onClick={() => setDiffOpen(true)}>
                  打开差异对比视图
                </button>
              </div>
            </div>
          )}
        </div>

        {/* 右：参数面板 */}
        <div className="panel">
          <div className="panel-header">针法参数</div>
          <div className="panel-body">
            {!region && <span className="muted">选择一个分区后调整参数，改动会实时重算针迹。</span>}
            {region && (
              <RegionParamsEditor
                key={region.id}
                regionId={region.id}
                kind={region.params.kind}
                angle={region.params.angle}
                rowSpacing={region.params.rowSpacing}
                pull={region.params.pullCompensation}
                running={region.params.runningStitchLength}
                tatami={region.params.tatamiStitchLength}
                maxLen={region.params.maxStitchLength}
                underlay={region.params.underlay}
                underlaySpacing={region.params.underlaySpacing}
                threadId={region.threadId}
                name={region.name}
                threads={threads}
                onChange={(patch) => updateRegionParams(region.id, patch)}
                onMeta={(patch) => updateRegion(region.id, patch)}
                onDelete={() => removeRegion(region.id)}
              />
            )}
            <div className="card" style={{ background: 'var(--panel-2)' }}>
              <h4 style={{ margin: '0 0 8px' }}>实时统计</h4>
              <div className="stats-strip">
                <div>
                  针数<b>{stats.stitchCount}</b>
                </div>
                <div>
                  跳针<b className="warn-text">{stats.jumpCount}</b>
                </div>
                <div>
                  换色<b>{stats.colorChangeCount}</b>
                </div>
                <div>
                  用线<b>{fmtMeters(stats.sewingLength)}</b>
                </div>
                <div>
                  预计工时
                  <b>{formatDuration(stats.estimatedSeconds)}</b>
                </div>
              </div>
              {stats.warnings.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  {stats.warnings.slice(0, 5).map((w: DensityWarning, i: number) => (
                    <div key={i} className={w.level === 'critical' ? 'critical-text' : 'warn-text'}>
                      ⚠ {w.level === 'critical' ? '严重起坨' : '起坨风险'}：{w.count} 针 / {unitToMm(w.cellSize).toFixed(0)}mm 格
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
      {diffOpen && <VersionDiffModal onClose={() => setDiffOpen(false)} />}
    </div>
  );
}

function DraftOverlay({ draft }: { draft: Pt[] }) {
  return (
    <div className="legend" style={{ position: 'absolute', bottom: 70, left: 16 }}>
      <span className="badge">{draft.length} 个顶点</span>
    </div>
  );
}

function RegionParamsEditor(props: {
  regionId: string;
  kind: StitchKind;
  angle: number;
  rowSpacing: number;
  pull: number;
  running: number;
  tatami: number;
  maxLen: number;
  underlay: boolean;
  underlaySpacing: number;
  threadId: string;
  name: string;
  threads: Thread[];
  onChange: (patch: Partial<RegionParams>) => void;
  onMeta: (patch: Partial<Region>) => void;
  onDelete: () => void;
}) {
  const angleDeg = (props.angle * 180) / Math.PI;
  return (
    <>
      <div>
        <label>分区名称</label>
        <input value={props.name} onChange={(e) => props.onMeta({ name: e.target.value })} />
      </div>
      <div>
        <label>针法</label>
        <select value={props.kind} onChange={(e) => props.onChange({ kind: e.target.value as StitchKind })}>
          <option value="running">平针（包边/走线）</option>
          <option value="satin">缎纹（细密光泽面）</option>
          <option value="tatami">榻榻米（大面积填充）</option>
        </select>
      </div>
      <div>
        <label>线色</label>
        <select value={props.threadId} onChange={(e) => props.onMeta({ threadId: e.target.value })}>
          {props.threads.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}（{t.code}）
            </option>
          ))}
        </select>
      </div>
      <Slider
        label={`针迹方向 ${angleDeg.toFixed(0)}°`}
        min={0}
        max={180}
        step={1}
        value={angleDeg}
        onChange={(v) => props.onChange({ angle: (v * Math.PI) / 180 })}
      />
      {props.kind !== 'running' && (
        <Slider
          label={`行间距（密度） ${unitToMm(props.rowSpacing).toFixed(2)} mm`}
          min={mmToUnit(0.15)}
          max={mmToUnit(2)}
          step={mmToUnit(0.05)}
          value={props.rowSpacing}
          onChange={(v) => props.onChange({ rowSpacing: v })}
        />
      )}
      <Slider
        label={`拉线补偿 ${unitToMm(props.pull).toFixed(2)} mm`}
        min={0}
        max={mmToUnit(3)}
        step={mmToUnit(0.1)}
        value={props.pull}
        onChange={(v) => props.onChange({ pullCompensation: v })}
      />
      {props.kind === 'running' && (
        <Slider
          label={`平针针距 ${unitToMm(props.running).toFixed(1)} mm`}
          min={mmToUnit(1)}
          max={mmToUnit(8)}
          step={mmToUnit(0.2)}
          value={props.running}
          onChange={(v) => props.onChange({ runningStitchLength: v })}
        />
      )}
      {props.kind === 'tatami' && (
        <Slider
          label={`榻榻米针长 ${unitToMm(props.tatami).toFixed(1)} mm`}
          min={mmToUnit(1)}
          max={mmToUnit(10)}
          step={mmToUnit(0.2)}
          value={props.tatami}
          onChange={(v) => props.onChange({ tatamiStitchLength: v })}
        />
      )}
      {props.kind !== 'running' && (
        <Slider
          label={`单针最大长度 ${unitToMm(props.maxLen).toFixed(1)} mm`}
          min={mmToUnit(4)}
          max={mmToUnit(20)}
          step={mmToUnit(0.5)}
          value={props.maxLen}
          onChange={(v) => props.onChange({ maxStitchLength: v })}
        />
      )}
      {props.kind !== 'running' && (
        <>
          <label className="row">
            <input
              type="checkbox"
              style={{ width: 'auto' }}
              checked={props.underlay}
              onChange={(e) => props.onChange({ underlay: e.target.checked })}
            />
            启用底衬针
          </label>
          {props.underlay && (
            <Slider
              label={`底衬行距 ${unitToMm(props.underlaySpacing).toFixed(1)} mm`}
              min={mmToUnit(1)}
              max={mmToUnit(5)}
              step={mmToUnit(0.2)}
              value={props.underlaySpacing}
              onChange={(v) => props.onChange({ underlaySpacing: v })}
            />
          )}
        </>
      )}
      <button className="danger" onClick={props.onDelete}>
        删除该分区
      </button>
    </>
  );
}

function Slider(props: { label: string; min: number; max: number; step: number; value: number; onChange: (v: number) => void }) {
  return (
    <div>
      <label>{props.label}</label>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(parseFloat(e.target.value))}
      />
    </div>
  );
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}分${s}秒`;
}
