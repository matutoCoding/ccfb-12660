import { useState } from 'react';
import { addThread, removeThread, useStore } from '../store';

export default function ThreadsPage() {
  const threads = useStore((s) => s.threads);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [color, setColor] = useState('#4f9cf9');
  const [sheen, setSheen] = useState(0.6);

  return (
    <div className="page">
      <div className="row" style={{ marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>绣线颜色库</h2>
        <span className="spacer" />
        <span className="muted">光泽度影响仿真中丝线随针迹方向的高光强度</span>
      </div>
      <div className="grid" style={{ gridTemplateColumns: '1fr 320px', alignItems: 'start' }}>
        <div className="card">
          <div className="design-grid">
            {threads.map((t) => (
              <div key={t.id} className="card" style={{ background: 'var(--panel-2)' }}>
                <div
                  style={{
                    height: 70,
                    borderRadius: 6,
                    background: `linear-gradient(135deg, ${t.color}, ${t.color} 55%, #ffffff33)`,
                    marginBottom: 8,
                    border: '1px solid #00000044'
                  }}
                />
                <div className="row">
                  <span className="swatch" style={{ background: t.color }} />
                  <strong>{t.name}</strong>
                  <span className="spacer" />
                  <span className="badge">{t.code}</span>
                </div>
                <div className="muted" style={{ fontSize: 12, margin: '6px 0' }}>
                  {t.color} · 光泽 {(t.sheen * 100).toFixed(0)}%
                </div>
                <button className="danger" onClick={() => removeThread(t.id)}>
                  删除
                </button>
              </div>
            ))}
          </div>
        </div>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>新增线色</h3>
          <div className="panel-body" style={{ padding: 0 }}>
            <div>
              <label>名称</label>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：宝蓝" />
            </div>
            <div>
              <label>线号</label>
              <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="如：B05" />
            </div>
            <div>
              <label>颜色</label>
              <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
            </div>
            <div>
              <label>光泽度 {(sheen * 100).toFixed(0)}%</label>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={sheen}
                onChange={(e) => setSheen(parseFloat(e.target.value))}
              />
            </div>
            <button
              className="primary"
              disabled={!name.trim() || !code.trim()}
              onClick={() => {
                addThread({ name: name.trim(), code: code.trim(), color, sheen });
                setName('');
                setCode('');
              }}
            >
              加入色库
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
