import { useEffect, useImperativeHandle, useRef, forwardRef } from 'react';
import { EmbroideryRenderer, type RenderMode, type RenderOptions } from '../render/EmbroideryRenderer';
import type { Pt, Stitch } from '../core/types';

export interface CanvasHandle {
  fit: () => void;
  screenToWorld: (sx: number, sy: number) => Pt;
  getRenderer: () => EmbroideryRenderer | null;
}

interface Props {
  stitches: Stitch[];
  options: Omit<RenderOptions, 'progress' | 'mode'> & { progress?: number };
  mode: RenderMode;
  onCanvasClick?: (world: Pt, e: React.MouseEvent) => void;
  onCanvasDrag?: (world: Pt, e: React.MouseEvent) => void;
  onCanvasUp?: (world: Pt, e: React.MouseEvent) => void;
  onCanvasDoubleClick?: (world: Pt, e: React.MouseEvent) => void;
  fitSignal?: number;
}

const EmbroideryCanvas = forwardRef<CanvasHandle, Props>(function EmbroideryCanvas(
  { stitches, options, mode, onCanvasClick, onCanvasDrag, onCanvasUp, onCanvasDoubleClick, fitSignal },
  ref
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<EmbroideryRenderer | null>(null);
  const dragState = useRef<{ down: boolean; panning: boolean; lastX: number; lastY: number; moved: boolean }>({
    down: false,
    panning: false,
    lastX: 0,
    lastY: 0,
    moved: false
  });
  // 最新数据进 ref，渲染循环读取，避免每帧重建
  const dataRef = useRef({ stitches, options, mode });
  dataRef.current = { stitches, options, mode };
  const fittedRef = useRef(false);

  useImperativeHandle(ref, () => ({
    fit: () => {
      const r = rendererRef.current;
      if (r) {
        r.fitTo(dataRef.current.stitches);
        fittedRef.current = true;
      }
    },
    screenToWorld: (sx, sy) =>
      rendererRef.current?.screenToWorld(sx, sy) ?? { x: 0, y: 0 },
    getRenderer: () => rendererRef.current
  }));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let renderer: EmbroideryRenderer;
    try {
      renderer = new EmbroideryRenderer(canvas);
    } catch (e) {
      alert((e as Error).message);
      return;
    }
    rendererRef.current = renderer;
    let raf = 0;
    const loop = () => {
      const { stitches: sts, options: opts, mode: m } = dataRef.current;
      renderer.render(sts, { ...opts, mode: m, progress: opts.progress ?? sts.length - 1 });
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      renderer.dispose();
      rendererRef.current = null;
      fittedRef.current = false;
    };
  }, []);

  // 针迹数量大幅变化时重新适配
  useEffect(() => {
    const r = rendererRef.current;
    if (r && (!fittedRef.current || fitSignal !== undefined)) {
      r.fitTo(stitches);
      fittedRef.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitSignal]);

  const toLocal = (e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    return {
      sx: (e.clientX - rect.left) * dpr,
      sy: (e.clientY - rect.top) * dpr
    };
  };

  return (
    <canvas
      ref={canvasRef}
      style={{ cursor: 'crosshair' }}
      onMouseDown={(e) => {
        const { sx, sy } = toLocal(e);
        dragState.current = { down: true, panning: e.button === 1 || e.shiftKey, lastX: sx, lastY: sy, moved: false };
      }}
      onMouseMove={(e) => {
        const st = dragState.current;
        const { sx, sy } = toLocal(e);
        if (st.down) {
          const dx = sx - st.lastX;
          const dy = sy - st.lastY;
          if (Math.abs(dx) + Math.abs(dy) > 3) st.moved = true;
          if (st.panning) {
            rendererRef.current!.camera.offsetX += dx;
            rendererRef.current!.camera.offsetY += dy;
          } else if (onCanvasDrag) {
            const world = rendererRef.current!.screenToWorld(sx, sy);
            onCanvasDrag(world, e);
          }
          st.lastX = sx;
          st.lastY = sy;
        }
      }}
      onMouseUp={(e) => {
        const st = dragState.current;
        const { sx, sy } = toLocal(e);
        const world = rendererRef.current!.screenToWorld(sx, sy);
        if (!st.moved && onCanvasClick) onCanvasClick(world, e);
        if (st.moved && onCanvasUp) onCanvasUp(world, e);
        st.down = false;
      }}
      onWheel={(e) => {
        e.preventDefault();
        const { sx, sy } = toLocal(e);
        rendererRef.current!.zoom(e.deltaY < 0 ? 1.12 : 0.89, { x: sx, y: sy });
      }}
      onContextMenu={(e) => e.preventDefault()}
      onDoubleClick={(e) => {
        const { sx, sy } = toLocal(e);
        onCanvasDoubleClick?.(rendererRef.current!.screenToWorld(sx, sy), e);
      }}
    />
  );
});

export default EmbroideryCanvas;
