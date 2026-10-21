/**
 * 鸿蒙端离线缓存（S2 第一版：整首下载 + LRU 配额）。
 *
 * 官方硬约束（docs/memory/2026-10-21-六端重审修复与死码清理.md §7.4）：
 *   · 必须落 **filesDir** —— `cacheDir` 会被系统按配额自动清理，音频缓存放那里会"莫名消失"；
 *   · `http.request` 单次响应默认 5MB（API 23 起 50MB），整首歌必须走下载任务而不是普通请求；
 *   · 用 `request.agent` 做下载（官方就是给它设计的），完成事件里再登记为"可离线播放"。
 *
 * 断点续传（`FileSpec.begins/ends` → HTTP Range）留在 S2.1：那需要精确的 API 形状，
 * 这一版先保证"完整下载过的歌能离线播"这条命脉，不做半成品续传。
 */

import { request } from '@kit.BasicServicesKit';
import { fileIo } from '@kit.CoreFileKit';
import { common } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

const TAG = 'SuenMusic_Cache';
const DOMAIN = 0x0000;

/** 缓存配额：2GB（鸿蒙端先给保守值，iOS 是 4GB） */
const QUOTA_BYTES: number = 2 * 1024 * 1024 * 1024;
const DIR_NAME: string = 'audio_cache';

interface CacheEntry {
  trackId: string;
  path: string;
  bytes: number;
  mtimeMs: number;
}

export class OfflineCache {
  private static instance: OfflineCache | null = null;
  static shared(): OfflineCache {
    if (OfflineCache.instance === null) { OfflineCache.instance = new OfflineCache(); }
    return OfflineCache.instance;
  }

  private ctx: common.Context | null = null;
  private dir: string = '';
  private ready: boolean = false;
  /** 正在下载的 trackId（防止同一首重复起任务） */
  private downloading: Set<string> = new Set<string>();
  /** 已完整落盘的 trackId → 路径 */
  private complete: Map<string, string> = new Map<string, string>();

  /** 必须在 UIAbility 启动时调一次（需要 context 拿 filesDir） */
  init(context: common.Context): void {
    if (this.ready) { return; }
    this.ctx = context;
    this.dir = context.filesDir + '/' + DIR_NAME;
    try {
      if (!fileIo.accessSync(this.dir)) {
        fileIo.mkdirSync(this.dir, true);
      }
      this.ready = true;
      this.scan();
      this.enforceQuota();
    } catch (e) {
      hilog.error(DOMAIN, TAG, '缓存目录初始化失败: %{public}s', JSON.stringify(e));
    }
  }

  /** 扫盘重建索引（进程重启后靠它恢复"哪些歌可离线播"） */
  private scan(): void {
    this.complete.clear();
    try {
      const names: string[] = fileIo.listFileSync(this.dir);
      for (let i = 0; i < names.length; i++) {
        const name = names[i];
        if (!name.endsWith('.bin')) { continue; }
        const id = name.substring(0, name.length - 4);
        const p = this.dir + '/' + name;
        const stat = fileIo.statSync(p);
        // 小于 32KB 的一律当残片（一首歌不可能这么小）
        if (stat.size > 32 * 1024) {
          this.complete.set(id, p);
        }
      }
      hilog.info(DOMAIN, TAG, '缓存索引重建完成，可离线曲目 %{public}d 首', this.complete.size);
    } catch (e) {
      hilog.error(DOMAIN, TAG, '扫盘失败: %{public}s', JSON.stringify(e));
    }
  }

  private pathOf(trackId: string): string {
    // 曲目 id 形如 qq_xxx / BVxxx，只含字母数字下划线；仍做一次净化
    const safe = trackId.replace(/[^A-Za-z0-9_.-]/g, '_');
    return this.dir + '/' + safe + '.bin';
  }

  /** 是否可离线播放（已完整落盘） */
  isCached(trackId: string): boolean {
    const p = this.complete.get(trackId);
    if (p === undefined) { return false; }
    try {
      return fileIo.accessSync(p);
    } catch (e) {
      this.complete.delete(trackId);
      return false;
    }
  }

  /** 缓存的绝对路径（未命中返回空串） */
  cachedPath(trackId: string): string {
    return this.isCached(trackId) ? (this.complete.get(trackId) as string) : '';
  }

  /**
   * 确保这首歌在缓存里。**不阻塞播放**：起个下载任务就返回，
   * 播放在线流的同时把字节落到 filesDir，下完登记为可离线。
   */
  ensureDownload(trackId: string, streamUrl: string): void {
    if (!this.ready || this.isCached(trackId) || this.downloading.has(trackId)) { return; }
    this.downloading.add(trackId);
    const target = this.pathOf(trackId);

    (async () => {
      try {
        const ctx = this.ctx;
        if (ctx === null) { return; }
        const task = await request.agent.create(ctx, {
          action: request.agent.Action.DOWNLOAD,
          url: streamUrl,
          overwrite: true,
          saveas: target
        });
        task.on('completed', () => {
          this.downloading.delete(trackId);
          this.complete.set(trackId, target);
          hilog.info(DOMAIN, TAG, '缓存完成 %{public}s', trackId);
          this.enforceQuota();
        });
        task.on('failed', (progress: object) => {
          this.downloading.delete(trackId);
          hilog.warn(DOMAIN, TAG, '缓存失败 %{public}s: %{public}s', trackId, JSON.stringify(progress));
        });
        await task.start();
      } catch (e) {
        this.downloading.delete(trackId);
        hilog.error(DOMAIN, TAG, '起下载任务失败: %{public}s', JSON.stringify(e));
      }
    })();
  }

  /** 统计 + 超配额按最久未访问淘汰（配额 2GB） */
  private enforceQuota(): void {
    try {
      const names: string[] = fileIo.listFileSync(this.dir);
      const entries: CacheEntry[] = [];
      let total = 0;
      for (let i = 0; i < names.length; i++) {
        const name = names[i];
        if (!name.endsWith('.bin')) { continue; }
        const p = this.dir + '/' + name;
        const stat = fileIo.statSync(p);
        const mtime = stat.mtime * 1000;
        total += stat.size;
        entries.push({ trackId: name.substring(0, name.length - 4), path: p,
          bytes: stat.size, mtimeMs: mtime });
      }
      if (total <= QUOTA_BYTES) { return; }
      entries.sort((a: CacheEntry, b: CacheEntry) => a.mtimeMs - b.mtimeMs);
      for (let i = 0; i < entries.length && total > QUOTA_BYTES; i++) {
        const e = entries[i];
        try {
          fileIo.unlinkSync(e.path);
          this.complete.delete(e.trackId);
          total -= e.bytes;
          hilog.info(DOMAIN, TAG, '淘汰缓存 %{public}s', e.trackId);
        } catch (err) {
          hilog.warn(DOMAIN, TAG, '淘汰失败: %{public}s', JSON.stringify(err));
        }
      }
    } catch (e) {
      hilog.error(DOMAIN, TAG, '配额检查失败: %{public}s', JSON.stringify(e));
    }
  }
}
