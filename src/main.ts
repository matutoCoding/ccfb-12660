import './style.css';
import { el, clear } from './ui/dom';
import { store } from './store/store';
import { mountLibrary } from './pages/library';
import { mountEditor } from './pages/editor';
import { mountSimulate } from './pages/simulate';
import { mountProduction } from './pages/production';

const PAGES = [
  { id: 'library', label: '花版库' },
  { id: 'editor', label: '制版编辑' },
  { id: 'sim', label: '针迹仿真' },
  { id: 'prod', label: '生产单' },
] as const;

type PageId = (typeof PAGES)[number]['id'];

const app = document.getElementById('app')!;
let currentPage: PageId = 'library';
let cleanup: (() => void) | null = null;

const headerName = el('span', { className: 'header-pattern-name' }, '');
const content = el('div', { style: 'flex:1;min-height:0;display:flex' });

const tabButtons = new Map<PageId, HTMLButtonElement>();

function navigate(page: PageId) {
  currentPage = page;
  cleanup?.();
  clear(content);
  for (const [id, btn] of tabButtons) btn.classList.toggle('active', id === page);
  switch (page) {
    case 'library':
      cleanup = mountLibrary(content, (p) => navigate(p as PageId));
      break;
    case 'editor':
      cleanup = mountEditor(content);
      break;
    case 'sim':
      cleanup = mountSimulate(content);
      break;
    case 'prod':
      cleanup = mountProduction(content);
      break;
  }
}

const tabs = el('nav', { className: 'tabs' });
for (const p of PAGES) {
  const btn = el('button', { className: 'tab', onclick: () => navigate(p.id) }, p.label);
  tabButtons.set(p.id, btn);
  tabs.append(btn);
}

app.append(
  el('header', { className: 'app-header' }, el('span', { className: 'app-title' }, '绣花制版仿真'), tabs, headerName),
  content
);

store.on('current', () => {
  headerName.textContent = store.current ? `当前：${store.current.name}` : '';
});

// 开发调试：控制台可直接访问 store
if (import.meta.env.DEV) {
  (window as unknown as { store: typeof store }).store = store;
}

void store.init().then(() => navigate('library'));
