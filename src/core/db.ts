// IndexedDB 持久化:花版库存储 + 历史版本。所有数据留在浏览器本地。

import { Pattern, PatternVersion, newId } from './types';

const DB_NAME = 'embroidery-studio';
const DB_VERSION = 1;
const STORE_PATTERNS = 'patterns';
const STORE_VERSIONS = 'versions';

export interface PatternRecord {
  pattern: Pattern;
  versionIds: string[];
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_PATTERNS)) {
          db.createObjectStore(STORE_PATTERNS, { keyPath: 'pattern.id' });
        }
        if (!db.objectStoreNames.contains(STORE_VERSIONS)) {
          db.createObjectStore(STORE_VERSIONS, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(db => new Promise<T>((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

export async function listPatterns(): Promise<Pattern[]> {
  const recs = await tx(STORE_PATTERNS, 'readonly', s => s.getAll() as IDBRequest<PatternRecord[]>);
  return recs.map(r => r.pattern).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function savePattern(pattern: Pattern): Promise<void> {
  pattern.updatedAt = Date.now();
  const existing = await tx(STORE_PATTERNS, 'readonly', s => s.get(pattern.id) as IDBRequest<PatternRecord | undefined>);
  const rec: PatternRecord = { pattern, versionIds: existing?.versionIds ?? [] };
  await tx(STORE_PATTERNS, 'readwrite', s => s.put(rec));
}

export async function deletePattern(id: string): Promise<void> {
  const rec = await tx(STORE_PATTERNS, 'readonly', s => s.get(id) as IDBRequest<PatternRecord | undefined>);
  if (rec) {
    for (const vid of rec.versionIds) {
      await tx(STORE_VERSIONS, 'readwrite', s => s.delete(vid));
    }
  }
  await tx(STORE_PATTERNS, 'readwrite', s => s.delete(id));
}

export async function duplicatePattern(id: string): Promise<Pattern | null> {
  const rec = await tx(STORE_PATTERNS, 'readonly', s => s.get(id) as IDBRequest<PatternRecord | undefined>);
  if (!rec) return null;
  const copy: Pattern = JSON.parse(JSON.stringify(rec.pattern));
  copy.id = newId();
  copy.name = copy.name + ' 副本';
  copy.createdAt = Date.now();
  copy.updatedAt = Date.now();
  await savePattern(copy);
  return copy;
}

/** 保存一个历史版本快照 */
export async function saveVersion(pattern: Pattern, note = ''): Promise<PatternVersion> {
  const version: PatternVersion = {
    id: newId(),
    savedAt: Date.now(),
    note: note || new Date().toLocaleString('zh-CN'),
    name: pattern.name,
    regions: JSON.parse(JSON.stringify(pattern.regions)),
    stitches: JSON.parse(JSON.stringify(pattern.stitches)),
  };
  await tx(STORE_VERSIONS, 'readwrite', s => s.put(version));
  const rec = await tx(STORE_PATTERNS, 'readonly', s => s.get(pattern.id) as IDBRequest<PatternRecord | undefined>);
  if (rec) {
    rec.versionIds.push(version.id);
    await tx(STORE_PATTERNS, 'readwrite', s => s.put(rec));
  }
  return version;
}

export async function listVersions(patternId: string): Promise<PatternVersion[]> {
  const rec = await tx(STORE_PATTERNS, 'readonly', s => s.get(patternId) as IDBRequest<PatternRecord | undefined>);
  if (!rec) return [];
  const versions: PatternVersion[] = [];
  for (const vid of rec.versionIds) {
    const v = await tx(STORE_VERSIONS, 'readonly', s => s.get(vid) as IDBRequest<PatternVersion | undefined>);
    if (v) versions.push(v);
  }
  return versions.sort((a, b) => b.savedAt - a.savedAt);
}

/** 对比两版针迹:按 0.1mm 量化坐标做集合差 */
export function diffStitches(a: { x: number; y: number }[], b: { x: number; y: number }[]): {
  added: number; removed: number; common: number;
} {
  const key = (p: { x: number; y: number }) => `${Math.round(p.x * 10)},${Math.round(p.y * 10)}`;
  const countMap = (arr: { x: number; y: number }[]) => {
    const m = new Map<string, number>();
    for (const p of arr) m.set(key(p), (m.get(key(p)) ?? 0) + 1);
    return m;
  };
  const ma = countMap(a), mb = countMap(b);
  let common = 0, removed = 0;
  for (const [k, na] of ma) {
    const nb = mb.get(k) ?? 0;
    common += Math.min(na, nb);
    removed += Math.max(0, na - nb);
  }
  let added = 0;
  for (const [k, nb] of mb) {
    const na = ma.get(k) ?? 0;
    added += Math.max(0, nb - na);
  }
  return { added, removed, common };
}
