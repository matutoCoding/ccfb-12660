import { useMemo, useState } from 'react';
import { useStore, getCompiled } from '../store';
import type { Design } from '../core/types';
import {
  autoNest,
  buildPatternSvg,
  composeSheet,
  computeSheetUsage,
  downloadSvg,
  stitchesOf
} from '../production/nesting';
import { fmtMeters, unitToMm } from '../core/units';

interface Entry {
  designId: string;
  copies: number;
}

export default function ProductionPage() {
  const designs = useStore((s) => s.designs);
  const threads = useStore((s) => s.threads);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [gapMm, setGapMm] = useState(10);

  const selected = entries
    .map((e) => ({ entry: e, design: designs.find((d) => d.id === e.designId) }))
    .filter((x): x is { entry: Entry; design: Design } => Boolean(x.design));

  const nested = useMemo(() => {
    if (!selected.length) return null;
    return autoNest(
      designs,
      selected.map(({ entry, design }) => ({ design, copies: entry.copies })),
      gapMm
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, gapMm, designs]);

  const placed = useMemo(() => {
    if (!nested) return [];
    return nested.items.map((item) => {
      const design = designs.find((d) => d.id === item.designId)!;
      return { item, design, stitches: stitchesOf(design) };
    });
  }, [nested, designs]);

  const allStitches = useMemo(() => composeSheet(placed), [placed]);
  const usage = useMemo(() => computeSheetUsage(allStitches), [allStitches]);

  const colorOf = (id: string | null) => threads.find((t) => t.id === id)?.color;
  const threadName = new Map(threads.map((t) => [t.id, `${t.name} ${t.code}`]));

  const totalThread = usage.reduce((s, u) => s + u.length, 0);

  return (
    <div className="page">
      <h2 style={{ marginTop: 0 }}>生产单 / 拼版</h2>
      <div className="grid" style={{ gridTemplateColumns: '340px 1fr', alignItems: 'start' }}>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>选择花版与份数</h3>
          <div className="panel-body" style={{ padding: 0 }}>
            {designs.length === 0 && <span className="muted">花版库为空</span>}
            {designs.map((d) => {
              const cur = entries.find((e) => e.designId === d.id);
              return (
                <div key={d.id} className="row" style={{ marginBottom: 8 }}>
                  <div style={{ flex: 1 }}>
                    <strong>{d.name}</strong>
                    <div className="muted" style={{ fontSize: 11 }}>
                      {unitToMm(d.width).toFixed(0)}×{unitToMm(d.height).toFixed(0)}mm ·{' '}
                      {getCompiled(d).stats.stitchCount} 针
                    </div>
                  </div>
                  <input
                    type="number"
                    min={0}
                    max={999}
                    style={{ width: 70 }}
                    value={cur?.copies ?? 0}
                    onChange={(e) => {
                      const copies = Math.max(0, parseInt(e.target.value || '0', 10));
                      setEntries((prev) => {
                        const rest = prev.filter((x) => x.designId !== d.id);
                        return copies > 0 ? [...rest, { designId: d.id, copies }] : rest;
                      });
                    }}
                  />
                </div>
              );
            })}
          </div>
          <label>花版间距 {gapMm} mm</label>
          <input
            type="range"
            min={2}
            max={40}
            value={gapMm}
            onChange={(e) => setGapMm(parseInt(e.target.value, 10))}
          />
        </div>

        <div className="card">
          <div className="row" style={{ marginBottom: 10 }}>
            <h3 style={{ margin: 0 }}>拼版结果</h3>
            <span className="spacer" />
            <button
              disabled={!nested}
              onClick={() => {
                if (!nested) return;
                const svg = buildPatternSvg(
                  allStitches,
                  nested.sheetWidth,
                  nested.sheetHeight,
                  colorOf,
                  new Map(
                    usage.map((u) => [u.threadId ?? '', threadName.get(u.threadId ?? '') ?? '未知线色'])
                  )
                );
                downloadSvg(svg, `生产纸样_${new Date().toISOString().slice(0, 10)}.svg`);
              }}
            >
              导出纸样 SVG
            </button>
          </div>
          {!nested ? (
            <div className="muted">在左侧设置至少一个花版的份数。</div>
          ) : (
            <>
              <div className="stats-strip" style={{ marginBottom: 12 }}>
                <div>
                  总份数
                  <b>{nested.items.length}</b>
                </div>
                <div>
                  拼版尺寸
                  <b>
                    {unitToMm(nested.sheetWidth).toFixed(0)}×{unitToMm(nested.sheetHeight).toFixed(0)} mm
                  </b>
                </div>
                <div>
                  总针数
                  <b>{allStitches.length}</b>
                </div>
                <div>
                  总用线
                  <b>{fmtMeters(totalThread)}</b>
                </div>
              </div>
              <NestPreview
                items={nested.items}
                designs={designs}
                sheetWidth={nested.sheetWidth}
                sheetHeight={nested.sheetHeight}
              />
              <h4>用线量明细</h4>
              <table>
                <thead>
                  <tr>
                    <th>线色</th>
                    <th>针数</th>
                    <th>用线长度</th>
                    <th>建议备线（+15% 损耗）</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.map((u) => (
                    <tr key={u.threadId ?? 'null'}>
                      <td>
                        <span className="swatch" style={{ background: colorOf(u.threadId) }} />{' '}
                        {threadName.get(u.threadId ?? '') ?? '未指定'}
                      </td>
                      <td>{u.stitchCount}</td>
                      <td>{fmtMeters(u.length)}</td>
                      <td className="ok-text">{fmtMeters(u.length * 1.15)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function NestPreview({
  items,
  designs,
  sheetWidth,
  sheetHeight
}: {
  items: ReturnType<typeof autoNest>['items'];
  designs: Design[];
  sheetWidth: number;
  sheetHeight: number;
}) {
  const scale = Math.min(620 / Math.max(1, sheetWidth), 380 / Math.max(1, sheetHeight));
  return (
    <div
      style={{
        position: 'relative',
        width: Math.max(1, sheetWidth * scale),
        height: Math.max(1, sheetHeight * scale),
        background: '#0f1216',
        borderRadius: 8,
        marginBottom: 14,
        overflow: 'hidden'
      }}
    >
      {items.map((it, i) => {
        const d = designs.find((dd) => dd.id === it.designId)!;
        return (
          <div
            key={i}
            title={`${d.name} @ (${unitToMm(it.x).toFixed(0)}, ${unitToMm(it.y).toFixed(0)})mm`}
            style={{
              position: 'absolute',
              left: it.x * scale,
              bottom: it.y * scale,
              width: d.width * scale,
              height: d.height * scale,
              border: '1px solid #4f9cf9',
              background: '#4f9cf922',
              fontSize: 10,
              color: '#9cc8ff',
              padding: 2,
              overflow: 'hidden'
            }}
          >
            {d.name}
          </div>
        );
      })}
    </div>
  );
}
