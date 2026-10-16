/**
 * 离线元数据快照（IndexedDB）。
 *
 * 解决的问题：离线缓存 L1 让"歌"能离线播，但**列表本身**（收藏、队列）断网时
 * 拉不到 —— 用户点不进列表，就够不着那些已缓存的歌。这里把"最后已知的数据"
 * 存一份在本地，断网时照常展示。
 *
 * 选 IndexedDB 而不是 localStorage：收藏列表可能有几百首完整曲目对象（几百 KB），
 * 同步写 localStorage 会卡主线程；IndexedDB 异步且容量宽松。IndexedDB 不可用
 * （隐私模式等）时退回 localStorage，保证功能在就有。
 */

const DB_NAME = 'suenmusic-offline';
const STORE = 'kv';
const VERSION = 1;

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (!dbPromise) {
    dbPromise = new Promise(resolve => {
      try {
        if (typeof indexedDB === 'undefined') return resolve(null);
        const req = indexedDB.open(DB_NAME, VERSION);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
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

function lsGet(key: string): unknown | null {
  try {
    const raw = localStorage.getItem(`suenmusic.offline.${key}`);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

function lsSet(key: string, value: unknown): void {
  try {
    localStorage.setItem(`suenmusic.offline.${key}`, JSON.stringify(value));
  } catch {
    /* 写不进去就算了（可能超配额），快照不是关键数据 */
  }
}

/** 写一份快照。失败静默 —— 快照永远不该打断正常流程 */
export async function saveOffline(key: string, value: unknown): Promise<void> {
  try {
    const db = await openDb();
    if (!db) {
      lsSet(key, value);
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch {
    lsSet(key, value);
  }
}

/** 读快照；没有或损坏返回 null。调用方必须自己处理 null（快照只是兜底） */
export async function loadOffline<T>(key: string): Promise<T | null> {
  try {
    const db = await openDb();
    if (!db) return (lsGet(key) as T) ?? null;
    return await new Promise<T | null>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve((req.result as T) ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return (lsGet(key) as T) ?? null;
  }
}
