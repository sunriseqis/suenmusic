/**
 * 本地数据层（IndexedDB）。
 *
 * 直连架构下，三端**不再把用户数据放在服务端**：收藏、不喜欢、历史、续播进度
 * 都是本机的主数据，服务端只在用户自己配了服务器时作为备份/同步目标。
 *
 * 为什么单独一个库而不是复用 `offline/snapshot.ts`：
 * 那个是**快照**（整块 JSON、覆盖写、失败静默、不是真相源）；这里是**主存储**
 * （按行读写、有序、要能增量查）。两者语义不同，混在一起以后会互相拖累。
 *
 * IndexedDB 不可用时（隐私模式等）退回 localStorage，行为一致但每次整表重写 ——
 * 对几百条收藏无所谓，对几万条历史不合适，所以历史有 MAX_HISTORY 上限。
 */

import type { Track } from '@/api/types.ts';

const DB_NAME = 'suenmusic-local';
const VERSION = 1;

const STORES = ['favorites', 'dislikes', 'history', 'progress'] as const;
export type StoreName = (typeof STORES)[number];

/** 历史最多保留条数。超出时删最旧的 —— 历史是"最近听过什么"，不是审计日志 */
const MAX_HISTORY = 3000;

export interface LocalFavorite {
  /** 曲目 id（`qq_<mid>`）。作为主键 */
  id: string;
  /** 曲目快照。收藏页要直接渲染歌名/封面，不能只有 id */
  track?: Track;
  addedAt: number;
}

export interface LocalDislike {
  /** `${type}:${id}`。IndexedDB 只能有一个主键，用组合键 */
  key: string;
  type: 'track' | 'artist';
  id: string;
  name: string;
  addedAt: number;
}

export interface LocalPlayRecord {
  /** 自增序号，仅用于排序与去重 */
  seq?: number;
  trackId: string;
  track?: Track;
  playedAt: number;
  playedMs: number;
  completed: boolean;
}

export interface LocalProgress {
  trackId: string;
  playedMs: number;
  playedAt: number;
}

// ---------------------------------------------------------------------------
// 连接
// ---------------------------------------------------------------------------

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (!dbPromise) {
    dbPromise = new Promise(resolve => {
      try {
        if (typeof indexedDB === 'undefined') return resolve(null);
        const req = indexedDB.open(DB_NAME, VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('favorites')) {
            db.createObjectStore('favorites', { keyPath: 'id' });
          }
          if (!db.objectStoreNames.contains('dislikes')) {
            db.createObjectStore('dislikes', { keyPath: 'key' });
          }
          if (!db.objectStoreNames.contains('history')) {
            const s = db.createObjectStore('history', { keyPath: 'seq', autoIncrement: true });
            s.createIndex('playedAt', 'playedAt');
          }
          if (!db.objectStoreNames.contains('progress')) {
            db.createObjectStore('progress', { keyPath: 'trackId' });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }
  return dbPromise;
}

// ---------------------------------------------------------------------------
// localStorage 后备
// ---------------------------------------------------------------------------

function lsKey(store: StoreName): string {
  return `suenmusic.local.${store}`;
}

function lsRead<T>(store: StoreName): T[] {
  try {
    const raw = localStorage.getItem(lsKey(store));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function lsWrite<T>(store: StoreName, rows: T[]): void {
  try {
    localStorage.setItem(lsKey(store), JSON.stringify(rows));
  } catch {
    /* 配额满/隐私模式：写不进去只能放弃，不能打断播放 */
  }
}

/**
 * 转成"能被结构化克隆"的纯对象。
 *
 * ⚠️ **这是必须的，不是保险**：IndexedDB 用结构化克隆算法写值，而 Vue 的响应式
 * 对象是 **Proxy** —— 直接 `put()` 会抛 `DataCloneError: #<Object> could not be cloned`。
 * 而调用方传进来的 `props.track` / `player.currentTrack` 全都是 Proxy。
 *
 * 症状极具误导性：界面上的红心变了（内存生效），但**一条都没落库**，
 * 杀进程重开就全没了；而且异常被静默吞掉，控制台也不一定看得到。
 */
function toPlain<T>(value: T): T {
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;
  }
}

function logFailure(action: string, store: StoreName, err: unknown): void {
  // 不打断主流程，但不能完全无声 —— 否则"没存上"会被误判成"存了但读不到"
  console.error(`[localdb] ${action} ${store} 失败:`, err);
}

function keyOf(store: StoreName, row: unknown): string {
  switch (store) {
    case 'favorites':
      return String((row as LocalFavorite).id);
    case 'dislikes':
      return String((row as LocalDislike).key);
    case 'history':
      return String((row as LocalPlayRecord).seq ?? '');
    case 'progress':
      return String((row as LocalProgress).trackId);
  }
}

// ---------------------------------------------------------------------------
// 基础读写
// ---------------------------------------------------------------------------

export async function ldbAll<T>(store: StoreName): Promise<T[]> {
  const db = await openDb();
  if (!db) return lsRead<T>(store);
  try {
    return await new Promise<T[]>((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).getAll();
      req.onsuccess = () => resolve((req.result as T[]) ?? []);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return lsRead<T>(store);
  }
}

export async function ldbGet<T>(store: StoreName, key: string): Promise<T | null> {
  const db = await openDb();
  if (!db) {
    const row = lsRead<T>(store).find(r => keyOf(store, r) === key);
    return row ?? null;
  }
  try {
    return await new Promise<T | null>((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).get(key);
      req.onsuccess = () => resolve((req.result as T) ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

/** 按主键写入（存在即覆盖）。主键由 `keyOf` 决定，调用方不用给 */
export async function ldbPut(store: StoreName, row: unknown): Promise<void> {
  const plain = toPlain(row);
  const db = await openDb();
  if (!db) {
    const key = keyOf(store, plain);
    const rows = lsRead<unknown>(store).filter(r => keyOf(store, r) !== key);
    rows.push(plain);
    lsWrite(store, rows);
    return;
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(plain);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch (err) {
    logFailure('put', store, err);
  }
}

export async function ldbDelete(store: StoreName, key: string): Promise<void> {
  const db = await openDb();
  if (!db) {
    lsWrite(
      store,
      lsRead<unknown>(store).filter(r => keyOf(store, r) !== key)
    );
    return;
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* 同上 */
  }
}

export async function ldbClear(store: StoreName): Promise<void> {
  const db = await openDb();
  if (!db) {
    lsWrite(store, []);
    return;
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* 同上 */
  }
}

export async function ldbCount(store: StoreName): Promise<number> {
  const db = await openDb();
  if (!db) return lsRead<unknown>(store).length;
  try {
    return await new Promise<number>((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// 收藏
// ---------------------------------------------------------------------------

export async function listFavorites(): Promise<LocalFavorite[]> {
  const rows = await ldbAll<LocalFavorite>('favorites');
  return rows.sort((a, b) => b.addedAt - a.addedAt);
}

export async function saveFavorite(track: Track, addedAt = Date.now()): Promise<void> {
  await ldbPut('favorites', { id: track.id, track, addedAt } satisfies LocalFavorite);
}

export async function removeFavorite(id: string): Promise<void> {
  await ldbDelete('favorites', id);
}

// ---------------------------------------------------------------------------
// 不喜欢（黑名单）
// ---------------------------------------------------------------------------

export async function listDislikes(): Promise<LocalDislike[]> {
  const rows = await ldbAll<LocalDislike>('dislikes');
  return rows.sort((a, b) => b.addedAt - a.addedAt);
}

export async function saveDislike(
  type: 'track' | 'artist',
  id: string,
  name: string,
  addedAt = Date.now()
): Promise<void> {
  await ldbPut('dislikes', {
    key: `${type}:${id}`,
    type,
    id,
    name,
    addedAt,
  } satisfies LocalDislike);
}

export async function removeDislike(type: 'track' | 'artist', id: string): Promise<void> {
  await ldbDelete('dislikes', `${type}:${id}`);
}

// ---------------------------------------------------------------------------
// 历史 / 续播进度
// ---------------------------------------------------------------------------

/** 记一次播放。同一首已有记录时更新它而不是追加 —— 否则历史会全是同一首 */
export async function recordPlay(rec: Omit<LocalPlayRecord, 'seq'>): Promise<void> {
  const rows = await ldbAll<LocalPlayRecord>('history');
  const existing = rows.find(r => r.trackId === rec.trackId);

  if (existing) {
    await ldbPut('history', { ...existing, ...rec });
  } else {
    const db = await openDb();
    if (!db) {
      const nextSeq = rows.reduce((m, r) => Math.max(m, r.seq ?? 0), 0) + 1;
      const next = [...rows, toPlain({ ...rec, seq: nextSeq })];
      lsWrite('history', next);
    } else {
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction('history', 'readwrite');
          tx.objectStore('history').add(toPlain(rec));
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      } catch (err) {
        logFailure('add', 'history', err);
      }
    }
  }

  await trimHistory();
}

async function trimHistory(): Promise<void> {
  const count = await ldbCount('history');
  if (count <= MAX_HISTORY) return;
  const rows = await ldbAll<LocalPlayRecord>('history');
  const drop = rows
    .sort((a, b) => a.playedAt - b.playedAt)
    .slice(0, count - MAX_HISTORY);
  for (const r of drop) {
    if (r.seq === undefined) continue;
    await ldbDelete('history', String(r.seq));
  }
}

export async function listHistory(limit = 200): Promise<LocalPlayRecord[]> {
  const rows = await ldbAll<LocalPlayRecord>('history');
  return rows.sort((a, b) => b.playedAt - a.playedAt).slice(0, limit);
}

export async function saveProgress(
  trackId: string,
  playedMs: number,
  playedAt = Date.now()
): Promise<void> {
  await ldbPut('progress', { trackId, playedMs, playedAt } satisfies LocalProgress);
}

export async function getProgress(trackId: string): Promise<LocalProgress | null> {
  return ldbGet<LocalProgress>('progress', trackId);
}
