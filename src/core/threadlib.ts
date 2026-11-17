// 绣线色库（常用涤纶丝色号，RGB 为近似显示色）

export interface ThreadColor {
  id: string;
  code: string;
  name: string;
  rgb: [number, number, number];
}

const T = (code: string, name: string, hex: string): ThreadColor => {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return { id: code, code, name, rgb: [r, g, b] };
};

export const THREADS: ThreadColor[] = [
  T('1800', '本白', '#f5f2e8'),
  T('1801', '漂白', '#ffffff'),
  T('1902', '黑色', '#1a1a1a'),
  T('1911', '深灰', '#4a4a4a'),
  T('1915', '浅灰', '#b8b8b8'),
  T('2001', '大红', '#d62300'),
  T('2017', '朱红', '#e84c1e'),
  T('2023', '玫红', '#d14d7e'),
  T('2036', '粉红', '#f2a7bb'),
  T('2047', '酒红', '#8c1d2f'),
  T('2105', '橙色', '#f07d00'),
  T('2204', '金黄', '#f2b705'),
  T('2210', '明黄', '#f7d708'),
  T('2225', '米色', '#e3d0a7'),
  T('2304', '棕色', '#7a4a21'),
  T('2312', '深棕', '#4e2e15'),
  T('2402', '草绿', '#6fa832'),
  T('2416', '翠绿', '#1e8c4a'),
  T('2428', '墨绿', '#1f4d2e'),
  T('2433', '湖绿', '#3fae9a'),
  T('2501', '宝蓝', '#1f4e9c'),
  T('2514', '藏青', '#1c2a52'),
  T('2522', '天蓝', '#6aaed6'),
  T('2530', '湖蓝', '#2b8fb8'),
  T('2607', '紫色', '#6b3fa0'),
  T('2615', '紫红', '#a03a7a'),
  T('2703', '金色', '#c8a23a'),
  T('2709', '银色', '#c0c0c8'),
];

export const DEFAULT_THREAD_SEQUENCE = THREADS.map((t) => t.id);

const byId = new Map(THREADS.map((t) => [t.id, t]));

export function threadById(id: string): ThreadColor {
  return byId.get(id) ?? THREADS[0];
}

export function threadCss(id: string): string {
  const t = threadById(id);
  return `rgb(${t.rgb[0]},${t.rgb[1]},${t.rgb[2]})`;
}

export function nearestThread(r: number, g: number, b: number): ThreadColor {
  let best = THREADS[0];
  let bestD = Infinity;
  for (const t of THREADS) {
    const dr = t.rgb[0] - r;
    const dg = t.rgb[1] - g;
    const db = t.rgb[2] - b;
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  return best;
}
