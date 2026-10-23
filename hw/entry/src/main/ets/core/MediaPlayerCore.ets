/**
 * 鸿蒙端播放内核（AVPlayer）。
 *
 * 与 iOS `AudioEngine` 同一套语义，只是换了平台 API：
 *   · 队列 / 下标 / 自动接续（endOfStream → 下一首）
 *   · 播放意图（`wantPlay`）与真实状态分离 —— 锁屏按钮只看意图
 *   · 断网优先播缓存（`fd://`），否则走 `<base>/api/stream/<id>?t=<token>`
 *   · 每次状态变化同时喂给：AppStorage（UI）+ AVSessionManager（锁屏/卡片/长时任务）
 *
 * 官方硬约束：`STREAM_USAGE_MUSIC` 必须接 AVSession + AUDIO_PLAYBACK 长时任务；
 * 「申请了但没有有效音频播放」会被系统挂起 —— 所以暂停/停止时主动取消（官方建议 on('pause') 后取消）。
 *
 * SysCap 提示（build 的 media/audio WARN）：`module.json5` 的 deviceTypes 仅 phone/tablet，
 * SystemCapability.Multimedia.Media.Core / Audio.Core 在这些设备上必然具备，不做降级。
 */

import { media } from '@kit.MediaKit';
import { audio } from '@kit.AudioKit';
import { fileIo } from '@kit.CoreFileKit';
import { common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { preferences } from '@kit.ArkData';
import { Track, artistLine, ResolveResponse } from './Models';
import { OfflineCache } from './OfflineCache';
import { HarmonyAVSessionManager, MusicMetadataParam } from '../common/AVSessionManager';
import { Notifier } from '../common/Notifier';
import { APIClient } from './APIClient';

const TAG = 'SuenMusic_Player';
const DOMAIN = 0x0000;

/** 播放会话持久化（冷启动续播，T10）：队列+下标低频整存，位置 5s 节流单存 */
const PLAYER_PREFS = 'suenmusic_player';
const SESSION_KEY = 'session';
const POS_KEY = 'pos';
const POS_PERSIST_INTERVAL_MS = 5000;
/**
 * 失败**挂起窗口**（ms）：装载失败先不惊动用户，给 AVPlayer/服务端一次自愈机会。
 *
 * 用户 2026-10-23 实测：专属页某些曲目首次 `/api/stream` 回 503（服务端还在解析），
 * AVPlayer 内部重试后 **1 秒内就播起来了**；而我们一失败就报错+发通知，观感是
 * 「错误闪一下又瞬间恢复」。窗口内恢复 → 静默撤销，什么都不发。
 */
const FAIL_GRACE_MS = 2500;
/** 播放模式偏好键（web localStorage `suenmusic.playMode` 同口径） */
const MODE_KEY = 'play_mode';

/** 播放模式环（web MODES 同序）：顺序 → 随机 → 单曲循环 → 列表循环 → 随机不重复 */
const PLAY_MODES: string[] = ['order', 'shuffle', 'repeat-one', 'list-loop', 'shuffle-once'];

/** 是否随机类模式（队列本体被洗过，原序存 sourceOrderIds） */
function isShuffleMode(m: string): boolean {
  return m === 'shuffle' || m === 'shuffle-once';
}

/** 持久化的播放会话形状（preferences 'session' 键的 JSON） */
interface PersistedSession {
  tracks: Track[];
  index: number;
  /** 装载时的原始队列顺序（id 列表）：切出随机模式按它摆回；旧会话可能缺 */
  sourceIds?: string[];
}

/** AppStorage 键（UI 与卡片共用；卡片读的是 NowPlaying 快照，这里只服务 UI） */
export const K_TITLE = 'np_title';
export const K_ARTIST = 'np_artist';
export const K_COVER = 'np_cover';
export const K_PLAYING = 'np_playing';
export const K_POS = 'np_pos';
export const K_DUR = 'np_dur';
export const K_INDEX = 'np_index';
export const K_TRACKID = 'np_trackid';
export const K_SOURCE = 'np_source';
export const K_HAS_TRACK = 'np_has_track';
/** 队列版本号：队列内容（顺序/增删）每次变化都自增，UI 靠它刷新 */
export const K_QUEUE_VERSION = 'np_queue_ver';
/** 播放模式（T10 批次 F）：'order' | 'shuffle' | 'repeat-one' | 'list-loop' | 'shuffle-once' */
export const K_PLAY_MODE = 'np_play_mode';
/** 队列来源（T10 收官第 ④ 条）：setQueue 时由装载方写入（搜索/收藏/每日推荐/歌单/首页…），
 *  播放页 eyebrow 用「状态 · 来源」口径展示；队列内切歌不改写（web FullPlayer 同口径） */
export const K_ORIGIN = 'np_origin';

export class MediaPlayerCore {
  private static instance: MediaPlayerCore | null = null;
  static shared(): MediaPlayerCore {
    if (MediaPlayerCore.instance === null) { MediaPlayerCore.instance = new MediaPlayerCore(); }
    return MediaPlayerCore.instance;
  }

  private player: media.AVPlayer | null = null;
  private av: HarmonyAVSessionManager | null = null;

  private queue: Track[] = [];
  private index: number = -1;
  private token: string = '';
  private wantPlay: boolean = false;
  /** 准备完成的序号：防止旧的 prepare 回调覆盖新曲 */
  private seq: number = 0;
  /** 当前交给 AVPlayer 的本地文件（缓存命中时用），切歌/销毁时必须关闭 */
  private openFile: fileIo.File | null = null;
  /** 本次装载新开、等 reset 之后才接管的文件 */
  private pendingFile: fileIo.File | null = null;
  /** 本次装载期望自动起播（prepared 之后才真正 play） */
  private pendingAutoplay: boolean = false;
  /** 换服重建队列时要恢复到的位置（-1 = 无需恢复）；prepared 后 seek 一次即清 */
  private pendingSeekMs: number = -1;
  /** 当前流地址（仅用于日志排查） */
  private currentUrl: string = '';
  /** 连续装载失败次数（成功起播即清零）。对齐 Web 端 networkFailStreak 的语义 */
  private failStreak: number = 0;
  /** 本次装载的失败是否已归口：prepare 拒绝与 error 事件常为同一失败的双报，防 failStreak 双计 */
  private failHandled: boolean = false;
  /** 连续失败上限：超过就停下报错，避免整条队列被瞬间跳空 */
  private static readonly MAX_FAIL_STREAK: number = 3;
  /** 失败挂起定时器（-1 = 无）；恢复播放或重新装载时清除 */
  private failTimer: number = -1;
  /**
   * 本次装载是否**用户显式点播**（点某首歌 / 点重试 / 锚定后重装）。
   *
   * 用户 2026-10-23 复述的既有规则（web `startCurrent({ noSkip: true })` 同口径）：
   *   · **列表连播**（自然接续 / 切歌自动装载）拿不到音源 → **跳过下一首**（不打断收听）；
   *   · **用户手动点这首歌**拿不到音源 → **不跳**，停在当前曲给重试 / 跳过 / 修正音源（锚定）入口。
   * 否则「自动跳过」会把用户想锚定的那首直接切走，永远锚不上。
   */
  private manualLoad: boolean = false;
  /** 上次向 AVSession 推送进度的时间（节流用，见 timeUpdate） */
  private lastStatePushAt: number = 0;
  private releasing: boolean = false;
  // ---- 冷启动续播（T10：进程被系统收走后，卡片/播控指令恢复上次会话） ----
  private prefs: preferences.Preferences | null = null;
  /** init 内启动的偏好装载；restore 必须等它落地，否则冷启动首批指令读不到会话 */
  private prefsReady: Promise<void> | null = null;
  /** 上次持久化播放位置的时间（5s 节流） */
  private lastPosPersistAt: number = 0;
  /** 会话恢复中标志：防止恢复路径内的空队列分支再次进入 restore */
  private restoring: boolean = false;
  /** 歌词拉取序号：切歌后旧请求回来直接丢弃 */
  private lyricSeq: number = 0;
  // ---- 播放模式（T10 批次 F，web player.ts 模式区同口径） ----
  /** 当前播放模式（默认顺序；loadPrefs 从偏好恢复） */
  private playMode: string = 'order';
  /** 装载时的原始队列顺序：随机模式下队列本体已洗，切出随机按它摆回 */
  private sourceOrderIds: string[] = [];

  init(context: common.Context, av: HarmonyAVSessionManager): void {
    this.av = av;
    OfflineCache.shared().init(context);
    this.prefsReady = this.loadPrefs(context);
  }

  /** init 是否已执行（PlayerControlHub 冷启动期据此暂存卡片指令） */
  get ready(): boolean { return this.av !== null; }

  private async loadPrefs(context: common.Context): Promise<void> {
    try {
      this.prefs = await preferences.getPreferences(context, PLAYER_PREFS);
      // 播放模式偏好恢复（web localStorage `suenmusic.playMode`）
      const saved = this.prefs.getSync(MODE_KEY, 'order');
      if (typeof saved === 'string' && PLAY_MODES.indexOf(saved) >= 0) {
        this.playMode = saved;
      }
    } catch (e) {
      hilog.warn(DOMAIN, TAG, '打开播放会话偏好失败: %{public}s', JSON.stringify(e));
    }
    this.publishMode();
  }

  /** 队列快照（副本）—— UI 只读，不允许直接改内部数组 */
  getQueueSnapshot(): Track[] {
    const out: Track[] = [];
    for (let i = 0; i < this.queue.length; i++) {
      out.push(this.queue[i]);
    }
    return out;
  }

  /** 队列长度 */
  get length(): number { return this.queue.length; }

  /** 当前下标（-1 = 空） */
  get currentIndex(): number { return this.index; }

  /** 队列变化后自增版本号，驱动 UI 重新取快照 */
  private bumpQueue(): void {
    AppStorage.setOrCreate<number>(K_QUEUE_VERSION, Date.now());
    this.persistSession();
  }

  /** 队列/下标变化即整存（低频：切歌、增删、排序才触发；restore 读回后也重存一次） */
  private persistSession(): void {
    const prefs = this.prefs;
    if (prefs === null) { return; }
    const data: PersistedSession = {
      tracks: this.queue,
      index: this.index,
      sourceIds: this.sourceOrderIds
    };
    prefs.put(SESSION_KEY, JSON.stringify(data))
      .then(() => {
        return prefs.flush();
      })
      .catch((e: BusinessError) => {
        hilog.warn(DOMAIN, TAG, '持久化播放队列失败: %{public}s', JSON.stringify(e));
      });
  }

  /** 播放位置单存（高频：只写数值，不重写队列 JSON） */
  private persistPosition(posMs: number): void {
    const prefs = this.prefs;
    if (prefs === null) { return; }
    prefs.put(POS_KEY, Math.max(0, posMs))
      .then(() => {
        return prefs.flush();
      })
      .catch((e: BusinessError) => {
        hilog.warn(DOMAIN, TAG, '持久化播放位置失败: %{public}s', JSON.stringify(e));
      });
  }

  /** 跳到指定下标并（可选）起播 */
  async jumpTo(target: number, autoplay: boolean): Promise<void> {
    if (target < 0 || target >= this.queue.length) { return; }
    if (target === this.index && this.wantPlay === autoplay) {
      // 点的是当前这首：当作"从头再来"
      await this.seek(0);
      if (autoplay && !this.wantPlay) { await this.play(); }
      return;
    }
    this.index = target;
    this.failStreak = 0;
    this.failHandled = false;
    this.bumpQueue();
    // 用户点了某一行 = 显式点播：失败停在当前曲，不跳
    this.manualLoad = true;
    await this.loadCurrent(autoplay);
  }

  /**
   * 删除队列里的一项。
   *
   * 三种情形分开处理（顺序错了会出现"删掉 A 却切到 B"）：
   *   · 删的是当前曲之前的：只挪下标，不动播放；
   *   · 删的是当前曲：原地装下一首（若已是最后一首则装新的最后一项）；
   *   · 队列被删空：停止播放并清空元数据。
   */
  async removeAt(target: number): Promise<void> {
    if (target < 0 || target >= this.queue.length) { return; }
    const wasCurrent = target === this.index;
    const wasPlaying = this.wantPlay;
    const removed = this.queue[target];

    this.queue.splice(target, 1);
    // 装载原序同步摘除（web removeAt 过滤 sourceOrderIds），否则切出随机摆不干净
    const k = this.sourceOrderIds.indexOf(removed.id);
    if (k >= 0) { this.sourceOrderIds.splice(k, 1); }

    if (this.queue.length === 0) {
      this.index = -1;
      this.wantPlay = false;
      await this.stop();
      AppStorage.setOrCreate<boolean>(K_HAS_TRACK, false);
      AppStorage.setOrCreate<string>(K_TITLE, '');
      AppStorage.setOrCreate<string>(K_ARTIST, '');
      AppStorage.setOrCreate<string>('np_error', '');
      this.bumpQueue();
      return;
    }

    if (target < this.index) {
      this.index -= 1;
      // 高亮跟着挪：内部下标变了必须同步推 K_INDEX，否则 QueueView 还按旧下标高亮
      AppStorage.setOrCreate<number>(K_INDEX, this.index);
      this.bumpQueue();
      return;
    }

    if (wasCurrent) {
      if (this.index >= this.queue.length) { this.index = this.queue.length - 1; }
      this.failStreak = 0;
      this.failHandled = false;
      this.bumpQueue();
      await this.loadCurrent(wasPlaying);
      return;
    }

    this.bumpQueue();
  }

  /**
   * 队列内移动一项（拖拽排序）。
   *
   * 下标修正必须分情况：把「当前播放项」挪走要跟着挪，把别的项跨过当前项
   * 也要相应 ±1 —— 否则拖完会变成"高亮的是 A，播的是 B"。
   */
  moveItem(from: number, to: number): void {
    const n = this.queue.length;
    if (from < 0 || from >= n || to < 0 || to >= n || from === to) { return; }
    const moved = this.queue.splice(from, 1)[0];
    this.queue.splice(to, 0, moved);

    if (from === this.index) {
      this.index = to;
    } else if (from < this.index && to >= this.index) {
      this.index -= 1;
    } else if (from > this.index && to <= this.index) {
      this.index += 1;
    }
    // 同 removeAt：下标修正后立刻同步给 UI，高亮才跟得住同一首歌
    AppStorage.setOrCreate<number>(K_INDEX, this.index);
    // 非随机模式下拖拽 = 用户钦定的新原序（web moveItem 同口径）；
    // 随机模式下队列本体是洗过的，保留 sourceOrderIds 供切出随机时摆回
    if (!isShuffleMode(this.playMode)) {
      this.sourceOrderIds = [];
      for (let i = 0; i < this.queue.length; i++) {
        this.sourceOrderIds.push(this.queue[i].id);
      }
    }
    this.bumpQueue();
  }

  get current(): Track | null {
    return this.queue.length > 0 && this.index >= 0 && this.index < this.queue.length
      ? this.queue[this.index] : null;
  }

  get isPlaying(): boolean { return this.wantPlay; }

  /** 当前播放位置（毫秒）。给 rebindServer 与 UI 用（取的是推给 AppStorage 的实时值） */
  get positionMs(): number {
    return AppStorage.get<number>(K_POS) ?? 0;
  }

  /**
   * 换服后重建播放队列：保住「当前曲目 + 播放位置 + 播放意图」。
   *
   * ⚠️ 不能只改 `APIClient.baseUrl` 就完事：队列里存的是绝对 URL
   * （`http://<base>/api/stream/...`），base 一变全部失效，必须走 loadCurrent 重建。
   * 位置恢复走 `pendingSeekMs`：`seek` 只在 prepared 之后有效，
   * 提前记下来、`stateChange('prepared')` 里补一次。
   */
  async rebindServer(token: string): Promise<void> {
    this.token = token;
    if (this.queue.length === 0 || this.index < 0) { return; }
    const pos = this.positionMs;
    const wasPlaying = this.wantPlay;
    // 重建是新服务器的账：上一台服务器的失败计数不能带过来
    this.failStreak = 0;
    this.failHandled = false;
    this.pendingSeekMs = pos;
    AppStorage.setOrCreate<number>(K_POS, pos);
    this.bumpQueue();
    await this.loadCurrent(wasPlaying);
  }

  /** 装载整条队列并从 startIndex 起播；origin = 队列来源（播放页 eyebrow 显示用，见 K_ORIGIN） */
  async setQueue(tracks: Track[], startIndex: number, token: string, origin: string): Promise<void> {
    this.queue = tracks;
    this.token = token;
    AppStorage.setOrCreate<string>(K_ORIGIN, origin);
    // ⚠️ bumpQueue 必须在 index 赋值之后：它内联 persistSession 整存「队列+下标」，
    // 放在前面会把新队列配旧下标写进持久层（冷启动续播播错歌的根因）
    this.index = Math.max(0, Math.min(startIndex, tracks.length - 1));
    // 记录装载原序：切出随机模式按它摆回（web sourceOrderIds）
    this.sourceOrderIds = [];
    for (let i = 0; i < tracks.length; i++) {
      this.sourceOrderIds.push(tracks[i].id);
    }
    // 随机模式装载即洗（web playQueue：选中曲钉队首，其余随机）
    if (isShuffleMode(this.playMode)) {
      this.shuffleWholeQueue(true);
    }
    this.bumpQueue();
    // 用户点歌起播 = 显式点播：失败不跳，留锚定入口
    this.manualLoad = true;
    await this.loadCurrent(true);
  }

  async play(): Promise<void> {
    // 冷启动续播：进程被系统收走后队列全丢，先恢复上次会话再起播
    if (this.queue.length === 0) {
      await this.restoreSession('play');
      return;
    }
    const p = this.player;
    if (p === null) { return; }
    this.wantPlay = true;
    if (p.state === 'prepared' || p.state === 'paused' || p.state === 'completed') {
      try {
        await p.play();
      } catch (e) {
        hilog.warn(DOMAIN, TAG, 'play 失败: %{public}s', JSON.stringify(e));
      }
      await this.av?.startContinuousTask();
      this.publishState();
    }
  }

  async pause(): Promise<void> {
    const p = this.player;
    this.wantPlay = false;
    if (p !== null && (p.state === 'playing' || p.state === 'prepared')) {
      try {
        await p.pause();
      } catch (e) {
        hilog.warn(DOMAIN, TAG, 'pause 失败: %{public}s', JSON.stringify(e));
      }
    }
    // 官方建议：收到暂停后如果不再需要播放，主动取消长时任务，
    // 否则"申请了但没在播"会被系统判定异常并挂起
    await this.av?.stopContinuousTask();
    // 暂停即落位置：进程若在后台被收走，续播从这里恢复
    this.persistPosition(AppStorage.get<number>(K_POS) ?? 0);
    this.publishState();
  }

  async toggle(): Promise<void> {
    if (this.wantPlay) { await this.pause(); } else { await this.play(); }
  }

  async seek(positionMs: number): Promise<void> {
    const p = this.player;
    if (p === null) { return; }
    if (p.state === 'prepared' || p.state === 'playing' || p.state === 'paused'
      || p.state === 'completed') {
      try {
        await p.seek(Math.max(0, positionMs));
      } catch (e) {
        hilog.warn(DOMAIN, TAG, 'seek 失败: %{public}s', JSON.stringify(e));
      }
    }
  }

  // ---------------- 播放模式（T10 批次 F，web player.ts 模式区同口径） ----------------

  /** 当前播放模式 */
  get mode(): string { return this.playMode; }

  private publishMode(): void {
    AppStorage.setOrCreate<string>(K_PLAY_MODE, this.playMode);
  }

  private persistModePref(): void {
    const doPut = (): void => {
      const prefs = this.prefs;
      if (prefs === null) { return; }
      prefs.put(MODE_KEY, this.playMode)
        .then(() => {
          return prefs.flush();
        })
        .catch((e: BusinessError) => {
          hilog.warn(DOMAIN, TAG, '持久化播放模式失败: %{public}s', JSON.stringify(e));
        });
    };
    if (this.prefs !== null) {
      doPut();
      return;
    }
    // 偏好还没打开完（冷启动极早期切模式）：等装载完再补写
    const ready = this.prefsReady;
    if (ready !== null) { ready.then(() => { doPut(); }); }
  }

  /**
   * 点模式钮循环切下一档（web cycleMode），返回切换后的模式。
   * 进入随机类模式把「当前曲之后的尾部」就地打乱（正在播的不动）；
   * 切出随机类模式把尾部按装载时的原序摆回。
   */
  cycleMode(): string {
    const i = PLAY_MODES.indexOf(this.playMode);
    const nextMode = PLAY_MODES[(i + 1) % PLAY_MODES.length];
    this.setMode(nextMode);
    return this.playMode;
  }

  setMode(m: string): void {
    if (PLAY_MODES.indexOf(m) < 0 || m === this.playMode) { return; }
    const wasShuffle = isShuffleMode(this.playMode);
    const willShuffle = isShuffleMode(m);
    this.playMode = m;
    this.publishMode();
    this.persistModePref();
    if (this.queue.length === 0 || this.index < 0) { return; }
    if (!wasShuffle && willShuffle) {
      this.shuffleTail();
    } else if (wasShuffle && !willShuffle) {
      this.restoreTailOrder();
    }
  }

  /** Fisher-Yates 就地洗牌 */
  private shuffleArray(list: Track[]): void {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = list[i];
      list[i] = list[j];
      list[j] = tmp;
    }
  }

  /** 打乱当前曲之后的尾部（web reorderTail(false)）：正在播的不动，下标不变 */
  private shuffleTail(): void {
    const tailStart = this.index + 1;
    if (tailStart + 1 >= this.queue.length) { return; } // 尾部不足 2 首洗不出新顺序
    const head = this.queue.slice(0, tailStart);
    const tail = this.queue.slice(tailStart);
    this.shuffleArray(tail);
    this.queue = head.concat(tail);
    this.bumpQueue();
  }

  /** 尾部按装载原序摆回（web reorderTail(true)）；中途入队、不在原序里的曲目原样追加尾部 */
  private restoreTailOrder(): void {
    const tailStart = this.index + 1;
    if (tailStart >= this.queue.length) { return; }
    const head = this.queue.slice(0, tailStart);
    const rest = this.queue.slice(tailStart);
    const tail: Track[] = [];
    for (let i = 0; i < this.sourceOrderIds.length; i++) {
      const id = this.sourceOrderIds[i];
      for (let j = 0; j < rest.length; j++) {
        if (rest[j].id === id) {
          tail.push(rest[j]);
          rest.splice(j, 1);
          break;
        }
      }
    }
    this.queue = head.concat(tail).concat(rest);
    this.bumpQueue();
  }

  /**
   * 整队重洗（web shuffleWholeQueue）：pinCurrent 时当前曲钉在队首（下标归 0），
   * 其余全新随机；不 pin 时整队重洗并让当前曲跟到新位置。
   */
  private shuffleWholeQueue(pinCurrent: boolean): void {
    if (this.queue.length < 2) { return; }
    const cur = this.current;
    if (pinCurrent && cur !== null) {
      const others: Track[] = [];
      for (let i = 0; i < this.queue.length; i++) {
        if (this.queue[i].id !== cur.id) { others.push(this.queue[i]); }
      }
      this.shuffleArray(others);
      const pinned: Track[] = [cur];
      this.queue = pinned.concat(others);
      this.index = 0;
      return;
    }
    const copy = this.queue.slice();
    this.shuffleArray(copy);
    this.queue = copy;
    if (cur !== null) {
      for (let i = 0; i < this.queue.length; i++) {
        if (this.queue[i].id === cur.id) { this.index = i; break; }
      }
    }
  }

  /** 自然到头停播（wantPlay 关 + 长时任务取消） */
  private stopAtEnd(): void {
    this.wantPlay = false;
    this.publishState();
    this.av?.stopContinuousTask();
  }

  /**
   * 选曲推进（web advance(auto)）：
   *   · 单曲循环 + 自然结束  → 重播本曲
   *   · 列表循环             → 回绕到队首
   *   · 随机类               → 队列本体已洗，顺序前进；播完一轮重洗续播 /
   *                            随机不重复播完一轮停下
   *   · 顺序                 → 到头停（自然结束）/ 手动到头不动
   */
  private async advance(auto: boolean): Promise<void> {
    // 自动接续（auto）/ 用户点上一首下一首 = 自动装载：失败按 web 语义跳过
    this.manualLoad = false;
    if (this.queue.length === 0) {
      await this.restoreSession('next');
      return;
    }
    const n = this.queue.length;
    const m = this.playMode;
    if (n === 1) {
      if (auto && (m === 'repeat-one' || m === 'list-loop')) {
        await this.seek(0);
        await this.play();
        return;
      }
      if (auto) { this.stopAtEnd(); }
      return;
    }
    if (m === 'repeat-one' && auto) {
      await this.seek(0);
      await this.play();
      return;
    }
    if (m === 'list-loop') {
      this.index = (this.index + 1) % n;
    } else if (this.index + 1 < n) {
      this.index += 1;
    } else {
      // 已在队尾
      if (m === 'shuffle') {
        // 随机一轮播完：当前曲钉队首整队重洗，接着播队首之后的第一首
        this.shuffleWholeQueue(true);
        this.index = 1;
      } else {
        // 顺序 / 随机不重复 / 单曲循环（手动）：到头停（自然结束）或不动（手动）
        if (auto) { this.stopAtEnd(); }
        return;
      }
    }
    this.failStreak = 0;
    this.failHandled = false;
    this.bumpQueue();
    await this.loadCurrent(auto || this.wantPlay);
  }

  async next(): Promise<void> {
    await this.advance(false);
  }

  /**
   * 用户点「重试」（T4 第 6 项）：清掉失败计数后按当前意图重装这首。
   * 连续失败停播后 `wantPlay` 已是 false —— 重试只负责重装，是否起播
   * 跟随用户意图（想播就按播放键），不做隐式自动起播。
   * forcePlay：锚定流程专用 —— 主播放可能正被试听暂停（wantPlay=false），
   * 但「锚定」的语义就是换源立刻听；由 loadCurrent 的 prepared→play 链
   * 确定性起播，绕开「装完再补 play()」与 prepared 的竞态（偶尔不起播的根因）。
   */
  async retryCurrent(forcePlay: boolean = false): Promise<void> {
    if (this.current === null) { return; }
    this.failStreak = 0;
    this.failHandled = false;
    // 用户点「重试」/ 锚定后重装 = 显式点播语义：再失败也不跳
    this.manualLoad = true;
    this.bumpQueue();
    await this.loadCurrent(forcePlay || this.wantPlay);
  }

  async prev(): Promise<void> {
    // 冷启动续播：空队列时 prev = 恢复会话并播上一首
    if (this.queue.length === 0) {
      await this.restoreSession('prev');
      return;
    }
    // 已在队首：回本曲开头（web prev 的 hasPrev=false 分支，列表循环也不回绕）
    if (this.index - 1 < 0) {
      await this.seek(0);
      return;
    }
    this.index -= 1;
    this.failStreak = 0;
    this.failHandled = false;
    this.bumpQueue();
    await this.loadCurrent(this.wantPlay);
  }

  async stop(): Promise<void> {
    this.wantPlay = false;
    // 停播后不再占用缓存文件：解除删除保护
    OfflineCache.shared().setProtected('');
    const p = this.player;
    if (p !== null) {
      // 顺序要紧：先让播放器停下（它还在用这个 fd），再归还句柄
      try {
        await p.stop();
      } catch (e) {
        hilog.warn(DOMAIN, TAG, 'stop 失败: %{public}s', JSON.stringify(e));
      }
    }
    this.releaseOpenFile();
    await this.av?.stopContinuousTask();
    this.publishState();
  }

  /**
   * 恢复上次播放会话（冷启动续播，T10）。
   *
   * 触发方：卡片/播控的 play/next/prev 指令在空队列时进入。流程：
   * 读持久化队列+下标+位置 → 重新领流令牌（旧令牌随上一进程死掉）→
   * play 意图带 `pendingSeekMs` 走 prepared 后 seek 到保存位置；
   * next/prev 意图先挪下标、从头起播（位置不跨曲恢复）。
   */
  private async restoreSession(intent: string): Promise<void> {
    if (this.restoring || this.queue.length > 0) { return; }
    this.restoring = true;
    try {
      const ready = this.prefsReady;
      if (ready !== null) { await ready; }
      const prefs = this.prefs;
      if (prefs === null) { return; }
      const raw = prefs.getSync(SESSION_KEY, '');
      if (typeof raw !== 'string' || raw.length === 0) { return; }
      const saved = JSON.parse(raw) as PersistedSession;
      if (!saved.tracks || saved.tracks.length === 0) { return; }
      const posVal = prefs.getSync(POS_KEY, 0);
      const posMs = typeof posVal === 'number' ? posVal : 0;
      const tokenRes = await APIClient.shared().streamSessionToken();
      this.queue = saved.tracks;
      this.index = Math.max(0, Math.min(saved.index, saved.tracks.length - 1));
      if (intent === 'next') {
        this.index = Math.min(this.index + 1, this.queue.length - 1);
      } else if (intent === 'prev') {
        this.index = Math.max(this.index - 1, 0);
      }
      // 恢复装载原序（旧会话缺 sourceIds 时按恢复后的队列顺序补）
      if (saved.sourceIds !== undefined && saved.sourceIds !== null) {
        this.sourceOrderIds = saved.sourceIds;
      } else {
        this.sourceOrderIds = [];
        for (let i = 0; i < this.queue.length; i++) {
          this.sourceOrderIds.push(this.queue[i].id);
        }
      }
      // 随机模式冷启动续播重洗一次（web restoreSession：每次进来都是新顺序）
      if (isShuffleMode(this.playMode)) {
        this.shuffleWholeQueue(true);
      }
      this.token = tokenRes.token;
      if (intent === 'play') { this.pendingSeekMs = posMs; }
      this.failStreak = 0;
      this.failHandled = false;
      hilog.info(DOMAIN, TAG,
        '恢复播放会话：%{public}d 首，下标 %{public}d，位置 %{public}dms，意图 %{public}s',
        this.queue.length, this.index, posMs, intent);
      this.bumpQueue();
      await this.loadCurrent(true);
    } catch (e) {
      hilog.warn(DOMAIN, TAG, '恢复播放会话失败: %{public}s', JSON.stringify(e));
    } finally {
      this.restoring = false;
    }
  }

  // ---------------- 内部 ----------------

  /** 归还交给 AVPlayer 的本地文件句柄（缓存播放专用） */
  private releaseOpenFile(): void {
    const file = this.openFile;
    this.openFile = null;
    if (file !== null) {
      try {
        fileIo.closeSync(file);
      } catch (e) {
        hilog.warn(DOMAIN, TAG, '关闭缓存文件失败: %{public}s', JSON.stringify(e));
      }
    }
  }

  /**
   * 装载一首：**只做「切换到 idle 并赋 url」**，之后全部交给 `stateChange` 驱动。
   *
   * ⚠️ 这里踩过一个真机坑（2026-10-21）：原来在本方法里连续做
   * `audioRendererInfo = …` → `url = …` → `prepare()`，结果客户端稳定报
   * 「这段音源装载失败」，而服务端日志一切正常（AVPlayer 也打印了
   * `notify initialized` / `Set source network out`）。
   *
   * 根因是**状态机时序**：`url` 只能在 `idle` 态赋值，赋值后状态**异步**
   * 迁移到 `initialized`；而 `audioRendererInfo` 官方要求「只允许在
   * `initialized` 状态下设置，且在首次 prepare 之前」。在 `idle` 态设它
   * 会直接抛异常 —— 也就是刚赋完 url 就设，几乎必然还在 idle。
   *
   * 所以现在的顺序是：`reset()` →（等 stateChange 通知 idle）→ `url = …`
   * →（等 stateChange 通知 initialized）→ `audioRendererInfo` + `prepare()`
   * →（等 prepared）→ `play()`。全部状态迁移都在 `attachEvents` 里处理。
   */
  private async loadCurrent(autoplay: boolean): Promise<void> {
    const track = this.current;
    if (track === null) { return; }
    const mySeq = ++this.seq;
    this.failHandled = false;
    // 重新装载即撤销挂起的失败（重试 / 跳过 / 锚定后重装都走这里）
    if (this.failTimer !== -1) {
      clearTimeout(this.failTimer);
      this.failTimer = -1;
    }
    this.pendingAutoplay = autoplay || this.wantPlay;
    // 登记删除保护：缓存面板删文件必须跳过正在播的这一首（fd:// 占用中删了直接断播）
    OfflineCache.shared().setProtected(track.id);
    const url = this.buildUrl(track);

    // 先落 UI 元数据：切歌瞬间界面就该变，别等 prepare
    this.publishTrack(track);
    // 音源标签（用户 2026-10-23 裁定：显示 bilibili / 网易云 / 未匹配）
    this.refreshSourceLabel(track);
    // 切歌即重置持久化位置：否则自动接续（endOfStream）后恢复会拿旧位置 seek 新曲
    this.persistPosition(0);

    try {
      if (this.player === null) {
        this.player = await media.createAVPlayer();
        this.attachEvents();
      }
      const p = this.player;
      // 换曲必须 reset 回 idle（url 只允许在 idle 态赋值）
      if (p.state !== 'idle') { await p.reset(); }
      if (mySeq !== this.seq) { return; }
      // reset 之后播放器已释放旧的资源句柄，这时才能安全关闭，避免 fd 泄漏
      this.releaseOpenFile();
      if (this.pendingFile !== null) {
        this.openFile = this.pendingFile;
        this.pendingFile = null;
      }
      this.currentUrl = url;
      p.url = url;
    } catch (e) {
      this.fail('赋流地址', e);
    }
  }

  /**
   * 每曲音源标签发布（`K_SOURCE` → 播放页「音源」行）。
   *
   * 用户 2026-10-23 裁定：这一行必须显示**真实音源**（bilibili / 网易云 / 未匹配），
   * 而不是「已锚定/未解析」这种只有锚定信息、看不出实际从哪播的说法。
   *
   * 取数走 `/api/resolve/<trackId>`（服务端解析缓存命中很快，且**顺带把缓存暖热**，
   * 后续 `/api/stream` 起播更快）。火后不管：不阻塞起播，失败按「未匹配」显示。
   * 锚定过的曲目服务端会直接回锚点来源，所以锚定后这一行自然变 `bilibili`。
   */
  private refreshSourceLabel(track: Track): void {
    const id = track.id;
    // 切歌先清空：不拿上一首的音源冒充这一首（空 = 未匹配）
    AppStorage.setOrCreate<string>(K_SOURCE, '');
    APIClient.shared().resolve(id)
      .then((r: ResolveResponse): void => {
        const cur = this.current;
        if (cur === null || cur.id !== id) {
          return;
        }
        AppStorage.setOrCreate<string>(K_SOURCE, r.ok ? r.source : '');
      })
      .catch((): void => {
        const cur = this.current;
        if (cur === null || cur.id !== id) {
          return;
        }
        AppStorage.setOrCreate<string>(K_SOURCE, '');
      });
  }

  /**
   * 统一的失败出口。
   *
   * 关键行为对齐 Web 端（`player.ts` 的 handlePlaybackError）：
   *   · 单首失败**不是**致命错误 —— 记一次失败、跳下一首；
   *   · 连续失败达到上限才停下并给用户明确提示（否则整条队列会被瞬间跳空）；
   *   · 界面只显示**人话**，错误码只进日志。
   *
   * 触发场景举例（真机实测）：服务端 `/api/resolve` 对某些冷门曲目返回
   * `below_threshold`（B 站搜不到，置信度 0 分）→ `/api/stream` 回 503 →
   * AVPlayer 报 5411004 "IO Network Unavailable"。对用户来说这只是"这首没有音源"。
   */
  private fail(step: string, e: Object): void {
    const code = JSON.stringify(e);
    hilog.error(DOMAIN, TAG, '装载失败于[%{public}s]: %{public}s', step, code);
    if (this.failHandled) { return; }
    this.failHandled = true;
    this.failStreak += 1;

    const track = this.current;
    const name = track === null ? '' : track.name;

    if (this.failStreak >= MediaPlayerCore.MAX_FAIL_STREAK) {
      this.settleFailure('连续多首找不到可播放音源，请检查网络或稍后再试', true);
      return;
    }

    // ⚠️ 2026-10-23 用户裁定（第 3 版）：
    // **不自动跳下一首**（会让人来不及手动锚定这首歌），**也不立刻报错**——
    // 先挂起 `FAIL_GRACE_MS`：AVPlayer 对 5xx 会自行重试，专属页实测 1s 内就播起来了，
    // 这种瞬时失败不该惊动用户（原来会在不到 1 秒内「弹错误 + 发通知 + 又瞬间恢复」）。
    // 窗口内恢复 → 静默撤销（'playing' 分支负责清计时器）；窗口到期仍没播 → 落定失败：
    // 停在当前曲 + 系统通知 + 错误行「重试 / 跳过」，更多菜单「修正音源」可就地锚定。
    if (this.failTimer !== -1) {
      clearTimeout(this.failTimer);
    }
    this.failTimer = setTimeout(() => {
      this.failTimer = -1;
      // 期间已经播起来（AVPlayer 自愈）→ 什么都不做，错误一律不发
      if (this.wantPlay) {
        return;
      }
      this.settleFailure('《' + name + '》没有可播放的匹配音源，可点「重试」或「更多 → 修正音源」手动锚定', false);
    }, FAIL_GRACE_MS);
  }

  /**
   * 失败**落定**：报错 + 通知 + 停在当前曲（不自动切歌）。
   * 注意这里要清 `pendingAutoplay`——否则 AVPlayer 随后一次迟到的 'prepared' 会把歌又播起来。
   */
  private settleFailure(message: string, consecutive: boolean): void {
    if (this.failTimer !== -1) {
      clearTimeout(this.failTimer);
      this.failTimer = -1;
    }
    this.pendingAutoplay = false;
    this.wantPlay = false;
    AppStorage.setOrCreate<boolean>(K_PLAYING, false);
    AppStorage.setOrCreate<string>('np_error', message);

    if (consecutive) {
      Notifier.notify('连续多首没有匹配音源', '已暂停播放，请检查网络或稍后再试');
      this.av?.stopContinuousTask();
      return;
    }

    // 自动装载（列表连播 / 切歌）：按 web 语义**跳过**，不打断收听
    if (!this.manualLoad) {
      const hasWayOut = this.index + 1 < this.queue.length
        || this.playMode === 'list-loop'
        || this.playMode === 'shuffle';
      if (hasWayOut) {
        Notifier.notify('没有匹配音源', '《' + this.currentName() + '》没有可播放的匹配音源，已自动跳过');
        // 稍等再跳：服务端瞬时抖动时不至于把整条队列连跳掉
        setTimeout(() => {
          this.manualLoad = false;
          this.next();
        }, 600);
        return;
      }
    }

    // 显式点播（手动点这首歌 / 重试 / 锚定后重装）或已无路可走：**停在当前曲**
    Notifier.notify('没有匹配音源', message);
    this.av?.stopContinuousTask();
  }

  /** 当前曲名（失败提示用；空队列给空串） */
  private currentName(): string {
    const t = this.current;
    return t === null ? '' : t.name;
  }

  /** 离线优先：命中缓存走 `fd://`，否则走服务端流（带短期令牌） */
  private buildUrl(track: Track): string {
    const cached = OfflineCache.shared().cachedPath(track.id);
    if (cached.length > 0) {
      try {
        const file = fileIo.openSync(cached, fileIo.OpenMode.READ_ONLY);
        this.pendingFile = file;
        return 'fd://' + file.fd;
      } catch (e) {
        hilog.warn(DOMAIN, TAG, '打开缓存文件失败: %{public}s', JSON.stringify(e));
      }
    }
    const base = APIClient.shared().getBaseUrl();
    const id = encodeURIComponent(track.id);
    return this.token.length > 0 ? `${base}/api/stream/${id}?t=${this.token}` : `${base}/api/stream/${id}`;
  }

  private attachEvents(): void {
    const p = this.player;
    if (p === null) { return; }

    /**
     * 状态机是**唯一**的推进者：idle → initialized → prepared → playing。
     *
     * 每一步都在对应的状态里做「官方允许在该状态做的事」：
     *   initialized : 设 audioRendererInfo（只允许此状态）、调 prepare()
     *   prepared    : 记时长、按待播意图决定 play 还是停在暂停
     *   playing     : 上报播放态、启动长时任务
     *   completed   : 上报暂停（曲末由 endOfStream 接管接续）
     */
    p.on('stateChange', (state: media.AVPlayerState) => {
      const player = this.player;
      if (player === null) { return; }

      if (state === 'initialized') {
        try {
          // 官方：只允许在 initialized 状态设置，且在首次 prepare 之前
          player.audioRendererInfo = {
            usage: audio.StreamUsage.STREAM_USAGE_MUSIC,
            rendererFlags: 0
          } as audio.AudioRendererInfo;
        } catch (e) {
          this.fail('设置音频渲染信息', e);
          return;
        }
        player.prepare().catch((e: Object) => {
          this.fail('prepare', e);
        });
        return;
      }

      if (state === 'prepared') {
        AppStorage.setOrCreate<number>(K_DUR, Math.max(0, player.duration));
        // 换服重建队列：恢复到切服前的位置（seek 只在 prepared 之后有效）
        if (this.pendingSeekMs >= 0) {
          const target = this.pendingSeekMs;
          this.pendingSeekMs = -1;
          AppStorage.setOrCreate<number>(K_POS, target);
          // AVPlayer.seek 返回 void（完成与否听 'seekDone'），不能当 Promise 用
          player.seek(Math.max(0, target));
        }
        if (this.pendingAutoplay) {
          this.wantPlay = true;
          player.play().catch((e: Object) => {
            this.fail('play', e);
          });
        } else {
          this.wantPlay = false;
          this.publishState();
        }
        return;
      }

      if (state === 'playing') {
        this.wantPlay = true;
        this.failStreak = 0;
        this.failHandled = false;
        // 挂起的失败作废：这一首其实播起来了（瞬时失败自愈），一律不打扰用户
        if (this.failTimer !== -1) {
          clearTimeout(this.failTimer);
          this.failTimer = -1;
        }
        // 成功起播清掉上一首的失败提示，避免陈旧错误一直挂在播放页
        AppStorage.setOrCreate<string>('np_error', '');
        this.publishState();
        // 只有真正播起来了才落缓存：装载即下载会让同一首并发两个上游请求，
        // 解析失败时也会双倍失败（实测 503 成对出现）
        const track = this.current;
        if (track !== null && this.currentUrl.startsWith('http')
          && !OfflineCache.shared().isCached(track.id)) {
          OfflineCache.shared().ensureDownload(track.id, this.currentUrl,
            track.name, artistLine(track));
        }
        this.av?.startContinuousTask();
        return;
      }

      if (state === 'paused' || state === 'completed') {
        this.publishState();
      }
    });

    p.on('timeUpdate', (timeMs: number) => {
      const pos = Math.max(0, timeMs);
      AppStorage.setOrCreate<number>(K_POS, pos);
      // 续播位置持久化：5s 节流（只写数值，prefs.flush 由 persistPosition 内部负责）
      const persistNow = Date.now();
      if (persistNow - this.lastPosPersistAt >= POS_PERSIST_INTERVAL_MS) {
        this.lastPosPersistAt = persistNow;
        this.persistPosition(pos);
      }
      /**
       * 给 AVSession 的进度**必须节流**。
       *
       * timeUpdate 每 500ms 一次，每次都 setAVPlaybackState → 播控服务的 IPC
       * 队列被打满，实测刷出成片的
       * `SetAVPlaybackState:2 in syncExecutor timeout after err:0`，
       * 而锁屏/播控其实只要 1 秒粒度。
       */
      const now = Date.now();
      if (now - this.lastStatePushAt >= 1000) {
        this.lastStatePushAt = now;
        this.av?.updatePlaybackStateFromNative(this.wantPlay, pos,
          Math.max(0, this.player === null ? 0 : this.player.duration));
      }
    });

    p.on('durationUpdate', (durationMs: number) => {
      AppStorage.setOrCreate<number>(K_DUR, Math.max(0, durationMs));
    });

    p.on('endOfStream', () => {
      // 自然结束接续全权交给播放模式（T10 批次 F advance(auto)）：
      // 单曲循环重播 / 列表循环回绕 / 随机重洗续播 / 随机不重复与顺序到头停
      this.advance(true);
    });

    p.on('error', (err: BusinessError) => {
      hilog.error(DOMAIN, TAG, 'AVPlayer 错误: %{public}s', JSON.stringify(err));
      this.fail('AVPlayer', err);
    });

    // 来电/其他应用抢占：系统会送来 audioInterrupt，按 hint 处理
    p.on('audioInterrupt', (info: audio.InterruptEvent) => {
      if (info.hintType === audio.InterruptHint.INTERRUPT_HINT_PAUSE
        || info.hintType === audio.InterruptHint.INTERRUPT_HINT_STOP) {
        this.pause();
      }
    });
  }

  /** 曲目元数据 → AppStorage + 播控中心 */
  private publishTrack(track: Track): void {
    AppStorage.setOrCreate<string>(K_TITLE, track.name);
    AppStorage.setOrCreate<string>(K_ARTIST, artistLine(track));
    AppStorage.setOrCreate<string>(K_COVER, track.al.picUrl);
    AppStorage.setOrCreate<string>(K_TRACKID, track.id);
    AppStorage.setOrCreate<number>(K_INDEX, this.index);
    AppStorage.setOrCreate<number>(K_DUR, track.dt);
    AppStorage.setOrCreate<number>(K_POS, 0);
    AppStorage.setOrCreate<boolean>(K_HAS_TRACK, true);

    const meta: MusicMetadataParam = {
      assetId: track.id,
      title: track.name,
      artist: artistLine(track),
      album: track.al.name,
      coverUrl: track.al.picUrl,
      durationMs: track.dt
    };
    this.av?.updateMetadata(meta);
    // 歌词单独异步补：2x4 卡片歌词窗 + 播控中心滚动歌词都吃这一口
    this.fetchLyric(track);
  }

  /**
   * 拉当前曲歌词 → AVSession（2x4 卡片歌词窗 + 播控中心滚动歌词）。
   *
   * 拉不到不影响播放（纯音乐/接口失败只是继续不显示歌词）；
   * 回来时已切歌（序号变了或当前曲对不上）直接丢弃，防止旧词盖新曲。
   */
  private async fetchLyric(track: Track): Promise<void> {
    const mySeq = ++this.lyricSeq;
    try {
      const res = await APIClient.shared().lyric(track.id);
      if (mySeq !== this.lyricSeq) { return; }
      const cur = this.current;
      if (cur === null || cur.id !== track.id) { return; }
      const lrc = res.lrc.lyric;
      if (lrc.length === 0) { return; }
      await this.av?.updateLyric({ assetId: track.id, lyric: lrc });
    } catch (e) {
      // 歌词拉不到不影响播放
    }
  }

  private publishState(): void {
    AppStorage.setOrCreate<boolean>(K_PLAYING, this.wantPlay);
    this.av?.updatePlaybackStateFromNative(this.wantPlay,
      AppStorage.get<number>(K_POS) ?? 0,
      this.player === null ? 0 : this.player.duration);
  }
}
