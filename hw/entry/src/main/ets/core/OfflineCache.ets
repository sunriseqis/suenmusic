/**
 * 鸿蒙端离线缓存（T10 收官第 ⑩ 条重造：流式下载 + LRU 配额）。
 *
 * 官方硬约束（docs/memory/2026-10-21-六端重审修复与死码清理.md §7.4）：
 *   · 必须落 **filesDir** —— `cacheDir` 会被系统按配额自动清理，音频缓存放那里会"莫名消失"；
 *   · `http.request` 单次响应默认 5MB（API 23 起 50MB），整首歌不能走普通请求。
 *
 * 下载通道（2026-10-23 验收第 10 条裁定）：**后台静默下载、用户无需管理、零系统通知**。
 * 原 `request.agent` 通道会强制弹系统下载通知、且无法关闭 —— 改 `http.requestInStream`
 * 流式分块写盘：`dataReceive` 边收边写 `.part` 临时文件，`dataEnd` 后校验、改名、登记。
 * 缓存页只留用量 + 清空，不做逐条管理（设计意图见 CachePage）。
 */

import { http } from '@kit.NetworkKit';
import { fileIo } from '@kit.CoreFileKit';
import { common } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

const TAG = 'SuenMusic_Cache';
const DOMAIN = 0x0000;

/** 缓存配额：1GB（规格 6.2；最高音质单曲约 10MB 级，可容纳 100 首以上） */
const QUOTA_BYTES: number = 1 * 1024 * 1024 * 1024;
/**
 * 「明显过小 = 残片」兜底门槛。
 * ⚠️ 它**只是兜底**，不是完整性判据：完整性按规格 5.1/5.2 用 Content-Length 比对
 * （没有 Content-Length 则以 dataEnd 流正常结束为准），见 isComplete()。
 */
const MIN_VALID_BYTES: number = 32 * 1024;
const DIR_NAME: string = 'audio_cache';
/**
 * 命中刷新的节流窗口（规格 6.3）。
 * 命中路径每次起播/重试都会走一遍；同一 trackId 在窗口内只 touch 一次，避免无谓 IO。
 */
const TOUCH_THROTTLE_MS: number = 60 * 1000;

interface CacheEntry {
  trackId: string;
  path: string;
  bytes: number;
  mtimeMs: number;
}

/**
 * 缓存面板展示用的单条信息（S3 增量 3）。
 * `name`/`artist` 来自下载时落盘的旁挂 `.meta` 文件；旧缓存没有则由 UI 回退显示 trackId。
 */
export interface CacheEntryInfo {
  trackId: string;
  path: string;
  bytes: number;
  /** 毫秒时间戳（文件 mtime；命中播放时会刷新，语义是「最后一次使用」，规格 6.3） */
  savedAt: number;
  name?: string;
  artist?: string;
}

/**
 * 曲名旁挂文件（`<id>.bin.meta`）的形状：缓存面板要显示曲名/歌手，而文件名只有 id。
 * **不记录音质**（规格 6.4 / 7.2）：缓存与音质解耦，一首歌一份；界面显示的是
 * 用户选择的档位，与缓存命中的实际档位无关，因此这里没有任何档位信息。
 */
interface CacheMeta {
  name: string;
  artist: string;
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
  /** 进行中的下载 → 取消闭包（切歌/播完/停止时销毁会话并删 `.part`，规格 3.1/3.2） */
  private cancels: Map<string, () => void> = new Map<string, () => void>();
  /** 已完整落盘的 trackId → 路径 */
  private complete: Map<string, string> = new Map<string, string>();
  /** trackId → 上次刷新访问时间的毫秒值（命中节流用，见 touchAccess） */
  private touchedAt: Map<string, number> = new Map<string, number>();
  /** 当前正在播放的 trackId：remove/clearAll 必须跳过它（`fd://` 播放期间删文件会直接打断播放） */
  private protectedId: string = '';

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
        // 规格 3.2/3.3：进程被杀等异常路径留下的 .part 一律清掉（不留残片、不续传）；
        // 正在下载的那份跳过（rescan 可能在下载途中被调用）
        if (name.endsWith('.part')) {
          // 文件名形如 <id>.bin.part：剥掉两层后缀才是 trackId（downloading 存的是 trackId）
          const base = name.endsWith('.bin.part')
            ? name.substring(0, name.length - 9) : name.substring(0, name.length - 5);
          if (!this.downloading.has(base)) {
            try {
              fileIo.unlinkSync(this.dir + '/' + name);
              hilog.info(DOMAIN, TAG, '清理残留下载分片 %{public}s', name);
            } catch (e) {
              // 清不掉不影响索引重建
            }
          }
          continue;
        }
        if (!name.endsWith('.bin')) { continue; }
        const id = name.substring(0, name.length - 4);
        const p = this.dir + '/' + name;
        const stat = fileIo.statSync(p);
        // 小于 32KB 的一律当残片（一首歌不可能这么小，兜底口径，不是完整性判据）
        if (stat.size > MIN_VALID_BYTES) {
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
   * 标记一次「缓存命中并交给播放器」的访问（规格 6.3：超配额按**最久未使用**优先淘汰）。
   * 文件 mtime 只在写文件时才变，播放命中不会刷新它 —— 不在这里显式 touch，
   * 淘汰顺序就退化成「最久未写入」：三个月前缓存、昨天刚播过 10 次的歌反而先被删，
   * 而三个月没碰过的歌留着（与 iOS 端 lastAccessAt 口径不一致）。
   * 命中路径可能被频繁调用，同一 trackId 在 TOUCH_THROTTLE_MS 内只 touch 一次。
   */
  touchAccess(trackId: string): void {
    if (!this.ready) { return; }
    const p = this.cachedPath(trackId);
    if (p.length === 0) { return; }
    const now = Date.now();
    const prev = this.touchedAt.get(trackId);
    if (prev !== undefined && now - prev < TOUCH_THROTTLE_MS) { return; }
    try {
      // 本机 API 26 声明（@ohos.file.fs，:3528；@kit.CoreFileKit 导出的 fileIo 即该命名空间，:99 export { utimes }）：
      //   declare function utimes(path: string, mtime: number): void;
      //   @param { number } mtime - New timestamp. The value is the number of MILLISECONDS elapsed
      //            since the Epoch. Only the time when the file was last modified can be changed.
      // ⚠️ 三点都与 POSIX / Node 的 fs.utimesSync(path, atime, mtime) 不同：
      //   ① 名字没有 Sync 后缀；② 只有 (path, mtime) 两个参数，改不了 atime；③ 单位是**毫秒**不是秒。
      //   传秒会把 mtime 打到 1970 附近，scan/enforceQuota 用 stat.mtime * 1000（:237、:556）
      //   排序时它就变成「最旧」→ 刚播过的歌先被淘汰，规格 6.3 的语义被反向实现。
      fileIo.utimes(p, now);
      // 只有真的写成功才记节流：失败的那次不该把下一次重试也挡掉
      this.touchedAt.set(trackId, now);
    } catch (e) {
      hilog.warn(DOMAIN, TAG, '刷新访问时间失败 %{public}s: %{public}s', trackId, JSON.stringify(e));
    }
  }

  /**
   * 取消某首正在进行的下载（规格 3.1 / 3.2 / 3.3）：销毁会话 + 丢弃 `.part`，
   * 不留残片、不续传、不留残余状态；下次起播从头判断。
   * 没有进行中的下载时是空操作。
   */
  cancelDownload(trackId: string): void {
    const cancel = this.cancels.get(trackId);
    if (cancel === undefined) { return; }
    hilog.info(DOMAIN, TAG, '取消缓存下载 %{public}s', trackId);
    cancel();
  }

  // ---------------- 缓存面板管理 API（S3 增量 3） ----------------

  /** 播放内核登记"正在播这首"：删除操作必须跳过它 */
  setProtected(trackId: string): void {
    this.protectedId = trackId;
  }

  /** 当前正在播放（受删除保护）的 trackId；空串 = 没有在播 */
  getProtected(): string {
    return this.protectedId;
  }

  /**
   * 配额（**1GB** 常量，UI 显示用）。H-18：旧注释误写 2GB —— 唯一真源是文件头的
   * `QUOTA_BYTES = 1 * 1024 * 1024 * 1024`（规格 6.2 就是 1GB），请勿按注释去「修正」常量。
   */
  quotaBytes(): number {
    return QUOTA_BYTES;
  }

  /** 重新扫盘刷新索引（外部改了文件后调用） */
  rescan(): void {
    this.scan();
  }

  /** 已完整缓存的单条信息（含旁挂曲名）。未命中返回 null */
  private entryOf(trackId: string): CacheEntryInfo | null {
    const p = this.cachedPath(trackId);
    if (p.length === 0) { return null; }
    try {
      const stat = fileIo.statSync(p);
      const meta = this.readMeta(trackId);
      const info: CacheEntryInfo = {
        trackId: trackId,
        path: p,
        bytes: stat.size,
        savedAt: stat.mtime * 1000
      };
      if (meta !== null) {
        info.name = meta.name;
        info.artist = meta.artist;
      }
      return info;
    } catch (e) {
      return null;
    }
  }

  /** 列出全部已完整缓存的曲目（按 savedAt 倒序，最新的在前） */
  listEntries(): CacheEntryInfo[] {
    const out: CacheEntryInfo[] = [];
    if (!this.ready) { return out; }
    const ids: string[] = [];
    this.complete.forEach((path: string, id: string) => { ids.push(id); });
    for (let i = 0; i < ids.length; i++) {
      const info = this.entryOf(ids[i]);
      if (info !== null) { out.push(info); }
    }
    out.sort((a: CacheEntryInfo, b: CacheEntryInfo) => b.savedAt - a.savedAt);
    return out;
  }

  /** 已用字节数（只统计 `.bin` 音频文件，不含旁挂 meta） */
  usedBytes(): number {
    if (!this.ready) { return 0; }
    let total = 0;
    try {
      const names: string[] = fileIo.listFileSync(this.dir);
      for (let i = 0; i < names.length; i++) {
        if (!names[i].endsWith('.bin')) { continue; }
        try {
          total += fileIo.statSync(this.dir + '/' + names[i]).size;
        } catch (e) {
          // 单文件 stat 失败不影响总量统计
        }
      }
    } catch (e) {
      return 0;
    }
    return total;
  }

  /**
   * 删除单条缓存。返回 false = 正在被播放占用或删除失败。
   * 删除后同步刷新 `complete` 索引，避免 `isCached` 仍返回 true。
   */
  remove(trackId: string): boolean {
    if (!this.ready) { return false; }
    if (trackId.length === 0) { return false; }
    if (trackId === this.protectedId) {
      hilog.info(DOMAIN, TAG, '缓存删除被跳过（正在播放）: %{public}s', trackId);
      return false;
    }
    const p = this.cachedPath(trackId);
    if (p.length === 0) { return false; }
    try {
      fileIo.unlinkSync(p);
    } catch (e) {
      hilog.warn(DOMAIN, TAG, '缓存删除失败 %{public}s: %{public}s', trackId, JSON.stringify(e));
      return false;
    }
    this.complete.delete(trackId);
    this.touchedAt.delete(trackId);
    this.deleteMeta(trackId);
    hilog.info(DOMAIN, TAG, '已删除缓存 %{public}s', trackId);
    return true;
  }

  /** 清空全部缓存（跳过正在播放那首）。返回实际删除条数 */
  clearAll(): number {
    if (!this.ready) { return 0; }
    const ids: string[] = [];
    this.complete.forEach((path: string, id: string) => { ids.push(id); });
    let count = 0;
    for (let i = 0; i < ids.length; i++) {
      if (this.remove(ids[i])) { count += 1; }
    }
    hilog.info(DOMAIN, TAG, '清空缓存完成，删除 %{public}d 条', count);
    return count;
  }

  // ---------------- 旁挂曲名文件 ----------------

  private metaPathOf(trackId: string): string {
    return this.pathOf(trackId) + '.meta';
  }

  private writeMeta(trackId: string, name: string, artist: string): void {
    // fs 模块没有写文本的快捷函数：开 fd → writeSync → 关 fd
    let file: fileIo.File | null = null;
    try {
      const m: CacheMeta = { name: name, artist: artist };
      file = fileIo.openSync(this.metaPathOf(trackId),
        fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
      fileIo.writeSync(file.fd, JSON.stringify(m));
    } catch (e) {
      // 旁挂写失败只降级为"面板显示 trackId"，不影响缓存本身
      hilog.warn(DOMAIN, TAG, '旁挂曲名写入失败 %{public}s: %{public}s', trackId, JSON.stringify(e));
    } finally {
      if (file !== null) {
        try {
          fileIo.closeSync(file);
        } catch (e) {
          // ignore
        }
      }
    }
  }

  private readMeta(trackId: string): CacheMeta | null {
    try {
      const p = this.metaPathOf(trackId);
      if (!fileIo.accessSync(p)) { return null; }
      const text = fileIo.readTextSync(p);
      if (text.length === 0) { return null; }
      return JSON.parse(text) as CacheMeta;
    } catch (e) {
      return null;
    }
  }

  private deleteMeta(trackId: string): void {
    try {
      const p = this.metaPathOf(trackId);
      if (fileIo.accessSync(p)) {
        fileIo.unlinkSync(p);
      }
    } catch (e) {
      // 旁挂清理失败无须处理
    }
  }

  /**
   * 确保这首歌在缓存里。**不阻塞播放**：起个流式下载就返回，
   * 播放在线流的同时把字节落到 filesDir，下完登记为可离线。
   * `name`/`artist` 供缓存页统计旁挂（下载完成时落 `.meta`）。**不记音质**（规格 6.4/7.2）。
   *
   * `http.requestInStream` 通道（第 ⑩ 条）：无系统通知、后台静默；
   * 分块写到 `<id>.bin.part`，流结束按**字节完整性**判定（规格 5.1/5.2/5.3）后改名登记。
   *
   * `streamUrl` 由调用方决定，且**只能是本曲 CDN 直链**（规格 4.1/4.2：绝不用 /api/stream 代理地址）：
   * 这里是**发起瞬间一次性发出**的请求，URL 内的短期令牌/签名只要此刻有效即可 —— 本方法不解析、
   * 不保存、不缓存 URL，也不做任何「令牌是否过期」的假设，因此令牌过期不会让已落盘的缓存失效。
   * `headers` 与直链配套（如 B 站需要 Referer/UA），空对象表示不加任何自定义头。
   *
   * 终止（规格 3.1/3.2/3.3）：调用方切歌/播完/停止时调 `cancelDownload`——销毁会话并删 `.part`。
   */
  ensureDownload(trackId: string, streamUrl: string, name: string, artist: string,
    headers: Record<string, string>): void {
    if (!this.ready || this.isCached(trackId) || this.downloading.has(trackId)) { return; }
    this.downloading.add(trackId);
    const target = this.pathOf(trackId);
    const tmp = target + '.part';

    (async () => {
      const session = http.createHttp();
      let file: fileIo.File | null = null;
      let settled = false;
      /** 已收字节数（规格 5.1：有 Content-Length 时必须与之逐字节相等） */
      let received = 0;
      /** 响应头里的 Content-Length；-1 = 没有（分块传输，规格 5.2 以 dataEnd 为准） */
      let contentLength = -1;
      const cleanup = (): void => {
        try {
          session.destroy();
        } catch (e) {
          // 会话已释放无须处理
        }
        if (file !== null) {
          try {
            fileIo.closeSync(file);
          } catch (e) {
            // fd 已关无须处理
          }
          file = null;
        }
      };
      const settle = (ok: boolean): void => {
        if (settled) { return; }
        settled = true;
        this.downloading.delete(trackId);
        this.cancels.delete(trackId);
        cleanup();
        if (!ok) {
          try {
            if (fileIo.accessSync(tmp)) {
              fileIo.unlinkSync(tmp);
            }
          } catch (e) {
            // 残片清理失败不影响主流程
          }
          hilog.warn(DOMAIN, TAG, '缓存下载失败 %{public}s', trackId);
          return;
        }
        try {
          fileIo.renameSync(tmp, target);
        } catch (e) {
          hilog.warn(DOMAIN, TAG, '缓存改名失败 %{public}s: %{public}s', trackId, JSON.stringify(e));
          try {
            if (fileIo.accessSync(tmp)) {
              fileIo.unlinkSync(tmp);
            }
          } catch (err) {
            // ignore
          }
          return;
        }
        this.complete.set(trackId, target);
        this.writeMeta(trackId, name, artist);
        hilog.info(DOMAIN, TAG, '缓存完成 %{public}s', trackId);
        this.enforceQuota();
      };
      // 终止语义入口（规格 3.1/3.2/3.3）：cancelDownload(trackId) 走 settle(false)，
      // 销毁会话 + unlink `.part`，不留残片、不续传
      this.cancels.set(trackId, (): void => { settle(false); });
      try {
        try {
          if (fileIo.accessSync(tmp)) {
            fileIo.unlinkSync(tmp);
          }
        } catch (e) {
          // 旧残片清不掉不致命，继续写
        }
        file = fileIo.openSync(tmp,
          fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
        /**
         * 流式落盘：**同步 writeSync**（H-21 评估后保留，故意不改异步）。
         *
         * 已知代价：快 CDN 下回调频率高，同步写占用主线程，理论上可能掉帧（洛雪式实现同样如此，
         * 规格未要求规避）。评估过改成异步 `fileIo.write`，但会**引入真时序问题**，故不动：
         *   1) `received` 是完整性判据的一部分（isComplete：落盘字节必须等于 received）——
         *      改成异步后必须在 dataEnd 前 await 写完队列，否则尾块没落盘就判「不完整」，
         *      把好文件删掉；
         *   2) 异步写不保证顺序，需要自建串行写队列 + 失败回压，出错还要能取消 settle，
         *      等于在下载状态机上再叠一层状态机；
         *   3) settle(false) 会 destroy 会话并 unlink .part，队列里未落地的写必须一起取消，
         *      否则写进已删文件（fd 有效但路径没了）。
         * 结论：留待真机掉帧实证后再做（届时按「写队列 + dataEnd await drain」整体改）。
         */
        session.on('dataReceive', (chunk: ArrayBuffer) => {
          if (file !== null) {
            fileIo.writeSync(file.fd, chunk);
            received += chunk.byteLength;
          }
        });
        // Content-Length 只在响应头里出现；拿不到（分块传输 / 该事件不可用）就走规格 5.2 的
        // dataEnd 判定 —— 注册失败绝不能连累下载本身，因此单独 try/catch
        try {
          session.on('headersReceive', (header: Object) => {
            contentLength = this.pickContentLength(header);
          });
        } catch (e) {
          hilog.warn(DOMAIN, TAG, 'headersReceive 注册失败，按「无 Content-Length」处理');
        }
        session.on('dataEnd', () => {
          // 流正常结束 → 按**字节完整性**立判（规格 5.1/5.2/5.3）：不再拿「>32KB」当完整性
          settle(this.isComplete(tmp, received, contentLength));
        });
        // requestInStream 的 Promise 解析值 = HTTP 状态码（number），不是 HttpResponse
        const opts: http.HttpRequestOptions = {
          method: http.RequestMethod.GET,
          connectTimeout: 15000,
          readTimeout: 60000
        };
        // 直链要求鉴权头（B 站等）才肯放行；空对象时不加 header 键，
        // 保证其它音源请求与原行为完全一致
        if (Object.keys(headers).length > 0) {
          opts.header = headers;
        }
        const code: number = await session.requestInStream(streamUrl, opts);
        // H-20：**206（Partial Content）也是成功**。部分 CDN 对带 Referer/Range 的请求回 206，
        // 旧写法 `code !== 200` 会把已经下完整的整首歌判成失败并删掉 .part（白下 + 永远缓存不上）。
        // 真失败（4xx/5xx）仍由 settle(false) 收口；实际码一律记日志，方便按 CDN 排障。
        if (code === 200 || code === 206) {
          if (code === 206) {
            hilog.info(DOMAIN, TAG, '缓存下载 HTTP 206 Partial Content，按成功处理 %{public}s', trackId);
          }
        } else {
          hilog.warn(DOMAIN, TAG, '缓存下载 HTTP %{public}d，按失败处理 %{public}s', code, trackId);
          settle(false);
        }
      } catch (e) {
        settle(false);
      }
    })();
  }

  /**
   * 完整性判定（规格 5.1 / 5.2 / 5.3）：
   *   · 有 Content-Length：落盘字节数必须**等于**它，差一个字节都不算完整；
   *   · 没有 Content-Length：以 dataEnd（流正常结束）为完整；
   *   · 额外保留「明显过小 = 残片」兜底（MIN_VALID_BYTES）——它只挡半截小文件，**不是**判据本身。
   * 任一不满足 → 调用方 settle(false)：丢弃、不留残片、不写缓存索引（5.3）。
   */
  private isComplete(tmp: string, received: number, contentLength: number): boolean {
    let size = -1;
    try {
      size = fileIo.statSync(tmp).size;
    } catch (e) {
      return false;
    }
    // 兜底：明显过小的一定是残片（scan 同口径）
    if (size <= MIN_VALID_BYTES) { return false; }
    // 写盘字节必须与收到的字节一致（写失败 = 残片）
    if (size !== received) { return false; }
    // 有 Content-Length 就逐字节比（5.1）；没有则以 dataEnd 正常结束为准（5.2）
    if (contentLength > 0) { return size === contentLength; }
    return true;
  }

  /**
   * 从 `headersReceive` 给的响应头里取 Content-Length（键名大小写不定）；取不到返回 -1。
   * 只服务规格 5.1 的字节比对：解析失败一律当「没有长度」→ 退回 5.2 的 dataEnd 判定。
   */
  private pickContentLength(header: Object): number {
    try {
      const text = JSON.stringify(header);
      const m = /"content-length"\s*:\s*"?(\d+)/i.exec(text);
      if (m === null) { return -1; }
      const n: number = Number(m[1]);
      return n > 0 ? n : -1;
    } catch (e) {
      return -1;
    }
  }

  /**
   * 统计 + 超配额按最久未访问淘汰（规格 6.2 配额 1GB / 6.3 最久未访问优先）。
   * 受保护 trackId（正在 fd:// 播放）一律跳过；跳过后仍超额就保留超额并记 warn。
   */
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
      let skippedProtected = false;
      for (let i = 0; i < entries.length && total > QUOTA_BYTES; i++) {
        const e = entries[i];
        // 正在 fd:// 播放的那份绝不淘汰：句柄占用中删掉 = 立刻断播。
        // 与 remove() 同一口径，宁可留着超额也不冒断播风险（超额在下面记 warn）。
        if (e.trackId === this.protectedId) {
          skippedProtected = true;
          continue;
        }
        try {
          fileIo.unlinkSync(e.path);
          this.complete.delete(e.trackId);
          this.touchedAt.delete(e.trackId);
          this.deleteMeta(e.trackId);
          total -= e.bytes;
          hilog.info(DOMAIN, TAG, '淘汰缓存 %{public}s', e.trackId);
        } catch (err) {
          hilog.warn(DOMAIN, TAG, '淘汰失败: %{public}s', JSON.stringify(err));
        }
      }
      if (total > QUOTA_BYTES) {
        // 允许保留超额：只可能是「可淘汰的只剩在播那份」或删文件失败，
        // 为满足配额强删在播文件是本末倒置
        hilog.warn(DOMAIN, TAG, '配额未压回（跳过在播缓存=%{public}s），仍超额 %{public}d 字节',
          skippedProtected ? '是' : '否', total - QUOTA_BYTES);
      }
    } catch (e) {
      hilog.error(DOMAIN, TAG, '配额检查失败: %{public}s', JSON.stringify(e));
    }
  }
}
