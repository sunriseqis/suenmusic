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
 */

import { media } from '@kit.MediaKit';
import { audio } from '@kit.AudioKit';
import { fileIo } from '@kit.CoreFileKit';
import { common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { Track, artistLine } from './Models';
import { OfflineCache } from './OfflineCache';
import { HarmonyAVSessionManager, MusicMetadataParam } from '../common/AVSessionManager';
import { APIClient } from './APIClient';

const TAG = 'SuenMusic_Player';
const DOMAIN = 0x0000;

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
  /** 上次向 AVSession 推送进度的时间（节流用，见 timeUpdate） */
  private lastStatePushAt: number = 0;
  private releasing: boolean = false;

  init(context: common.Context, av: HarmonyAVSessionManager): void {
    this.av = av;
    OfflineCache.shared().init(context);
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

    this.queue.splice(target, 1);

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

  /** 装载整条队列并从 startIndex 起播 */
  async setQueue(tracks: Track[], startIndex: number, token: string): Promise<void> {
    this.queue = tracks;
    this.token = token;
    this.bumpQueue();
    this.index = Math.max(0, Math.min(startIndex, tracks.length - 1));
    await this.loadCurrent(true);
  }

  async play(): Promise<void> {
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

  async next(): Promise<void> {
    if (this.index + 1 >= this.queue.length) { return; }
    this.index += 1;
    this.bumpQueue();
    await this.loadCurrent(this.wantPlay);
  }

  async prev(): Promise<void> {
    if (this.index - 1 < 0) { return; }
    this.index -= 1;
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
    this.pendingAutoplay = autoplay || this.wantPlay;
    // 登记删除保护：缓存面板删文件必须跳过正在播的这一首（fd:// 占用中删了直接断播）
    OfflineCache.shared().setProtected(track.id);
    const url = this.buildUrl(track);

    // 先落 UI 元数据：切歌瞬间界面就该变，别等 prepare
    this.publishTrack(track);

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
      this.wantPlay = false;
      AppStorage.setOrCreate<boolean>(K_PLAYING, false);
      AppStorage.setOrCreate<string>('np_error', '连续多首找不到可播放音源，请检查网络或稍后再试');
      this.av?.stopContinuousTask();
      return;
    }

    const canAdvance = this.index + 1 < this.queue.length;
    AppStorage.setOrCreate<string>('np_error',
      canAdvance ? '《' + name + '》暂无可用音源，已跳过' : '《' + name + '》暂无可用音源');
    if (canAdvance) {
      // 稍等一下再跳：避免服务端瞬时抖动时把整条队列连跳掉
      setTimeout(() => {
        this.next();
      }, 600);
    } else {
      this.wantPlay = false;
      AppStorage.setOrCreate<boolean>(K_PLAYING, false);
      this.av?.stopContinuousTask();
    }
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
      // 自动接续：还有下一首就播，否则停下（单曲循环由 repeat 开关后续补）
      if (this.index + 1 < this.queue.length) {
        this.index += 1;
        this.bumpQueue();
        this.loadCurrent(true);
      } else {
        this.wantPlay = false;
        this.publishState();
        this.av?.stopContinuousTask();
      }
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
  }

  private publishState(): void {
    AppStorage.setOrCreate<boolean>(K_PLAYING, this.wantPlay);
    this.av?.updatePlaybackStateFromNative(this.wantPlay,
      AppStorage.get<number>(K_POS) ?? 0,
      this.player === null ? 0 : this.player.duration);
  }
}
