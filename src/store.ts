/**
 * 应用状态中枢。
 * useSyncExternalStore 订阅；花版变更后 500ms debounce 写入 IndexedDB（自动保存）。
 * 针迹编译结果按 design 版本缓存，分区参数一变即失效重算。
 */

import { useSyncExternalStore } from 'react';
import type { Design, Pt, Region, Stitch, StitchKind, Thread, VersionSnapshot } from './core/types';
import { defaultParams } from './core/params';
import { uid, mmToUnit } from './core/units';
import { compileDesign } from './stitches/compiler';
import { computeStats, type DesignStats } from './core/stats';
import { autoSchedule } from './core/scheduling';
import { parseDst, writeDst } from './dst/dst';
import {
  deleteDesign as dbDeleteDesign,
  duplicateDesign as dbDuplicate,
  getAllDesigns,
  getAllThreads,
  putDesign,
  putThread,
  deleteThread as dbDeleteThread,
  saveVersion as dbSaveVersion,
  listVersions,
  seedDefaultThreads
} from './storage/db';

interface State {
  loaded: boolean;
  designs: Design[];
  threads: Thread[];
  currentId: string | null;
  selectedRegionId: string | null;
  /** designId → 编译缓存 */
  compileCache: Map<string, { stitches: Stitch[]; stats: DesignStats }>;
  /** designId → 缓存键（id:version） */
  compileKey: Map<string, string> | null;
  versions: VersionSnapshot[];
  toast: string | null;
}

const state: State = {
  loaded: false,
  designs: [],
  threads: [],
  currentId: null,
  selectedRegionId: null,
  compileCache: new Map(),
  compileKey: null,
  versions: [],
  toast: null
};

const listeners = new Set<() => void>();
let toastTimer: ReturnType<typeof setTimeout> | null = null;

function emit() {
  listeners.forEach((l) => l());
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}
function getSnapshot() {
  return state;
}

const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
function scheduleSave(design: Design) {
  const old = saveTimers.get(design.id);
  if (old) clearTimeout(old);
  saveTimers.set(
    design.id,
    setTimeout(() => {
      void putDesign(design);
      saveTimers.delete(design.id);
    }, 500)
  );
}

function showToast(msg: string) {
  state.toast = msg;
  emit();
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    state.toast = null;
    emit();
  }, 2200);
}

/* ---------- 初始化 ---------- */

export async function initStore() {
  if (state.loaded) return;
  const [designs, threads] = await Promise.all([getAllDesigns(), seedDefaultThreads().then(() => getAllThreads())]);
  state.designs = designs;
  state.threads = threads;
  // 刷新后自动回到最近编辑的花版，避免编辑器页空白
  if (!state.currentId && designs.length) state.currentId = designs[0].id;
  state.loaded = true;
  emit();
}

/* ---------- 选择 hooks ---------- */

export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(getSnapshot()),
    () => selector(getSnapshot())
  );
}

export function useCurrentDesign(): Design | null {
  return useStore((s) => s.designs.find((d) => d.id === s.currentId) ?? null);
}

/* ---------- 花版 CRUD ---------- */

export function createDesign(name = '新花版'): string {
  const now = Date.now();
  const design: Design = {
    id: uid('ds'),
    name,
    createdAt: now,
    updatedAt: now,
    width: mmToUnit(100),
    height: mmToUnit(100),
    regions: [],
    stitchOrder: [],
    importedStitches: null,
    version: 1
  };
  state.designs = [design, ...state.designs];
  state.currentId = design.id;
  state.selectedRegionId = null;
  void putDesign(design);
  emit();
  return design.id;
}

export function selectDesign(id: string | null) {
  state.currentId = id;
  state.selectedRegionId = null;
  state.versions = [];
  emit();
}

export async function duplicateCurrent() {
  if (!state.currentId) return;
  const copy = await dbDuplicate(state.currentId, uid('ds'));
  if (copy) {
    state.designs = [copy, ...state.designs];
    state.currentId = copy.id;
    emit();
    showToast('已复制花版');
  }
}

export async function removeDesign(id: string) {
  await dbDeleteDesign(id);
  state.designs = state.designs.filter((d) => d.id !== id);
  state.compileCache.delete(id);
  if (state.currentId === id) state.currentId = null;
  emit();
}

function mutateCurrent(mut: (d: Design) => void) {
  const d = state.designs.find((x) => x.id === state.currentId);
  if (!d) return;
  mut(d);
  d.updatedAt = Date.now();
  d.version += 1;
  state.compileCache.delete(d.id);
  scheduleSave(d);
  emit();
}

/* ---------- 分区操作 ---------- */

export function addRegion(polygon: Pt[], kind: StitchKind = 'satin', name?: string): string | null {
  const d = state.designs.find((x) => x.id === state.currentId);
  if (!d) return null;
  const threadId = state.threads[0]?.id ?? 'th_0';
  const id = uid('rg');
  const region: Region = {
    id,
    name: name ?? `分区 ${d.regions.length + 1}`,
    polygon,
    holes: [],
    threadId,
    params: defaultParams(kind),
    visible: true
  };
  mutateCurrent((cur) => {
    cur.regions.push(region);
    cur.stitchOrder.push(id);
  });
  state.selectedRegionId = id;
  emit();
  return id;
}

export function updateRegionPolygon(regionId: string, polygon: Pt[]) {
  mutateCurrent((d) => {
    const r = d.regions.find((x) => x.id === regionId);
    if (r) r.polygon = polygon;
  });
}

export function updateRegionParams(regionId: string, patch: Partial<Region['params']>) {
  mutateCurrent((d) => {
    const r = d.regions.find((x) => x.id === regionId);
    if (r) r.params = { ...r.params, ...patch };
  });
}

export function updateRegion(regionId: string, patch: Partial<Omit<Region, 'params'>>) {
  mutateCurrent((d) => {
    const r = d.regions.find((x) => x.id === regionId);
    if (r) Object.assign(r, patch);
  });
}

export function removeRegion(regionId: string) {
  mutateCurrent((d) => {
    d.regions = d.regions.filter((r) => r.id !== regionId);
    d.stitchOrder = d.stitchOrder.filter((id) => id !== regionId);
  });
  if (state.selectedRegionId === regionId) state.selectedRegionId = null;
}

export function selectRegion(id: string | null) {
  state.selectedRegionId = id;
  emit();
}

export function toggleRegionVisible(regionId: string) {
  mutateCurrent((d) => {
    const r = d.regions.find((x) => x.id === regionId);
    if (r) r.visible = !r.visible;
  });
}

/* ---------- 绣制顺序 ---------- */

export function runAutoSchedule() {
  const d = state.designs.find((x) => x.id === state.currentId);
  if (!d) return;
  const result = autoSchedule(d.regions);
  mutateCurrent((cur) => {
    cur.stitchOrder = result.order;
  });
  showToast(`自动排程：换色 ${result.colorChanges} 次`);
}

export function moveRegionOrder(regionId: string, delta: -1 | 1) {
  mutateCurrent((d) => {
    const idx = d.stitchOrder.indexOf(regionId);
    const target = idx + delta;
    if (idx < 0 || target < 0 || target >= d.stitchOrder.length) return;
    [d.stitchOrder[idx], d.stitchOrder[target]] = [d.stitchOrder[target], d.stitchOrder[idx]];
  });
}

/* ---------- 编译与统计（按 design.version 缓存） ---------- */

export function getCompiled(design: Design): { stitches: Stitch[]; stats: DesignStats } {
  // version 在每次 mutateCurrent 时自增，作为缓存失效键，
  // 不能只靠 design 对象引用（状态是原地修改的，引用不变会导致 useMemo 不重算）
  const cacheKey = `${design.id}:${design.version}`;
  const cached = state.compileCache.get(design.id);
  if (cached && state.compileKey?.get(design.id) === cacheKey) {
    return cached;
  }
  const stitches = design.importedStitches ?? compileDesign(design.regions, design.stitchOrder);
  const stats = computeStats(stitches);
  const entry = { stitches, stats };
  state.compileCache.set(design.id, entry);
  state.compileKey ??= new Map();
  state.compileKey.set(design.id, cacheKey);
  return entry;
}

/* ---------- DST 导入导出 ---------- */

export async function importDstFile(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const parsed = parseDst(buf);
  const now = Date.now();
  const name = file.name.replace(/\.dst$/i, '') || '导入花版';
  const bbox = parsed.stitches.reduce(
    (b, s) => ({
      minX: Math.min(b.minX, s.x),
      minY: Math.min(b.minY, s.y),
      maxX: Math.max(b.maxX, s.x),
      maxY: Math.max(b.maxY, s.y)
    }),
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  );
  const design: Design = {
    id: uid('ds'),
    name: parsed.header.designName || name,
    createdAt: now,
    updatedAt: now,
    width: bbox.maxX - bbox.minX || mmToUnit(50),
    height: bbox.maxY - bbox.minY || mmToUnit(50),
    regions: [],
    stitchOrder: [],
    importedStitches: parsed.stitches,
    version: 1
  };
  state.designs = [design, ...state.designs];
  state.currentId = design.id;
  await putDesign(design);
  emit();
  if (parsed.warnings.length) showToast(`导入完成，${parsed.warnings.length} 条告警`);
  else showToast(`导入 ${parsed.stitches.length} 针`);
  return design.id;
}

export function exportCurrentDst() {
  const d = state.designs.find((x) => x.id === state.currentId);
  if (!d) return;
  const { stitches } = getCompiled(d);
  const bytes = writeDst(stitches, { designName: d.name });
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
  const blob = new Blob([buf], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${d.name}.dst`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast('已导出 DST');
}

/** 把导入的原始针迹转为可编辑分区（按换色点切段，每段一个矩形外框分区占位） */
export function convertImportedToRegions() {
  mutateCurrent((d) => {
    if (!d.importedStitches) return;
    // 简化处理：整体生成一个包围盒分区，针法榻榻米，保留原始针迹直到用户编辑
    const sts = d.importedStitches;
    const bbox = sts.reduce(
      (b, s) => ({
        minX: Math.min(b.minX, s.x),
        minY: Math.min(b.minY, s.y),
        maxX: Math.max(b.maxX, s.x),
        maxY: Math.max(b.maxY, s.y)
      }),
      { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
    );
    const id = uid('rg');
    d.regions = [
      {
        id,
        name: '导入花版分区',
        polygon: [
          { x: bbox.minX, y: bbox.minY },
          { x: bbox.maxX, y: bbox.minY },
          { x: bbox.maxX, y: bbox.maxY },
          { x: bbox.minX, y: bbox.maxY }
        ],
        holes: [],
        threadId: state.threads[0]?.id ?? 'th_0',
        params: defaultParams('tatami'),
        visible: true
      }
    ];
    d.stitchOrder = [id];
    d.importedStitches = null;
  });
}

/* ---------- 线色库 ---------- */

export function addThread(t: Omit<Thread, 'id'>) {
  const thread: Thread = { ...t, id: uid('th') };
  state.threads = [...state.threads, thread];
  void putThread(thread);
  emit();
}

export function removeThread(id: string) {
  state.threads = state.threads.filter((t) => t.id !== id);
  void dbDeleteThread(id);
  emit();
}

/* ---------- 版本快照 ---------- */

export async function takeSnapshot(label?: string) {
  const d = state.designs.find((x) => x.id === state.currentId);
  if (!d) return;
  const { stats } = getCompiled(d);
  const snap: VersionSnapshot = {
    id: uid('vs'),
    designId: d.id,
    label: label ?? `v${d.version} ${new Date().toLocaleString('zh-CN')}`,
    createdAt: Date.now(),
    design: structuredClone(d),
    stats
  };
  await dbSaveVersion(snap);
  state.versions = [snap, ...state.versions];
  emit();
  showToast('已保存版本快照');
}

export async function loadVersions(designId: string) {
  state.versions = await listVersions(designId);
  emit();
}

export function restoreSnapshot(snap: VersionSnapshot) {
  const restored: Design = { ...structuredClone(snap.design), updatedAt: Date.now() };
  state.designs = state.designs.map((d) => (d.id === restored.id ? restored : d));
  state.currentId = restored.id;
  state.compileCache.delete(restored.id);
  void putDesign(restored);
  emit();
  showToast('已恢复该版本');
}

/** 两版针迹差异：按索引返回新增/缺失/位移针 */
export interface StitchDiff {
  added: Stitch[];
  removed: Stitch[];
  moved: Array<{ from: Stitch; to: Stitch; index: number }>;
}

export function diffStitches(a: Stitch[], b: Stitch[]): StitchDiff {
  const added: Stitch[] = [];
  const removed: Stitch[] = [];
  const moved: StitchDiff['moved'] = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (i >= a.length) added.push(b[i]);
    else if (i >= b.length) removed.push(a[i]);
    else if (a[i].x !== b[i].x || a[i].y !== b[i].y) moved.push({ from: a[i], to: b[i], index: i });
  }
  return { added, removed, moved };
}

export { showToast };
