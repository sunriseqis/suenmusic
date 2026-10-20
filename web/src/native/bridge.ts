/**
 * 原生音频桥：把 Media3 播放器包装成 store 认识的 `<audio>` 兼容面。
 *
 * 设计目标：player store 的解析/重试/进度上报逻辑**零改动**——它继续用
 * `el.src / el.play() / el.currentTime / addEventListener('ended')` 这套
 * HTMLMediaElement 接口，桥在背后转发给原生 Media3 播放器。
 *
 * 队列归属（v1 约定）：
 *   - 原生持有**整条队列**（通知栏/锁屏能显示曲目列表），但开启
 *     pauseAtEndOfMediaItems：每首歌播完即暂停，不自动接续
 *   - "播完怎么办"仍由 store 的 advance() 决定（单曲循环/随机/顺序全在
 *     Web 侧），桥在收到"到末尾"事件时发 `ended`，store 走完自己的逻辑后
 *     设置新的 el.src，桥再 seekToIndex 到对应曲目
 *     —— 这样锁屏切歌、UI 切歌、自动接续三条路都收敛到同一个决策点
 *
 * 缓存 key 说明（离线 L1 预留）：流地址带时效签名，SimpleCache 若按 URL 做
 * key 会随签名轮换全部失效 —— 所以桥给原生层传的是曲目 id（稳定），
 * 原生层以 id 作为缓存键（见 SuenAudioService 的注释）。
 */
import { SuenAudio, isNativeAudio, type NativeTrack, type NativeTrackChange } from './audio';
export { isNativeAudio };
import { http } from '@/api/client.ts';
import { onNetworkEnvironmentChanged } from '@/api/servers.ts';
import type { Track } from '@/api/types.ts';

interface QueueEntry {
  id: string;
  /** 曲目元数据时长（毫秒）。优先于 ExoPlayer 对流式音频的估算 */
  durationMs: number;
}

/** 单例：同一时刻只有一个桥在桥接原生播放器 */
let active: NativeAudioBridge | null = null;
let listenersRegistered = false;

/** 上次成功使用的流会话（baseUrl + token），离线发队列时兜底用 */
const STREAM_SESSION_KEY = 'suenmusic.streamSession';

function readStreamSession(): { baseUrl: string; token: string } | null {
  try {
    const raw = localStorage.getItem(STREAM_SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as { baseUrl?: unknown; token?: unknown };
    if (typeof s.baseUrl !== 'string' || typeof s.token !== 'string') return null;
    return { baseUrl: s.baseUrl, token: s.token };
  } catch {
    return null;
  }
}

export class NativeAudioBridge extends EventTarget {
  private srcField = '';
  preload = 'none';
  crossOrigin: string | null = null;
  dataset: Record<string, string> = {};
  volume = 1;
  muted = false;
  error: unknown = null;

  private baseUrl = '';
  private items: QueueEntry[] = [];
  /**
   * 服务端给的真实时长（ms），按 trackId 存。
   *
   * 队列里带的是 Q 音元数据时长，锚定到时长不同的视频后它就是错的 ——
   * store 探测到真实时长后写进这里，进度条才对得上实际播放内容。
   */
  private knownDurationMs = new Map<string, number>();
  private trackId: string | null = null;
  private pendingIndex: number | null = null;
  private durationSec = 0;
  private currentSec = 0;
  private pausedFlag = true;
  private metadataEmitted = false;
  /** 原生队列的当前索引（用于识别"原生自己接续了下一首"） */
  private nativeIndex = -1;
  /** 原生接续回调：由 store 注入，参数是切到的曲目 id */
  private onAdvance: ((trackId: string) => void) | null = null;

  constructor(baseUrl: string) {
    super();
    if (active && active !== this) active.detach();
    active = this;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.registerNativeListeners();
  }

  /** 元素兼容面：store 只用这些 */
  get duration() {
    return this.durationSec > 0 ? this.durationSec : NaN;
  }

  get currentTime() {
    return this.currentSec;
  }

  set currentTime(sec: number) {
    this.currentSec = sec;
    void SuenAudio.seek({ positionMs: Math.round(sec * 1000) }).catch(() => {});
  }

  get paused() {
    return this.pausedFlag;
  }

  get src() {
    return this.srcField;
  }

  set src(v: string) {
    this.srcField = v;
    this.trackId = this.extractTrackId(v);
    this.pendingIndex = this.trackId ? this.indexOf(this.trackId) : null;
    this.metadataEmitted = false;
    this.durationSec = 0;
    this.currentSec = 0;
  }

  load(): void {
    // 装载 = 定位到待播曲目（不出声：出声一律由 play() 负责，
    // 否则恢复上次会话时会"打开 App 就自己响"）
    const idx = this.pendingIndex;
    // ⚠️ 索引必须在原生队列范围内：越界会让 MediaController.seekTo 抛
    // IllegalArgumentException 直接崩掉应用（实测踩过）。这里只做防御，
    // 真正的保障是 store 在改动队列时调用 syncNativeQueue。
    if (idx !== null && idx >= 0 && idx < this.items.length) {
      void SuenAudio.seekToIndex({ index: idx, autoplay: false, force: true }).catch(() => {});
    }
  }

  removeAttribute(name: string): void {
    if (name === 'src') {
      this.src = '';
      this.trackId = null;
      this.pendingIndex = null;
      this.metadataEmitted = false;
    }
  }

  async play(): Promise<void> {
    const idx = this.pendingIndex;
    this.pendingIndex = null;
    /**
     * 只在"原生不在这个条目上"时才定位。
     *
     * 恢复会话后原生已经就位在那首（还带着续播位置），这里再 seekToIndex
     * 会把位置归零 —— 真机报障："重开后位置和歌曲都对，一点播放就从头开始"。
     * nativeIndex 由 progress 心跳与 trackChange 持续校准，可信。
     */
    if (idx !== null && idx >= 0 && idx < this.items.length && idx !== this.nativeIndex) {
      await SuenAudio.seekToIndex({ index: idx }).catch(() => {});
    }
    this.pausedFlag = false;
    await SuenAudio.play().catch(() => {});
  }

  pause(): void {
    this.pausedFlag = true;
    void SuenAudio.pause().catch(() => {});
  }

  /** 记录服务端探测到的真实时长（覆盖队列里的 Q 音元数据），并立刻通知 UI */
  setKnownDuration(trackId: string, durationMs: number): void {
    if (!trackId || !(durationMs > 0)) return;
    this.knownDurationMs.set(trackId, durationMs);
    this.durationSec = durationMs / 1000;
    this.metadataEmitted = false;
    this.dispatchEvent(new Event('durationchange'));
  }

  /**
   * 硬重载本条目的音源（换音源后用）。
   *
   * 为什么必须存在：原生路径下 `set src` 只用来识别 trackId，URL 不进播放器；
   * 而 ExoPlayer 的磁盘缓存键是曲目 id、内存缓冲也不受 seek 影响 ——
   * 只改 src / 只 seekToIndex 都会继续放旧音源。这条走原生的 stop()+重建条目。
   */
  async reloadSource(trackId: string, positionMs = 0): Promise<void> {
    const idx = this.indexOf(trackId);
    if (idx === null || idx < 0) return;
    // 位置与元数据状态跟着重置：重载后会重新走一遍 loadedmetadata/progress
    this.currentSec = positionMs / 1000;
    this.metadataEmitted = false;
    this.pendingIndex = null;
    await SuenAudio.reloadCurrent({ index: idx, positionMs, autoplay: true }).catch(() => {});
  }

  /** store 的 playQueue 调用：把整条队列交给原生（含流会话令牌） */
  async setQueueFromTracks(
    tracks: Track[],
    startIndex: number,
    startPositionMs = 0,
    autoplay = true,
    tailOnly = false
  ): Promise<void> {
    const toNative = (t: Track): NativeTrack => ({
      id: t.id,
      title: t.name,
      artist: (t.ar ?? []).map((a: { name?: string }) => a.name).filter(Boolean).join(' / '),
      album: t.al?.name,
      coverUrl: t.al?.picUrl,
      durationMs: t.dt || 0,
    });
    // tailOnly：只把 [startIndex, 队尾) 这一段交给原生替换，正在播的那首不动
    const items: NativeTrack[] = (tailOnly ? tracks.slice(startIndex) : tracks).map(toNative);

    /**
     * 流会话令牌：优先向服务端要新的；拿不到（离线/弱网）就退回上次存的那份。
     *
     * 为什么离线也要能发队列：断网时播放走原生缓存（命中就不联网），但原生播放器
     * 组流 URL 要求 baseUrl 非空以定位缓存和代理。服务端单一真相源下，流会话始终
     * 面向服务端流路由 `<baseUrl>/api/stream/<id>?t=<token>`。
     */
    let token: string | null = null;
    try {
      token =
        (await http.get<{ token: string; expiresInMs: number }>('/api/stream/session-token'))
          .token ?? null;
    } catch {
      token = null;
    }

    if (token !== null) {
      // 存一份供下次离线使用（会话令牌有效期 24h）
      try {
        localStorage.setItem(
          STREAM_SESSION_KEY,
          JSON.stringify({ baseUrl: this.baseUrl, token })
        );
      } catch {
        /* ignore */
      }
    } else {
      const last = readStreamSession();
      if (last) {
        if (!this.baseUrl) this.rebindBaseUrl(last.baseUrl);
        token = last.token;
      }
    }

    if (!this.baseUrl) {
      const savedBase = localStorage.getItem('suenmusic.baseUrl');
      if (savedBase) this.rebindBaseUrl(savedBase);
    }

    // 离线/弱网兜底令牌，保持 URL 语法合法
    const effectiveToken = token ?? 'offline';

    // ⚠️ 令牌/基地址这关过了才记 items：失败时 items 不能先动 ——
    // 否则桥以为队列已生效、原生其实没收到，`load()` 会拿越界索引去 seek
    this.items = tracks.map(t => ({ id: t.id, durationMs: t.dt || 0 }));

    await SuenAudio.setQueue({
      baseUrl: this.baseUrl,
      token: effectiveToken,
      items,
      startIndex,
      startPositionMs,
      autoplay,
      tailOnly,
    });
  }

  /**
   * 注入"原生已接续到下一首"的回调。
   *
   * 为什么由原生接续：熄屏后安卓会挂起 WebView 的 JS，Web 端的曲终判定不会执行
   * —— 实测表现为"锁屏不自动续播、解锁后才跳曲"。改由 Media3 自己走队列，
   * Web 只负责把索引同步过来（UI/歌词随之更新）。
   */
  setAdvanceHandler(fn: (trackId: string) => void): void {
    this.onAdvance = fn;
  }

  /** 服务器地址变更时由 store 通知（桥内的流地址拼接依赖它） */
  rebindBaseUrl(baseUrl: string): void {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  /**
   * 记录原生索引；**曲目真的换了**才回调 store。
   *
   * 关键规则：解析出的 trackId 与"当前曲"（`this.trackId`）相同 = 什么都没变，
   * 直接返回。两类事件都靠它挡掉：
   *   - `setQueue` 之后 Media3 必然回一条 trackChange(reason=PLAYLIST_CHANGED)，
   *     那不是切歌，只是我们自己重发队列的回声；
   *   - progress 心跳（每 500ms）里带着的索引，同一首时也不该当切歌。
   * 不挡的后果是 store 的 `syncNativeAdvance` 每次都被调用，把播放位置清成 0、
   * 把"暂停"强行改成"正在播放" —— 实测就是"切模式后进度乱跳"的来源。
   */
  private noteNativeIndex(index: number, id?: string, force = false): void {
    if (!force && index === this.nativeIndex) return;
    const trackId = id ?? this.items[index]?.id;
    if (!trackId) return;
    this.nativeIndex = index;
    if (trackId === this.trackId) return;   // 同一首：位置/播放态都不该被动
    this.trackId = trackId;
    if (!this.onAdvance) return;
    // 当前曲目的时长跟着换，避免 UI 继续显示上一首
    const meta = this.items.find(i => i.id === trackId)?.durationMs ?? 0;
    this.durationSec = meta > 0 ? meta / 1000 : 0;
    this.metadataEmitted = false;
    this.onAdvance(trackId);
  }

  /** 供桥接内部的曲目定位 */
  private indexOf(id: string): number {
    return this.items.findIndex(e => e.id === id);
  }

  private extractTrackId(url: string): string | null {
    const m = /\/api\/stream\/([^/?]+)/.exec(url);
    if (!m || !m[1]) return null;
    return decodeURIComponent(m[1]);
  }

  private detach(): void {
    this.items = [];
  }

  // ---- 原生事件 → DOM 事件 ----

  private registerNativeListeners(): void {
    if (!isNativeAudio || listenersRegistered) return;
    listenersRegistered = true;

    void SuenAudio.addListener('progress', d => {
      if (active !== this) return;
      this.currentSec = d.positionMs / 1000;
      /**
       * 时长优先级：**服务端给的真实时长** > 队列元数据 > ExoPlayer 的估算。
       *
       * 元数据（Q 音）在"锚定到时长不同的视频"时是错的 —— 用户选了 2 分多的音源，
       * 界面却按元数据显示 3 分多，播完直接切歌。所以 store 探测到真实时长后会
       * 通过 setKnownDuration 传进来，这里优先用它。
       * ExoPlayer 的估算只能垫底：它对代理流按码率外推，实测能把 5:46 估成 1:32:21。
       */
      const known = this.knownDurationMs.get(this.trackId ?? '') ?? 0;
      const meta = this.items.find(i => i.id === this.trackId)?.durationMs ?? 0;
      const durSec =
        known > 0
          ? known / 1000
          : meta > 0
            ? meta / 1000
            : d.durationMs > 0
              ? d.durationMs / 1000
              : 0;
      if (durSec > 0 && durSec !== this.durationSec) {
        this.durationSec = durSec;
        this.dispatchEvent(new Event('durationchange'));
        if (!this.metadataEmitted) {
          this.metadataEmitted = true;
          this.dispatchEvent(new Event('loadedmetadata'));
          this.dispatchEvent(new Event('canplay'));
        }
      }
      this.dispatchEvent(new Event('timeupdate'));

      // 索引变化 = 原生自己接续/用户在通知栏切歌 → 通知 store 同步
      this.noteNativeIndex(d.index);
    });

    void SuenAudio.addListener('trackChange', (d: NativeTrackChange) => {
      if (active !== this) return;
      /**
       * reason=3 是 PLAYLIST_CHANGED —— **我们自己**重发/重排队列的回声
       * （setQueue / 尾段重排之后 Media3 必然发一条），不是切歌。
       * 它到达的时机可能早于 `src` 被设置，光靠"同 id 就跳过"挡不住，
       * 所以这里直接按 reason 丢掉：队列顺序与当前索引 Web 端本来就知道。
       */
      if (d.reason === 3) return;
      // AUTO=播完接续、SEEK=锁屏/通知栏切歌 —— 这两种是真切歌，同步索引
      this.noteNativeIndex(d.index, d.id ?? undefined, true);
    });

    void SuenAudio.addListener('state', d => {
      if (active !== this) return;
      this.pausedFlag = !d.playing;
      this.dispatchEvent(new Event(d.playing ? 'play' : 'pause'));
      if (d.playing) this.dispatchEvent(new Event('playing'));
    });

    void SuenAudio.addListener('error', d => {
      if (active !== this) return;
      this.error = d;
      this.dispatchEvent(new Event('error'));
    });

    void SuenAudio.addListener('networkChanged', () => {
      void onNetworkEnvironmentChanged();
    });
  }
}

/** 会话流令牌 + 队列交给原生。播放队列建立时由 store 调用 */
/** 换音源（锚定 / 强制重解析）后的硬重载。非原生路径是空操作 */
export async function reloadNativeSource(trackId: string, positionMs = 0): Promise<void> {
  if (!isNativeAudio || !active) return;
  await active.reloadSource(trackId, positionMs);
}

/**
 * 把服务端探测到的真实时长告诉原生桥（非原生路径是空操作）。
 *
 * 不做这件事的话，锚定到更短/更长的视频后进度条仍按 Q 音元数据画 ——
 * 用户会看到"选了 2 分多的音源，界面还显示 3 分多，播完自动切歌"。
 */
export function setNativeKnownDuration(trackId: string, durationMs: number): void {
  if (!isNativeAudio || !active) return;
  active.setKnownDuration(trackId, durationMs);
}

export async function setNativeQueue(
  tracks: Track[],
  startIndex: number,
  bridge: NativeAudioBridge,
  baseUrl: string,
  startPositionMs = 0,
  autoplay = true,
  tailOnly = false
): Promise<void> {
  bridge.rebindBaseUrl(baseUrl);
  await bridge.setQueueFromTracks(tracks, startIndex, startPositionMs, autoplay, tailOnly);
}

