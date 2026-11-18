import { useEffect } from 'react';
import { NavLink, Route, Routes, Navigate } from 'react-router-dom';
import { initStore, useStore } from './store';
import LibraryPage from './pages/LibraryPage';
import EditorPage from './pages/EditorPage';
import SimulationPage from './pages/SimulationPage';
import ProductionPage from './pages/ProductionPage';
import ThreadsPage from './pages/ThreadsPage';

export default function App() {
  const loaded = useStore((s) => s.loaded);
  const toast = useStore((s) => s.toast);

  useEffect(() => {
    void initStore();
  }, []);

  if (!loaded) {
    return <div style={{ padding: 40 }} className="muted">正在加载花版库…</div>;
  }

  return (
    <div className="app-shell">
      <nav className="topbar">
        <span className="brand">🧵 绣花制版仿真</span>
        <NavLink to="/library" className={({ isActive }) => (isActive ? 'active' : '')}>
          花版库
        </NavLink>
        <NavLink to="/editor" className={({ isActive }) => (isActive ? 'active' : '')}>
          制版编辑
        </NavLink>
        <NavLink to="/simulation" className={({ isActive }) => (isActive ? 'active' : '')}>
          针迹仿真
        </NavLink>
        <NavLink to="/production" className={({ isActive }) => (isActive ? 'active' : '')}>
          生产单
        </NavLink>
        <NavLink to="/threads" className={({ isActive }) => (isActive ? 'active' : '')}>
          线色库
        </NavLink>
      </nav>
      <Routes>
        <Route path="/" element={<Navigate to="/library" replace />} />
        <Route path="/library" element={<LibraryPage />} />
        <Route path="/editor" element={<EditorPage />} />
        <Route path="/simulation" element={<SimulationPage />} />
        <Route path="/production" element={<ProductionPage />} />
        <Route path="/threads" element={<ThreadsPage />} />
      </Routes>
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
