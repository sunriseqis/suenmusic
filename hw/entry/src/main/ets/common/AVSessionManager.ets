/**
 * AVSession（播控中心 / 锁屏 / 车机）+ 长时任务 + 桌面卡片快照。
 *
 * 从 `pages/Index.ets` 原样搬出（原生化后不再依赖 WebView）：
 *   · 入参形状沿用原来的 JSON 字符串（`updateMetadata(meta)` / `updatePlaybackState(stateStr,…)`），
 *     这样原生播放内核只要把同样的 payload 传进来，整套播控/卡片逻辑**一行不用改**；
 *   · 唯一的 WebView 依赖（`runJavaScript` 回灌脚本）换成可选回调，原生传 null。
 *
 * 官方硬约束（docs/memory/2026-10-21-六端重审修复与死码清理.md §7.4）：
 * `STREAM_USAGE_MUSIC` 场景必须接 AVSession + 申请 AUDIO_PLAYBACK 长时任务，
 * 且"申请了但没有有效音频播放"会被系统挂起 —— 所以暂停后要主动取消。
 */

import { common, Want, wantAgent } from '@kit.AbilityKit';
import { backgroundTaskManager } from '@kit.BackgroundTasksKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { avSession } from '@kit.AVSessionKit';
import { http } from '@kit.NetworkKit';
import { image } from '@kit.ImageKit';
import { fileIo } from '@kit.CoreFileKit';
import { formBindingData, formProvider, formInfo } from '@kit.FormKit';
import { MediaPlayerCore } from '../core/MediaPlayerCore';
import {
  NowPlayingSnapshot,
  writeSnapshot,
  buildFormBindingObject,
  CARD_COVER_KEY_PREFIX,
  LyricLine,
  parseLyricLines,
  activeLyricIndex
} from './NowPlaying';

const TAG = 'SuenMusic_AVSession';
const DOMAIN = 0x0000;
/** 卡片封面文件（formImages 的数据源），与 FormExtensionAbility 共享沙箱 */
const CARD_COVER_PATH = '/card_cover.img';
/**
 * formImages 单张文件上限（官方：不超过 2MB）。超限会让 updateForm 整体失败 ——
 * 不只是丢封面，标题/歌词/播放态全部停在旧状态。
 */
const MAX_CARD_COVER_BYTES = 2 * 1024 * 1024 - 128 * 1024;

interface MusicMetadataParam {
  assetId?: string;
  title?: string;
  artist?: string;
  album?: string;
  coverUrl?: string;
  durationMs?: number;
  lyric?: string;
  /** 当前曲目是否已收藏（web 侧收藏集合的已知状态） */
  favorite?: boolean;
}

/** web 侧收藏变化上报的形状（SuenHarmony.updateFavorite） */
interface FavoriteUpdateParam {
  assetId?: string;
  favorite?: boolean;
}

interface PlaybackStateJsonData {
  state?: string;
  positionMs?: number;
  durationMs?: number;
}

class HarmonyAVSessionManager {
  private session: avSession.AVSession | null = null;
  private context: common.UIAbilityContext;
  private currentPixelMap: image.PixelMap | null = null;
  private currentCoverUrl: string = '';
  private currentMetadata: avSession.AVMetadata | null = null;
  /** 当前这首的 assetId。歌词只对"当时那首"有效，靠它判断一次歌词该不该收 */
  private currentAssetId: string = '';
  /** 当前这首的歌词。**单独存**，不再借"伪造一条 AVMetadata"来表达 */
  private currentLyric: string = '';
  /**
   * 元数据上报的单调序号。
   *
   * 一次切歌会触发多次上报（加载时 + loadedmetadata），JS 侧是发完就不管
   * （不 await），所以多个 async 调用会同时在飞 —— 谁最后 resolve 谁就赢。
   * 封面下载走网络（超时预算 5s+5s），旧的那次如果晚回来就会把新歌覆盖，
   * 表现就是「切歌后仍显示上一首」。只有序号等于最新值的结果才允许落地。
   */
  private metaSeq: number = 0;
  private isContinuousTaskRunning: boolean = false;
  private stopTaskTimer: number = -1;
  /** 会话重建中标志：防止重建内部的失败再次触发重建（递归风暴） */
  private rebuildingSession: boolean = false;

  // ---- 桌面卡片用的当前曲目（播放状态变化时不必等元数据重来一遍） ----
  private isPlaying: boolean = false;
  private currentCardTitle: string = '';
  private currentCardArtist: string = '';
  private currentCardCover: string = '';
  /** 当前曲目是否已收藏（web 收藏集合的已知状态，卡片红心用） */
  private currentFavorite: boolean = false;
  /** 当前播放位置（毫秒）。web 每 ~1s 上报一次，卡片歌词靠它滚动 */
  private currentPositionMs: number = 0;
  /** 封面字节是否已落盘（卡片 formImages 的前提） */
  private coverFileReady: boolean = false;
  /**
   * 当前封面的 formImages key（'suen_cover_<版本>'，'' = 尚无）。
   * 官方要求刷新卡片图片必须换新 key（复用同一个 key 不重拷字节）——
   * 每次新封面落盘生成一个，随快照走，三条推卡路径共用同一个。
   */
  private currentCoverKey: string = '';
  /** 最新下载的封面原始字节（写盘 + 解码共用一次下载） */
  private cachedCoverBuffer: ArrayBuffer | undefined = undefined;
  /** 卡片上次推送时的歌词活跃行（-2 = 尚未算过；行变化才推卡片） */
  private lastCardLyricIndex: number = -2;
  /** 上次"无歌词时推卡片进度"的时间戳（毫秒） */
  private lastCardProgressPushAt: number = 0;
  /**
   * 卡片探测冷却时间戳。
   *
   * 没有添加任何桌面卡片时，`getPublishedRunningFormInfos()` 会直接抛错
   * （实测 code 16500100）。这是**正常状态**而不是故障，但原来每秒都 throw +
   * 打 ERROR，日志被刷满，真正的播放错误反而被淹没。这里失败后退避 60 秒再试。
   */
  private cardProbeBlockedUntil: number = 0;
  /**
   * 状态推送的并发闸门。
   *
   * 真机日志里出现过成片的
   * `SetAVPlaybackState:2 in syncExecutor timeout after err:0`
   * —— 播放态每秒被推好几次（timeUpdate + 状态变化 + 卡片同步各来一发），
   * 播控服务的 IPC 队列被打满。这里做三件事：
   *   ① 上一发没回来就丢掉这一发（绝不排队）；
   *   ② 播放态没变时至少间隔 900ms；
   *   ③ 播放态变了立刻推（锁屏按钮要即时响应）。
   */
  private statePushInFlight: boolean = false;
  private lastPushedPlaying: boolean = false;
  private lastStatePushAt: number = 0;
  /** 已成功上报过的曲目 id：同一首重复上报只做一次（封面下载 + PixelMap 很重） */
  private lastMetaAssetId: string = '';
  /** LRC 解析缓存：currentLyric 变了才重 parse */
  private lyricCacheSource: string = '';
  private lyricCacheLines: LyricLine[] = [];

  constructor(context: common.UIAbilityContext) {
    this.context = context;
  }

  async init(): Promise<void> {
    try {
      this.session = await avSession.createAVSession(this.context, 'SuenMusicSession', 'audio');
      await this.session.activate();
      hilog.info(DOMAIN, TAG, 'AVSession created and activated successfully');
      this.registerSessionListeners();
      // 会话一建好就先给它一条**只有应用名**的最小元数据：系统要看到会话有
      // 元数据才会在锁屏/播控中心给出那条控件。真曲目信息随后被覆盖。
      // 这里写应用名而不是编一个歌名 —— 不知道就不知道，别骗系统。
      // 播控中心点击展开歌词面板由 AVMetadata.lyric 驱动（fetchLyric 接线，
      // T10），不需要 setLaunchAbility 拉起应用。
      await this.pushMinimalMetadata();
    } catch (err) {
      hilog.error(DOMAIN, TAG, 'Failed to create AVSession: %{public}s', JSON.stringify(err));
    }
  }

  /**
   * 暂停 → 播放 的恢复时刻，重新激活 AVSession。
   *
   * 应用长时间后台挂起期间，系统可能把会话去激活甚至销毁（错误码 6600102
   * "The session does not exist"）—— 播控中心控件消失、锁屏按钮失灵的根源。
   * activate() 幂等，多调一次没有代价；会话已不存在则走 rebuildSession() 重建。
   */
  private async reactivateSession(): Promise<void> {
    const session = this.session;
    if (!session) return;
    try {
      await session.activate();
      hilog.info(DOMAIN, TAG, 'session re-activated on play transition');
    } catch (err) {
      const be = err as BusinessError;
      if (be.code === 6600102) {
        hilog.warn(DOMAIN, TAG, 'session gone (6600102) on activate, rebuilding');
        await this.rebuildSession();
      } else {
        hilog.warn(DOMAIN, TAG, 'session.activate failed: %{public}s', JSON.stringify(err));
      }
    }
  }

  /**
   * 重建 AVSession（自愈路径，对应 6600102 会话不存在）。
   *
   * 旧句柄先销毁（可能已随系统清理失效，失败属预期，吞掉），
   * 再走一遍 init 的建会话流程，并把缓存的元数据 / 播放态重放一遍 ——
   * 不重放的话新会话是空的，播控中心有了控件却没有内容。
   * 播放态在下一个 ~1s 的进度上报里自然会被最新值覆盖，这里只求"尽快像样"。
   */
  private async rebuildSession(): Promise<void> {
    if (this.rebuildingSession) return;
    this.rebuildingSession = true;
    const old = this.session;
    this.session = null;
    if (old) {
      try {
        await old.destroy().catch((e: BusinessError) => {
          hilog.warn(DOMAIN, TAG, 'old session destroy failed (expected if already gone): %{public}s',
            JSON.stringify(e));
        });
      } catch {
        /* ignore */
      }
    }
    try {
      this.session = await avSession.createAVSession(this.context, 'SuenMusicSession', 'audio');
      await this.session.activate();
      this.registerSessionListeners();
      hilog.warn(DOMAIN, TAG, 'AVSession rebuilt successfully');
      if (this.currentMetadata) {
        try {
          await this.session.setAVMetadata(this.currentMetadata);
        } catch (err) {
          hilog.error(DOMAIN, TAG, 'replay setAVMetadata failed: %{public}s', JSON.stringify(err));
        }
      }
      try {
        const state = this.isPlaying
          ? avSession.PlaybackState.PLAYBACK_STATE_PLAY
          : avSession.PlaybackState.PLAYBACK_STATE_PAUSE;
        const playbackState: avSession.AVPlaybackState = {
          state: state,
          position: {
            elapsedTime: Math.max(0, Math.round(this.currentPositionMs)),
            updateTime: new Date().getTime()
          },
          duration: this.currentMetadata?.duration || 0
        };
        await this.session.setAVPlaybackState(playbackState);
      } catch (err) {
        hilog.error(DOMAIN, TAG, 'replay setAVPlaybackState failed: %{public}s', JSON.stringify(err));
      }
    } catch (err) {
      hilog.error(DOMAIN, TAG, 'rebuild AVSession failed: %{public}s', JSON.stringify(err));
    } finally {
      this.rebuildingSession = false;
    }
  }

  /**
   * 推一条最小元数据（只有应用名），保证播控中心那条控件先出现。
   *
   * ⚠️ 同样遵守"不写 undefined 键"的规矩：只给 assetId/title/artist/album，
   * 不碰 lyric 与 mediaImage。
   */
  private async pushMinimalMetadata(): Promise<void> {
    const session = this.session;
    if (!session) return;
    const metadata: avSession.AVMetadata = {
      assetId: 'suen_app',
      title: 'SuenMusic',
      artist: 'SuenMusic',
      album: 'SuenMusic',
      duration: 0
    };
    this.currentMetadata = metadata;
    try {
      await session.setAVMetadata(metadata);
      hilog.info(DOMAIN, TAG, 'setAVMetadata(最小元数据) success');
    } catch (err) {
      hilog.error(DOMAIN, TAG, 'setAVMetadata(最小元数据) failed: %{public}s', JSON.stringify(err));
    }
  }

  private registerSessionListeners(): void {
    if (!this.session) return;

    // 六个控制指令一次性注册：任何一步抛错只损失后续按钮，不打崩会话建立
    try {
      this.session.on('play', () => {
        hilog.info(DOMAIN, TAG, 'AVSession received: play');
        this.dispatchControl('play');
      });

      this.session.on('pause', () => {
        hilog.info(DOMAIN, TAG, 'AVSession received: pause');
        this.dispatchControl('pause');
      });

      this.session.on('stop', () => {
        hilog.info(DOMAIN, TAG, 'AVSession received: stop');
        this.dispatchControl('stop');
      });

      this.session.on('playNext', () => {
        hilog.info(DOMAIN, TAG, 'AVSession received: playNext');
        this.dispatchControl('next');
      });

      this.session.on('playPrevious', () => {
        hilog.info(DOMAIN, TAG, 'AVSession received: playPrevious');
        this.dispatchControl('prev');
      });

      this.session.on('seek', (timeMs: number) => {
        hilog.info(DOMAIN, TAG, 'AVSession received: seek %{public}d', timeMs);
        this.dispatchControl('seek', timeMs);
      });
    } catch (e) {
      hilog.warn(DOMAIN, TAG, '注册 AVSession 控制监听失败: %{public}s', JSON.stringify(e));
    }
  }

  /**
   * 会话指令统一出口（锁屏 / 播控中心 / 车机按钮都走这里）。
   *
   * 直连播放内核。WebView 壳已删（T6 / S5 §三），没有网页可反控。
   */
  private dispatchControl(action: string, param?: number): void {
    const core = MediaPlayerCore.shared();
    if (action === 'play') { core.play(); }
    else if (action === 'pause') { core.pause(); }
    else if (action === 'stop') { core.stop(); }
    else if (action === 'next') { core.next(); }
    else if (action === 'prev') { core.prev(); }
    else if (action === 'seek' && typeof param === 'number') { core.seek(param); }
  }

  /**
   * 推送曲目元数据（标题 / 歌手 / 专辑 / 时长）。
   *
   * 两条铁律，都是踩过的坑：
   *
   * 1) **绝不等封面**：封面下载走网络（超时预算 5s + 5s），把它 await 在
   *    setAVMetadata 之前，会让"新歌的元数据被堵在慢网络后面"；而上一首那次
   *    如果晚回来就会覆盖新歌 —— 表现就是「切歌后仍显示上一首」。
   *    现在先推纯文本元数据（立刻生效），封面回来后异步再补一次。
   *
   * 2) **metaSeq 守卫**：一次切歌会触发多次上报，多个 async 调用同时在飞，
   *    谁最后 resolve 谁就赢。只有序号仍是最新值的结果才允许落地。
   */
  async updateMetadata(meta: MusicMetadataParam): Promise<void> {
    try {
      await this.doUpdateMetadata(meta);
    } catch (err) {
      // JS 桥是"发完不管"地调它（不 await），异常绝不能抛回桥 ——
      // 未处理的 Promise 拒绝在鸿蒙上会被记成应用错误。
      hilog.error(DOMAIN, TAG, 'updateMetadata 异常: %{public}s', JSON.stringify(err));
    }
  }

  /** updateMetadata 的实现体。外面那层只负责兜异常 */
  private async doUpdateMetadata(meta: MusicMetadataParam): Promise<void> {
    const session = this.session;
    if (!session) {
      // 以前这里是静默 return —— 元数据被丢弃却毫无痕迹，极难排查
      hilog.error(DOMAIN, TAG, '元数据被丢弃：AVSession 尚未就绪（assetId=%{public}s）',
        meta.assetId || '');
      return;
    }

    const seq = ++this.metaSeq;
    const assetId = meta.assetId || '';

    // 同一首重复上报直接返回：状态变化会重复触发，而每次都要下封面 + 建 PixelMap。
    // 只有「上一次确实成功落地了元数据」才允许去重 —— 会话重建/失败时
    // currentMetadata 还是 null，必须让它重新走一遍，否则播控中心会永久空白。
    if (assetId.length > 0 && assetId === this.lastMetaAssetId
      && this.currentMetadata !== null) {
      return;
    }

    // 换曲：上一首的歌词、封面、收藏状态立即作废（它们只对"当时那首"有效）
    if (assetId !== this.currentAssetId) {
      this.currentAssetId = assetId;
      this.currentLyric = '';
      this.currentCoverUrl = '';
      this.currentFavorite = false;
      this.coverFileReady = false;
      this.lastCardLyricIndex = -2;
    }
    if (meta.lyric) {
      this.currentLyric = meta.lyric;
    }
    if (meta.favorite !== undefined) {
      this.currentFavorite = meta.favorite;
    }

    // ⚠️⚠️ **绝不能把 undefined 的键塞进 AVMetadata**。
    //
    // 实测代价（2026-10-10）：旧代码这里写的是
    //   `mediaImage: pixelMap || this.currentPixelMap || undefined, lyric: lyricStr || undefined`
    // 那两次 setAVMetadata **一次都没成功过**（catch 里有日志但没人看到），于是
    //   · 歌名一直是「未知曲目」—— 那是 updateLyric 里伪造的那条撑着的
    //   · 封面永远拉不到 —— 封面逻辑压根没跑到
    //   · 切歌后仍显示上一首 —— 元数据从未被更新
    // 而那条伪造数据 `{assetId, title, lyric}` 之所以能成功，正因为它
    // **一个 undefined 字段都没有**。所以这里改成"有值才赋键"。
    const metadata: avSession.AVMetadata = {
      assetId: assetId || 'suen_' + Date.now(),
      title: meta.title || '未知曲目',
      artist: meta.artist || '未知歌手',
      album: meta.album || 'SuenMusic',
      duration: meta.durationMs || 0
    };
    if (this.currentLyric) {
      metadata.lyric = this.currentLyric;
    }
    if (this.currentPixelMap) {
      metadata.mediaImage = this.currentPixelMap;
    }
    this.currentMetadata = metadata;

    try {
      await session.setAVMetadata(metadata);
      // 只有真正落地成功才记「已上报」——失败/会话未就绪时这里不记，
      // 下一次同曲上报必须还能走完整链路（否则播控中心永久空白）
      this.lastMetaAssetId = assetId;
      hilog.info(DOMAIN, TAG,
        'setAVMetadata(文本) success: seq=%{public}d, title=%{public}s, artist=%{public}s, hasLyric=%{public}s',
        seq, metadata.title || '', metadata.artist || '', metadata.lyric ? 'true' : 'false');
    } catch (err) {
      hilog.error(DOMAIN, TAG, 'setAVMetadata(文本) failed: %{public}s', JSON.stringify(err));
      return;
    }

    // 桌面卡片跟着换歌（卡片进程读的是 preferences 里的快照，不是内存）
    this.currentCardTitle = meta.title ? meta.title.trim() : '';
    this.currentCardArtist = meta.artist ? meta.artist.trim() : '';
    this.currentCardCover = meta.coverUrl ? meta.coverUrl.trim() : '';
    this.syncCard();

    // 封面单独补，不阻塞上面的标题；回来后必须还是"最新一次"才认
    this.attachCover(meta.coverUrl ? meta.coverUrl.trim() : '', seq);
  }

  /**
   * 把"正在听什么"写进快照，并主动刷新所有桌面卡片。
   *
   * 为什么不靠卡片自己来取：卡片进程是**独立进程**，且 SDK 禁止在那里引用
   * multimedia.media 等模块 —— 它只能被动接收。这里写快照 + updateForm，
   * 才是卡片更新的主动来源。注意 `form_config.json` 的 `updateDuration` **单位是 30 分钟**
   * 而不是分钟（官方定义），且系统对定时刷新另有硬配额（每卡每天 50 次）——
   * 所以"靠 updateDuration 兜底"最多算 30 分钟一次，真正的高频更新只能靠这里主动推。
   * （此前配的是 30，等于 15 小时，卡片一天只自刷一次多。）
   *
   * 封面走官方 formImages 机制（卡片 Image 不能加载网络 URL）：
   * 字节先落盘 cacheDir/card_cover.img → 每次推送前开 fd →
   * `{'formImages': {'suen_cover_<版本>': fd}}` 随 payload 一起送 →
   * 卡片侧 Image('memory://suen_cover_<版本>') 显示。fd 在 IPC 中被系统
   * 复制，await updateForm 之后关掉自己这份是安全的。
   * key 每次新封面换新值（NowPlayingSnapshot.coverKey），复用旧 key 不刷新。
   *
   * 失败不外抛：卡片是附加功能，不该因为它拖垮播控中心那条主链路。
   */
  private async syncCard(): Promise<void> {
    const hasTrack = this.currentCardTitle.length > 0;
    const snap: NowPlayingSnapshot = {
      title: hasTrack ? this.currentCardTitle : '暂无歌曲播放',
      artist: hasTrack ? (this.currentCardArtist.length > 0 ? this.currentCardArtist : '未知歌手') : '',
      coverUrl: hasTrack ? this.currentCardCover : '',
      playing: hasTrack && this.isPlaying,
      favorite: hasTrack && this.currentFavorite,
      lyric: hasTrack ? this.currentLyric : '',
      positionMs: this.currentPositionMs,
      durationMs: hasTrack && this.currentMetadata ? (this.currentMetadata.duration || 0) : 0,
      coverReady: hasTrack && this.coverFileReady,
      coverKey: hasTrack && this.coverFileReady ? this.currentCoverKey : '',
      alive: true,
      updatedAt: new Date().getTime()
    };
    // 封面 fd：文件就绪才开，失败降级为无封面（卡片画占位块）
    let coverFd = -1;
    if (snap.coverReady) {
      coverFd = this.openCoverFd();
    }
    try {
      await writeSnapshot(this.context, snap);
      // 注意用的是 RunningFormInfo 而不是 FormInfo —— 后者没有 id 字段，
      // 拿不到 formId 就没法 updateForm（实测踩过：'formId' does not exist）。
      // 没有桌面卡片时这里会抛 16500100 —— 属正常状态，退避后静默
      const now = new Date().getTime();
      if (now < this.cardProbeBlockedUntil) {
        return;
      }
      let infos: Array<formInfo.RunningFormInfo> = [];
      try {
        infos = await formProvider.getPublishedRunningFormInfos();
      } catch (probeErr) {
        this.cardProbeBlockedUntil = now + 60000;
        hilog.info(DOMAIN, TAG, '未检测到桌面卡片（60s 内不再探测）: %{public}s',
          JSON.stringify(probeErr));
        return;
      }
      if (infos.length === 0) {
        this.cardProbeBlockedUntil = now + 60000;
        return;
      }
      for (const info of infos) {
        const obj = buildFormBindingObject(snap, this.dimensionOfForm(info), coverFd);
        try {
          // await 之后系统已在 IPC 中复制 fd，可以安全关闭自己这份
          await formProvider.updateForm(info.formId, formBindingData.createFormBindingData(obj));
        } catch (err) {
          hilog.error(DOMAIN, TAG, '卡片刷新失败 formId=%{public}s: %{public}s',
            info.formId, JSON.stringify(err));
        }
      }
      hilog.info(DOMAIN, TAG, '已刷新 %{public}d 张桌面卡片：%{public}s（封面 fd=%{public}d）',
        infos.length, snap.title, coverFd);
    } catch (err) {
      hilog.warn(DOMAIN, TAG, 'syncCard 失败: %{public}s', JSON.stringify(err));
    } finally {
      this.closeCoverFd(coverFd);
    }
  }

  /** 打开卡片封面文件的 fd（-1 = 文件不存在/打开失败，调用方按无封面降级） */
  private openCoverFd(): number {
    try {
      const file = fileIo.openSync(this.context.cacheDir + CARD_COVER_PATH, fileIo.OpenMode.READ_ONLY);
      return file.fd;
    } catch (err) {
      hilog.warn(DOMAIN, TAG, '封面文件打开失败（卡片按无封面降级）：%{public}s', JSON.stringify(err));
      return -1;
    }
  }

  private closeCoverFd(fd: number): void {
    if (fd < 0) {
      return;
    }
    try {
      fileIo.closeSync(fd);
    } catch (err) {
      // 关 fd 失败无须处理：fd 生命周期随进程结束
    }
  }

  /** 当前歌词的活跃行下标（带 LRC 解析缓存；positionMs 由 web 每秒上报） */
  private currentLyricActiveIndex(positionMs: number): number {
    if (this.lyricCacheSource !== this.currentLyric) {
      this.lyricCacheSource = this.currentLyric;
      this.lyricCacheLines = parseLyricLines(this.currentLyric);
    }
    return activeLyricIndex(this.lyricCacheLines, positionMs);
  }

  /** 卡片规格 → CardPayload 的 dimension 字符串（与 formInfo.FormDimension 数值一致） */
  private dimensionOfForm(info: formInfo.RunningFormInfo): string {
    return info.dimension === formInfo.FormDimension.Dimension_2_4 ? '3' : '2';
  }

  /**
   * web 侧收藏状态变化上报（SuenHarmony.updateFavorite）。
   *
   * assetId 与当前曲目不符时忽略 —— 上报者（收藏页批量操作等）不知道
   * "正在播哪首"，过滤这一层放在这里。
   */
  updateFavorite(assetId: string, favorite: boolean): void {
    if (assetId.length === 0 || assetId !== this.currentAssetId) {
      hilog.info(DOMAIN, TAG, '收藏上报与非当前曲目不符，忽略（assetId=%{public}s）', assetId);
      return;
    }
    if (this.currentFavorite === favorite) return;
    this.currentFavorite = favorite;
    this.syncCard();
  }

  /**
   * 异步补封面。封面是这个链路里唯一走网络的一步，所以必须自带守卫：
   * 下载期间用户又切了歌（seq 变了），这次的结果就属于旧曲目，连同已解码的
   * PixelMap 一起丢弃 —— 否则旧封面会盖在新歌上。
   *
   * 一次下载两用：原始字节写盘（卡片 formImages 用）+ 解码成 PixelMap
   * （播控中心 mediaImage 用）。写盘失败只降级卡片（画占位块），不阻塞
   * 播控中心那条主链路。
   */
  private async attachCover(cover: string, seq: number): Promise<void> {
    if (!cover) return;
    if (!(cover.startsWith('http://') || cover.startsWith('https://'))) return;

    let buffer: ArrayBuffer | undefined = undefined;
    if (cover === this.currentCoverUrl && this.currentPixelMap && this.cachedCoverBuffer) {
      buffer = this.cachedCoverBuffer;
    } else {
      buffer = await this.downloadCoverData(cover);
    }
    if (!buffer) return;

    if (seq !== this.metaSeq) {
      hilog.info(DOMAIN, TAG, '封面到达时已切歌，丢弃（封面 seq=%{public}d，当前 seq=%{public}d）',
        seq, this.metaSeq);
      return;
    }

    // 1) 字节落盘 —— 卡片 formImages 的数据源（失败只降级，不挡主链路）
    this.coverFileReady = await this.saveCoverFile(buffer);
    if (!this.coverFileReady) {
      hilog.warn(DOMAIN, TAG, '封面落盘失败，卡片本次按无封面显示');
    } else {
      // 新封面换新 key：formImages 复用旧 key 时系统不重拷字节，卡片会一直显示旧图
      this.currentCoverKey = CARD_COVER_KEY_PREFIX + Date.now();
    }

    // 2) 解码 PixelMap 给播控中心
    const pixelMap = await this.decodeCoverPixelMap(buffer);
    const session = this.session;
    if (!session || !pixelMap) {
      // 播控中心拿不到封面不算失败：卡片那份已经准备好了
      this.syncCard();
      return;
    }

    // ⚠️ **不释放** this.currentPixelMap：它已经被交给系统播控中心当作
    // mediaImage 了，释放正在被系统持有的 PixelMap 有让那条控件渲染失败的
    // 风险。旧的那张交给 GC 回收即可（每张 512×512，代价可接受）。
    this.currentPixelMap = pixelMap;
    this.currentCoverUrl = cover;
    this.cachedCoverBuffer = buffer;
    const meta = this.currentMetadata;
    if (meta) {
      meta.mediaImage = pixelMap;
    }

    try {
      await session.setAVMetadata(meta);
      hilog.info(DOMAIN, TAG, 'setAVMetadata(补封面) success: seq=%{public}d', seq);
    } catch (err) {
      hilog.error(DOMAIN, TAG, 'setAVMetadata(补封面) failed: %{public}s', JSON.stringify(err));
    }
    // 3) 卡片补推：封面从"无"变"有"，卡片需要拿到 formImages 才显示得了
    this.syncCard();
  }

  /**
   * 把封面字节写进 cacheDir/card_cover.img（覆盖写）。
   *
   * 2MB 守卫：formImages 单张超限会导致 updateForm 整体失败（卡片整卡停更）。
   * 原始字节超限时降级为「解码 512×512 再重编码 JPEG」（通常 <300KB）后落盘；
   * 压缩也失败才放弃本次写盘，卡片按无封面显示。
   */
  private async saveCoverFile(buffer: ArrayBuffer): Promise<boolean> {
    let bytes = buffer;
    if (buffer.byteLength > MAX_CARD_COVER_BYTES) {
      hilog.warn(DOMAIN, TAG, '封面 %{public}d 字节超过 formImages 2MB 上限，降级压缩重编码',
        buffer.byteLength);
      const packed = await this.compressCoverBytes(buffer);
      if (!packed) {
        hilog.warn(DOMAIN, TAG, '封面压缩失败，卡片本次按无封面显示');
        return false;
      }
      bytes = packed;
    }
    let file: fileIo.File | null = null;
    try {
      const path = this.context.cacheDir + CARD_COVER_PATH;
      file = fileIo.openSync(path, fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
      fileIo.writeSync(file.fd, bytes);
      return true;
    } catch (err) {
      hilog.error(DOMAIN, TAG, '封面落盘失败: %{public}s', JSON.stringify(err));
      return false;
    } finally {
      if (file) {
        try {
          fileIo.closeSync(file);
        } catch (err) {
          // ignore
        }
      }
    }
  }

  /** 超限封面降级：解码 512×512 → JPEG(quality 85) 重编码。失败返回 undefined。 */
  private async compressCoverBytes(buffer: ArrayBuffer): Promise<ArrayBuffer | undefined> {
    const packer = image.createImagePacker();
    try {
      const source = image.createImageSource(buffer);
      const decodingOptions: image.DecodingOptions = {
        desiredSize: { width: 512, height: 512 }
      };
      const pixelMap = await source.createPixelMap(decodingOptions);
      await source.release();
      // packing 自 API 13 起废弃，改用 packToData（同一签名语义）
      const packOpts: image.PackingOption = { format: 'image/jpeg', quality: 85 };
      const packed = await packer.packToData(pixelMap, packOpts);
      await pixelMap.release();
      return packed;
    } catch (err) {
      hilog.error(DOMAIN, TAG, '封面压缩重编码失败: %{public}s', JSON.stringify(err));
      return undefined;
    } finally {
      packer.release();
    }
  }

  /**
   * 更新歌词（系统锁屏 / 播控中心显示用）。
   *
   * ⚠️ 这里曾经在 currentMetadata 为空时**凭空造一条 AVMetadata** 推给系统
   * （assetId 写死 'suen_current'、title 写死 '未知曲目'），于是播控中心一上来
   * 就是「未知曲目」。现在**只用 web 真实送来的数据，绝不编造标题**。
   *
   * ⚠️ 更要紧的一条：**不能依赖 updateMetadata 先到**。web 侧的歌词消息现在
   * 带上了完整元数据，所以单靠这条消息也能把播控中心建立起来 ——
   * 两条路互不依赖，任何一条先到都不会让控件缺失（这是上一版"控件完全消失"
   * 的根因方向：当时歌词消息只在元数据已存在时才推，元数据那条要是没到，
   * 控件就整条都没有了）。
   */
  async updateLyric(payload: MusicMetadataParam): Promise<void> {
    try {
      const session = this.session;
      if (!session) {
        hilog.error(DOMAIN, TAG, '歌词被丢弃：AVSession 尚未就绪');
        return;
      }

      const assetId = payload.assetId || '';

      // 换曲（或首次）：用这条消息自带的元数据把整条状态重建起来。
      // doUpdateMetadata 会推文本、把 lyric 一起带上、再异步补封面。
      if (assetId && assetId !== this.currentAssetId) {
        hilog.info(DOMAIN, TAG, '歌词消息带来新曲目，先重建元数据（assetId=%{public}s）', assetId);
        await this.doUpdateMetadata(payload);
        return;
      }

      const meta = this.currentMetadata;
      if (!meta) {
        // 还没有当前曲目的元数据：这条消息若自带元数据就用它建立，否则只暂存歌词
        if (assetId && (payload.title || payload.artist)) {
          hilog.info(DOMAIN, TAG, '歌词消息自带元数据，先建立播控中心（assetId=%{public}s）', assetId);
          await this.doUpdateMetadata(payload);
          return;
        }
        this.currentLyric = assetId ? payload.lyric || '' : '';
        hilog.info(DOMAIN, TAG, '歌词先于元数据到达，暂存 %{public}d 字（assetId=%{public}s）',
          this.currentLyric.length, assetId || '(空)');
        return;
      }

      // 走到这里说明曲目相同（assetId 为空 = web 那边暂时没有曲目）：
      // 只清/更新歌词，绝不动标题与封面。
      if (!assetId && payload.lyric) {
        hilog.info(DOMAIN, TAG, '歌词缺少 assetId，忽略');
        return;
      }

      const lyric = payload.lyric || '';
      this.currentLyric = lyric;
      // 同上：绝不能赋 undefined。空字符串是"没有歌词"的正常表达。
      meta.lyric = lyric;

      await session.setAVMetadata(meta);
      hilog.info(DOMAIN, TAG, 'setAVMetadata(歌词) success: assetId=%{public}s, len=%{public}d',
        this.currentAssetId || '(空)', lyric.length);

      // 卡片背面显示的歌词跟这一条是同一份 —— 歌词到了就顺带刷卡片
      this.syncCard();
    } catch (err) {
      // 同 updateMetadata：JS 桥不 await，异常绝不能抛回去
      hilog.error(DOMAIN, TAG, 'updateLyric 异常: %{public}s', JSON.stringify(err));
    }
  }

  /**
   * 连续任务（AUDIO_PLAYBACK 长时任务）需要的 WantAgent。
   *
   * ⚠️ 这里**故意不写返回类型**，两个"显然"的写法都是错的：
   *   - `Promise<wantAgent.WantAgent>`：`@kit.AbilityKit` 的 wantAgent 命名空间
   *     **没有导出 `WantAgent` 这个名字**（只有 `getWantAgent`），
   *     报 10505001 'wantAgent' has no exported member named 'WantAgent'。
   *   - `Promise<Object>`：`backgroundTaskManager.startBackgroundRunning()`
   *     的第三个参数正是那个未导出的类型，`Object` 是它的父类型、传不进去，
   *     只会把"名字找不到"换成一个新的"类型不匹配"。
   * 交给类型推断：`getWantAgent()` 的返回类型恰好就是 API 期望的那个类型。
   */
  private async getContinuousTaskWantAgent() {
    const bundleName = this.context.abilityInfo?.bundleName || 'com.suenmusic.app';
    const abilityName = this.context.abilityInfo?.name || 'EntryAbility';
    const targetWant: Want = {
      bundleName: bundleName,
      abilityName: abilityName
    };
    const wantAgentInfo: wantAgent.WantAgentInfo = {
      wants: [targetWant],
      actionType: wantAgent.OperationType.START_ABILITY,
      requestCode: 0,
      actionFlags: [wantAgent.WantAgentFlags.UPDATE_PRESENT_FLAG]
    };
    try {
      return await wantAgent.getWantAgent(wantAgentInfo);
    } catch (e) {
      // 长时任务 wantAgent 拿不到：返回 undefined，startBackgroundRunning 会因
      // 缺 agent 走自己的 catch，不至于把调用方打崩
      hilog.warn(0x0000, 'SuenMusic_AVSession', 'getWantAgent 失败: %{public}s', JSON.stringify(e));
      return undefined;
    }
  }

  async startContinuousTask(): Promise<void> {
    if (this.isContinuousTaskRunning) {
      return;
    }
    try {
      const agent = await this.getContinuousTaskWantAgent();
      await backgroundTaskManager.startBackgroundRunning(
        this.context,
        backgroundTaskManager.BackgroundMode.AUDIO_PLAYBACK,
        agent
      );
      this.isContinuousTaskRunning = true;
      hilog.info(DOMAIN, TAG, 'Continuous task AUDIO_PLAYBACK started successfully');
    } catch (err) {
      hilog.error(DOMAIN, TAG, 'Failed to start continuous task: %{public}s', JSON.stringify(err));
    }
  }

  async stopContinuousTask(): Promise<void> {
    if (!this.isContinuousTaskRunning) {
      return;
    }
    try {
      await backgroundTaskManager.stopBackgroundRunning(this.context);
      this.isContinuousTaskRunning = false;
      hilog.info(DOMAIN, TAG, 'Continuous task AUDIO_PLAYBACK stopped successfully');
    } catch (err) {
      hilog.warn(DOMAIN, TAG, 'Failed to stop continuous task: %{public}s', JSON.stringify(err));
      this.isContinuousTaskRunning = false;
    }
  }

  /** 原生播放内核的便捷入口：调用方不必到处拼 `'playing'/'paused'` 字符串 */
  async updatePlaybackStateFromNative(
    playing: boolean, positionMs: number, durationMs: number
  ): Promise<void> {
    if (this.statePushInFlight) {
      return;
    }
    const now = Date.now();
    const changed = playing !== this.lastPushedPlaying;
    if (!changed && now - this.lastStatePushAt < 900) {
      return;
    }
    this.lastPushedPlaying = playing;
    this.lastStatePushAt = now;
    this.statePushInFlight = true;
    try {
      await this.updatePlaybackState(playing ? 'playing' : 'paused', positionMs, durationMs);
    } finally {
      this.statePushInFlight = false;
    }
  }

  async updatePlaybackState(stateStr: string, positionMs?: number, durationMs?: number): Promise<void> {
    if (!this.session) return;

    try {
      let state = avSession.PlaybackState.PLAYBACK_STATE_PAUSE;
      if (stateStr === 'playing') {
        state = avSession.PlaybackState.PLAYBACK_STATE_PLAY;
        // 收到播放态：清除待停止定时器，并确保后台长时任务已启动（防止切后台被系统冻结挂起）
        if (this.stopTaskTimer !== -1) {
          clearTimeout(this.stopTaskTimer);
          this.stopTaskTimer = -1;
        }
        const wasPlaying = this.isPlaying;
        await this.startContinuousTask();
        if (!wasPlaying) {
          // 暂停/挂起后恢复播放：重新激活会话，防止播控中心控件消失/失灵
          await this.reactivateSession();
        }
      } else if (stateStr === 'stopped' || stateStr === 'idle' || stateStr === 'paused') {
        state = (stateStr === 'stopped' || stateStr === 'idle')
          ? avSession.PlaybackState.PLAYBACK_STATE_STOP
          : avSession.PlaybackState.PLAYBACK_STATE_PAUSE;

        // 暂停或切歌间歇：延时 30 秒停止长时任务。
        // 避免切歌缓冲、短暂停顿导致长时任务被立即注销而引发进程被冻结挂起。
        // 若 30 秒内未恢复播放，则自动释放长时任务以满足系统能效审计要求。
        if (this.stopTaskTimer === -1) {
          this.stopTaskTimer = setTimeout(() => {
            this.stopContinuousTask();
            this.stopTaskTimer = -1;
          }, 30000);
        }
      }

      const elapsed = Math.max(0, Math.round(positionMs || 0));
      const updateTime = new Date().getTime();
      const playbackState: avSession.AVPlaybackState = {
        state: state,
        position: {
          elapsedTime: elapsed,
          updateTime: updateTime
        },
        duration: durationMs || 0
      };

      // 留痕：锁屏歌词的滚动位置由这组数据推算（elapsed + updateTime 外推）。
      // 一旦再出现"控件里比实际快/慢"，这行能直接看出是推的值不对还是外推不对。
      hilog.info(DOMAIN, TAG, 'setAVPlaybackState: state=%{public}d, elapsed=%{public}d, updateTime=%{public}d',
        state, elapsed, updateTime);

      await this.session.setAVPlaybackState(playbackState);

      // web 每 ~1 秒上报一次 positionMs —— 卡片歌词按时间轴滚动靠它。
      // 只在活跃行变化时才推卡片：卡片刷新走 IPC，逐秒推既浪费也不平滑。
      this.currentPositionMs = elapsed;
      const activeIdx = this.currentLyricActiveIndex(elapsed);
      if (activeIdx >= 0) {
        // 有歌词：只在活跃行变化时推 —— 卡片刷新走 IPC，逐秒推既浪费也不平滑
        if (activeIdx !== this.lastCardLyricIndex) {
          this.lastCardLyricIndex = activeIdx;
          this.syncCard();
        }
      } else {
        // 没歌词（纯音乐 / 尚未拉到歌词）：卡片上的进度条只能靠定时推，
        // 否则整首都停在切歌那一刻的位置（重审 F）。5 秒一次折中。
        const nowMs = Date.now();
        if (nowMs - this.lastCardProgressPushAt >= 5000) {
          this.lastCardProgressPushAt = nowMs;
          this.syncCard();
        }
      }

      // 播放/暂停状态一变，卡片上的"播放中/已暂停"就该跟着变
      const nowPlaying = state === avSession.PlaybackState.PLAYBACK_STATE_PLAY;
      if (nowPlaying !== this.isPlaying) {
        this.isPlaying = nowPlaying;
        this.syncCard();
      }
    } catch (err) {
      const be = err as BusinessError;
      if (be.code === 6600102) {
        // 会话已被系统销毁：重建，下一个 ~1s 的进度上报会补回最新播放态
        hilog.warn(DOMAIN, TAG, 'setAVPlaybackState hit 6600102 (session gone), rebuilding');
        await this.rebuildSession();
      } else {
        hilog.error(DOMAIN, TAG, 'setAVPlaybackState failed: %{public}s', JSON.stringify(err));
      }
    }
  }

  /**
   * 下载封面原始字节。
   *
   * ⚠️ 必须显式 `expectDataType: ARRAY_BUFFER`：不指定时拿到的可能是 string，
   *    下面 `instanceof ArrayBuffer` 就永远为 false —— 封面永远拉不到，
   *    而且旧代码在这条分支上**一行日志都不打**，是它最难排查的地方。
   *    现在三种失败（非 200 / 拿到非二进制 / 解码抛异常）都会留下日志。
   */
  private async downloadCoverData(url: string): Promise<ArrayBuffer | undefined> {
    const httpRequest = http.createHttp();
    try {
      const response = await httpRequest.request(url, {
        method: http.RequestMethod.GET,
        connectTimeout: 5000,
        readTimeout: 5000,
        expectDataType: http.HttpDataType.ARRAY_BUFFER,
        header: {
          'Referer': ''
        }
      });

      if (response.responseCode !== 200) {
        hilog.error(DOMAIN, TAG, '封面下载失败：HTTP %{public}d（%{public}s）',
          response.responseCode, url);
        return undefined;
      }

      if (!(response.result instanceof ArrayBuffer)) {
        hilog.error(DOMAIN, TAG,
          '封面下载拿到的是非二进制内容（HTTP %{public}d）：expectDataType 未生效或上游返回了文本（%{public}s）',
          response.responseCode, url);
        return undefined;
      }
      hilog.info(DOMAIN, TAG, '封面下载成功：%{public}s（%{public}d 字节）',
        url, response.result.byteLength);
      return response.result;
    } catch (err) {
      hilog.error(DOMAIN, TAG, '封面下载异常 %{public}s: %{public}s', url, JSON.stringify(err));
      return undefined;
    } finally {
      httpRequest.destroy();
    }
  }

  /** 解码封面字节为 PixelMap（播控中心 mediaImage 用） */
  private async decodeCoverPixelMap(buffer: ArrayBuffer): Promise<image.PixelMap | undefined> {
    try {
      const imageSource = image.createImageSource(buffer);
      const decodingOptions: image.DecodingOptions = {
        desiredSize: { width: 512, height: 512 }
      };
      const pixelMap = await imageSource.createPixelMap(decodingOptions);
      await imageSource.release();
      hilog.info(DOMAIN, TAG, '封面解码成功');
      return pixelMap;
    } catch (err) {
      hilog.error(DOMAIN, TAG, '封面解码异常: %{public}s', JSON.stringify(err));
      return undefined;
    }
  }

  async destroy(): Promise<void> {
    if (this.stopTaskTimer !== -1) {
      clearTimeout(this.stopTaskTimer);
      this.stopTaskTimer = -1;
    }
    await this.stopContinuousTask();
    if (!this.session) return;
    try {
      if (this.currentPixelMap) {
        await this.currentPixelMap.release();
        this.currentPixelMap = null;
      }
      await this.session.destroy();
      this.session = null;
      hilog.info(DOMAIN, TAG, 'AVSession destroyed');
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'Failed to destroy AVSession: %{public}s', JSON.stringify(e));
    }
  }
}

export { HarmonyAVSessionManager, MusicMetadataParam, FavoriteUpdateParam };
