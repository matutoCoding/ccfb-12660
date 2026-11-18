/**
 * IndexedDB 持久化：花版、历史版本、线色库、生产单。
 * 自动保存由 store 层在变更后 debounce 调用 putDesign。
 */

import { openDB, type IDBPDatabase } from 'idb';
import type { Design, ProductionSheet, Thread, VersionSnapshot } from '../core/types';

const DB_NAME = 'embroidery-studio';
const DB_VERSION = 1;

const STORE = {
  designs: 'designs',
  versions: 'versions',
  threads: 'threads',
  sheets: 'sheets'
} as const;

let dbPromise: Promise<IDBPDatabase> | null = null;

function db(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(d) {
        d.createObjectStore(STORE.designs, { keyPath: 'id' });
        const v = d.createObjectStore(STORE.versions, { keyPath: 'id' });
        v.createIndex('designId', 'designId');
        d.createObjectStore(STORE.threads, { keyPath: 'id' });
        d.createObjectStore(STORE.sheets, { keyPath: 'id' });
      }
    });
  }
  return dbPromise;
}

/* ---------- 花版 ---------- */

export async function putDesign(design: Design): Promise<void> {
  const d = await db();
  await d.put(STORE.designs, design);
}

export async function getAllDesigns(): Promise<Design[]> {
  const d = await db();
  const list = await d.getAll(STORE.designs);
  return list.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getDesign(id: string): Promise<Design | undefined> {
  const d = await db();
  return d.get(STORE.designs, id);
}

export async function deleteDesign(id: string): Promise<void> {
  const d = await db();
  const tx = d.transaction([STORE.designs, STORE.versions], 'readwrite');
  await tx.objectStore(STORE.designs).delete(id);
  const idx = tx.objectStore(STORE.versions).index('designId');
  let cursor = await idx.openCursor(id);
  while (cursor) {
    await cursor.delete();
    cursor = await cursor.continue();
  }
  await tx.done;
}

export async function duplicateDesign(id: string, newId: string): Promise<Design | null> {
  const existing = await getDesign(id);
  if (!existing) return null;
  const copy: Design = structuredClone(existing);
  copy.id = newId;
  copy.name = `${existing.name} 副本`;
  copy.createdAt = Date.now();
  copy.updatedAt = Date.now();
  copy.version = 1;
  await putDesign(copy);
  return copy;
}

/* ---------- 版本快照 ---------- */

export async function saveVersion(snapshot: VersionSnapshot): Promise<void> {
  const d = await db();
  await d.put(STORE.versions, snapshot);
}

export async function listVersions(designId: string): Promise<VersionSnapshot[]> {
  const d = await db();
  const all = await d.getAllFromIndex(STORE.versions, 'designId', designId);
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function deleteVersion(snapshotId: string): Promise<void> {
  const d = await db();
  await d.delete(STORE.versions, snapshotId);
}

/* ---------- 线色库 ---------- */

export async function putThread(thread: Thread): Promise<void> {
  const d = await db();
  await d.put(STORE.threads, thread);
}

export async function getAllThreads(): Promise<Thread[]> {
  const d = await db();
  return d.getAll(STORE.threads);
}

export async function deleteThread(id: string): Promise<void> {
  const d = await db();
  await d.delete(STORE.threads, id);
}

/** 首次启动时写入常用涤纶丝线色 */
export async function seedDefaultThreads(): Promise<Thread[]> {
  const existing = await getAllThreads();
  if (existing.length) return existing;
  const palette: Array<[string, string, string]> = [
    ['纯白', 'W01', '#f5f5f0'],
    ['墨黑', 'K01', '#1c1c1e'],
    ['大红', 'R01', '#d23b3b'],
    ['酒红', 'R02', '#8e2430'],
    ['橘红', 'O01', '#e8743b'],
    ['金黄', 'Y01', '#f2c14e'],
    ['明黄', 'Y02', '#f7e06b'],
    ['草绿', 'G01', '#5ba85b'],
    ['墨绿', 'G02', '#245c3f'],
    ['湖蓝', 'B01', '#3b8fd2'],
    ['藏青', 'B02', '#1f3a68'],
    ['天蓝', 'B03', '#7fc4e8'],
    ['紫色', 'P01', '#7a4fb0'],
    ['粉色', 'P02', '#f0a8c0'],
    ['咖啡', 'N01', '#6b4a36'],
    ['米色', 'N02', '#e8dcc4']
  ];
  const threads: Thread[] = palette.map(([name, code, color], i) => ({
    id: `th_${i.toString(36)}`,
    name,
    code,
    color,
    sheen: 0.6
  }));
  for (const t of threads) await putThread(t);
  return threads;
}

/* ---------- 生产单 ---------- */

export async function putSheet(sheet: ProductionSheet): Promise<void> {
  const d = await db();
  await d.put(STORE.sheets, sheet);
}

export async function getAllSheets(): Promise<ProductionSheet[]> {
  const d = await db();
  const list = await d.getAll(STORE.sheets);
  return list.sort((a, b) => b.createdAt - a.createdAt);
}

export async function deleteSheet(id: string): Promise<void> {
  const d = await db();
  await d.delete(STORE.sheets, id);
}
