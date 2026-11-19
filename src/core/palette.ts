// 绣线颜色库(仿 Madeira 常用色,RGB 为近似值)

export interface ThreadColor {
  id: string;
  name: string;
  rgb: [number, number, number];
}

export const THREAD_PALETTE: ThreadColor[] = [
  { id: 'T1800', name: '正红', rgb: [0.78, 0.06, 0.10] },
  { id: 'T1847', name: '深红', rgb: [0.55, 0.02, 0.08] },
  { id: 'T1911', name: '桃红', rgb: [0.95, 0.35, 0.45] },
  { id: 'T1023', name: '橙', rgb: [0.95, 0.45, 0.05] },
  { id: 'T1067', name: '金黄', rgb: [0.98, 0.75, 0.10] },
  { id: 'T1124', name: '明黄', rgb: [0.99, 0.90, 0.20] },
  { id: 'T1250', name: '草绿', rgb: [0.30, 0.65, 0.20] },
  { id: 'T1294', name: '深绿', rgb: [0.05, 0.35, 0.15] },
  { id: 'T1376', name: '湖蓝', rgb: [0.10, 0.55, 0.75] },
  { id: 'T1410', name: '宝蓝', rgb: [0.05, 0.20, 0.60] },
  { id: 'T1466', name: '藏青', rgb: [0.05, 0.10, 0.30] },
  { id: 'T1533', name: '紫', rgb: [0.45, 0.20, 0.60] },
  { id: 'T1602', name: '咖啡', rgb: [0.40, 0.22, 0.10] },
  { id: 'T1687', name: '米色', rgb: [0.85, 0.75, 0.60] },
  { id: 'T1701', name: '浅灰', rgb: [0.70, 0.70, 0.72] },
  { id: 'T1755', name: '深灰', rgb: [0.35, 0.35, 0.38] },
  { id: 'T1801', name: '黑', rgb: [0.08, 0.08, 0.09] },
  { id: 'T1802', name: '白', rgb: [0.96, 0.96, 0.95] },
  { id: 'T1905', name: '粉', rgb: [0.98, 0.70, 0.78] },
  { id: 'T1988', name: '香槟金', rgb: [0.85, 0.70, 0.40] },
];

const byId = new Map(THREAD_PALETTE.map(c => [c.id, c]));

export function threadColor(id: string): ThreadColor {
  return byId.get(id) ?? THREAD_PALETTE[0];
}

/** 从 RGB 找最接近的库内颜色(位图描边分区自动配色用) */
export function nearestThread(r: number, g: number, b: number): ThreadColor {
  let best = THREAD_PALETTE[0], bestD = Infinity;
  for (const c of THREAD_PALETTE) {
    const d = (c.rgb[0] - r) ** 2 + (c.rgb[1] - g) ** 2 + (c.rgb[2] - b) ** 2;
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}
