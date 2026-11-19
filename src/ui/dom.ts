// 轻量 DOM 助手

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v as unknown as EventListener);
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
}

export function fmtTime(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} 秒`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m} 分 ${s} 秒`;
}

export function fmtLen(mm: number): string {
  return mm >= 1000 ? `${(mm / 1000).toFixed(2)} m` : `${mm.toFixed(0)} mm`;
}

export function download(filename: string, data: ArrayBuffer | string, mime = 'application/octet-stream'): void {
  const blob = data instanceof ArrayBuffer ? new Blob([data], { type: mime }) : new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function pickFile(accept: string): Promise<File | null> {
  return new Promise(resolve => {
    const input = el('input', { type: 'file', accept, style: 'display:none' });
    input.onchange = () => resolve(input.files?.[0] ?? null);
    document.body.append(input);
    input.click();
    setTimeout(() => input.remove(), 60000);
  });
}
