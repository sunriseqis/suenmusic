/**
 * 全屏播放页（T10 批次 F 重构：对齐 web FullPlayer 移动断点）。
 *
 * 结构（web FullPlayer）：
 *   · 顶栏三件：chevron-down 收起 + 中央 eyebrow（正在播放/已停止/错误）+ ellipsis 更多菜单
 *   · 环境光晕（封面模糊垫底）+ 封面主体 + 曲名/歌手·专辑行 + 红心
 *   · 专属推荐理由卡 + 两级不喜欢浮层（批次 A 已有，随层键接入返回手势）
 *   · 底部：进度条 + 五键（模式 | 上一首/播放/下一首 | 队列）+ 错误重试行 + 3 行歌词 peek
 *   · 歌词 sheet / 队列 sheet（底部抽屉）滑动进出，web 同款层级：
 *     dislike > more > queue > lyrics > 关播放页（NativeRoot onBackPress 读 K_PLAYER_SHEET）
 *   · 修正音源锚定弹窗（'anchor' 层，web AnchorDialog）：候选搜索 / 行点击试听
 *     （试听前暂停主播放，停试听恢复）/ 锚定 / 已有锚点解除；锚定后清旧音源缓存重装
 *     当前曲（服务端已清解析缓存，重装即走新锚点）
 *
 * 播放状态机仍在 `MediaPlayerCore`；播放模式（5 态环）也由内核持有，
 * 本页只做展示与 cycleMode 触发。
 */

import { hilog } from '@kit.PerformanceAnalysisKit';
import { media } from '@kit.MediaKit';
import { BusinessError } from '@kit.BasicServicesKit';
import {
  MediaPlayerCore, K_TITLE, K_ARTIST, K_COVER, K_PLAYING, K_POS, K_DUR, K_INDEX,
  K_TRACKID, K_PLAY_MODE, K_ORIGIN, K_SOURCE
} from '../core/MediaPlayerCore';
import { APIClient } from '../core/APIClient';
import { Track, BiliCandidate, AnchorTrackMeta, TrackAnchorInfo } from '../core/Models';
import { OfflineCache } from '../core/OfflineCache';
import { AppState, K_FAV_REV, K_PLAYER_SHEET } from '../viewmodel/AppState';
import { openCollection } from '../common/CollectionNav';
import { Tokens } from '../common/Tokens';
import { Dim, Motion } from '../common/Dimension';
import { AppToast } from '../common/AppToast';
import { DislikeDialog } from '../common/DislikeDialog';
import { Copy, cleanAiText } from '../common/Copy';
import { LyricView, fetchLyricDoc, peekLyric } from './LyricView';
import { LyricLine } from '../common/NowPlaying';
import { QueueView } from './QueueView';
import { NeuInput } from './NeuInput';
import { WebIcon, WebIconButton, WebIconName, NeuBtnChrome } from '../common/WebIcons';
import { WebButton, NeuBtnVariant, NeuBtnSize } from '../common/WebButtons';

const TAG = 'SuenMusic_Player';

@Component
export struct PlayerPage {
  @StorageLink(K_TITLE) title: string = '';
  @StorageLink(K_ARTIST) artist: string = '';
  @StorageLink(K_COVER) cover: string = '';
  @StorageLink(K_PLAYING) playing: boolean = false;
  @StorageLink(K_POS) @Watch('refreshPeek') positionMs: number = 0;
  @StorageLink(K_DUR) durationMs: number = 1;
  @StorageLink(K_INDEX) index: number = -1;
  @StorageLink('np_error') err: string = '';
  @StorageLink(K_PLAY_MODE) playMode: string = 'order';
  /** 队列来源（第 ④ 条）：eyebrow「状态 · 来源」，setQueue 装载方写入 */
  @StorageLink(K_ORIGIN) origin: string = '';
  /** 播放页内部浮层层级（唯一写入方；NativeRoot 返回手势读它逐层关） */
  @StorageLink(K_PLAYER_SHEET) sheet: string = 'none';

  // 窗口全屏布局下的系统避让区实时值（顶部收起钮与底部 peek 需避开刘海/手势条）
  /** 当前曲的真实音源（bilibili / netease；空 = 未匹配），由内核每曲发布 */
  @StorageProp(K_SOURCE) npSource: string = '';
  @StorageProp('topAvoidHeight') topAvoidHeight: number = 0;
  @StorageProp('bottomAvoidHeight') bottomAvoidHeight: number = 0;

  // 拖动进度条期间不能用播放位置驱动滑块（松手才 seek，见 bottomFoot） */
  @State dragging: boolean = false;
  @State dragPos: number = 0;
  /** 切歌即收起 dislike/more 浮层（web watch track.id 同口径） */
  @StorageLink(K_TRACKID) @Watch('onTrackChanged') trackId: string = '';
  // 歌词 peek（当前行附近 3 行；面板未开时靠 fetchLyricDoc 预热缓存）
  @State peekLines: LyricLine[] = [];
  @State peekActive: number = -1;
  // 红心：切歌 / 收藏集变化时异步刷新当前曲收藏态（NativeRoot 迷你条同款）
  @StorageProp(K_FAV_REV) @Watch('refreshFav') favRev: number = 0;
  @State favored: boolean = false;

  // 修正音源 / 手动锚定（web AnchorDialog：候选搜索 → 试听 → 锚定；已有锚点可解除）
  @State anchorKeyword: string = '';
  @State anchorCandidates: BiliCandidate[] = [];
  @State anchorMeta: AnchorTrackMeta | null = null;
  @State anchorSearching: boolean = false;
  /** 风控 / 空结果等说明文字 */
  @State anchorNote: string = '';
  /** 该曲目已存在的锚点（更多菜单「音源」标签 + 锚定弹窗回显/解除） */
  @State anchorInfo: TrackAnchorInfo | null = null;
  /** 正在试听的候选（bvid；空 = 没在放） */
  @State previewingBvid: string = '';
  /** 正在提交锚定的候选 */
  @State anchoringBvid: string = '';
  @State removingAnchor: boolean = false;
  /** 试听用的独立 AVPlayer（单实例：换条即换 URI，关弹窗/切歌即停；不动主播放内核） */
  private previewPlayer: media.AVPlayer | null = null;
  /** 试听把主播放暂停了（停试听时要恢复；锚定流程例外：重装后统一起播） */
  private previewPausedMain: boolean = false;

  /** 避让区 px → vp（走 UIContext 实例方法，全局 px2vp 已弃用） */
  private avoidVp(px: number): number {
    return this.getUIContext().px2vp(px);
  }

  onClose: () => void = () => {};

  aboutToAppear(): void {
    this.refreshFav();
    this.refreshPeek();
    this.warmPeek();
    this.loadCurrentAnchor();
  }

  aboutToDisappear(): void {
    this.stopPreview(true);
  }

  private onTrackChanged(): void {
    // 歌词/队列 sheet 跨曲保留（内容跟着新曲刷新）；dislike/more/anchor 随曲收起
    if (this.sheet === 'dislike' || this.sheet === 'more' || this.sheet === 'anchor') {
      this.sheet = 'none';
    }
    this.stopPreview(true);
    this.anchorCandidates = [];
    this.anchorMeta = null;
    this.anchorNote = '';
    this.anchoringBvid = '';
    this.refreshPeek();
    this.warmPeek();
    this.loadCurrentAnchor();
  }

  // ---------------- 歌词 peek（web lyric-peek 3 行） ----------------

  private refreshPeek(): void {
    const p = peekLyric(this.trackId, this.positionMs);
    this.peekLines = p.lines;
    this.peekActive = p.activeIndex;
  }

  /** 面板未开时也要有词：预热模块级歌词缓存（缓存命中即空转） */
  private async warmPeek(): Promise<void> {
    const id = this.trackId;
    if (id.length === 0) { return; }
    await fetchLyricDoc(id);
    if (this.trackId === id) {
      this.refreshPeek();
    }
  }

  // ---------------- 红心（web mini-action toggleCurrentFav 同口径） ----------------

  private async refreshFav(): Promise<void> {
    if (this.trackId.length === 0) {
      this.favored = false;
      return;
    }
    try {
      const ids = await APIClient.shared().favoredIds([this.trackId]);
      this.favored = ids.indexOf(this.trackId) >= 0;
    } catch (e) {
      // 静默：收藏标记失败不该影响播放页
    }
  }

  private async toggleFav(): Promise<void> {
    if (this.trackId.length === 0) { return; }
    const was = this.favored;
    this.favored = !was;
    try {
      if (was) {
        await APIClient.shared().removeFavorite(this.trackId);
      } else {
        await APIClient.shared().addFavorite(this.trackId, this.currentTrack());
      }
      AppState.shared().bumpFavRev();
    } catch (e) {
      this.favored = was;
      this.showToast(Copy.describeError(e));
    }
  }

  // ---------------- 播放模式（内核 cycleMode；本页只做图标/文案映射） ----------------

  private modeLabelOf(m: string): string {
    if (m === 'shuffle') { return Copy.modeShuffle; }
    if (m === 'repeat-one') { return Copy.modeRepeatOne; }
    if (m === 'list-loop') { return Copy.modeListLoop; }
    if (m === 'shuffle-once') { return Copy.modeShuffleOnce; }
    return Copy.modeOrder;
  }

  /** 当前模式的 web 图标名（第 ⑧ 条：sys.symbol 换 web 自绘图标，视觉重量两端一致） */
  private modeIconName(): string {
    if (this.playMode === 'shuffle') { return WebIconName.MODE_SHUFFLE; }
    if (this.playMode === 'shuffle-once') { return WebIconName.MODE_SHUFFLE_ONCE; }
    if (this.playMode === 'repeat-one') { return WebIconName.MODE_REPEAT_ONE; }
    if (this.playMode === 'list-loop') { return WebIconName.MODE_LOOP; }
    return WebIconName.MODE_ORDER;
  }

  /** 非默认顺序模式 = 激活态（web mode-btn active 琥珀） */
  private modeActive(): boolean {
    return this.playMode !== 'order';
  }

  private cycleModeWithToast(): void {
    const m = MediaPlayerCore.shared().cycleMode();
    this.showToast(`播放模式：${this.modeLabelOf(m)}`);
  }

  // ---------------- 修正音源 / 手动锚定（web AnchorDialog 同口径） ----------------

  /** 已锚定 → bilibili；否则未解析（hw 无逐曲音源追踪：走 AVPlayer 拿不到解析响应，网易云分支无从得知，回执记差异） */
  /**
   * 「音源」行文案（用户 2026-10-23 裁定：**bilibili / 网易云 / 未匹配**）。
   * 取内核每曲发布的真实解析来源，不再只按「有没有锚点」猜。
   * 锚定过的曲目服务端 resolve 直接回锚点来源，因此锚定后这里自然是 bilibili。
   */
  private sourceLabel(): string {
    if (this.npSource === 'bilibili') {
      return 'bilibili';
    }
    if (this.npSource === 'netease') {
      return '网易云';
    }
    // 兜底：解析还没回来/失败但已手动锚定 —— 锚点必然是 bilibili
    if (this.npSource.length === 0 && this.anchorInfo !== null) {
      return 'bilibili';
    }
    return '未匹配';
  }

  private currentAnchorText(): string {
    const a = this.anchorInfo;
    if (a === null) { return ''; }
    const t = a.title.length > 0 ? a.title : a.bvid;
    return a.author.length > 0 ? `锚点 ${t} · ${a.author}` : `锚点 ${t}`;
  }

  /** 查该曲已有锚点（失败静默，按未锚定展示） */
  private async loadCurrentAnchor(): Promise<void> {
    const id = this.trackId;
    if (id.length === 0) {
      this.anchorInfo = null;
      return;
    }
    try {
      const res = await APIClient.shared().fetchTrackAnchor(id);
      if (this.trackId === id) { this.anchorInfo = res.anchor; }
    } catch (e) {
      if (this.trackId === id) { this.anchorInfo = null; }
    }
  }

  /** 打开锚定弹窗：关键词默认「歌名 + 主歌手」并自动搜一轮（web watch(track) 同口径） */
  private openAnchorSheet(): void {
    const t = this.currentTrack();
    if (t === null) { return; }
    this.stopPreview(true);
    const first = t.ar.length > 0 ? t.ar[0].name : '';
    this.anchorKeyword = (t.name + ' ' + first).trim();
    this.anchorCandidates = [];
    this.anchorMeta = null;
    this.anchorNote = '';
    this.anchoringBvid = '';
    this.sheet = 'anchor';
    this.searchAnchor();
    this.loadCurrentAnchor();
  }

  private closeAnchorSheet(): void {
    this.stopPreview(true);
    this.sheet = 'none';
  }

  private async searchAnchor(): Promise<void> {
    const id = this.trackId;
    if (id.length === 0 || this.anchorSearching) { return; }
    this.anchorSearching = true;
    this.anchorNote = '';
    this.stopPreview(true);
    try {
      const res = await APIClient.shared().biliCandidates(id, this.anchorKeyword);
      if (this.trackId !== id) { return; }
      this.anchorCandidates = res.candidates;
      // Q 音侧的原版参照：歌名 / 歌手·专辑 / 时长，对着它挑 B 站视频
      this.anchorMeta = res.track;
      if (res.rejected) {
        this.anchorNote = res.message !== undefined && res.message.length > 0
          ? res.message : 'bilibili 搜索被风控拦截，请稍后重试';
      } else if (res.candidates.length === 0) {
        this.anchorNote = '没有搜到候选视频，换个关键词试试';
      }
    } catch (e) {
      if (this.trackId === id) {
        this.anchorNote = Copy.describeError(e);
      }
    } finally {
      this.anchorSearching = false;
    }
  }

  /** 候选时长与曲目差得多 → 大概率不是同一录音（阈值 20 秒，web durationMismatch 同口径） */
  private durationMismatch(c: BiliCandidate): boolean {
    return Math.abs(c.durationDiff) > 20;
  }

  /** 服务端给的 durationDiff 是绝对值，不声称长/短方向（web 同口径） */
  private durationDiffText(c: BiliCandidate): string {
    return `差 ${Math.round(Math.abs(c.durationDiff))} 秒`;
  }

  /**
   * 停试听。resumeMain：被试听暂停的主播放是否随之恢复。
   * 锚定流程传 false —— 马上要重装当前曲（retryCurrent 后统一起播），先恢复会闪一下旧音源。
   */
  private stopPreview(resumeMain: boolean): void {
    this.previewingBvid = '';
    const p = this.previewPlayer;
    this.previewPlayer = null;
    if (p !== null) {
      p.release().catch((): void => {});
    }
    if (this.previewPausedMain) {
      this.previewPausedMain = false;
      if (resumeMain) {
        MediaPlayerCore.shared().play().catch((): void => {});
      }
    }
  }

  /**
   * 点候选行即试听（独立 AVPlayer 单实例：换条即换 URI；失败/播完自动收）。
   * 试听前必须先停主播放 —— 两条音频叠着放，用户根本听不出试听的是哪条（2026-10-23 验收反馈）。
   */
  private async previewCandidate(c: BiliCandidate): Promise<void> {
    if (this.previewingBvid === c.bvid) {
      // 再点同一行 = 停试听，主播放恢复
      this.stopPreview(true);
      return;
    }
    // 换行试听：主播放保持暂停，直接切新条
    this.stopPreview(false);
    const core = MediaPlayerCore.shared();
    if (core.isPlaying) {
      this.previewPausedMain = true;
      await core.pause();
    }
    const url = APIClient.shared().getBaseUrl() + c.previewUrl;
    this.previewingBvid = c.bvid;
    media.createAVPlayer().then((player: media.AVPlayer) => {
      // 等待创建期间又点了别的条 / 已被关掉：弃用这个新实例
      if (this.previewingBvid !== c.bvid) {
        player.release().catch((): void => {});
        return;
      }
      this.previewPlayer = player;
      player.on('error', () => {
        this.stopPreview(true);
        this.showToast('试听加载失败，请稍后重试');
      });
      player.on('stateChange', (state: string) => {
        if (state === 'initialized') {
          // AVPlayer 官方时序：initialized 必须显式 prepare() 才会到 prepared ——
          // 漏了这步播放器停在 initialized，无声也无报错（试听无声的根因，2026-10-23 验收反馈）
          player.prepare().catch((): void => {});
        } else if (state === 'prepared') {
          player.play().catch((): void => {});
        } else if (state === 'completed' || state === 'stopped') {
          // 试听自然播完：把主播放接回来
          this.stopPreview(true);
        }
      });
      player.url = url;
    }).catch((e: BusinessError) => {
      this.stopPreview(true);
      this.showToast('试听加载失败，请稍后重试');
    });
  }

  /** 锚定落地（web doAnchor 同口径）：入库 → 停试听 → 清旧音源缓存 → 重装当前曲走新锚点 */
  private async doAnchor(c: BiliCandidate): Promise<void> {
    const t = this.currentTrack();
    if (t === null || this.anchoringBvid.length > 0) { return; }
    this.anchoringBvid = c.bvid;
    try {
      await APIClient.shared().anchorTrack(t.id, {
        bvid: c.bvid,
        title: c.title,
        author: c.author,
        durationSec: c.durationSec
      });
      this.stopPreview(false);
      this.anchoringBvid = '';
      this.anchorInfo = null;
      this.sheet = 'none';
      this.showToast('已锚定，开始播放');
      // 旧音源字节以曲目 id 缓存（fd:// 优先）：不清会直接盖住新锚点（web retryAfterAnchor 同坑）
      OfflineCache.shared().setProtected('');
      OfflineCache.shared().remove(t.id);
      // 服务端锚定时已清解析缓存，重装当前曲即走新锚点。
      // forcePlay：主播放被试听暂停时 wantPlay=false，普通 retryCurrent 会重装成暂停态；
      // 装完再补 play() 又与 prepared 竞态（偶尔不起播的根因）—— 走 loadCurrent 起播链
      await MediaPlayerCore.shared().retryCurrent(true);
      await this.loadCurrentAnchor();
    } catch (e) {
      this.anchoringBvid = '';
      this.showToast(Copy.describeError(e));
    }
  }

  /** 解除锚定：该曲目回到自动匹配 */
  private async removeCurrentAnchor(): Promise<void> {
    const id = this.trackId;
    if (id.length === 0 || this.removingAnchor) { return; }
    this.removingAnchor = true;
    try {
      await APIClient.shared().unanchorTrack(id);
      this.anchorInfo = null;
      this.showToast('已解除锚定，该曲目回到自动匹配');
    } catch (e) {
      this.showToast(Copy.describeError(e));
    } finally {
      this.removingAnchor = false;
    }
  }

  /** 原版参照副行：歌手 ' / ' 连接 · 专辑（web ref-card 同口径） */
  private refSubLine(): string {
    const m = this.anchorMeta;
    if (m === null) { return ''; }
    const artists = m.artists.join(' / ');
    if (artists.length > 0 && m.albumName.length > 0) { return `${artists} · ${m.albumName}`; }
    return artists.length > 0 ? artists : m.albumName;
  }

  /** 原版参照副行（紧凑合并版）：歌手·专辑 · 参考时长 —— 三行并两行（用户反馈信息密度过高） */
  private refMetaLine(): string {
    const m = this.anchorMeta;
    if (m === null) { return ''; }
    const sub = this.refSubLine();
    const dur = this.mmss(m.durationMs);
    return sub.length > 0 ? `${sub} · ${dur}` : `参考时长 ${dur}`;
  }

  // ---------------- 更多菜单（web dots：歌手 / 专辑；音源类 hw 无链路，回执记差异） ----------------

  private hasArtistEntry(): boolean {
    const t = this.currentTrack();
    return t !== null && t.ar.length > 0 && t.ar[0].id.length > 0;
  }

  private hasAlbumEntry(): boolean {
    const t = this.currentTrack();
    return t !== null && t.al.id.length > 0;
  }

  private goArtist(): void {
    const t = this.currentTrack();
    if (t === null || t.ar.length === 0 || t.ar[0].id.length === 0) { return; }
    const first = t.ar[0];
    this.sheet = 'none';
    this.onClose();
    openCollection('artist', first.id, first.name);
  }

  private goAlbum(): void {
    const t = this.currentTrack();
    if (t === null || t.al.id.length === 0) { return; }
    this.sheet = 'none';
    this.onClose();
    openCollection('album', t.al.id, t.al.name);
  }

  // ---------------- 专属推荐理由卡 + 两级不喜欢（批次 A，随层键接入） ----------------

  /** 当前播放曲目（队列快照按下标取；K_INDEX/K_TITLE 变化驱动重渲染） */
  private currentTrack(): Track | null {
    const q = MediaPlayerCore.shared().getQueueSnapshot();
    if (this.index < 0 || this.index >= q.length) { return null; }
    return q[this.index];
  }

  /** 是否携带专属推荐理由（有卡时封面收缩让位，web has-reco） */
  private hasReco(): boolean {
    const t = this.currentTrack();
    return t !== null && t.recommendReason !== undefined && t.recommendReason.length > 0;
  }

  private recoText(): string {
    const t = this.currentTrack();
    if (t === null || t.recommendReason === undefined) { return ''; }
    return cleanAiText(t.recommendReason);
  }

  private firstArtistName(): string {
    const t = this.currentTrack();
    if (t === null || t.ar.length === 0) { return this.artist; }
    return t.ar[0].name;
  }

  /** 副行：歌手 · 专辑（web t-sub 同口径） */
  private subLine(): string {
    const t = this.currentTrack();
    const album = t !== null && t.al.name.length > 0 ? t.al.name : '';
    return album.length > 0 ? `${this.artist} · ${album}` : this.artist;
  }

  /** 顶栏 eyebrow（web head-eyebrow 同口径）：错误 > 「正在播放/已停止 · 来源」（第 ④ 条） */
  private eyebrowText(): string {
    if (this.err.length > 0) { return this.err; }
    const status = this.playing ? '正在播放' : '已停止';
    return this.origin.length > 0 ? `${status} · ${this.origin}` : status;
  }

  /** 轻提示走自绘 AppToast（系统 toast 在沉浸式窗口实测漂到顶部偏右，用户 2026-10-23 反馈） */
  private showToast(message: string): void {
    AppToast.show(message);
  }

  /** 队列里该歌手的歌（当前曲除外）从尾往头删，前面的下标不失效；当前曲最后摘触发切歌 */
  private async removeArtistFromQueue(mid: string, currentId: string): Promise<void> {
    const core = MediaPlayerCore.shared();
    const q = core.getQueueSnapshot();
    const targets: number[] = [];
    for (let i = 0; i < q.length; i++) {
      if (q[i].id === currentId) { continue; }
      const a = q[i].ar.length > 0 ? q[i].ar[0] : null;
      if (a !== null && (a.mid ?? '') === mid) { targets.push(i); }
    }
    targets.sort((a: number, b: number): number => b - a);
    for (let k = 0; k < targets.length; k++) {
      await core.removeAt(targets[k]);
    }
    const q2 = core.getQueueSnapshot();
    for (let i = 0; i < q2.length; i++) {
      if (q2[i].id === currentId) {
        await core.removeAt(i);
        break;
      }
    }
  }

  /** 两级不喜欢落地（web FullPlayer onDislike 同口径）：toast + 队列摘除 + 通知每日页重拉 */
  private async doDislike(kind: string): Promise<void> {
    const t = this.currentTrack();
    if (t === null) { return; }
    this.sheet = 'none';
    try {
      if (kind === 'track') {
        await APIClient.shared().dislike('track', t.id, t.name);
        this.showToast(`已将《${t.name}》移出推荐，后续将减少同类推荐`);
        if (this.index >= 0) {
          await MediaPlayerCore.shared().removeAt(this.index);
        }
      } else {
        const first = t.ar.length > 0 ? t.ar[0] : null;
        const mid = first === null ? '' : (first.mid ?? '');
        if (mid.length === 0) {
          this.showToast('该歌曲无歌手信息');
          return;
        }
        await APIClient.shared().dislike('artist', mid, first === null ? '' : first.name);
        this.showToast(`已屏蔽歌手「${first === null ? '' : first.name}」，后续将不再推荐`);
        await this.removeArtistFromQueue(mid, t.id);
      }
    } catch (e) {
      this.showToast(Copy.describeError(e));
      hilog.warn(0x0000, TAG, 'dislike 失败: %{public}s', JSON.stringify(e));
      return;
    }
    AppState.shared().bumpDailyRefresh();
  }

  private mmss(ms: number): string {
    const total = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  }

  // ---------------- Builder ----------------


  /** 专属推荐理由卡（web m-info-card）：标签 + 不喜欢入口 + 理由正文 */
  @Builder
  recoCard() {
    // 用户 2026-10-23：文字离卡片顶部空隙过大、上下留白不对称。
    // 根因：dislike 键是 44 触控区，塞在标题 Row 里把整行撑到 44 高，标题文字被垂直居中 →
    // 顶部看起来多出 ~14vp，而底部只有 padding 12vp。
    // 改法：键**绝对定位**在卡片右上角（Stack TopEnd，不参与行高），标题行回到文字高度，
    // 上下用同一档 padding，留白对称；正文因此也能完整显示。
    Column({ space: Dim.s2 }) {
      Row() {
        Text('专属推荐理由')
          .fontSize(Dim.fsCaption)
          .fontWeight(FontWeight.Medium)
          .fontColor(Tokens.text2)
        Blank()
        // 单图标「不喜欢」入口：透明底，不使用强调色。
        // **键壳 36**：卡片标题文字行高（fsCaption≈11fp → 实测量出来比 36 还高一点点），
        // 键不再把整行撑高 → 上下留白对称、正文不被挤压，也不会盖到正文首行。
        Row() {
          WebIcon(WebIconName.DISLIKE_SONG, Dim.icon12,
            this.sheet === 'dislike' ? '#E5484D' : Tokens.text2)
        }
        .width(Dim.btnMd)
        .height(Dim.btnMd)
        .justifyContent(FlexAlign.Center)
        .backgroundColor(Color.Transparent)
        .accessibilityText('不喜欢')
        .onClick(() => {
          this.sheet = this.sheet === 'dislike' ? 'none' : 'dislike';
        })
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)

      Text(this.recoText())
        .fontSize(Dim.fsMinor)
        .fontColor(Tokens.text2)
        .width('100%')
    }
    .width('100%')
    // top 取 0：标题行被 36 键壳撑到 36vp，文字垂直居中天然带 ~11.6vp 上留白；
    // 若再加 top padding 就和底部（s3=12vp）不对等了 —— 这是用户反馈的「顶部空隙过大」的直接来源。
    .padding({ left: Dim.s3, right: Dim.s3, top: 0, bottom: Dim.s3 })
    .borderRadius(Dim.radiusSm)
    .border({ width: Dim.hairline, color: Tokens.line })
    .backgroundColor(Tokens.panel2)
  }

  /** 封面 + 曲名/副行/红心 + 推荐卡（web FullPlayer 主区） */
  @Builder
  coverView() {
    Column({ space: Dim.s4 }) {
      Image(this.cover.length > 0 ? this.cover : $r('app.media.app_icon'))
        .width(this.hasReco() ? Dim.coverReco : Dim.coverXl)
        .height(this.hasReco() ? Dim.coverReco : Dim.coverXl)
        .borderRadius(Dim.radiusLg)
        .objectFit(ImageFit.Cover)

      Row({ space: Dim.s2 }) {
        Column({ space: Dim.s0 }) {
          Text(this.title)
            .fontSize(Dim.fsHero)
            .fontWeight(FontWeight.Medium)
            .fontColor(Tokens.text1)
            .maxLines(2)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
          Text(this.subLine())
            .fontSize(Dim.fsBody)
            .fontColor(Tokens.text2)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }
        .alignItems(HorizontalAlign.Start)
        .layoutWeight(1)

        // 红心（web info-main plain 键，第 ③ 条）：web 自绘 heart 图标
        WebIconButton({
          iconName: this.favored ? WebIconName.HEART_FILLED : WebIconName.HEART,
          boxSize: 36,
          glyphColor: this.favored ? Tokens.accent : Tokens.text2,
          chromeKind: NeuBtnChrome.PLAIN,
          onTap: () => {
            this.toggleFav();
          }
        })
          .accessibilityText(this.favored ? '取消收藏' : '收藏')
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)

      // 推荐卡（不喜欢的选择弹窗已改为页面级自绘 DislikeDialog，不再用贴着卡片上弹的小浮层）
      if (this.hasReco()) {
        this.recoCard()
      }
    }
    .width('100%')
    .layoutWeight(1)
    .justifyContent(FlexAlign.Center)
  }

  /** 底部：进度条 + 五键控制排 + 错误重试 + 歌词 peek（web FullPlayer foot） */
  @Builder
  bottomFoot() {
    Column({ space: Dim.s2 }) {
      Slider({
        value: this.dragging ? this.dragPos : Math.min(this.positionMs, this.durationMs),
        min: 0,
        max: Math.max(1, this.durationMs),
        step: 1000
      })
        .selectedColor(Tokens.accent)
        .trackColor(Tokens.panel)
        .blockColor(Tokens.accent)
        .onChange((v: number, mode: SliderChangeMode) => {
          if (mode === SliderChangeMode.Begin) {
            this.dragging = true;
            this.dragPos = v;
          } else if (mode === SliderChangeMode.Moving) {
            this.dragPos = v;
          } else {
            this.dragging = false;
            MediaPlayerCore.shared().seek(Math.round(v));
          }
        })
      Row() {
        Text(this.mmss(this.positionMs)).fontSize(Dim.fsCaption).fontColor(Tokens.text2)
        Blank()
        Text(this.mmss(this.durationMs)).fontSize(Dim.fsCaption).fontColor(Tokens.text2)
      }
      .width('100%')

      // 五键控制排（web controls：模式翼 | 上一首/播放/下一首 | 队列翼；第 ③⑧ 条 web 图标键）
      Row() {
        WebIconButton({
          iconName: this.modeIconName(),
          boxSize: 36,
          glyphColor: this.modeActive() ? Tokens.accent : Tokens.text2,
          chromeKind: NeuBtnChrome.PLAIN,
          onTap: () => {
            this.cycleModeWithToast();
          }
        })
          .accessibilityText(`播放模式：${this.modeLabelOf(this.playMode)}`)

        Blank()

        Row({ space: Dim.s4 }) {
          WebIconButton({
            iconName: WebIconName.PREV,
            boxSize: 44,
            glyphColor: Tokens.text1,
            chromeKind: NeuBtnChrome.PLAIN,
            onTap: () => {
              MediaPlayerCore.shared().prev();
            }
          })
            .accessibilityText('上一首')

          WebIconButton({
            iconName: this.playing ? WebIconName.PAUSE : WebIconName.PLAY,
            boxSize: 60,
            glyphColor: Tokens.accent,
            chromeKind: NeuBtnChrome.GRADIENT,
            onTap: () => {
              MediaPlayerCore.shared().toggle();
            }
          })
            .accessibilityText(this.playing ? '暂停' : '播放')

          WebIconButton({
            iconName: WebIconName.NEXT,
            boxSize: 44,
            glyphColor: Tokens.text1,
            chromeKind: NeuBtnChrome.PLAIN,
            onTap: () => {
              MediaPlayerCore.shared().next();
            }
          })
            .accessibilityText('下一首')
        }
        .alignItems(VerticalAlign.Center)

        Blank()

        WebIconButton({
          iconName: WebIconName.LIST,
          boxSize: 36,
          glyphColor: Tokens.text2,
          chromeKind: NeuBtnChrome.PLAIN,
          onTap: () => {
            this.sheet = 'queue';
          }
        })
          .accessibilityText('播放队列')
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)

      if (this.err.length > 0) {
        Text(this.err)
          .fontSize(Dim.fsMinor)
          .fontColor('#E5484D')
          .maxLines(2)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')
          .textAlign(TextAlign.Center)
        // 失败处理（T4 + 2026-10-23 用户裁定）：内核不再自动跳过，动作交给用户
        // 重试 = 重装当前曲；跳过 = 主动播下一首；「更多 → 修正音源」可就地锚定
        Row({ space: Dim.s2 }) {
          WebButton({
            labelStr: '重试',
            sizeKind: NeuBtnSize.MD,
            onTap: () => {
              this.err = '';
              MediaPlayerCore.shared().retryCurrent();
            }
          })
            .accessibilityText('重试播放当前歌曲')
          WebButton({
            labelStr: '跳过',
            variantKind: NeuBtnVariant.GHOST,
            sizeKind: NeuBtnSize.MD,
            onTap: () => {
              this.err = '';
              MediaPlayerCore.shared().next();
            }
          })
            .accessibilityText('跳过这首歌，播放下一首')
        }
      }

      // 歌词 peek（web lyric-wrap：当前行 ±1，点开歌词 sheet）
      Column({ space: Dim.s1 }) {
        ForEach(this.peekLines, (line: LyricLine, i: number) => {
          // web .peek-line.on：accent 13px Medium；非当前行：t2 12px opacity .5
          Text(line.text)
            .fontSize(i === this.peekActive ? Dim.fsBody : Dim.fsMinor)
            .fontWeight(i === this.peekActive ? FontWeight.Medium : FontWeight.Normal)
            .fontColor(i === this.peekActive ? Tokens.accent : Tokens.text2)
            .opacity(i === this.peekActive ? 1 : 0.5)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .width('100%')
            .textAlign(TextAlign.Center)
        }, (line: LyricLine, i: number) => `${i}_${line.timeMs}`)
      }
      .width('100%')
      .constraintSize({ minHeight: Dim.peekH })
      .justifyContent(FlexAlign.Center)
      .accessibilityText('展开歌词')
      .onClick(() => {
        this.sheet = 'lyrics';
      })
    }
    .width('100%')
    .padding({ top: Dim.s2, bottom: Dim.s2 })
  }

  /** 歌词 sheet（web LyricsPanel：整页上滑，顶栏 eyebrow + chevron-down 收起） */
  @Builder
  lyricSheet() {
    Column() {
      // 头（第 ⑦ 条，web LyricsPanel 同款）：eyebrow 左对齐撑满 + chevron-down 收起钮靠右
      Row() {
        Text(`歌词 · ${this.title}`)
          .fontSize(Dim.fsCaption)
          .fontColor(Tokens.text2)
          .letterSpacing(Dim.s0)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)
        WebIconButton({
          iconName: WebIconName.CHEVRON_DOWN,
          boxSize: Dim.touchMin,
          glyphColor: Tokens.text1,
          chromeKind: NeuBtnChrome.PLAIN,
          onTap: () => {
            this.sheet = 'none';
          }
        })
          .accessibilityText('收起歌词')
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)
      .padding({ bottom: Dim.s2 })
      // T11 第 1 条：歌词层整页盖住 tab 栏时，顶栏整条也可点收起（不再只靠右上角小钮）
      .accessibilityText('收起歌词')
      .onClick(() => {
        this.sheet = 'none';
      })

      LyricView()
    }
    .width('100%')
    .height('100%')
    .padding({
      left: Dim.s5,
      right: Dim.s5,
      top: this.avoidVp(this.topAvoidHeight) + Dim.s3,
      bottom: this.avoidVp(this.bottomAvoidHeight) + Dim.s4
    })
    .backgroundColor(Tokens.bg)
    .transition(TransitionEffect.translate({ y: '100%' })
      .animation({ duration: Motion.standard, curve: Motion.curve }))
  }

  /** 队列 sheet（web 移动端 QueuePanel：底部抽屉 + 遮罩点击关闭） */
  @Builder
  queueSheet() {
    Stack({ alignContent: Alignment.Bottom }) {
      Column()
        .width('100%')
        .height('100%')
        .backgroundColor(Tokens.scrim)
        .onClick(() => {
          this.sheet = 'none';
        })
        .transition(TransitionEffect.OPACITY
          .animation({ duration: Motion.standard, curve: Motion.curve }))

      Column() {
        QueueView({
          showClose: true,
          onClose: () => {
            this.sheet = 'none';
          }
        })
      }
      .width('100%')
      .height('70%')
      .backgroundColor(Tokens.bg)
      .borderRadius({ topLeft: Dim.radiusLg, topRight: Dim.radiusLg })
      .padding({ top: Dim.s1, bottom: this.avoidVp(this.bottomAvoidHeight) })
      .transition(TransitionEffect.translate({ y: '100%' })
        .animation({ duration: Motion.standard, curve: Motion.curve }))
    }
    .width('100%')
    .height('100%')
  }

  /** 更多菜单（web more-menu：音源 / 歌手 / 专辑 / 修正音源） */
  @Builder
  moreSheet() {
    Stack({ alignContent: Alignment.TopEnd }) {
      Column()
        .width('100%')
        .height('100%')
        .backgroundColor(Tokens.scrim)
        .onClick(() => {
          this.sheet = 'none';
        })
        .transition(TransitionEffect.OPACITY
          .animation({ duration: Motion.fast, curve: Motion.curve }))

      Column() {
        if (this.currentTrack() !== null) {
          Row() {
            Text('音源')
              .fontSize(Dim.fsCaption)
              .fontColor(Tokens.text2)
            Blank()
            Text(this.sourceLabel())
              .fontSize(Dim.fsSub)
              .fontColor(Tokens.text1)
          }
          .width('100%')
          .padding({ left: Dim.s2, right: Dim.s2, top: Dim.s1, bottom: Dim.s1 })
          .accessibilityText(`音源：${this.sourceLabel()}`)

          if (this.hasArtistEntry() || this.hasAlbumEntry()) {
            Divider()
              .strokeWidth(Dim.hairline)
              .color(Tokens.line)
              .margin({ top: Dim.s1, bottom: Dim.s1 })
          }
        }
        if (this.hasArtistEntry()) {
          Row() {
            Text('歌手')
              .fontSize(Dim.fsCaption)
              .fontColor(Tokens.text2)
            Blank()
            Text(this.firstArtistName())
              .fontSize(Dim.fsSub)
              .fontColor(Tokens.text1)
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
              .layoutWeight(1)
              .textAlign(TextAlign.End)
          }
          .width('100%')
          .padding({ left: Dim.s2, right: Dim.s2, top: Dim.s2, bottom: Dim.s2 })
          .borderRadius(Dim.radiusSm)
          .accessibilityText('查看歌手')
          .onClick(() => {
            this.goArtist();
          })
        }
        if (this.hasAlbumEntry()) {
          if (this.hasArtistEntry()) {
            Divider()
              .strokeWidth(Dim.hairline)
              .color(Tokens.line)
              .margin({ top: Dim.s1, bottom: Dim.s1 })
          }
          Row() {
            Text('专辑')
              .fontSize(Dim.fsCaption)
              .fontColor(Tokens.text2)
            Blank()
            Text(this.albumName())
              .fontSize(Dim.fsSub)
              .fontColor(Tokens.text1)
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
              .layoutWeight(1)
              .textAlign(TextAlign.End)
          }
          .width('100%')
          .padding({ left: Dim.s2, right: Dim.s2, top: Dim.s2, bottom: Dim.s2 })
          .borderRadius(Dim.radiusSm)
          .accessibilityText('查看专辑')
          .onClick(() => {
            this.goAlbum();
          })
        }
        if (this.currentTrack() !== null) {
          Divider()
            .strokeWidth(Dim.hairline)
            .color(Tokens.line)
            .margin({ top: Dim.s1, bottom: Dim.s1 })
          Row() {
            Text('修正音源')
              .fontSize(Dim.fsCaption)
              .fontColor(Tokens.text2)
            Blank()
            Text('›')
              .fontSize(Dim.fsSub)
              .fontColor(Tokens.text2)
          }
          .width('100%')
          .padding({ left: Dim.s2, right: Dim.s2, top: Dim.s2, bottom: Dim.s2 })
          .borderRadius(Dim.radiusSm)
          .accessibilityText('修正音源')
          .onClick(() => {
            this.openAnchorSheet();
          })
        }
      }
      .width(Dim.popW)
      .padding(Dim.s2)
      .borderRadius(Dim.radiusMd)
      .backgroundColor(Tokens.panel)
      .border({ width: Dim.hairline, color: Tokens.line })
      .margin({ top: this.avoidVp(this.topAvoidHeight) + Dim.touchMin, right: Dim.s3 })
      .transition(TransitionEffect.OPACITY
        .animation({ duration: Motion.fast, curve: Motion.curve }))
    }
    .width('100%')
    .height('100%')
  }

  /** 修正音源弹窗（web AnchorDialog：音源 / 已有锚点 / 搜索 / 原版参照 / 候选列表；紧凑版式 2026-10-23 用户反馈） */
  @Builder
  anchorSheet() {
    Column() {
      // 用户 2026-10-23：音源 / 已有锚点 / 搜索行 / 原版参照 / 候选列表之间**一个间隔都没有**，
      // 全部糊成一坨 → 统一 s3 块间距（弹窗内所有分块都吃同一档，不再逐个调 padding）
      Column({ space: Dim.s3 }) {
        // 头：标题 + 关闭（曲名在参照卡里有，不重复占行）
        Row() {
          Text('锚定音源')
            .fontSize(Dim.fsSub)
            .fontWeight(FontWeight.Medium)
            .fontColor(Tokens.text1)
            .layoutWeight(1)
          WebIconButton({
            iconName: WebIconName.CLOSE,
            boxSize: 36,
            glyphColor: Tokens.text2,
            chromeKind: NeuBtnChrome.PLAIN,
            onTap: () => {
              this.closeAnchorSheet();
            }
          })
            .accessibilityText('关闭')
        }
        .width('100%')
        .alignItems(VerticalAlign.Center)

        // 音源行已删（用户 2026-10-23：锚定弹窗里不要这行 —— 音源信息在「更多」菜单里已经有了）

        // 已有锚点：回显 + 可解除（锚错了随时推翻重来）
        if (this.anchorInfo !== null) {
          Row({ space: Dim.s2 }) {
            Text(this.currentAnchorText())
              .fontSize(Dim.fsMinor)
              .fontColor(Tokens.text1)
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
              .layoutWeight(1)
            WebButton({
              labelStr: this.removingAnchor ? '解除中…' : '解除',
              sizeKind: NeuBtnSize.SM,
              disabledFlag: this.removingAnchor,
              onTap: () => {
                this.removeCurrentAnchor();
              }
            })
              .accessibilityText('解除锚定')
          }
          .width('100%')
          .padding({ left: Dim.s2, right: Dim.s2, top: Dim.s1, bottom: Dim.s1 })
          .borderRadius(Dim.radiusSm)
          .border({ width: Dim.hairline, color: Tokens.line })
          .backgroundColor(Tokens.panel2)
        }

        // 搜索行：关键词默认「歌名 + 主歌手」，可改后重搜
        Row({ space: Dim.s2 }) {
          NeuInput({ content: this.anchorKeyword, placeholder: '歌名 歌手' })
            .layoutWeight(1)
          // 搜索键改**放大镜图标**（不再占「搜索」两字宽度），灰白透明底 —— 与播放页收起键同一套 PLAIN 键，
          // 不用琥珀填充（用户 2026-10-23 反馈：锚定页这两类图标不要强调色打底）
          WebIconButton({
            iconName: WebIconName.SEARCH,
            boxSize: Dim.touchMin,
            glyphColor: this.anchorSearching ? Tokens.accent : Tokens.text2,
            chromeKind: NeuBtnChrome.PLAIN,
            onTap: () => {
              this.searchAnchor();
            }
          })
            .accessibilityText('搜索 bilibili 候选')
        }
        .width('100%')
        .alignItems(VerticalAlign.Center)

        if (this.anchorNote.length > 0) {
          Text(this.anchorNote)
            .fontSize(Dim.fsMinor)
            .fontColor(Tokens.text2)
            .width('100%')
            .textAlign(TextAlign.Center)
        }

        // 原版参照：Q 音侧元数据（歌名 + 歌手·专辑·参考时长合并一行，帮用户认出正确的视频）
        if (this.anchorMeta !== null) {
          Column({ space: Dim.s0 }) {
            Text(this.anchorMeta.name)
              .fontSize(Dim.fsSub)
              .fontWeight(FontWeight.Medium)
              .fontColor(Tokens.text1)
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
            Text(this.refMetaLine())
              .fontSize(Dim.fsCaption)
              .fontColor(Tokens.text2)
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
          }
          .alignItems(HorizontalAlign.Start)
          .width('100%')
          .padding({ left: Dim.s2, right: Dim.s2, top: Dim.s1, bottom: Dim.s1 })
          .borderRadius(Dim.radiusSm)
          .border({ width: Dim.hairline, color: Tokens.line })
          .backgroundColor(Tokens.panel2)
        }

        // 候选列表（可滚动）
        if (this.anchorSearching && this.anchorCandidates.length === 0) {
          Text('正在搜索 bilibili 候选…')
            .fontSize(Dim.fsMinor)
            .fontColor(Tokens.text2)
            .width('100%')
            .textAlign(TextAlign.Center)
            .padding({ top: Dim.s4, bottom: Dim.s4 })
        } else {
          Scroll() {
            Column() {
              ForEach(this.anchorCandidates, (c: BiliCandidate) => {
                this.candidateRow(c)
              }, (c: BiliCandidate) => c.bvid)
            }
            .width('100%')
          }
          .layoutWeight(1)
          .width('100%')
          .scrollBar(BarState.Off)
          .edgeEffect(EdgeEffect.None)
        }
      }
      .width('92%')
      .constraintSize({ maxHeight: '80%' })
      .padding(Dim.s3)
      .borderRadius(Dim.radiusLg)
      .backgroundColor(Tokens.bg)
      .border({ width: Dim.hairline, color: Tokens.line })
      // 弹窗本体吸收点击，别漏到遮罩上把弹窗关掉
      .onClick(() => {})
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Tokens.scrim)
    .justifyContent(FlexAlign.Center)
    .onClick(() => {
      this.closeAnchorSheet();
    })
    .transition(TransitionEffect.OPACITY
      .animation({ duration: Motion.fast, curve: Motion.curve }))
  }

  /**
   * 候选行（web anchor-candidates .row）：标题 + UP·时长·置信 + 时长差异警告 + 锚定钮。
   * 点行即试听（再点停止）；试听中的行整行染色示别。
   * 置信分必须显示（用户裁定 2026-10-23）；行内放不下时省作者名不省置信。
   */
  @Builder
  candidateRow(c: BiliCandidate) {
    Row({ space: Dim.s2 }) {
      Column({ space: Dim.s0 }) {
        Text(c.title)
          .fontSize(Dim.fsBody)
          .fontColor(Tokens.text1)
          .maxLines(2)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        Text(`${c.author} · ${this.mmss(c.durationSec * 1000)} · 置信 ${Math.round(c.score)}`
          + (this.previewingBvid === c.bvid ? ' · 试听中' : ''))
          .fontSize(Dim.fsCaption)
          .fontColor(Tokens.text2)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        if (this.durationMismatch(c)) {
          Text(`时长${this.durationDiffText(c)}，可能不是同一版本`)
            .fontSize(Dim.fsCaption)
            .fontColor(Tokens.accent)
        }
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1)

      // 锚定键改**大头针图标**（sys.symbol.pin），灰白透明底；提交中染 accent 且拦住重复点击
      WebIconButton({
        iconName: WebIconName.PIN,
        boxSize: Dim.touchMin,
        glyphColor: this.anchoringBvid === c.bvid ? Tokens.accent : Tokens.text2,
        chromeKind: NeuBtnChrome.PLAIN,
        onTap: () => {
          if (this.anchoringBvid.length > 0) { return; }
          this.doAnchor(c);
        }
      })
        .accessibilityText('锚定该视频')
    }
    .width('100%')
    .padding({ left: Dim.s2, right: Dim.s2, top: Dim.s2, bottom: Dim.s2 })
    .border({ width: { top: Dim.hairline }, color: Tokens.line })
    .backgroundColor(this.previewingBvid === c.bvid ? Tokens.panel2 : Color.Transparent)
    .alignItems(VerticalAlign.Center)
    .accessibilityText(this.previewingBvid === c.bvid ? '停止试听' : '试听该候选')
    .onClick(() => {
      this.previewCandidate(c);
    })
  }

  private albumName(): string {
    const t = this.currentTrack();
    return t === null ? '' : t.al.name;
  }

  build() {
    Stack() {
      // 环境光晕（web .ambient）：模糊封面垫底，主层透明浮在其上
      if (this.cover.length > 0) {
        Image(this.cover)
          .width('100%')
          .height('100%')
          .objectFit(ImageFit.Cover)
          .blur(Dim.glowBlur)
          .opacity(0.15)
      }

      // 主层
      Column() {
        // 顶栏三件（web head）：收起 / eyebrow / 更多（第 ③⑧ 条 web 图标键）
        Row() {
          // T11 第 1 条：逃生口加大到 44 触控区 + 主文字色（原先 36 键 + 次级灰，找不到）
          WebIconButton({
            iconName: WebIconName.CHEVRON_DOWN,
            boxSize: Dim.touchMin,
            glyphColor: Tokens.text1,
            chromeKind: NeuBtnChrome.PLAIN,
            onTap: () => {
              this.onClose();
            }
          })
            .accessibilityText('收起播放页')
          Blank()
          Text(this.eyebrowText())
            .fontSize(Dim.fsCaption)
            .fontColor(this.err.length > 0 ? '#E5484D' : Tokens.text2)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .constraintSize({ maxWidth: '60%' })
          Blank()
          WebIconButton({
            iconName: WebIconName.DOTS,
            boxSize: 36,
            glyphColor: Tokens.text2,
            chromeKind: NeuBtnChrome.PLAIN,
            onTap: () => {
              this.sheet = 'more';
            }
          })
            .accessibilityText('更多')
        }
        .width('100%')
        .padding({ top: Dim.s1, bottom: Dim.s2 })
        .alignItems(VerticalAlign.Center)

        this.coverView()
        this.bottomFoot()
      }
      .width('100%')
      .height('100%')
      .padding({
        left: Dim.s5,
        right: Dim.s5,
        top: this.avoidVp(this.topAvoidHeight) + Dim.s3,
        bottom: this.avoidVp(this.bottomAvoidHeight) + Dim.s4
      })

      // 浮层层级（返回手势逐层关，顺序 dislike > more > queue > lyrics，见 NativeRoot）
      if (this.sheet === 'lyrics') {
        this.lyricSheet()
      }
      if (this.sheet === 'queue') {
        this.queueSheet()
      }
      if (this.sheet === 'more') {
        this.moreSheet()
      }
      if (this.sheet === 'anchor') {
        this.anchorSheet()
      }

      // 「不喜欢」选择弹窗（自绘哑光三选，替换系统 AlertDialog —— 用户 2026-10-23 反馈风格割裂）
      if (this.sheet === 'dislike') {
        DislikeDialog({
          trackName: this.title,
          artistName: this.firstArtistName(),
          onTrack: (): void => {
            this.doDislike('track');
          },
          onArtist: (): void => {
            this.doDislike('artist');
          },
          onCancel: (): void => {
            this.sheet = 'none';
          }
        })
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Tokens.bg)
  }
}
