// 花版库:新建/复制/删除/导入导出 DST/自动保存列表/历史版本对比。

import { el, download, pickFile, fmtTime } from './dom';
import { createPattern, Flag, Pattern } from '../core/types';
import { parseDst, writeDst } from '../core/dst';
import { computeStats } from '../core/sequence';
import { threadColor } from '../core/palette';
import * as db from '../core/db';

function toast(msg: string): void {
  const t = el('div', { class: 'toast' }, [msg]);
  document.body.append(t);
  setTimeout(() => t.remove(), 2200);
}

export function renderLibrary(container: HTMLElement): () => void {
  const page = el('div', { class: 'page' });
  container.append(page);
  let disposed = false;

  async function refresh(): Promise<void> {
    if (disposed) return;
    const patterns = await db.listPatterns();
    page.innerHTML = '';

    const newBtn = el('button', { class: 'primary' }, ['+ 新建花版']);
    newBtn.onclick = async () => {
      const p = createPattern(`新花版 ${new Date().toLocaleDateString('zh-CN')}`);
      await db.savePattern(p);
      location.hash = `#/edit/${p.id}`;
    };
    const importBtn = el('button', {}, ['导入 DST']);
    importBtn.onclick = async () => {
      const file = await pickFile('.dst');
      if (!file) return;
      try {
        const data = parseDst(await file.arrayBuffer());
        const p = createPattern(data.name || file.name.replace(/\.dst$/i, ''));
        p.stitches = data.stitches;
        // DST 只有针迹没有分区,作为只读针迹版导入(可直接仿真/导出)
        await db.savePattern(p);
        toast(`导入成功:${data.stitches.filter(s => s.flag === Flag.Stitch).length} 针,${data.colorChanges} 次换色`);
        refresh();
      } catch (e) {
        toast('DST 解析失败: ' + (e as Error).message);
      }
    };
    page.append(
      el('div', { class: 'toolbar-row' }, [
        newBtn, importBtn,
        el('span', { class: 'hint' }, ['数据自动保存在浏览器本地(IndexedDB),可直接导入客户 DST 看效果']),
      ]),
    );

    if (!patterns.length) {
      page.append(el('p', { class: 'hint' }, ['还没有花版。新建一个,或导入 DST 文件。']));
      return;
    }

    const grid = el('div', { class: 'card-grid' });
    for (const p of patterns) {
      grid.append(patternCard(p));
    }
    page.append(grid);
  }

  function patternCard(p: Pattern): HTMLElement {
    const stats = computeStats(p.stitches);
    const colorIds = [...new Set(p.regions.map(r => r.colorId))];
    const swatches = el('div', { class: 'swatches' },
      colorIds.slice(0, 10).map(id => {
        const c = threadColor(id);
        return el('i', { style: `background:rgb(${c.rgb.map(v => v * 255).join(',')})`, title: c.name });
      }),
    );
    if (!colorIds.length && p.stitches.length) {
      swatches.append(el('span', { class: 'hint' }, ['DST 导入(无分区)']));
    }

    const open = (hash: string) => () => { location.hash = hash; };

    const editBtn = el('button', { class: 'small primary' }, ['制版']);
    editBtn.onclick = open(`#/edit/${p.id}`);
    const simBtn = el('button', { class: 'small' }, ['仿真']);
    simBtn.onclick = open(`#/sim/${p.id}`);
    const dupBtn = el('button', { class: 'small' }, ['复制']);
    dupBtn.onclick = async () => { await db.duplicatePattern(p.id); refresh(); };
    const expBtn = el('button', { class: 'small' }, ['导出 DST']);
    expBtn.onclick = () => {
      if (!p.stitches.length) { toast('花版还没有针迹'); return; }
      download(`${p.name}.dst`, writeDst(p.name, p.stitches));
    };
    const verBtn = el('button', { class: 'small' }, ['版本']);
    verBtn.onclick = () => showVersions(p);
    const delBtn = el('button', { class: 'small danger' }, ['删除']);
    delBtn.onclick = async () => {
      if (confirm(`删除花版「${p.name}」及其所有历史版本?`)) {
        await db.deletePattern(p.id);
        refresh();
      }
    };

    return el('div', { class: 'card' }, [
      el('h3', {}, [p.name]),
      el('div', { class: 'meta' }, [
        `${stats.stitchCount} 针 · ${stats.colorChanges} 换色 · 约 ${fmtTime(stats.estimatedSeconds)}`,
      ]),
      swatches,
      el('div', { class: 'meta' }, [`更新于 ${new Date(p.updatedAt).toLocaleString('zh-CN')}`]),
      el('div', { class: 'actions' }, [editBtn, simBtn, dupBtn, expBtn, verBtn, delBtn]),
    ]);
  }

  async function showVersions(p: Pattern): Promise<void> {
    const versions = await db.listVersions(p.id);
    const selected = new Set<string>();
    const list = el('div', {});
    const result = el('div', { class: 'hint' }, ['勾选两个版本可对比针迹差异']);

    function renderList(): void {
      list.innerHTML = '';
      if (!versions.length) {
        list.append(el('p', { class: 'hint' }, ['暂无历史版本。在制版编辑页点「保存版本」创建快照。']));
        return;
      }
      for (const v of versions) {
        const cb = el('input', { type: 'checkbox' });
        cb.onchange = () => {
          cb.checked ? selected.add(v.id) : selected.delete(v.id);
          updateDiff();
        };
        const stats = computeStats(v.stitches);
        list.append(el('div', { class: 'row' }, [
          cb,
          el('span', {}, [`${v.note} — ${stats.stitchCount} 针`]),
          el('span', { class: 'hint' }, [new Date(v.savedAt).toLocaleString('zh-CN')]),
        ]));
      }
    }

    function updateDiff(): void {
      if (selected.size !== 2) {
        result.textContent = '勾选两个版本可对比针迹差异';
        return;
      }
      const [a, b] = versions.filter(v => selected.has(v.id));
      const only = (arr: typeof a.stitches) => arr.filter(s => s.flag === Flag.Stitch);
      const diff = db.diffStitches(only(a.stitches), only(b.stitches));
      result.textContent =
        `「${a.note}」vs「${b.note}」:共同 ${diff.common} 针,` +
        `新增 ${diff.added} 针,删除 ${diff.removed} 针`;
    }

    renderList();
    const closeBtn = el('button', {}, ['关闭']);
    const mask = el('div', { class: 'modal-mask' }, [
      el('div', { class: 'modal' }, [
        el('h3', {}, [`「${p.name}」历史版本`]),
        list,
        el('hr', { style: 'border-color:var(--border)' }),
        result,
        el('div', { class: 'row', style: 'justify-content:flex-end;margin-top:12px' }, [closeBtn]),
      ]),
    ]);
    closeBtn.onclick = () => mask.remove();
    mask.onclick = e => { if (e.target === mask) mask.remove(); };
    document.body.append(mask);
  }

  refresh();
  return () => { disposed = true; };
}
