import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import EmbroideryCanvas from '../components/EmbroideryCanvas';
import { useCurrentDesign, useStore, getCompiled } from '../store';
import { StitchFlag } from '../core/types';
import { fmtMeters, unitToMm } from '../core/units';

/** 走针动画：按文件内针序逐针播放，速度可调、进度可拖 */
export default function SimulationPage() {
  const design = useCurrentDesign();
  const threads = useStore((s) => s.threads);
  const navigate = useNavigate();
  const [progress, setProgress] = useState(0);
  const [playing, setPlaying] = useState(false);
  /** 每秒走针数 */
  const [speed, setSpeed] = useState(120);
  const [fitSignal, setFitSignal] = useState(0);
  const rafRef = useRef<number>(0);
  const lastTsRef = useRef<number>(0);
  const accRef = useRef<number>(0);
  /** 单例守卫：StrictMode 双挂载或快速重渲染时，只允许最新一个动画循环存活 */
  const runTokenRef = useRef(0);

  const compiled = useMemo(
    () => (design ? getCompiled(design) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [design, design?.version]
  );
  const stitches = compiled?.stitches ?? [];
  const hasStitches = stitches.length > 0;

  useEffect(() => {
    setProgress(0);
    setPlaying(stitches.length > 1);
    if (stitches.length) setFitSignal((v) => v + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [design?.id]);

  useEffect(() => {
    if (!playing || stitches.length === 0) {
      lastTsRef.current = 0;
      accRef.current = 0;
      return;
    }
    const token = ++runTokenRef.current;
    let rafId = 0;
    lastTsRef.current = 0;
    accRef.current = 0;
    const tick = (ts: number) => {
      if (token !== runTokenRef.current) return; // 旧循环自动退出
      if (!lastTsRef.current) lastTsRef.current = ts;
      const dt = (ts - lastTsRef.current) / 1000;
      lastTsRef.current = ts;
      accRef.current += dt * speed;
      const steps = Math.floor(accRef.current);
      accRef.current -= steps;
      if (steps > 0) {
        setProgress((p) => {
          const next = p + steps;
          if (next >= stitches.length - 1) {
            setPlaying(false);
            return stitches.length - 1;
          }
          return next;
        });
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    rafRef.current = rafId;
    return () => {
      // 使当前循环失效并取消它自己的 RAF（局部 id，不会误杀新循环）
      runTokenRef.current++;
      cancelAnimationFrame(rafId);
      lastTsRef.current = 0;
      accRef.current = 0;
    };
  }, [playing, speed, stitches.length]);

  if (!design) {
    return (
      <div className="page">
        <div className="card">
          <p className="muted">请先选择一个花版。</p>
          <button className="primary" onClick={() => navigate('/library')}>
            去花版库
          </button>
        </div>
      </div>
    );
  }

  const renderThreads = new Map(threads.map((t) => [t.id, { id: t.id, color: t.color, sheen: t.sheen }]));
  const safeProgress = hasStitches ? Math.min(progress, stitches.length - 1) : 0;
  const current = hasStitches ? stitches[safeProgress] : undefined;
  const nextJump = hasStitches
    ? stitches.findIndex((s, i) => i >= safeProgress && s.flags & StitchFlag.Jump)
    : -1;
  const nextCC = hasStitches
    ? stitches.findIndex((s, i) => i >= safeProgress && s.flags & StitchFlag.ColorChange)
    : -1;

  return (
    <div className="page" style={{ height: 'calc(100vh - 48px - 32px)' }}>
      <div className="canvas-wrap" style={{ height: '100%' }}>
        <EmbroideryCanvas
          stitches={stitches}
          fitSignal={fitSignal}
          mode="simulation"
          options={{
            progress: safeProgress,
            playing,
            showJumps: true,
            showColorChanges: true,
            showStitchDirection: true,
            warnings: compiled!.stats.warnings,
            threads: renderThreads,
            fabricStretch: 0
          }}
        />
        <div className="sim-controls">
          <div className="scrub-row">
            <button className="primary" onClick={() => setPlaying((v) => !v)}>
              {playing ? '⏸ 暂停' : '▶ 播放'}
            </button>
            <button
              onClick={() => {
                setProgress(0);
                setPlaying(false);
              }}
            >
              ⏮ 起点
            </button>
            <input
              type="range"
              min={0}
              max={Math.max(0, stitches.length - 1)}
              value={safeProgress}
              onChange={(e) => {
                setPlaying(false);
                setProgress(parseInt(e.target.value, 10));
              }}
            />
            <span className="badge">
              {hasStitches ? safeProgress + 1 : 0} / {stitches.length}
            </span>
          </div>
          <div className="scrub-row">
            <label className="muted" style={{ margin: 0, whiteSpace: 'nowrap' }}>
              走针速度
            </label>
            <input
              type="range"
              min={20}
              max={1000}
              step={20}
              value={speed}
              onChange={(e) => setSpeed(parseInt(e.target.value, 10))}
              style={{ maxWidth: 260 }}
            />
            <span className="badge">{speed} 针/秒</span>
            <span className="spacer" />
            <div className="legend">
              <span>
                <i style={{ background: '#eac759' }} />
                跳针点
              </span>
              <span>
                <i style={{ background: '#f273d9' }} />
                换色点
              </span>
            </div>
          </div>
          <div className="stats-strip">
            <div>
              当前坐标
              <b>
                {current ? `${unitToMm(current.x).toFixed(1)}, ${unitToMm(current.y).toFixed(1)} mm` : '-'}
              </b>            </div>
            <div>
              下一跳针
              <b className="warn-text">{nextJump >= 0 ? `第 ${nextJump + 1} 针` : '无'}</b>
            </div>
            <div>
              下一换色
              <b style={{ color: '#f273d9' }}>{nextCC >= 0 ? `第 ${nextCC + 1} 针` : '无'}</b>
            </div>
            <div>
              已绣用线
              <b>{fmtMeters(sewnLength(stitches, safeProgress))}</b>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function sewnLength(stitches: ReturnType<typeof getCompiled>['stitches'], upto: number): number {
  if (!stitches.length) return 0;
  let total = 0;
  for (let i = 1; i <= upto && i < stitches.length; i++) {
    if (stitches[i].flags & StitchFlag.Jump) continue;
    total += Math.hypot(stitches[i].x - stitches[i - 1].x, stitches[i].y - stitches[i - 1].y);
  }
  return total;
}
