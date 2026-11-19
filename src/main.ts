// 应用入口:路由 + 页面装配。

import './style.css';
import { el } from './ui/dom';
import { renderLibrary } from './ui/library';
import { renderEditor } from './ui/editor';
import { renderSimulation } from './ui/simulation';
import { renderProduction } from './ui/production';

type Cleanup = () => void;
let cleanup: Cleanup | null = null;

const NAV = [
  { hash: '#/library', label: '花版库' },
  { hash: '#/edit', label: '制版编辑' },
  { hash: '#/sim', label: '针迹仿真' },
  { hash: '#/production', label: '生产单' },
];

function route(): { page: string; id: string | null } {
  const h = location.hash || '#/library';
  const m = h.match(/^#\/(\w+)(?:\/([\w-]+))?/);
  return { page: m?.[1] ?? 'library', id: m?.[2] ?? null };
}

function mount(): void {
  cleanup?.();
  cleanup = null;
  const app = document.getElementById('app')!;
  app.innerHTML = '';
  const { page, id } = route();

  const navs = NAV.map(n =>
    el('a', { href: n.hash, class: page === n.hash.slice(2) ? 'active' : '' }, [n.label]),
  );
  app.append(
    el('div', { class: 'topbar' }, [
      el('span', { class: 'logo' }, ['绣花制版仿真']),
      el('nav', {}, navs),
      el('span', { class: 'spacer' }),
    ]),
  );

  const container = el('div', { style: 'flex:1;display:flex;flex-direction:column;overflow:hidden' });
  app.append(container);

  switch (page) {
    case 'edit':
      cleanup = renderEditor(container, id);
      break;
    case 'sim':
      cleanup = renderSimulation(container, id);
      break;
    case 'production':
      cleanup = renderProduction(container);
      break;
    default:
      cleanup = renderLibrary(container);
  }
}

window.addEventListener('hashchange', mount);
mount();
