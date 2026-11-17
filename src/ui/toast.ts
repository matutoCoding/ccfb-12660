// 轻提示

export function toast(msg: string, ms = 2600) {
  const node = document.createElement('div');
  node.className = 'toast';
  node.textContent = msg;
  document.body.append(node);
  setTimeout(() => node.remove(), ms);
}
