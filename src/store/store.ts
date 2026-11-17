// 全局状态：花版列表、当前花版、针迹计划缓存、自动保存

import type { Pattern, StitchPlan, Region, VersionSnapshot } from '../core/types';
import { uid } from '../core/types';
import { buildPlan } from '../core/stitchgen';
import { dbLoadAll, dbPut, dbDelete } from './db';

type Listener = () => void;

const MAX_VERSIONS = 20;

class Store {
  patterns: Pattern[] = [];
  currentId: string | null = null;
  plan: StitchPlan | null = null;
  spm = 800; // 机器速度（针/分钟）

  private listeners = new Map<string, Set<Listener>>();
  private saveTimer: number | null = null;
  private planTimer: number | null = null;

  on(event: 'patterns' | 'current' | 'plan', fn: Listener): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(fn);
    return () => set!.delete(fn);
  }

  private emit(event: string) {
    this.listeners.get(event)?.forEach((fn) => fn());
  }

  async init() {
    this.patterns = await dbLoadAll();
    this.patterns.sort((a, b) => b.updatedAt - a.updatedAt);
    if (this.patterns.length > 0) this.currentId = this.patterns[0].id;
    this.emit('patterns');
    this.emit('current');
    this.recomputePlan();
  }

  get current(): Pattern | null {
    return this.patterns.find((p) => p.id === this.currentId) ?? null;
  }

  select(id: string | null) {
    this.currentId = id;
    this.emit('current');
    this.recomputePlan();
  }

  createPattern(name?: string): Pattern {
    const p: Pattern = {
      id: uid(),
      name: name ?? `花版 ${this.patterns.length + 1}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      regions: [],
      versions: [],
    };
    this.patterns.unshift(p);
    this.currentId = p.id;
    void dbPut(p);
    this.emit('patterns');
    this.emit('current');
    this.recomputePlan();
    return p;
  }

  duplicatePattern(id: string) {
    const src = this.patterns.find((p) => p.id === id);
    if (!src) return;
    const copy: Pattern = JSON.parse(JSON.stringify(src));
    copy.id = uid();
    copy.name = src.name + ' 副本';
    copy.createdAt = Date.now();
    copy.updatedAt = Date.now();
    copy.regions.forEach((r) => (r.id = uid()));
    this.patterns.unshift(copy);
    void dbPut(copy);
    this.emit('patterns');
  }

  deletePattern(id: string) {
    this.patterns = this.patterns.filter((p) => p.id !== id);
    if (this.currentId === id) {
      this.currentId = this.patterns[0]?.id ?? null;
      this.emit('current');
      this.recomputePlan();
    }
    void dbDelete(id);
    this.emit('patterns');
  }

  /** 修改当前花版：自动保存（防抖）+ 针迹重算（防抖） */
  updateCurrent(mutate: (p: Pattern) => void, opts: { immediatePlan?: boolean } = {}) {
    const p = this.current;
    if (!p) return;
    mutate(p);
    p.updatedAt = Date.now();
    this.emit('current');
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      void dbPut(p);
      this.saveTimer = null;
    }, 400);
    if (opts.immediatePlan) this.recomputePlan();
    else this.schedulePlan();
  }

  schedulePlan(delay = 150) {
    if (this.planTimer !== null) window.clearTimeout(this.planTimer);
    this.planTimer = window.setTimeout(() => {
      this.planTimer = null;
      this.recomputePlan();
    }, delay);
  }

  recomputePlan() {
    const p = this.current;
    this.plan = p ? buildPlan(p.regions, { spm: this.spm }) : null;
    this.emit('plan');
  }

  setSpm(spm: number) {
    this.spm = spm;
    this.recomputePlan();
  }

  saveVersion(label?: string): VersionSnapshot | null {
    const p = this.current;
    if (!p) return null;
    const snap: VersionSnapshot = {
      id: uid(),
      time: Date.now(),
      label: label ?? `版本 ${p.versions.length + 1}`,
      regions: JSON.parse(JSON.stringify(p.regions)),
    };
    p.versions.push(snap);
    if (p.versions.length > MAX_VERSIONS) p.versions.shift();
    void dbPut(p);
    this.emit('current');
    return snap;
  }

  restoreVersion(versionId: string) {
    const p = this.current;
    const v = p?.versions.find((x) => x.id === versionId);
    if (!p || !v) return;
    this.updateCurrent((pat) => {
      pat.regions = JSON.parse(JSON.stringify(v.regions));
    }, { immediatePlan: true });
  }

  deleteVersion(versionId: string) {
    this.updateCurrent((pat) => {
      pat.versions = pat.versions.filter((x) => x.id !== versionId);
    });
  }

  addRegions(regions: Region[]) {
    this.updateCurrent((pat) => {
      pat.regions.push(...regions);
    }, { immediatePlan: true });
  }
}

export const store = new Store();
