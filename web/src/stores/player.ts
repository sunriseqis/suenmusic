/**
 * 播放器 store。
 *
 * 落实 PLAN.md 5.2 的全部约定，四条最容易做错的地方在这里集中说明：
 *
 * 1. **`streamUrl` 绝不缓存**。它带签名时效，过期就 403。本地只记它的
 *    签发时刻与 TTL，一旦过期就重新解析。
 * 2. **403 / 404 要自愈**：用 `force=1` 重新解析，**恢复原播放位置**后重设 `src`。
 *    服务端在流代理层也会兜底重解析一次，但客户端这层是必要的 ——
 *    令牌过期发生在流代理之前，请求根本到不了那里。
 * 3. **总时长以流的 `Content-Range` 为准**。曲目 `dt` 来自 QQ，
 *    而实际播的是 B 站音源，两者经常不一致（官方 MV 常有 5–8s 前奏）。
 * 4. **续播只属于"恢复上次会话"，不属于"选一首歌"**。用户主动点播放一律从头 ——
 *    播到一半切走、再切回来，期望的是重听，不是接上刚才那句；只有刷新页面 /
 *    重开应用时才把上次那首从原位置摆回来（见 `restoreSession`）。
 *    播放中节流上报，上报端点是 `/api/history`，不是 `/api/history/progress`（后者是批量读）。
 */

import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import * as playbackApi from '@/api/playback.ts';
import { ApiError, onBaseUrlChanged } from '@/api/client.ts';
import {
  NativeAudioBridge,
  isNativeAudio,
  reloadNativeSource,
  setNativeKnownDuration,
  setNativeQueue,
} from '@/native/bridge.ts';
import { SuenAudio } from '@/native/audio.ts';
import { getBaseUrl } from '@/api/client.ts';
import { useUiStore } from '@/stores/ui.ts';
import { useFavoritesStore } from '@/stores/favorites.ts';
import type { Track } from '@/api/types.ts';
import { coverUrl, artistNames } from '@/utils/format.ts';

declare global {
  interface Window {
    SuenHarmony?: {
      updateMediaMetadata(metaJson: string): void;
      updatePlaybackState(stateJson: string): void;
      updateLyric?(lyricJson: string): void;
      updateFavorite?(favJson: string): void;
      getAppVersion?(): string;
      openInBrowser?(url: string): boolean;
      isNativePlatform?(): boolean;
      getPlatform?(): string;
    };
    __suenAudioControl?: {
      play: () => void;
      pause: () => void;
      stop?: () => void;
      toggle?: () => void;
      toggleFavorite?: () => Promise<boolean>;
      next: () => void;
      prev: () => void;
      seek: (targetMs: number) => void;
    };
  }
}

function notifyNetworkError(msg = '当前网络连接失败，已暂停播放'): void {
  try {
    const ui = useUiStore();
    ui.err(msg);
  } catch {
    /* ignore */
  }
}

/** 播放中每隔多久上报一次进度。15s 是"断网丢得不多"与"请求不频繁"的折中 */
const REPORT_INTERVAL_MS = 15_000;

/** 续播位置低于这个值就从头播 —— 上次只听了 3 秒，没必要续 */
const RESUME_MIN_MS = 5_000;

/** 距结尾不足这个值也不续播，否则一进来就"播完了" */
const RESUME_TAIL_GUARD_MS = 5_000;

/**
 * 上次播放会话的存储键。
 *
 * 只存"队列 + 播到第几首"，**不存位置** —— 进度以服务端 `/api/history` 为准，
 * 本地再存一份迟早会与之打架（比如在另一台设备上听得更久）。
 */
const SESSION_KEY = 'suenmusic.lastSession';

/** 快照超过这个时长就不再恢复 —— 隔天打开时突然响起昨天的歌很唐突 */
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// -------------------------------------------------------------------------
// 播放模式（五态）
// -------------------------------------------------------------------------

export type PlaybackMode = 'order' | 'shuffle' | 'repeat-one' | 'list-loop' | 'shuffle-once';

const MODE_KEY = 'suenmusic.playMode';

const MODES: readonly PlaybackMode[] = [
  'order',
  'shuffle',
  'repeat-one',
  'list-loop',
  'shuffle-once',
];

/** 各模式的中文标签，供播放条按钮的 aria-label / title 使用 */
export const PLAYBACK_MODE_LABEL: Record<PlaybackMode, string> = {
  order: '顺序播放',
  shuffle: '随机播放',
  'repeat-one': '单曲循环',
  'list-loop': '列表循环',
  'shuffle-once': '随机不重复',
};

/** 模式 → 图标名。注意 list-loop 的图标叫 mode-loop（没有 mode-list-loop） */
export const PLAYBACK_MODE_ICON: Record<PlaybackMode, PlaybackIconName> = {
  order: 'mode-order',
  shuffle: 'mode-shuffle',
  'repeat-one': 'mode-repeat-one',
  'list-loop': 'mode-loop',
  'shuffle-once': 'mode-shuffle-once',
};

/** 播放模式相关的图标名子集（从 NeuIcon 的 IconName 里挑出来的） */
export type PlaybackIconName =
  | 'mode-order'
  | 'mode-loop'
  | 'mode-repeat-one'
  | 'mode-shuffle'
  | 'mode-shuffle-once';

function readMode(): PlaybackMode {
  try {
    const raw = localStorage.getItem(MODE_KEY);
    if (raw && (MODES as readonly string[]).includes(raw)) return raw as PlaybackMode;
  } catch {
    /* ignore */
  }
  return 'order';
}

export const usePlayerStore = defineStore('player', () => {
  // -------------------------------------------------------------------------
  // 状态
  // -------------------------------------------------------------------------

  const queue = ref<Track[]>([]);
  const index = ref(-1);
  const playing = ref(false);
  const loading = ref(false);

  /**
   * 队列的**原始列表顺序**（曲目 id）。
   *
   * 随机播放是"就地打乱 queue 本身"，所以队列顺序会丢失原始顺序；退出随机
   * 播放时要把它摆回去（真机报障："切随机再切任何模式队列都是乱的"）。
   * 只在**建立队列**时写入（playQueue / playTrack / 恢复会话），随快照落盘。
   * 不进响应式：没有任何界面读它。
   */
  let sourceOrderIds: string[] = [];

  /** 当前播放位置与总时长（毫秒）。总时长优先取流响应，见 probeDuration */
  const positionMs = ref(0);
  const durationMs = ref(0);

  // ---- 音量（localStorage 持久化，跨会话保持） ----

  const VOLUME_KEY = 'suenmusic.volume';

  function readVolume(): number {
    try {
      const raw = localStorage.getItem(VOLUME_KEY);
      const n = raw === null ? NaN : Number(raw);
      if (Number.isFinite(n) && n >= 0 && n <= 1) return n;
    } catch {
      /* ignore */
    }
    return 0.9;
  }

  function saveVolume(): void {
    try {
      localStorage.setItem(VOLUME_KEY, String(volume.value));
    } catch {
      /* ignore */
    }
  }

  const volume = ref(readVolume());
  const muted = ref(false);

  /** 播放模式。持久化 localStorage，跨会话保持 */
  const mode = ref<PlaybackMode>(readMode());

  /** 当前音源来源（resolve 响应的 source）。播放条/详情页的音源角标用它 */
  const currentSource = ref<'bilibili' | 'netease' | null>(null);
  /**
   * 上一行那个 source 属于哪首曲目。
   *
   * currentSource 在换曲时不会立刻清空（要等新流解析成功才覆盖），
   * 只凭它判断会把这句"当前音源"指到上一首上。锚定弹窗靠这个 id 对齐，
   * 不是同一首就如实显示"未解析"。
   */
  const currentSourceTrackId = ref<string | null>(null);

  /** 最近一次失败原因，直接展示给用户（服务端已写好中文） */
  const errorMessage = ref<string | null>(null);
  /** 正在 `force=1` 重解析，界面上可以显示"正在重新匹配音源" */
  const resolving = ref(false);

  /**
   * 待锚定曲目（非 null = 锚定弹窗打开）。
   *
   * 解析失败（低置信 / 无候选 / 风控）时自动置上，由全局的 AnchorDialog
   * 渲染：用户搜 B 站候选 → 试听 → 锚定入库，之后永远可播。
   */
  const anchorCandidate = ref<Track | null>(null);

  /**
   * 顶栏状态文案（用户拍板）：播放→"正在播放"，暂停→"已停止"，
   * 网络/出错→直接显示原因（"当前无网络" / "当前网络连接失败，请稍后再试"）。
   */
  const headStatus = computed(() => {
    if (errorMessage.value) return errorMessage.value;
    return playing.value ? '正在播放' : '已停止';
  });

  const currentTrack = computed<Track | null>(() =>
    index.value >= 0 && index.value < queue.value.length ? (queue.value[index.value] ?? null) : null
  );
  const hasNext = computed(() => index.value >= 0 && index.value < queue.value.length - 1);
  const hasPrev = computed(() => index.value > 0);

  /** 进度百分比，0–100。总时长未知时给 0，滑块保持可用（拖了会重新解析） */
  const progressPercent = computed(() =>
    durationMs.value > 0
      ? Math.min(100, Math.max(0, (positionMs.value / durationMs.value) * 100))
      : 0
  );

  // -------------------------------------------------------------------------
  // audio 元素
  // -------------------------------------------------------------------------

  /**
   * 刻意用普通变量而不是 `ref`：`<audio>` 是很重且有内部状态的对象，
   * 把它塞进 Vue 的响应式代理只会带来无谓的开销与难以排查的怪异行为。
   */
  let audio: HTMLAudioElement | null = null;

  /** 当前 `src` 对应的 streamUrl（已拼基地址）。仅用于比对，不作为缓存使用 */
  let currentStreamUrl: string | null = null;
  /** 服务端返回的原始相对路径，调试与界面展示用 */
  let currentStreamUrlRaw: string | null = null;
  /** 当前 streamUrl 的签发时刻与有效期，用于判断"还有没有必要重新解析" */
  let streamIssuedAt = 0;
  let streamTtlMs = 0;
  let streamTrackId: string | null = null;

  /** 本轮播放是否已经因 403/404 重试过一次，避免死循环 */
  let retriedForCurrent = false;

  /**
   * 上一次装载**失败**的曲目 id。
   *
   * 用途：用户重试同一首时，解析要带上 `retry=1` 让服务端无视"缓存的失败结果"。
   * 没有它就会出现真机报障的那种体验 ——「这一首怎么点都播不出来，
   * 换一首再切回来又好了」：失败结果在负缓存周期内把这首歌锁死了。
   * 成功装载后立即清空，避免无谓地绕缓存。
   */
  let lastFailedTrackId: string | null = null;
  /** 重试时希望恢复到的位置 */
  let pendingSeekMs: number | null = null;

  let reportTimer: number | null = null;
  let lastReportedMs = 0;

  /**
   * 把"待恢复的位置"落到 audio 上。
   *
   * 在 `loadedmetadata` / `canplay` / `playing` 三处都会调：流式音频的
   * `seekable` 就绪时机各浏览器不一，多试一次的成本远低于"拖了没反应"。
   * 设置成功即清空，不会重复 seek。
   */
  function applyPendingSeek(): void {
    const el = audio;
    if (!el || pendingSeekMs === null) return;
    const target = pendingSeekMs;
    try {
      el.currentTime = target / 1000;
    } catch {
      // readyState 不足时部分浏览器会抛错，留给下一个事件再试
      return;
    }
    pendingSeekMs = null;
    positionMs.value = target;
  }

  function ensureAudio(): HTMLAudioElement {
    if (audio) return audio;

    // 安卓端：原生 Media3 播放器的兼容桥（锁屏/后台播放/通知栏控制都在原生层）
    if (isNativeAudio) {
      const bridge = new NativeAudioBridge(getBaseUrl());
      // 原生自己接续下一首（熄屏也能工作）→ 这里只把索引同步过来
      bridge.setAdvanceHandler(id => syncNativeAdvance(id));
      attachAudioListeners(bridge as unknown as HTMLAudioElement);
      audio = bridge as unknown as HTMLAudioElement;
      return audio;
    }

    const el = new Audio();
    // 不预加载：解析出来才拉流，避免"点了播放却卡很久"
    el.preload = 'none';
    el.volume = volume.value;
    el.muted = muted.value;
    // 跨域流不需要 CORS 凭据；设成 anonymous 可避免某些浏览器拒绝播放
    el.crossOrigin = 'anonymous';
    // 标记一下，验收脚本与线上排查都靠它定位到这个元素
    el.dataset.suenmusicAudio = '';

    /**
     * 挂进 DOM 是有意为之。
     *
     * 没有 `controls` 属性的 `<audio>` 不渲染任何东西（占 0×0 空间），
     * 所以挂上去不会影响布局；但带来两个实际好处：
     *   1. 浏览器 DevTools 的媒体面板能识别它，排查播放问题时能直接看到状态
     *   2. 自动化验收可以读到 `currentTime` / `duration` / `error`，
     *      否则 `new Audio()` 出来的对象在页面上下文里根本取不到
     * 某些移动端浏览器对不在 DOM 里的媒体元素另有更严格的策略，挂上去也更稳。
     */
    document.body.appendChild(el);

    setupMediaSessionControls();
    attachAudioListeners(el);

    audio = el;
    return el;
  }

  function syncMediaSessionMetadata(track: Track | null, durMs?: number): void {
    if (!track) {
      if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
        try {
          navigator.mediaSession.metadata = null;
        } catch {
          /* ignore */
        }
      }
      return;
    }

    const title = track.name || '未知曲目';
    const artist = artistNames(track.ar);
    const album = track.al?.name || 'SuenMusic';
    const cover = coverUrl(track.al?.picUrl, 500);
    const duration = durMs || durationMs.value || track.dt || 0;

    // 1. 同步至鸿蒙 NEXT 原生 AVSession（原生端自动拉取图片并解码为 PixelMap 显示至播控中心与锁屏）
    if (typeof window !== 'undefined' && window.SuenHarmony?.updateMediaMetadata) {
      try {
        window.SuenHarmony.updateMediaMetadata(
          JSON.stringify({
            assetId: track.id,
            title,
            artist,
            album,
            coverUrl: cover,
            durationMs: duration,
          })
        );
      } catch {
        /* ignore */
      }
    }

    // 2. 同步至 W3C 标准 MediaSession（桌面浏览器、Chrome、Safari 锁屏）
    if (!isNativeAudio && typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title,
          artist,
          album,
          artwork: cover
            ? [
                { src: cover, sizes: '500x500', type: 'image/jpeg' },
                { src: coverUrl(track.al?.picUrl, 150), sizes: '150x150', type: 'image/jpeg' },
              ]
            : [],
        });
      } catch {
        /* ignore */
      }
    }
  }

  function syncMediaSessionPlaybackState(state: 'playing' | 'paused' | 'stopped', posMs?: number, durMs?: number): void {
    const dur = durMs ?? durationMs.value;
    const pos = posMs ?? positionMs.value;

    // 1. 同步至鸿蒙 NEXT 原生 AVSession
    if (typeof window !== 'undefined' && window.SuenHarmony?.updatePlaybackState) {
      try {
        window.SuenHarmony.updatePlaybackState(
          JSON.stringify({
            state,
            positionMs: pos,
            durationMs: dur,
          })
        );
      } catch {
        /* ignore */
      }
    }

    // 2. 同步至 W3C 标准 MediaSession
    if (!isNativeAudio && typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
      try {
        navigator.mediaSession.playbackState = state === 'playing' ? 'playing' : 'paused';
        if (typeof navigator.mediaSession.setPositionState === 'function' && dur > 0) {
          navigator.mediaSession.setPositionState({
            duration: Math.max(0, dur / 1000),
            playbackRate: 1,
            position: Math.min(Math.max(0, pos / 1000), dur / 1000),
          });
        }
      } catch {
        /* ignore */
      }
    }
  }

  function setupMediaSessionControls(): void {
    if (typeof window === 'undefined') return;

    // 供鸿蒙原生 AVSession 反向控制网页播放器
    window.__suenAudioControl = {
      play: () => {
        if (audio && audio.paused) void toggle();
      },
      pause: () => {
        if (audio && !audio.paused) audio.pause();
      },
      stop: () => {
        if (audio && !audio.paused) audio.pause();
      },
      next: () => void advance(false),
      prev: () => void prev(),
      seek: (targetMs: number) => void seek(targetMs),
    };

    if (!isNativeAudio && 'mediaSession' in navigator) {
      try {
        navigator.mediaSession.setActionHandler('play', () => {
          if (audio && audio.paused) void toggle();
        });
        navigator.mediaSession.setActionHandler('pause', () => {
          if (audio && !audio.paused) audio.pause();
        });
        navigator.mediaSession.setActionHandler('previoustrack', () => {
          void prev();
        });
        navigator.mediaSession.setActionHandler('nexttrack', () => {
          void advance(false);
        });
        navigator.mediaSession.setActionHandler('seekto', details => {
          if (details.seekTime !== undefined) {
            void seek(details.seekTime * 1000);
          }
        });
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * 事件订阅：原生桥与 HTMLAudioElement 共用。
   *
   * ⚠️ 原生分支最初漏掉了这一步（监听只挂在 `new Audio()` 的路径里），
   * 后果是 store 收不到原生的进度/时长/播放态事件 —— 播放页进度冻结在 0:00、
   * 时长显示历史脏值，用户看到的就是"播不了 + 时长信息全是错的"（实测报障）。
   */
  function attachAudioListeners(el: HTMLAudioElement): void {
    /**
     * 鸿蒙播控中心的歌词滚动，是靠原生 AVSession 的 playbackState 推算"现在播到哪"。
     * 原来只在 play / pause / ended / loadedmetadata / seek() 这些时刻上报一次，
     * 系统就只能拿"最后一个锚点"自己外推 —— 而 applyPendingSeek()（续播跳转）
     * 这类不经 seek() 的位置变化不会上报，锚点于是 stale，误差随时间累积。
     * 实测症状：锁屏里歌词快 20 秒，而 App 内进度条是对的。
     *
     * 这里按 1 秒节流补一次上报，锚定就不再依赖"上一次上报是什么时候"。
     * 锁屏时 timeupdate 依然会触发（媒体事件不受 JS 定时器节流影响）。
     */
    let lastPosReport = 0;
    /** 本地进度落库的节流。3 秒足够"杀进程后还能接上"，而写一条记录很便宜 */
    let lastLocalPosSave = 0;
    el.addEventListener('timeupdate', () => {
      positionMs.value = Math.round(el.currentTime * 1000);

      /**
       * **本地进度每 3 秒落一次**，不等 15 秒的服务端上报周期。
       *
       * 真机反馈："播了一会儿杀掉重开，续播没了"。原因是进度只随 15 秒的
       * 上报周期保存，杀掉得太早（或在两次上报之间）就什么都没留下。
       * 本地写是 IndexedDB 单条 put，代价可以忽略。
       */
      const cur = currentTrack.value;
      if (cur) {
        const t = Date.now();
        if (t - lastLocalPosSave >= 3_000) {
          lastLocalPosSave = t;
          saveSession();
        }
      }

      if (!playing.value) return;
      const now = Date.now();
      if (now - lastPosReport < 1000) return;
      lastPosReport = now;
      syncMediaSessionPlaybackState('playing', positionMs.value, durationMs.value);
    });

    /**
     * 切到后台 / 页面被回收前，把会话与进度立刻落一次。
     *
     * 安卓从最近任务划掉不保证有回调，但 `visibilitychange` 通常在冻结前会到 ——
     * 有它比只靠 15 秒定时器强。这里不 await，尽力而为。
     */
    const flushLocal = (): void => {
      if (document.visibilityState !== 'hidden') return;
      saveSession();
      void reportProgress(true);
    };
    document.addEventListener('visibilitychange', flushLocal);
    window.addEventListener('pagehide', flushLocal);

    el.addEventListener('durationchange', () => {
      // 浏览器自己解析出的时长。仅在"比已知值更可信"时采用 ——
      // 流式响应下它常常是 Infinity 或 0
      if (Number.isFinite(el.duration) && el.duration > 0) {
        durationMs.value = Math.round(el.duration * 1000);
        syncMediaSessionPlaybackState(playing.value ? 'playing' : 'paused', positionMs.value, durationMs.value);
      }
    });

    el.addEventListener('play', () => {
      playing.value = true;
      startReporting();
      syncMediaSessionPlaybackState('playing', positionMs.value, durationMs.value);
    });

    el.addEventListener('pause', () => {
      playing.value = false;
      stopReporting();
      // 暂停时立刻落一次，避免"听到一半关掉"丢失进度
      saveSession();
      void reportProgress(true);
      syncMediaSessionPlaybackState('paused', positionMs.value, durationMs.value);
    });

    el.addEventListener('ended', () => {
      playing.value = false;
      stopReporting();
      positionMs.value = durationMs.value;
      void reportProgress(true, true);
      syncMediaSessionPlaybackState('stopped', durationMs.value, durationMs.value);
      // 播完自动前进：按播放模式分派（单曲循环重播、循环类绕回、
      // 顺序/随机不重复到头即停），见 advance()
      void advance(true);
    });

    el.addEventListener('waiting', () => {
      loading.value = true;
    });
    // 元数据一到就落位置：比原来在 playing 里设更早，既避免"先出声再跳"，
    // 也让"就位但不自动播放"的恢复会话能拿到正确位置
    el.addEventListener('loadedmetadata', () => {
      applyPendingSeek();
      syncMediaSessionMetadata(currentTrack.value, durationMs.value);
      syncMediaSessionPlaybackState(playing.value ? 'playing' : 'paused', positionMs.value, durationMs.value);
    });
    el.addEventListener('canplay', () => {
      loading.value = false;
      applyPendingSeek();
    });
    el.addEventListener('playing', () => {
      loading.value = false;
      // 兜底：前面两次若因 seekable 未就绪而没设上，这里再试
      applyPendingSeek();
      syncMediaSessionPlaybackState('playing', positionMs.value, durationMs.value);
    });

    el.addEventListener('error', () => {
      void handlePlaybackError();
    });
  }

  // -------------------------------------------------------------------------
  // 音源地址管理
  // -------------------------------------------------------------------------

  /** 当前地址是否还新鲜（留 10s 余量，避免"刚检查完就过期"） */
  function streamUrlFresh(trackId: string): boolean {
    if (!currentStreamUrl || streamTrackId !== trackId) return false;
    if (streamTtlMs <= 0) return false;
    return Date.now() < streamIssuedAt + streamTtlMs - 10_000;
  }

  /**
   * 探测流的真实时长。
   *
   * 用 `Range: bytes=0-0` 发一个"只要 1 字节"的请求，从 `Content-Range`
   * 的斜杠后读总长度。这比等 `<audio>` 自己算出 duration 可靠得多 ——
   * 服务端返回的是 206 + 精确字节数，浏览器算出来的则经常是 Infinity。
   *
   * 顺带还起到了**探活**作用：地址若已失效，这里就会拿到 403/404，
   * 于是可以在真正播放之前就重新解析，用户不会听到一段静默。
   */
  async function probeStream(
    url: string
  ): Promise<{ ok: boolean; status: number; durationMs: number | null }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(url, {
        headers: { Range: 'bytes=0-0' },
        credentials: 'omit',
        signal: controller.signal,
        cache: 'no-store',
      });

      /**
       * 时长只认服务端的 `X-Audio-Duration-Ms`（= 实际匹配到的视频时长，含手动锚点）。
       *
       * ⚠️ 这里曾经把 `Content-Range` 斜杠后的数字**当成毫秒**返回 —— 那是字节总数，
       * 根本不是时长。之所以长期没暴露，是因为原生路径下时长总被队列元数据覆盖；
       * 一旦用户锚定到时长不同的视频（2 分多 vs 元数据 3 分多），错就露出来了。
       */
      const headerMs = Number(res.headers.get('X-Audio-Duration-Ms'));
      const durationMs = Number.isFinite(headerMs) && headerMs > 0 ? headerMs : null;

      // 服务端忽略了 Range 并回 200（整包）时，必须立刻掐断，
      // 否则等于把整个音频预先下载一遍，白白吃掉带宽
      void res.body?.cancel();

      return { ok: res.ok || res.status === 206, status: res.status, durationMs };
    } catch {
      return { ok: false, status: 0, durationMs: null };
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  /**
   * 解析并装载音源，把 `<audio>` 准备好但不自动播放。
   *
   * @param force 传给服务端的 `force=1`，会清掉服务端全部缓存层重新匹配
   * @param keepPositionMs 重解析后要恢复到的位置（403 自愈、拖动时用）
   * @param allowResume 是否允许回落到服务端记录的进度。**默认否** ——
   *   只有恢复上次会话才该为 true，见文件头第 4 条
   */
  let loadSequence = 0;

  async function load(
    track: Track,
    opts: {
      force?: boolean;
      keepPositionMs?: number | null;
      allowResume?: boolean;
      /** true = 这是"自动接续"引发的装载：失败要静默跳过，不弹提示 */
      fromAdvance?: boolean;
      /**
       * true = 用户**显式点**了这首歌（点列表某行 / 跳播）：
       * 离线且没缓存时只提示"当前无网络"，**不跳到别的歌**（用户明确点的就是他想要的那首）。
       */
      noSkip?: boolean;
    } = {}
  ): Promise<boolean> {
    const seq = ++loadSequence;
    const el = ensureAudio();
    loading.value = true;
    errorMessage.value = null;
    pendingSeekMs = opts.keepPositionMs ?? null;

    /**
     * 系统报"离线"时**先试离线缓存**（飞行模式下一次 fetch 要挂十几秒才失败，
     * 用户看到的就是"转半天没反应"）。
     *
     * ⚠️ 但缓存没命中时**必须继续走网络**，不能就地判死 ——
     * `navigator.onLine` 在安卓 WebView 上并不可靠：VPN 建连/切换、网络抖动、
     * 没有 VALIDATED 的网络都会报 false（实测在一台设备上复现过）。
     * 原来这里直接 detach + 返回失败，于是「锚定换源」这条路**必然自锁**：
     * 它前面刚 evictCache 清空了缓存 → 离线兜底必然 miss → 播放器被 stop() 掉
     * 且没装载任何媒体 → 用户之后点播放只是在空播放器上调 play()，什么都不会发生。
     * 真机报障原话：「锚定后彻底卡住，重试多次播放才开始播」。
     */
    if (navigator.onLine === false) {
      const r = await tryLoadFromOfflineCache(track);
      if (seq !== loadSequence) return false;
      if (r === 'played') {
        loading.value = false;
        lastFailureRateLimited = false;
        return true;
      }
      // 未命中：继续往下走正常网络路径，由它（以及它的 catch）给出真实结论
    }

    try {
      // 这一首上次装载失败过 → 让服务端无视那条"缓存的失败"，否则重试等于白试
      const isRetry = lastFailedTrackId === track.id;
      const { result, url } = await playbackApi.resolveStreamUrl(
        track.id,
        opts.force === true,
        isRetry
      );
      if (seq !== loadSequence) return false;

      // 服务端回源补全的完整元数据：队列里的曲目可能来自字段不全的搜索召回行
      // （低置信的歌常只有歌名），缺封面/专辑/歌手时用这份现场补上，
      // 播放页与播放条立刻显示完整信息，不必等刷新
      const full = result.track;
      if (full) {
        if (full.name && full.name.length > (track.name?.length ?? 0)) track.name = full.name;
        if (full.al?.picUrl || full.al?.name) track.al = full.al;
        if (full.ar?.length) track.ar = full.ar;
        if (full.dt && !track.dt) track.dt = full.dt;
      }
      // 封面显示层兜底：曲目没有 Q 音专辑封面时用 B 站视频封面顶上
      if (!track.al?.picUrl && result.coverUrl) {
        track.al = { ...(track.al ?? { id: '', name: '' }), picUrl: result.coverUrl };
      }
      syncMediaSessionMetadata(track, durationMs.value);

      if (!result.ok || !url) {
        // 记下"这首失败了"：用户下次重试同一首时要绕过服务端的失败缓存
        lastFailedTrackId = track.id;
        durationMs.value = track.dt || 0;
        await detachCurrentAudio();
        if (seq !== loadSequence) return false;

        /**
         * 失败分三态（用户拍板）：
         *   1. **上游限速/限流**（服务端可达，但 QQ/B站/网易被限速）→
         *      等一会就能恢复 → 提示"当前网络繁忙，请等待"，并且**停止跳转**
         *      （狂试只会让限速更久，要留时间给上游恢复）
         *   2. 音源不可用 / 搜不到 → 瞬间可知，与服务端不可达**统一呈现"网络连接失败"**
         *      并按同一套链跳下一首继续试
         */
        if (result.rateLimited) {
          lastFailureRateLimited = true;
          errorMessage.value = '当前网络繁忙，请等待';
          return false;
        }
        lastFailureRateLimited = false;
        if (opts.noSkip) {
          errorMessage.value = '网络连接失败';
          // 显式点播失败：给锚定入口，用户可手动关联到别的音源
          if (opts.allowResume !== true) anchorCandidate.value = track;
          return false;
        }
        networkFailStreak += 1;
        if (networkFailStreak >= MAX_NETWORK_FAILS) {
          networkFailStreak = 0;
          errorMessage.value = '网络连接失败，请稍后再试';
          return false;
        }
        errorMessage.value = '当前无网络';
        const advanced = await retryNextTrack();
        if (seq !== loadSequence) return false;
        if (!advanced) {
          networkFailStreak = 0;
          errorMessage.value = '网络连接失败，请稍后再试';
        }
        return advanced;
      }

      const probe = await probeStream(url);
      if (seq !== loadSequence) return false;
      if (!probe.ok) {
        lastFailedTrackId = track.id;
        errorMessage.value =
          probe.status === 403 || probe.status === 404
            ? '音源链接已失效，正在重新匹配'
            : `音源不可用（HTTP ${probe.status}）`;
        return false;
      }

      currentStreamUrl = url;
      currentStreamUrlRaw = result.streamUrl ?? url;
      streamIssuedAt = Date.now();
      streamTtlMs = Math.max(0, result.streamTokenExpiresInSec) * 1000;
      streamTrackId = track.id;
      // 音源角标数据：网易云的歌标红、B 站的歌标粉（用户拍板的约定）
      currentSource.value = result.source ?? 'bilibili';
      currentSourceTrackId.value = track.id;

      // 时长优先级：流的精确时长（服务端 X-Audio-Duration-Ms）> 曲目元数据
      durationMs.value = probe.durationMs ?? (track.dt || 0);
      // 同步给原生桥：队列里带的是 Q 音元数据，锚定到时长不同的视频后它是错的
      if (probe.durationMs) setNativeKnownDuration(track.id, probe.durationMs);

      // 没有显式指定位置、且调用方明确要求续播时，才去问服务端"上次听到哪"。
      // 主动点播放一律从头 —— 播到一半切走再切回来，用户要的是重听。
      if (pendingSeekMs === null && opts.allowResume === true) {
        const resumed = await fetchResumePosition(track.id, durationMs.value);
        if (seq !== loadSequence) return false;
        if (resumed !== null) pendingSeekMs = resumed;
      }

      el.src = url;
      el.load();

      lastFailedTrackId = null;
      return true;
    } catch (e) {
      lastFailedTrackId = track.id;
      if (seq !== loadSequence) return false;
      // 网络不通时还有一条路：这首完整在离线缓存里就能直接播
      const offline = await tryLoadFromOfflineCache(track);
      if (seq !== loadSequence) return false;
      if (offline === 'played') return true;
      const preservePos = opts.keepPositionMs != null;
      await detachCurrentAudio(preservePos);
      if (seq !== loadSequence) return false;
      if (offline === 'uncached' || (e instanceof ApiError && e.isNetworkError)) {
        if (opts.noSkip || preservePos) {
          errorMessage.value = '当前网络连接失败，请稍后再试';
          notifyNetworkError('当前网络连接失败，已暂停播放');
          return false;
        }
        networkFailStreak += 1;
        if (networkFailStreak >= MAX_NETWORK_FAILS) {
          networkFailStreak = 0;
          errorMessage.value = '当前网络连接失败，请稍后再试';
          notifyNetworkError('当前网络连接失败，请稍后再试');
          return false;
        }
        const advanced = await retryNextTrack();
        if (seq !== loadSequence) return false;
        if (!advanced) {
          networkFailStreak = 0;
          errorMessage.value = '当前网络连接失败，请稍后再试';
          notifyNetworkError('当前网络连接失败，请稍后再试');
        } else {
          errorMessage.value = '当前无网络';
        }
        return advanced;
      }
      errorMessage.value =
        e instanceof ApiError ? e.message : '解析音源失败，请稍后重试';
      return false;
    } finally {
      if (seq === loadSequence) {
        loading.value = false;
      }
    }
  }

  /**
   * 装载失败时**停掉上一次的音频**。
   *
   * ⚠️ 不停的话会出现"界面停在新歌、声音还是上一首"的错位（真机报障）：原生
   * 播放器里还挂着上一首（有缓存的）曲目，用户点播放时听到的是旧歌，界面却是新歌。
   * 当 keepPosition 为 true 时（弱网重试），保留本地播放位置以便网络恢复后续播。
   */
  async function detachCurrentAudio(keepPosition = false): Promise<void> {
    const el = audio;
    if (!el) return;
    el.pause();
    el.removeAttribute('src');
    el.load();
    await SuenAudio.stop().catch(() => {});
    if (!keepPosition) {
      positionMs.value = 0;
    }
    lastReportedMs = 0;
  }

  /**
   * 连续"连不上服务端"的次数。
   *
   * 用户拍板的口径：**成功播出一首就清零**（说明网通了），连续 5 次不通才判定
   * "当前网络连接失败"。注意这**不是探测**：就是正常的播放流程 —— 解析请求发不
   * 出去 → 跳下一首继续试。缓存只负责"有缓存走缓存"，不做"去后台找有缓存的歌"
   * 那种事（那是把冗余手段当功能）。
   */
  let networkFailStreak = 0;
  /** 上一次失败是否属于"上游限速"（决定播到一半失败时是提示繁忙还是跳下一首） */
  let lastFailureRateLimited = false;
  const MAX_NETWORK_FAILS = 5;

  /**
   * 解析失败后前进一首继续试（走到队尾不绕回，由失败计数兜底）。
   *
   * @returns 是否成功播出（成功则整条链返回 true）
   */
  async function retryNextTrack(): Promise<boolean> {
    const next = index.value + 1;
    if (next >= queue.value.length) return false;
    index.value = next;
    positionMs.value = 0;
    lastReportedMs = 0;
    return await startCurrent({ fromAdvance: true, autoplay: true });
  }

  /**
   * 离线兜底：解析失败（连不上服务端）时，看这首是否**完整**在离线缓存里。
   *
   * 返回值：
   *   - `'played'`  走缓存装载成功
   *   - `'uncached'` 原生平台但这首还没完整缓存（只播过一半的算不上）
   *   - `'skip'`    压根不适用（浏览器端没有原生缓存这回事）
   *
   * 必须判"完整"：只播到一半的歌离线会卡在缺口上（判定在原生
   * SuenAudioCache.isFullyCached：缓存字节须覆盖索引记录的内容总长）。
   */
  async function tryLoadFromOfflineCache(track: Track): Promise<'played' | 'uncached' | 'skip'> {
    if (!isNativeAudio) return 'skip';
    const { cached } = await SuenAudio.isCached({ id: track.id }).catch(() => ({ cached: false }));
    if (!cached) return 'uncached';
    const el = ensureAudio();
    currentStreamUrl = null;
    currentStreamUrlRaw = null;
    streamIssuedAt = 0;
    streamTtlMs = 0;
    streamTrackId = track.id;
    currentSource.value = null;
    currentSourceTrackId.value = null;
    durationMs.value = track.dt || 0;
    el.src = getBaseUrl().replace(/\/+$/, '') + `/api/stream/${encodeURIComponent(track.id)}`;
    el.load();
    return 'played';
  }

  /**
   * 取续播位置。从未播过时服务端返回 404，这是正常情况，返回 null。
   * 太靠前或太靠后的位置都不续播。
   */
  async function fetchResumePosition(trackId: string, totalMs: number): Promise<number | null> {
    try {
      const p = await playbackApi.fetchProgress(trackId);
      if (!p || !Number.isFinite(p.playedMs)) return null;
      if (p.playedMs < RESUME_MIN_MS) return null;
      if (totalMs > 0 && p.playedMs > totalMs - RESUME_TAIL_GUARD_MS) return null;
      return p.playedMs;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // 播放失败自愈
  // -------------------------------------------------------------------------

  async function handlePlaybackError(): Promise<void> {
    const el = audio;
    const track = currentTrack.value;
    if (!el || !track) return;

    const resumeAt = Math.round(el.currentTime * 1000) || positionMs.value;

    if (retriedForCurrent) {
      retriedForCurrent = false;
      await detachCurrentAudio(true);
      playing.value = false;
      loading.value = false;
      if (lastFailureRateLimited) {
        errorMessage.value = '当前网络繁忙，请等待';
        notifyNetworkError('当前网络繁忙，请等待');
        stopReporting();
        return;
      }
      errorMessage.value = '当前网络连接失败，请稍后再试';
      notifyNetworkError('当前网络连接失败，已暂停播放');
      stopReporting();
      return;
    }

    retriedForCurrent = true;
    resolving.value = true;
    // 服务端在流代理层也会自动重解析一次，这里再显式 force 一次
    // 是为了把"令牌过期"这类到不了流代理的失败也覆盖掉
    const ok = await load(track, { force: true, keepPositionMs: resumeAt });
    resolving.value = false;

    if (ok) {
      try {
        await el.play();
      } catch {
        /* 自动播放策略可能拦截，交给用户手势 */
      }
    }
  }

  // -------------------------------------------------------------------------
  // 进度上报
  // -------------------------------------------------------------------------

  function startReporting(): void {
    if (reportTimer !== null) return;
    reportTimer = window.setInterval(() => {
      // 顺手把快照里的播放位置刷新一下：进程被杀时它是唯一还在本地的进度
      // （服务端那条记录 15s 才写一次，且可能因为各种原因缺失）
      saveSession();
      void reportProgress();
    }, REPORT_INTERVAL_MS);
  }

  function stopReporting(): void {
    if (reportTimer !== null) {
      clearInterval(reportTimer);
      reportTimer = null;
    }
  }

  /**
   * 上报播放进度。
   *
   * 位置没变（比如暂停着发呆）就不发，省掉一堆无意义请求。
   * 上报失败一律吞掉 —— 这只是统计，不该打断播放。
   */
  async function reportProgress(force = false, completed = false): Promise<void> {
    const track = currentTrack.value;
    if (!track) return;

    const ms = positionMs.value;
    if (!force && Math.abs(ms - lastReportedMs) < 3_000) return;
    lastReportedMs = ms;

    try {
      await playbackApi.reportPlay({
        trackId: track.id,
        playedMs: ms,
        durationMs: durationMs.value,
        completed,
        // 顺手带上曲目快照，服务端会写进缓存表 ——
        // 否则历史列表只有 id 没有歌名
        tracks: [track],
      });
    } catch {
      /* 静默失败 */
    }
  }

  // -------------------------------------------------------------------------
  // 对外动作
  // -------------------------------------------------------------------------

  /** 播放单曲。`list` 传入时会把它设为播放队列 */
  /**
   * 播放来源（收藏 / 搜索 / 每日推荐 / 歌单 / 首页）。
   *
   * 设计稿的顶栏写的是「PLAYING FROM · 收藏」—— 用户要知道**这首是从哪来的**，
   * 而不是一句对所有情况都成立的"正在播放"。
   * 按当前路由推断而不是让每个调用点传参：来源就是"用户在哪一屏点的播放"，
   * 路由本身就带着这个信息，多传一个参数只会多一处可能忘掉的地方。
   */
  const origin = ref('首页');
  function detectOrigin(): string {
    const p = typeof window !== 'undefined' ? window.location.pathname : '/';
    if (p.startsWith('/search')) return '搜索';
    if (p.startsWith('/favorites')) return '收藏';
    if (p.startsWith('/daily')) return '每日推荐';
    if (p.startsWith('/collection')) return '歌单';
    return '首页';
  }

  async function playTrack(track: Track, list?: Track[]): Promise<void> {
    origin.value = detectOrigin();
    if (list && list.length > 0) {
      queue.value = list;
      sourceOrderIds = list.map(t => t.id);
      index.value = list.findIndex(t => t.id === track.id);
      if (index.value < 0) {
        queue.value = [track];
        sourceOrderIds = [track.id];
        index.value = 0;
      }
    } else {
      const existing = queue.value.findIndex(t => t.id === track.id);
      if (existing >= 0) {
        index.value = existing;
      } else {
        queue.value = [...queue.value, track];
        // 追加型：原始顺序跟着追加，不能在打乱过的队列上重算
        sourceOrderIds = sourceOrderIds.includes(track.id)
          ? sourceOrderIds
          : [...sourceOrderIds, track.id];
        index.value = queue.value.length - 1;
      }
    }

    /**
     * 随机模式：与 playQueue 同样必须先洗牌。
     *
     * 漏掉这一步的后果是**模式与实际不一致**：列表原顺序当队列用，界面上写着
     * "随机播放"，实际却是从上到下顺序播。洗牌时把刚点的这首固定在队首，
     * 所以"点哪首就先响哪首"没有被破坏。
     */
    if (mode.value === 'shuffle' || mode.value === 'shuffle-once') shuffleWholeQueue(true);
    // ⚠️ 点歌必须显式归零：syncNativeQueue 默认携带当前进度，那是给
    // "同曲重发队列不打断"用的；点新歌时它会把上一首的位置带给下一首，
    // 且每次点击继续继承（真机报障："切歌全部跳到原位置并无限继承"）
    positionMs.value = 0;
    lastReportedMs = 0;
    durationMs.value = track.dt || 0;
    stopReporting();   // 装载完成、真正出声后再由 play 事件重启上报
    await syncNativeQueue({ startPositionMs: 0 });
    // 用户点的就是这一首：离线没缓存时只提示，不跳过
    await startCurrent({ noSkip: true });
  }

  /**
   * 原生自己接续到下一首时的同步。
   *
   * 为什么不是 store 的 advance()：熄屏后 WebView 的 JS 会被挂起，Web 端的
   * 曲终判定根本不执行（实测"锁屏不续播、解锁才跳曲"）。所以改由 Media3 走队列，
   * 这里只负责把 UI 状态对齐——索引按**曲目 id** 反查（原生队列顺序可能被重发
   * 或后续做随机重排，id 才是稳定锚点）。
   */
  function syncNativeAdvance(trackId: string): void {
    const i = queue.value.findIndex(t => t.id === trackId);
    if (i >= 0 && i !== index.value) index.value = i;
    positionMs.value = 0;
    lastReportedMs = 0;
    // 落盘：原生接续发生在熄屏/后台，进程被杀后只有快照能让下次开 App
    // 从"刚刚在听的这首"接着放（真机报障："重开后可能是上一首歌"）
    saveSession();
    const track = currentTrack.value;
    if (track) durationMs.value = track.dt || 0;
    playing.value = true;
    loading.value = false;
    currentStreamUrl = null;   // 新曲目要用新地址，重新解析交给原有重试链路
  }

  /**
   * 原生端专用：把**当前队列**整条交给 Media3（通知栏/锁屏曲目列表）。
   *
   * 所有会改动队列的入口（playQueue / playTrack / restoreSession）都必须调它 ——
   * 否则桥里的曲目表与原生队列不一致，`seekToIndex` 会拿到越界索引（实测崩过一次：
   * 搜索页点单曲走 playTrack，没同步队列 → indexOf 返回 -1 → seekTo(-1)）。
   *
   * @param opts.autoplay 装载后是否立刻出声。**默认 true**；
   *   只有恢复上次会话传 false（打开 App 不该自己响起来，出声交给用户按播放）
   * @param opts.tailOnly 只替换 `[index, 队尾)` 这一段（重排未播部分时用）。
   *   正在播的那首不在替换范围内 → 原生不重新装载 → 切模式不再"卡一下"
   * @param opts.startPositionMs 起播位置，默认用 store 里的当前进度
   */
  async function syncNativeQueue(
    opts: { autoplay?: boolean; tailOnly?: boolean; startPositionMs?: number } = {}
  ): Promise<void> {
    if (!isNativeAudio) return;
    const bridge = ensureAudio() as unknown as NativeAudioBridge;
    const tailOnly = opts.tailOnly === true;
    // tailOnly 时从"当前曲的下一首"开始替换：把正在播的这首留在替换范围之外，
    // 原生才不需要重新装载它（这正是不卡的前提）
    const from = tailOnly ? (index.value >= 0 ? index.value + 1 : 0) : index.value;
    if (tailOnly && from >= queue.value.length) return;   // 没有未播部分，不用发
    // 带上当前播放位置：重发队列（换路径/恢复）时正在听的这首不被打断
    await setNativeQueue(
      queue.value,
      from,
      bridge,
      getBaseUrl(),
      opts.startPositionMs ?? positionMs.value,
      opts.autoplay !== false,
      tailOnly
    );
    // 原生自己接续时要遵守单曲/列表循环（'order'/'shuffle*' 交给原生顺序播放，
    // 前台恢复后 store 的随机逻辑仍会在用户手动切歌时生效）
    const repeat: 'off' | 'one' | 'all' =
      mode.value === 'repeat-one' ? 'one' : mode.value === 'list-loop' ? 'all' : 'off';
    await SuenAudio.setRepeatMode({ mode: repeat }).catch(() => {});
  }

  /** 用整个列表替换队列并从 `startIndex` 开始播 */
  async function playQueue(list: Track[], startIndex = 0): Promise<void> {
    if (list.length === 0) return;
    origin.value = detectOrigin();
    queue.value = list;
    sourceOrderIds = list.map(t => t.id);
    index.value = Math.min(Math.max(startIndex, 0), list.length - 1);
    // 随机模式：开播前先把顺序打乱（"记忆为随机播放"启动时同样生效）
    if (mode.value === 'shuffle' || mode.value === 'shuffle-once') shuffleWholeQueue(true);
    positionMs.value = 0;
    lastReportedMs = 0;
    durationMs.value = queue.value[index.value]?.dt || 0;
    stopReporting();
    await syncNativeQueue({ startPositionMs: 0 });   // 点歌从头
    await startCurrent();
  }

  /**
   * 装载当前队列项，按需开始播放。
   *
   * @param opts.allowResume 允许接上服务端记录的进度。**默认否** ——
   *   只有 `restoreSession`（刷新/重开页面）才该传 true
   * @param opts.autoplay 装载后是否立刻出声。恢复会话时传 false：
   *   一进页面就响既唐突，也多半会被浏览器的自动播放策略拦下
   * @param opts.startPositionMs 直接用这个位置续播（快照里的本地进度），
   *   有值时不再去问服务端的续播记录 —— 服务端那条记录可能缺失或被写坏
   * @returns 音源是否装载成功
   */
  async function startCurrent(
    opts: {
      allowResume?: boolean;
      autoplay?: boolean;
      startPositionMs?: number;
      /** true = 自动接续触发（失败静默跳过） */
      fromAdvance?: boolean;
      /** true = 用户显式点播（失败只提示，不跳走） */
      noSkip?: boolean;
    } = {}
  ): Promise<boolean> {
    const track = currentTrack.value;
    if (!track) return false;

    const el = ensureAudio();
    retriedForCurrent = false;
    pendingSeekMs = null;
    positionMs.value = 0;
    lastReportedMs = 0;
    // 换曲瞬间先落到元数据时长：否则会短暂显示上一首的时长（"脏数据"），
    // 等解析/原生的精确值回来才被覆盖 —— 影响感官（用户报障）
    durationMs.value = track.dt || 0;

    const ok = await load(track, {
      fromAdvance: opts.fromAdvance === true,
      noSkip: opts.noSkip === true,
      allowResume: opts.allowResume === true,
      keepPositionMs:
        opts.startPositionMs !== undefined && opts.startPositionMs > 1000
          ? opts.startPositionMs
          : null,
    });
    if (!ok) {
      playing.value = false;
      // 装载失败必须把发声体一起停掉：`<audio>` 里还装着上一首的流，
      // 不摘的话会出现"界面显示的是这首失败的曲子，声音还是上一首"的错位
      el.pause();
      el.removeAttribute('src');
      el.load();
      return false;
    }

    /**
     * 带起播位置的装载（恢复会话）要把位置**在 saveSession 之前**写回状态。
     *
     * 否则顺序是：`positionMs=0` → `saveSession()` 落盘 0 →（稍后）UI 才被更新。
     * 只要用户在这个窗口里杀掉 App，续播位置就真被 0 覆盖了 ——
     * 表现和"续播没做"一模一样。
     */
    if (opts.startPositionMs !== undefined && opts.startPositionMs > 1000) {
      positionMs.value = opts.startPositionMs;
    }

    saveSession();

    if (opts.autoplay === false) {
      // 位置已由 pendingSeek 在 loadedmetadata 时落好，等用户点播放即可
      playing.value = false;
      syncMediaSessionMetadata(track, durationMs.value);
      syncMediaSessionPlaybackState('paused', positionMs.value, durationMs.value);
      return true;
    }

    try {
      await el.play();
      syncMediaSessionMetadata(track, durationMs.value);
      syncMediaSessionPlaybackState('playing', positionMs.value, durationMs.value);
    } catch (e) {
      // 自动播放被拦截是**正常现象**（尤其是移动端），不是错误。
      // 此时不报错，让用户点一下播放按钮即可。
      playing.value = false;
      syncMediaSessionPlaybackState('paused', positionMs.value, durationMs.value);
      if ((e as Error)?.name !== 'NotAllowedError') {
        errorMessage.value = '无法开始播放，请再点一次播放按钮';
      }
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // 会话快照：刷新 / 重开后接着听
  // -------------------------------------------------------------------------

  /**
   * 落盘会话快照。
   *
   * 除了队列与当前索引，还存两样：
   *   - `positionMs`：本地进度。服务端那条记录 15s 才写一次、还可能因为各种
   *     原因缺失，进程被杀后它就是唯一能用来"接着听"的东西（真机报障：
   *     "重开后位置错误，可能跳到这首歌开头"）。
   *   - `sourceIds`：队列的**原始顺序**。随机播放会就地打乱队列，没有它就
   *     无法在用户退出随机播放时把顺序摆回去（真机报障："切随机再切任何模式
   *     队列都是乱的"）。
   */
  function saveSession(): void {
    if (queue.value.length === 0 || index.value < 0) return;
    try {
      localStorage.setItem(
        SESSION_KEY,
        JSON.stringify({
          at: Date.now(),
          queue: queue.value,
          index: index.value,
          positionMs: Math.round(positionMs.value),
          sourceIds: sourceOrderIds,
        })
      );
    } catch {
      /* 无痕模式等写不进去，忽略 —— 恢复不了不是致命问题 */
    }
  }

  function readSession(): {
    queue: Track[];
    index: number;
    positionMs: number;
    sourceIds: string[] | null;
  } | null {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      const snap = JSON.parse(raw) as {
        at?: unknown;
        queue?: unknown;
        index?: unknown;
        positionMs?: unknown;
        sourceIds?: unknown;
      };
      if (!Array.isArray(snap.queue) || snap.queue.length === 0) return null;
      if (typeof snap.at !== 'number' || Date.now() - snap.at > SESSION_MAX_AGE_MS) return null;
      const i = typeof snap.index === 'number' ? snap.index : 0;
      if (i < 0 || i >= snap.queue.length) return null;
      return {
        queue: snap.queue as Track[],
        index: i,
        positionMs: typeof snap.positionMs === 'number' ? snap.positionMs : 0,
        sourceIds: Array.isArray(snap.sourceIds)
          ? (snap.sourceIds.filter(v => typeof v === 'string') as string[])
          : null,
      };
    } catch {
      return null;
    }
  }

  function clearSession(): void {
    try {
      localStorage.removeItem(SESSION_KEY);
    } catch {
      /* 忽略 */
    }
  }

  /**
   * 恢复上次的播放队列，**就位但不自动播放**。
   *
   * 这是"续播"唯一该登场的地方。与"在列表里点一首歌"是两回事：
   * 用户主动选曲一律从头，见 `startCurrent` 的 `allowResume`。
   *
   * @returns 是否成功摆好（本地没有快照或装载失败时为 false）
   */
  async function restoreSession(): Promise<boolean> {
    const snap = readSession();
    if (!snap) return false;

    queue.value = snap.queue;
    index.value = snap.index;

    /**
     * WebView 被系统回收 / Activity 重建，但原生播放服务还活着的情况：
     * 这时**不能**再 syncNativeQueue —— 那会把正在播放的队列重置，
     * 用户从车载蓝牙或耳机唤醒时就会听到"断了/队列没了"。
     * 直接接管原生状态即可。
     */
    if (isNativeAudio) {
      try {
        const st = await SuenAudio.getStatus();
        if (st?.playing && st.queueLength > 0) {
          playing.value = true;
          positionMs.value = st.positionMs ?? snap.positionMs;
          durationMs.value = st.durationMs || currentTrack.value?.dt || 0;
          return true;
        }
      } catch {
        /* 查不到就按冷启动处理 */
      }
    }
    // 原始顺序：老快照没有这个字段，退化为"当前顺序即原始顺序"（至少不会更乱）
    sourceOrderIds = snap.sourceIds ?? snap.queue.map(t => t.id);

    /**
     * 记忆为随机播放时，启动就重新打乱一次（用户要求：每次开播都要新顺序，
     * 而不是沿用上次那套固定顺序）。当前曲固定队首，用户无感。
     */
    if (mode.value === 'shuffle' || mode.value === 'shuffle-once') {
      shuffleWholeQueue(true);
    }

    /**
     * 队列**不分模式**都要交给原生。
     *
     * 原先这句只写在洗牌分支里，于是顺序模式冷启动后原生手里根本没有这条队列
     * （实测：恢复阶段插件调用只有 addListener ×4，没有 setQueue、没有 seekToIndex），
     * 用户按播放时原生只收到一条 play，播不到恢复出来的那首。
     *
     * `startPositionMs` 用快照里的本地进度：原生队列一上来就落在"上次听到哪"，
     * 不再先停在 0 再被 seek 拉回来（真机报障："重开后跳到这首歌开头"）。
     *
     * `autoplay: false` = 就位但不出声；交队列失败（离线 / 令牌接口不可用）
     * 不阻断恢复流程 —— 音源加载那条路自有兜底。
     */
    try {
      await syncNativeQueue({ autoplay: false, startPositionMs: snap.positionMs });
    } catch {
      /* 交不了队列不阻断恢复 */
    }

    const ok = await startCurrent({
      allowResume: true,
      autoplay: false,
      startPositionMs: snap.positionMs,
    });

    /**
     * 恢复后**必须把进度写回 UI 状态**。
     *
     * 原生路径下 `pendingSeekMs` 只交给了原生队列，`applyPendingSeek` 依赖
     * `loadedmetadata` 之类的媒体事件才会把 `positionMs` 同步回来 —— 而恢复时
     * `autoplay:false`，这些事件不一定触发。真机表现：原生已经在 2:14，播放页
     * 却显示 0:00 和"已停止"，用户会认为"续播又丢了"。
     */
    if (ok) {
      positionMs.value = Math.max(0, snap.positionMs);
      if (!durationMs.value && currentTrack.value?.dt) {
        durationMs.value = currentTrack.value.dt;
      }
    }

    if (!ok) {
      /**
       * 恢复失败**绝不能清空队列**。
       *
       * 之前这里是 `queue=[] + clearSession()`：一次冷启动时的网络抖动
       * （例如刚从车载蓝牙唤醒、数据还没连上）就把用户攒的队列永久删掉。
       * 表现正是"唤醒后播放队列没了"，而且再也恢复不回来。
       *
       * 现在保留队列与快照，只把状态置为未播放；用户点播放会重新解析，
       * 下次冷启动也还有机会恢复。
       */
      errorMessage.value = null;
      playing.value = false;
      positionMs.value = Math.max(0, snap.positionMs);
      if (!durationMs.value && currentTrack.value?.dt) {
        durationMs.value = currentTrack.value.dt;
      }
    }
    return ok;
  }

  async function toggle(): Promise<void> {
    const el = audio;
    if (!el || !currentTrack.value) return;

    if (el.paused) {
      try {
        await el.play();
      } catch {
        // 原生播放器若出现状态未就绪或空队列异常，尝试重发队列
        if (isNativeAudio) {
          try {
            await syncNativeQueue({ startPositionMs: positionMs.value });
            await el.play();
            return;
          } catch {
            /* 走常规重载 */
          }
        }
        const resumePos = positionMs.value > RESUME_MIN_MS ? positionMs.value : null;
        if (await startCurrent({ startPositionMs: resumePos ?? undefined, autoplay: true })) return;
        errorMessage.value = '当前网络连接失败，请稍后再试';
        notifyNetworkError('当前网络连接失败，请检查网络');
      }
    } else {
      el.pause();
    }
  }

  // -------------------------------------------------------------------------
  // 播放模式分派
  // -------------------------------------------------------------------------

  /** 单曲循环：把当前曲目从 0 重播。流还装着，不用重新解析 */
  async function replayCurrent(): Promise<void> {
    const el = audio;
    if (!el || !currentTrack.value) return;
    el.currentTime = 0;
    positionMs.value = 0;
    try {
      await el.play();
    } catch {
      /* 自动播放策略拦截时交给用户手势 */
    }
  }

  /**
   * 自动前进遇到播不了的曲目（低置信 / 限流）时继续往后跳的剩余预算。
   * 上限为队列长度：整队都解析失败时恰好停住，不会死循环。
   * 用户手动切歌（auto=false）不消耗预算、也不跳过 —— 失败就停在原地，
   * 让锚定弹窗接手。
   */
  let autoSkipBudget = 0;

  /** advance 各分支共用的"装载当前曲目"。自动前进失败时递归跳下一首 */
  async function startAfterAdvance(auto: boolean): Promise<void> {
    const ok = await startCurrent({ fromAdvance: auto });
    if (ok) {
      autoSkipBudget = 0;
      return;
    }
    if (!auto) return;
    if (autoSkipBudget >= queue.value.length) {
      // 整队都播不了：停住，锚定弹窗已经打开，交给用户处理
      autoSkipBudget = 0;
      playing.value = false;
      return;
    }
    autoSkipBudget += 1;
    await advance(true);
  }

  /**
   * 前进到下一首，按播放模式分派。
   *
   * @param auto true = 曲目自然播完后的自动前进；false = 用户点了"下一首"。
   *   两者在"要不要停"上语义不同：order/shuffle-once 自动前进到头就停，
   *   用户手动则保留在原地不动；repeat-one 的自动前进是重播本曲，
   *   用户手动"下一首"仍然前进（与主流播放器一致）
   */
  async function advance(auto: boolean): Promise<void> {
    const n = queue.value.length;
    if (n === 0) return;
    const m = mode.value;

    if (m === 'repeat-one' && auto) {
      await replayCurrent();
      return;
    }

    if (m === 'list-loop') {
      index.value = (index.value + 1) % n;
      await startAfterAdvance(auto);
      return;
    }

    if (m === 'shuffle' || m === 'shuffle-once') {
      /**
       * 随机模式：**队列本身就是洗好的顺序**（见 shuffleWholeQueue），
       * 所以这里只需顺序前进 —— 好处是原生层（通知栏/锁屏/熄屏接续）也严格
       * 按随机顺序走，不再出现"后台退化成顺序播放"。
       */
      const next = index.value + 1;
      if (next < n) {
        index.value = next;
        await startAfterAdvance(auto);
        return;
      }
      // 一轮放完：'shuffle' 整条重洗（新顺序，首项不固定）继续；
      // 'shuffle-once' 到此为止
      if (m === 'shuffle' && shuffleWholeQueue(false)) {
        await syncNativeQueue({ startPositionMs: 0 });
        await startAfterAdvance(auto);
        return;
      }
      playing.value = false;
      return;
    }

    // order（以及 repeat-one 下用户手动点"下一首"）
    if (!hasNext.value) {
      playing.value = false;
      return;
    }
    index.value += 1;
    await startAfterAdvance(auto);
  }

  /**
   * 打乱**整条**队列（本地 Fisher-Yates），用新顺序替换本地队列。
   *
   * 用在"队列刚建立/还没在播"的时机：playQueue / playTrack / 恢复会话 /
   * 一轮放完接着随机。这些时刻整条重发队列没有任何代价（本来就要重新装载）。
   *
   * @param pinCurrent 把正在播放的那首固定在队首（点歌/恢复时用户无感）
   * @returns 是否真的洗了（队列不足 2 首时没有可打乱的东西，返回 false）
   *
   * **为什么在本地洗**（原先是发 id 给服务端换一份排列回来，2026-09-14 改回本地）：
   *   - 队列本来就是**本地的**（快照存 localStorage），洗牌是一次纯计算，
   *     没有任何一份数据是服务端才有的 —— 发过去换回来纯属多余往返；
   *   - 那多出来的一次往返还**卡在起播路径上**（洗牌 await 在 startCurrent 之前）；
   *   - 最要命的是**离线直接失效**：请求失败时只能静默回落到原顺序，
   *     于是"界面写着随机、实际顺序播" —— 与"离线也能听缓存"的产品目标正面冲突。
   *
   * 洗牌结果依然会成为**队列本身的顺序**，所以原生层（后台/锁屏/熄屏接续）
   * 与前台完全一致 —— 这一点跟谁洗的无关，队列顺序才是唯一的真相。
   */
  function shuffleWholeQueue(pinCurrent: boolean): boolean {
    const list = queue.value;
    if (list.length < 2) return false;
    const cur = currentTrack.value;
    const pinned = pinCurrent && cur && list.some(t => t.id === cur.id) ? cur : null;
    const rest = pinned ? list.filter(t => t.id !== pinned.id) : [...list];

    fisherYates(rest);

    queue.value = pinned ? [pinned, ...rest] : rest;
    index.value = 0;
    return true;
  }

  /** 就地洗牌（Fisher-Yates，均匀分布） */
  function fisherYates(list: Track[]): void {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const a = list[i];
      const b = list[j];
      if (a === undefined || b === undefined) continue;
      list[i] = b;
      list[j] = a;
    }
  }

  /** "未播部分"的起点：当前曲之后。还没开始播（index<0）时就是整条 */
  function tailStart(): number {
    return index.value >= 0 ? index.value + 1 : 0;
  }

  /**
   * 只重排**未播部分**（当前曲之后），正在播的那首原地不动。
   *
   * 切播放模式时用这个而不是 `shuffleWholeQueue`：整条重发会让原生重新
   * 装载正在播的那首（重新缓冲 → 用户听到"卡一下"），尾段替换则完全不动它。
   *
   * @param bySourceOrder true = 按**原始列表顺序**摆回（退出随机播放时用），
   *                      false = 重新打乱
   */
  function reorderTail(bySourceOrder: boolean): boolean {
    const from = tailStart();
    const head = queue.value.slice(0, from);
    const tail = queue.value.slice(from);
    if (tail.length < 2) return false;

    if (bySourceOrder) {
      const byId = new Map(tail.map(t => [t.id, t] as const));
      const ordered: Track[] = [];
      for (const id of sourceOrderIds) {
        const t = byId.get(id);
        if (t) ordered.push(t);
      }
      // 原始顺序里查不到的（队列被手工改过）按现有顺序补在后面，一首都不丢
      const seen = new Set(ordered.map(t => t.id));
      for (const t of tail) if (!seen.has(t.id)) ordered.push(t);
      queue.value = [...head, ...ordered];
    } else {
      fisherYates(tail);
      queue.value = [...head, ...tail];
    }
    return true;
  }

  /**
   * 切换播放模式。
   *
   * 两种方向都要处理**未播部分的顺序**：
   *   - 进随机：把当前曲之后的部分重新打乱（用户要求：每次都新顺序，
   *     不像很多播放器那样对同一歌单固定一套）；
   *   - 出随机：按**原始列表顺序**把它摆回去 —— 否则"切随机再切任何模式
   *     队列都是乱的"（真机报障）。
   *
   * 两条路都走 `tailOnly` 同步：正在播的那首不动，所以切换过程既不卡也不跳。
   */
  function setMode(m: PlaybackMode): void {
    const prev = mode.value;
    mode.value = m;
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      /* ignore */
    }
    if (m === prev) return;

    const wasShuffle = prev === 'shuffle' || prev === 'shuffle-once';
    const isShuffle = m === 'shuffle' || m === 'shuffle-once';
    if (isShuffle) {
      if (reorderTail(false)) void syncNativeQueue({ tailOnly: true });
    } else if (wasShuffle) {
      if (reorderTail(true)) void syncNativeQueue({ tailOnly: true });
    }
  }

  /** 五态依次轮转，供播放条上的单个按钮循环切换 */
  function cycleMode(): PlaybackMode {
    const nextMode = MODES[(MODES.indexOf(mode.value) + 1) % MODES.length] as PlaybackMode;
    setMode(nextMode);
    return nextMode;
  }

  async function next(): Promise<void> {
    await advance(false);
  }

  async function prev(): Promise<void> {
    // 单击即切上一首（用户拍板：不做"先回到本曲开头"的两段式）。
    // 想重听当前曲，拖进度条到 0 或再点一次都可以。
    if (!hasPrev.value) {
      // 队列头部：退无可退时回到本曲开头，避免按钮点了没反应
      if (audio) {
        audio.currentTime = 0;
        positionMs.value = 0;
      }
      return;
    }
    index.value -= 1;
    await startCurrent();
  }

  /** 跳到队列中的某一首并开始播放（队列面板点击跳播用） */
  async function jumpTo(i: number): Promise<void> {
    if (i < 0 || i >= queue.value.length || i === index.value) return;
    index.value = i;
    // 显式点播某一首：离线没缓存时只提示"当前无网络"，不擅自跳到别的歌
    await startCurrent({ noSkip: true });
  }

  /**
   * 锚定弹窗关闭（未锚定）。只清状态，不重试 —— 用户可能就是想跳过这首。
   */
  function dismissAnchorDialog(): void {
    anchorCandidate.value = null;
  }

  /**
   * 主动发起锚定：详情页状态灯旁的锚定按钮触发。
   * 与"解析失败自动弹出"共用同一个弹窗 —— 手动锚定随时可以覆写旧锚点。
   */
  function requestAnchor(): void {
    const t = currentTrack.value;
    if (t) anchorCandidate.value = t;
  }

  /**
   * 锚定完成后重试指定或当前曲目：重新装载并播放。
   * 服务端在锚定时已清掉解析缓存，这次解析会直接走新锚点。
   */
  async function retryAfterAnchor(targetTrack?: Track): Promise<void> {
    const track = targetTrack || anchorCandidate.value || currentTrack.value;
    anchorCandidate.value = null;
    if (!track) return;

    // 校准队列索引至被锚定曲目
    const qIdx = queue.value.findIndex(t => t.id === track.id);
    let inserted = false;
    if (qIdx >= 0) {
      index.value = qIdx;
    } else {
      queue.value.splice(index.value, 0, track);
      inserted = true;
    }
    /**
     * ⚠️ 新插入的曲目**不在原生队列里**：不同步的话，下面的 `load()` 走
     * `el.src → indexOf → seekToIndex` 会因为拿不到索引而**静默 no-op**
     * （桥的 load/play 只认原生队列里已有的条目），表现为"锚定完播的还是原来那首"。
     */
    if (inserted) await syncNativeQueue({ autoplay: false, startPositionMs: 0 });

    /**
     * 重新锚定 = 换了音源。原生音频缓存以**曲目 id** 为键（见 SuenAudioCache），
     * 旧音源的字节留在缓存里会直接盖住新音源 —— 锚定了却听不出任何变化。
     * 先清掉这一首的缓存，新音源才能真正生效。
     */
    if (isNativeAudio) {
      await SuenAudio.evictCache({ id: track.id }).catch(() => {});
    }

    retriedForCurrent = false;
    // 强制回源解析，且禁止跳下一首（noSkip: true）以确保用户能感知当前曲目的真实结果
    const ok = await load(track, { force: true, noSkip: true });
    if (!ok) return;

    /**
     * ★ 换源之后必须让原生**硬重载**这一条目。
     *
     * 上面的 load() 最后只做 `el.src = url; el.load()` —— 在原生路径下是空操作：
     * src 仅用于识别 trackId，URL 不进播放器；而 ExoPlayer 的磁盘缓存键是曲目 id、
     * 内存缓冲也不受 seek 影响。少了这一步的真实表现（真机＋虚拟机都复现过）：
     * 「锚定换了源，播放器继续放旧音源，时长要等旧缓冲耗尽才变，甚至一直不变」。
     */
    if (isNativeAudio) {
      await reloadNativeSource(track.id, 0);
    }

    saveSession();
    try {
      await ensureAudio().play();
    } catch {
      /* 自动播放策略拦截时交给用户手势 */
    }
  }

  /**
   * 从队列移除某一首（队列面板的"移除"按钮用）。
   *
   * 移除当前播放项时自动接上下一首继续播（没有下一首就停）；
   * 移除其它项不打断播放。随机模式下顺序是队列自身的顺序，队列缩短无需额外处理。
   */
  async function removeAt(i: number): Promise<void> {
    if (i < 0 || i >= queue.value.length) return;
    const wasCurrent = i === index.value;
    const wasPlaying = playing.value;
    const removedId = queue.value[i]?.id;

    queue.value.splice(i, 1);
    // 原始顺序跟着移除：否则退出随机播放时会把它又摆回来
    if (removedId) sourceOrderIds = sourceOrderIds.filter(id => id !== removedId);

    if (queue.value.length === 0) {
      // 队列空了：收尾停播，但不清会话快照之外的状态 —— reset 只属于登出
      stopReporting();
      if (audio) {
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
      }
      index.value = -1;
      playing.value = false;
      positionMs.value = 0;
      durationMs.value = 0;
      currentStreamUrl = null;
      streamTrackId = null;
      streamTtlMs = 0;
      clearSession();
      return;
    }

    if (i < index.value) {
      // 移除的项在当前项之前：当前项下标左移，播放不中断
      index.value -= 1;
    } else if (wasCurrent) {
      // 移除的正是当前项：原地接上"现在的第 i 首"继续播
      index.value = Math.min(i, queue.value.length - 1);
      await startCurrent();
      if (!wasPlaying) {
        // 原本就是暂停状态的话，装载但不出声
        audio?.pause();
      }
    }

    saveSession();
  }

  /**
   * 跳转到指定位置。
   *
   * 地址可能已过期（尤其长时间暂停后）。过期时先重新解析再跳 ——
   * 直接对旧地址 seek 会静默失败，用户看到的是"拖了没反应"。
   */
  async function seek(ms: number): Promise<void> {
    const el = ensureAudio();
    const track = currentTrack.value;
    if (!track) return;

    const target = Math.max(0, Math.min(ms, durationMs.value > 0 ? durationMs.value : ms));

    if (currentStreamUrl && !streamUrlFresh(track.id)) {
      const ok = await load(track, { force: false, keepPositionMs: target });
      if (ok) {
        try {
          await el.play();
        } catch {
          /* 用户手势缺失 */
        }
        return;
      }
    }

    el.currentTime = target / 1000;
    positionMs.value = target;
    syncMediaSessionPlaybackState(playing.value ? 'playing' : 'paused', target, durationMs.value);
  }

  function seekPercent(percent: number): Promise<void> {
    const total = durationMs.value;
    if (total <= 0) return Promise.resolve();
    return seek((percent / 100) * total);
  }

  function setVolume(v: number): void {
    volume.value = Math.min(1, Math.max(0, v));
    if (audio) audio.volume = volume.value;
    if (volume.value > 0 && muted.value) setMuted(false);
    saveVolume();
  }

  function setMuted(m: boolean): void {
    muted.value = m;
    if (audio) audio.muted = m;
  }

  /** 停止并清空。退出登录时调用 —— 否则下一个用户会看见上一个人的播放队列 */
  function reset(): void {
    stopReporting();
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }
    queue.value = [];
    sourceOrderIds = [];
    index.value = -1;
    playing.value = false;
    loading.value = false;
    positionMs.value = 0;
    durationMs.value = 0;
    errorMessage.value = null;
    currentSource.value = null;
    currentSourceTrackId.value = null;
    currentStreamUrl = null;
    currentStreamUrlRaw = null;
    streamTrackId = null;
    streamTtlMs = 0;
    retriedForCurrent = false;
    pendingSeekMs = null;
    syncMediaSessionMetadata(null);
    syncMediaSessionPlaybackState('stopped', 0, 0);
    // 队列属于上一个账号，快照也不能留给下一个用户
    clearSession();
  }

  /**
   * 基地址变更（用户改设置 / 多路径自动切换）时的收尾与恢复。
   *
   * 旧地址立刻作废；若当时正在播放，就在新路径上把当前曲目重新装载并恢复
   * 播放位置 —— 用户拍板"允许播放中切换，重载当前曲"（约 0.5-1 秒断音，
   * 换来的是出门/回家时不用手动干预）。
   *
   * 原生端额外要做的：Media3 队列里的流地址是**绝对地址**，换路径后整条
   * 队列都失效，必须重发（syncNativeQueue）+ 重绑基地址。
   */
  onBaseUrlChanged(() => {
    const resumeTrack = currentTrack.value;
    const resumeAt = positionMs.value;
    const wasPlaying = playing.value;

    currentStreamUrl = null;
    streamTtlMs = 0;
    streamTrackId = null;
    if (audio && audio.src) {
      audio.pause();
      audio.removeAttribute('src');
      playing.value = false;
    }
    if (!resumeTrack || !wasPlaying) return;

    void (async () => {
      try {
        if (isNativeAudio) {
          const bridge = ensureAudio() as unknown as NativeAudioBridge;
          bridge.rebindBaseUrl(getBaseUrl());
          await syncNativeQueue();
        }
        pendingSeekMs = resumeAt > RESUME_MIN_MS ? resumeAt : null;
        await startCurrent();
        await ensureAudio().play();
      } catch {
        /* 自动播放可能被浏览器策略拦下；此时停在暂停态，等用户点播放 */
      }
    })();
  });

  return {
    // 状态
    queue,
    index,
    playing,
    loading,
    resolving,
    positionMs,
    durationMs,
    volume,
    muted,
    mode,
    currentSource,
    currentSourceTrackId,
    errorMessage,
    headStatus,
    anchorCandidate,
    // 派生
    currentTrack,
    hasNext,
    hasPrev,
    progressPercent,
    // 动作
    playTrack,
    playQueue,
    startCurrent,
    origin,
    restoreSession,
    toggle,
    next,
    prev,
    jumpTo,
    removeAt,
    dismissAnchorDialog,
    requestAnchor,
    retryAfterAnchor,
    seek,
    seekPercent,
    setVolume,
    setMuted,
    setMode,
    cycleMode,
    reportProgress,
    reset,
    /** 当前流的原始相对路径，仅供设置页/调试展示 */
    currentStreamPath: () => currentStreamUrlRaw,
  };
});

/**
 * 把 `window.__suenAudioControl` 注册成**始终存在**的全局控制面。
 *
 * 供鸿蒙原生（AVSession 锁屏控制、桌面卡片按钮）反向控制网页播放器。
 * 必须在 main.ts 启动时调用一次：音频元素要等第一次播放才创建（ensureAudio），
 * 若注册挂在那之后，"恢复会话但还没播过"的冷启动窗口里原生按播放是空操作。
 * 这里全部走 store 公开 API，store 内部自己处理 ensureAudio / startCurrent。
 */
export function registerGlobalAudioControl(): void {
  if (typeof window === 'undefined' || window.__suenAudioControl) return;

  window.__suenAudioControl = {
    play: () => {
      const p = usePlayerStore();
      if (!p.playing) void p.toggle();
    },
    pause: () => {
      const p = usePlayerStore();
      if (p.playing) void p.toggle();
    },
    stop: () => {
      const p = usePlayerStore();
      if (p.playing) void p.toggle();
    },
    /**
     * 桌面卡片播放键用它：进程被杀后卡片快照可能残留播放态，
     * play/pause 二选一会判错方向，toggle 两种情况都正确。
     */
    toggle: () => {
      void usePlayerStore().toggle();
    },
    next: () => void usePlayerStore().next(),
    prev: () => void usePlayerStore().prev(),
    seek: (targetMs: number) => void usePlayerStore().seek(targetMs),
    toggleFavorite: async (): Promise<boolean> => {
      const p = usePlayerStore();
      const track = p.currentTrack;
      if (!track) return false;
      return useFavoritesStore().toggle(track);
    },
  };
}
