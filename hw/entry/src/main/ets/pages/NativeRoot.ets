/**
 * 鸿蒙原生客户端入口（S2；S4 打磨；T10 批次 B：Tab 栏/迷你条对齐 web 移动端）。
 *
 * **这里没有 ArkWeb、没有 WebView** —— 全原生迭代的前提。
 * 旧 `pages/Index.ets`（WebView 壳）已于 T6（S5 §三，2026-10-22）删除，无回退路径。
 * Tab 顺序与名称对齐 web `nav.ts`：发现 / 专属 / 收藏 / 搜索 / 设置（T10 §2.7）。
 */

import { LoginPage } from './LoginPage';
import { HomePage } from './HomePage';
import { SearchPage } from './SearchPage';
import { FavoritesPage } from './FavoritesPage';
import { DailyPage } from './DailyPage';
import { SettingsPage } from './SettingsPage';
import { PlayerPage } from './PlayerPage';
import { ServerListPage } from './ServerListPage';
import { CachePage } from './CachePage';
import { CollectionPage } from './CollectionPage';
import {
  K_COLLECTION_REQ, K_COLLECTION_DEPTH, K_COLLECTION_BACK
} from '../common/CollectionNav';
import { AppState, K_LOGGED_IN, K_BOOTSTRAP_DONE, K_FAV_REV, K_FAV_KEYWORD, K_PLAYER_SHEET } from '../viewmodel/AppState';
import {
  MediaPlayerCore, K_TITLE, K_ARTIST, K_COVER, K_PLAYING, K_HAS_TRACK, K_POS, K_DUR, K_TRACKID
} from '../core/MediaPlayerCore';
import { APIClient, ApiError } from '../core/APIClient';
import { Track } from '../core/Models';
import { HarmonyAVSessionManager } from '../common/AVSessionManager';
import { applyPendingCardControl } from '../common/PlayerControlHub';
import { common } from '@kit.AbilityKit';
import { Tokens } from '../common/Tokens';
import { Dim, Motion } from '../common/Dimension';
import { WebIconButton, WebIconName, NeuBtnChrome } from '../common/WebIcons';
import { AppToast, K_TOAST_TEXT, K_TOAST_SEQ } from '../common/AppToast';

/** 迷你条滑动切歌阈值（web SWIPE_TH = 60px） */
const MINI_SWIPE_TH = 60;
/** 迷你条拖拽位移上限（web miniDragX 钳制 ±80px） */
const MINI_DRAG_CLAMP = 80;
/** 自绘轻提示底距（迷你条 + Tab 栏之上，避免压住壳件） */
const TOAST_BOTTOM_GAP = 132;
/** 手势结束后吞掉合成 click 的时间窗（TrackItem CLICK_GUARD_MS 同款保险） */
const MINI_CLICK_GUARD_MS = 350;
/** 启动占位图标边长（vp） */
const SPLASH_ICON_SIZE = 80;

@Entry
@Component
struct NativeRoot {
  @StorageLink(K_LOGGED_IN) loggedIn: boolean = false;
  // bootstrap（恢复登录态）完成前显示启动占位：冷启动不再先画一帧登录页再翻转
  @StorageLink(K_BOOTSTRAP_DONE) bootstrapDone: boolean = false;
  @StorageLink(K_HAS_TRACK) hasTrack: boolean = false;
  @StorageLink(K_TITLE) title: string = '';
  @StorageLink(K_ARTIST) artist: string = '';
  @StorageLink(K_COVER) cover: string = '';
  @StorageLink(K_PLAYING) playing: boolean = false;
  // 迷你条内嵌进度条（T10 批次 B，web mini-progress）
  @StorageLink(K_POS) barPos: number = 0;
  @StorageLink(K_DUR) barDur: number = 0;
  // 迷你条红心：切歌或收藏集变化时异步刷新当前曲收藏态
  @StorageLink(K_TRACKID) @Watch('refreshBarFav') barTrackId: string = '';
  @StorageProp(K_FAV_REV) @Watch('refreshBarFav') favRev: number = 0;
  @State barFav: boolean = false;
  @State showPlayer: boolean = false;
  @State showServers: boolean = false;
  @State showCache: boolean = false;
  // 集合详情浮层（T10 批次 D）：任意页 openCollection() 写信号，这里监听拉起
  @State showCollection: boolean = false;
  @State collKind: string = 'album';
  @State collId: string = '';
  @State collName: string = '';
  @StorageProp(K_COLLECTION_REQ) @Watch('onCollectionReq') collReq: number = 0;
  // ⚠️ 不能叫 `tabIndex`：ArkUI 的 Tabs 有同名属性修饰符，重名会报类型冲突
  @State currentTab: number = 0;
  /** Tab 栏导轨实测宽（滑块定位用，onAreaChange 回填；第 ⑭ 条滑块层） */
  @State barW: number = 0;
  /** 按压中的 tab 下标（按压下沉反馈；-1 = 无） */
  @State pressedTab: number = -1;
  /** 迷你条拖拽实时位移（钳制 ±80，web miniDragX） */
  @State miniDragX: number = 0;
  // 窗口全屏布局（EntryAbility setWindowLayoutFullScreen）后系统避让区实时值：
  // 刘海/状态栏高度、底部手势条高度因机型而异，由 avoidAreaChange 动态推送，禁止硬编码
  // 自绘轻提示（AppToast → 底部居中；系统 toast 在沉浸式窗口实测漂到顶部偏右）
  @StorageProp(K_TOAST_TEXT) toastText: string = '';
  @StorageProp(K_TOAST_SEQ) @Watch('onToastSeq') toastSeq: number = 0;
  @State toastVisible: boolean = false;
  private toastTimer: number = -1;
  /** 主题切换信号：切完主题立刻重推桌面卡片（卡片深浅跟设置，不跟系统） */
  @StorageProp('card_refresh') @Watch('onCardRefresh') cardRefresh: number = 0;
  @StorageProp('topAvoidHeight') topAvoidHeight: number = 0;
  @StorageProp('bottomAvoidHeight') bottomAvoidHeight: number = 0;

  private avSession: HarmonyAVSessionManager | null = null;
  /** onPageShow 首次触发（应用首亮）不算热启动，避免与 aboutToAppear 的 load 重复 */
  private uiShown: boolean = false;
  /** 最近一次迷你条手势结束时间：吞掉手势后的合成 click，防误开播放页 */
  private lastMiniSwipeEndAt: number = 0;

  /** 避让区 px → vp（走 UIContext 实例方法，全局 px2vp 已弃用） */
  private avoidVp(px: number): number {
    return this.getUIContext().px2vp(px);
  }

  // ---------------- 迷你条红心（web mini-action toggleCurrentFav 同口径） ----------------

  /** 当前曲收藏态：切歌 / 收藏集变化时刷新；拉不到只是心不亮，不打断播放 */
  private async refreshBarFav(): Promise<void> {
    if (this.barTrackId.length === 0) {
      this.barFav = false;
      return;
    }
    try {
      const ids = await APIClient.shared().favoredIds([this.barTrackId]);
      this.barFav = ids.indexOf(this.barTrackId) >= 0;
    } catch (e) {
      // 静默：收藏标记失败不该影响播放条
    }
  }

  /** 队列快照里找当前曲（收藏时带快照写服务端，省后续补全） */
  private currentBarTrack(): Track | null {
    const q = MediaPlayerCore.shared().getQueueSnapshot();
    for (let i = 0; i < q.length; i++) {
      if (q[i].id === this.barTrackId) { return q[i]; }
    }
    return null;
  }

  private async toggleBarFav(): Promise<void> {
    if (this.barTrackId.length === 0) { return; }
    const was = this.barFav;
    this.barFav = !was;
    try {
      if (was) {
        await APIClient.shared().removeFavorite(this.barTrackId);
      } else {
        await APIClient.shared().addFavorite(this.barTrackId, this.currentBarTrack());
      }
      AppState.shared().bumpFavRev();
    } catch (e) {
      this.barFav = was;
      const err = e as ApiError;
      AppToast.show(err.message);
    }
  }

  /** 主题切换后重推卡片 */
  onCardRefresh(): void {
    if (this.cardRefresh <= 0) {
      return;
    }
    const av = this.avSession;
    if (av !== null) {
      av.refreshCard();
    }
  }

  /** 轻提示序号变化 = 弹一条（同文案连点也会重弹；2.2s 自动收） */
  onToastSeq(): void {
    if (this.toastSeq <= 0) {
      return;
    }
    this.toastVisible = true;
    if (this.toastTimer !== -1) {
      clearTimeout(this.toastTimer);
    }
    this.toastTimer = setTimeout(() => {
      this.toastVisible = false;
    }, 2200);
  }

  // ---------------- 迷你条拖拽切歌（web onTouchStart/Move/End + swiped 旗标） ----------------

  /** 迷你条内嵌进度条百分比（0-100 整数；总时长未知时 0） */
  private barProgressPct(): number {
    if (this.barDur <= 0) { return 0; }
    const pct = (this.barPos / this.barDur) * 100;
    return Math.round(Math.min(100, Math.max(0, pct)));
  }

  /** 松手/被打断后弹回原位（快动效档） */
  private snapMiniBack(): void {
    this.getUIContext().animateTo({ duration: Motion.fast, curve: Motion.curve }, () => {
      this.miniDragX = 0;
    });
  }

  aboutToAppear(): void {
    // 冷启动（S4 §四验收#4）：AVSession/播放内核/bootstrap 都是首帧之后才需要的
    // 初始化，让出主线程先把登录页首帧画出来（<1.5s 目标）
    setTimeout(() => {
      // `getContext(this)` 已弃用；从 UIContext 取宿主 Context
      const ctx = this.getUIContext().getHostContext() as common.UIAbilityContext;
      this.avSession = new HarmonyAVSessionManager(ctx);
      this.avSession.init();
      // 播放内核需要 context 拿 filesDir（缓存）与 AVSession（锁屏/长时任务）
      MediaPlayerCore.shared().init(ctx, this.avSession);
      // bootstrap 恢复 baseUrl/登录态是异步；冷启动续播（拉新流令牌）依赖它们，
      // 所以暂存的卡片指令必须等 bootstrap 完成后才能应用
      AppState.shared().bootstrap(ctx).then(() => {
        applyPendingCardControl();
      });
    }, 0);
  }

  aboutToDisappear(): void {
    this.avSession?.destroy();
  }

  /** 热启动（后台 → 前台）：发一次首页刷新信号。离线时 HomePage 重拉失败会挂离线提示行 */
  onPageShow(): void {
    if (this.uiShown) {
      AppState.shared().bumpHomeRefresh();
    } else {
      this.uiShown = true;
    }
  }

  /** 收到打开集合详情的信号：读参数并拉起浮层（重复打开同一目标也刷新） */
  private onCollectionReq(): void {
    const kind = AppStorage.get<string>('collection_kind');
    const id = AppStorage.get<string>('collection_id');
    const name = AppStorage.get<string>('collection_name');
    if (kind === undefined || id === undefined || name === undefined) { return; }
    this.collKind = kind;
    this.collId = id;
    this.collName = name;
    this.showCollection = true;
  }

  /** 返回手势/返回键：按视觉层级从顶往下关（播放页内部浮层 > 播放页 > 集合 > 服务端 > 缓存），全关了才交给系统 */
  onBackPress(): boolean {
    if (this.showPlayer) {
      // 播放页内部浮层（dislike/more/queue/lyrics，T10 批次 F web FullPlayer 返回层级）：
      // 返回第一下关最上层浮层，全关了才轮到关播放页
      const layer = AppStorage.get<string>(K_PLAYER_SHEET);
      if (layer !== undefined && layer !== 'none') {
        AppStorage.setOrCreate(K_PLAYER_SHEET, 'none');
        return true;
      }
      this.showPlayer = false;
      return true;
    }
    if (this.showCollection) {
      // 集合浮层有内部栈：深度 > 1 先弹内层（信号转发给 CollectionPage），否则整层关闭
      const d = AppStorage.get<number>(K_COLLECTION_DEPTH);
      if (d !== undefined && d > 1) {
        const b = AppStorage.get<number>(K_COLLECTION_BACK);
        AppStorage.setOrCreate(K_COLLECTION_BACK, b === undefined ? 1 : b + 1);
      } else {
        this.showCollection = false;
      }
      return true;
    }
    if (this.showServers) {
      this.showServers = false;
      return true;
    }
    if (this.showCache) {
      this.showCache = false;
      return true;
    }
    // 收藏 Tab：先退出收藏内搜索的筛选态，而不是退出应用（web Favorites.vue
    // registerBackHandler：页面内临时状态没有自己的路由，返回第一下天然应该清掉）
    if (this.currentTab === 2) {
      const kw = AppStorage.get<string>(K_FAV_KEYWORD);
      if (kw !== undefined && kw.length > 0) {
        AppStorage.setOrCreate(K_FAV_KEYWORD, '');
        return true;
      }
    }
    return false;
  }

  // ---------------- 底部 Tab 栏（web MobileShell.vue .tabbar：凹槽导轨 + 活动滑块） ----------------

  /** 单个 Tab 格子：纯文字层（背景/描边/指示条全部抽到滑块层，第 ⑭ 条） */
  @Builder
  tabCell(label: string, idx: number) {
    Column() {
      Text(label)
        .fontSize(Dim.fsMinor)
        .fontWeight(this.currentTab === idx ? FontWeight.Medium : FontWeight.Normal)
        .fontColor(this.currentTab === idx ? Tokens.text1 : Tokens.text2)
        // web `.tab{padding:0 0 8px}`：文字上移，给滑块底部的琥珀指示条让位
        .margin({ bottom: Dim.s2 })
    }
    .layoutWeight(1)
    .height(Dim.touchMin)
    .justifyContent(FlexAlign.Center)
    // 按压下沉（第 ⑭ 条机械反馈，与 web NeuIconButton :active translateY(1) 同语言）
    .translate({ y: this.pressedTab === idx ? 1 : 0 })
    .accessibilityText(label)
    .accessibilityLevel(this.currentTab === idx ? 'yes' : 'no')
    .onClick(() => {
      // 切 tab = 路由导航（web 点 tabbar 换路由）：先收掉所有详情浮层再切页。
      // 滑块平移 + 文字变色都收进 animateTo（第 ⑭ 条：原先是硬切，零过渡）
      this.showCollection = false;
      this.showServers = false;
      this.showCache = false;
      this.getUIContext().animateTo({ duration: Motion.fast, curve: Motion.curve }, () => {
        this.currentTab = idx;
      });
    })
    .onTouch((e: TouchEvent) => {
      if (e.type === TouchType.Down) {
        this.pressedTab = idx;
      } else if (e.type === TouchType.Up || e.type === TouchType.Cancel) {
        this.pressedTab = -1;
      }
    })
  }

  /**
   * 活动滑块（第 ⑭ 条）：panel2 底 + 顶沿内高光 + 底部琥珀指示条 12×2，
   * 独立层随 currentTab 平移（animateTo 驱动），不占格子文档流。
   */
  @Builder
  tabSlider() {
    Stack({ alignContent: Alignment.Bottom }) {
      Row()
        .width(Dim.tabIndicatorW)
        .height(Dim.tabIndicatorH)
        .backgroundColor(Tokens.accent)
        .margin({ bottom: Dim.s1 })
    }
    .width(this.tabSliderW())
    .height(Dim.touchMin)
    .borderRadius(Dim.radiusTab)
    .backgroundColor(Tokens.panel2)
    .border({ width: { top: Dim.hairline }, color: { top: Tokens.hi } })
    .translate({ x: this.tabSliderX() })
  }

  /** Tab 栏容器：整条凹槽导轨（bg 底 + 发丝线描边 + 大圆角），滑块垫底、格子层在上 */
  @Builder
  tabBar() {
    Stack({ alignContent: Alignment.Start }) {
      this.tabSlider()
      Row({ space: Dim.s1 }) {
        this.tabCell('发现', 0)
        this.tabCell('专属', 1)
        this.tabCell('收藏', 2)
        this.tabCell('搜索', 3)
        this.tabCell('设置', 4)
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)
    }
    .width('100%')
    .padding(Dim.s1)
    .margin({ left: Dim.s3, right: Dim.s3, top: Dim.s1, bottom: Dim.s2 })
    .borderRadius(Dim.radiusMd)
    .backgroundColor(Tokens.bg)
    .border({ width: Dim.hairline, color: Tokens.line })
    .onAreaChange((_old: Area, area: Area) => {
      // area.width 是 Length（string|number|Resource），实测布局宽必为 vp 数值，typeof 收窄
      const w: Length = area.width;
      if (typeof w === 'number') {
        this.barW = w;
      }
    })
  }

  /** 滑块宽：导轨内容区五等分（内容区 = 实测宽 - 两侧 padding - 4 个 gap） */
  private tabSliderW(): number {
    if (this.barW <= 0) { return 0; }
    return (this.barW - 6 * Dim.s1) / 5;
  }

  /** 滑块 x：内容区起点 + 当前下标 × (滑块宽 + gap) */
  private tabSliderX(): number {
    return this.currentTab * (this.tabSliderW() + Dim.s1);
  }

  // ---------------- 迷你播放条（web PlayerBar.vue compact 形态逐元素对齐） ----------------


  /**
   * 迷你条：凸面板 + 底部内嵌 2px 进度条 + 封面/歌名/歌手 + 红心/播放图标键。
   * 整条点击展开全屏播放页；左右滑动（±60 阈值）切歌，滑动后的合成 click 不展开。
   * 红心/播放键点击由子组件消费，不会冒泡触发展开（ArkUI 点击不冒泡，web @click.stop 等价）。
   */
  @Builder
  playerBar() {
    Stack({ alignContent: Alignment.BottomStart }) {
      Row({ space: Dim.s3 }) {
        Image(this.cover.length > 0 ? this.cover : $r('app.media.app_icon'))
          .width(Dim.coverMini).height(Dim.coverMini).borderRadius(Dim.radiusSm).objectFit(ImageFit.Cover)
        Column({ space: Dim.s0 }) {
          Text(this.title)
            .fontSize(Dim.fsSub)
            .fontWeight(FontWeight.Medium)
            .fontColor(Tokens.text1)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
          Text(this.artist)
            .fontSize(Dim.fsCaption)
            .fontColor(Tokens.text2)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }
        .alignItems(HorizontalAlign.Start)
        .layoutWeight(1)

        // 红心（web mini-action heart，fav-on 点亮 accent；第 ③ 条 web 自绘图标配 chrome 键）
        WebIconButton({
          iconName: this.barFav ? WebIconName.HEART_FILLED : WebIconName.HEART,
          boxSize: 28,
          glyphColor: this.barFav ? Tokens.accent : Tokens.text2,
          chromeKind: NeuBtnChrome.PLAIN,
          onTap: () => { this.toggleBarFav(); }
        })
          .accessibilityText(this.barFav ? '取消收藏' : '收藏')

        // 播放/暂停图标键（web：播放键必须留在条上，滑动切歌不可发现；第 ③ 条）
        WebIconButton({
          iconName: this.playing ? WebIconName.PAUSE : WebIconName.PLAY,
          boxSize: 36,
          glyphColor: Tokens.text1,
          chromeKind: NeuBtnChrome.PLAIN,
          onTap: () => { MediaPlayerCore.shared().toggle(); }
        })
          .accessibilityText(this.playing ? '暂停' : '播放')
      }
      .width('100%')
      .padding({ left: Dim.s3, right: Dim.s3, top: Dim.s2, bottom: Dim.s2 })

      // 注意：这里原本还有一条 1vp 顶沿内高光（barSheen）—— 用户 2026-10-23 反馈「按钮上方有一条横线」，
      // 迷你条高度矮，这条高光横跨整条上沿、压在按钮上方，观感就是一条杂线，故删除。

      // 底部内嵌进度条（web mini-progress neu-inset：line 底 + accent 填充）
      Row() {
        Row()
          .height(Dim.miniProgressH)
          .width(`${this.barProgressPct()}%`)
          .backgroundColor(Tokens.accent)
      }
      .width('100%')
      .height(Dim.miniProgressH)
      .backgroundColor(Tokens.line)
    }
    .width('100%')
    .borderRadius(Dim.radiusLg)
    .backgroundColor(Tokens.panel)
    .border({ width: Dim.hairline, color: Tokens.line })
    .clip(true)
    .translate({ x: this.miniDragX })
    .accessibilityText('打开播放页')
    .onClick(() => {
      // 滑动刚结束的合成 click 不展开（web swiped 旗标同语义）
      if (Date.now() - this.lastMiniSwipeEndAt < MINI_CLICK_GUARD_MS) { return; }
      this.showPlayer = true;
    })
    .gesture(
      PanGesture({ fingers: 1, direction: PanDirection.Horizontal, distance: Dim.s3 })
        .onActionUpdate((e: GestureEvent) => {
          const dx = e.offsetX;
          this.miniDragX = Math.max(-MINI_DRAG_CLAMP, Math.min(MINI_DRAG_CLAMP, dx));
        })
        .onActionEnd((e: GestureEvent) => {
          this.lastMiniSwipeEndAt = Date.now();
          const dx = e.offsetX;
          this.snapMiniBack();
          if (Math.abs(dx) >= MINI_SWIPE_TH) {
            if (dx < 0) {
              MediaPlayerCore.shared().next();
            } else {
              MediaPlayerCore.shared().prev();
            }
          }
        })
        .onActionCancel(() => {
          // 手势被系统打断：只弹回，绝不当作切歌
          this.lastMiniSwipeEndAt = Date.now();
          this.snapMiniBack();
        })
    )
  }

  build() {
    Stack() {
      if (!this.bootstrapDone) {
        // 启动占位：中性底色 + 居中应用图标，bootstrap 恢复登录态期间不闪登录页
        Column() {
          Image($r('app.media.app_icon'))
            .width(SPLASH_ICON_SIZE)
            .height(SPLASH_ICON_SIZE)
            .borderRadius(Dim.radiusLg)
        }
        .width('100%')
        .height('100%')
        .justifyContent(FlexAlign.Center)
        .alignItems(HorizontalAlign.Center)
      } else if (!this.loggedIn) {
        LoginPage()
      } else {
        Column() {
          // 内容层 + 浮层层收进内层 Stack（T10 批次 D 反馈2）：
          // 迷你条与 Tab 栏是壳件（web MobileShell .mini-dock fixed / .tabbar 网格行），
          // 必须永远盖在详情浮层之上 —— 浮层只允许占据 dock 以上的内容区。
          Stack() {
            // barHeight(0)：系统 tabBar 整条隐藏，改用下方自建 tabBar（web .tabbar 对齐）；
            // scrollable(false)：禁用 Tabs 自带横滑切页，避免抢走列表行右滑收藏手势
            Tabs({ index: this.currentTab, barPosition: BarPosition.End }) {
              TabContent() { HomePage() }
              TabContent() { DailyPage() }
              TabContent() { FavoritesPage() }
              TabContent() { SearchPage() }
              TabContent() {
                SettingsPage({
                  onOpenServers: (): void => { this.showServers = true; },
                  onOpenCache: (): void => { this.showCache = true; }
                })
              }
            }
            .barHeight(0)
            .onChange((i: number) => {
              this.currentTab = i;
            })
            // 页面零动效：切 tab 无滑动无渐变（web 移动端同口径）
            .animationDuration(0)
            .scrollable(false)
            .width('100%')
            .height('100%')

            // 浮层背板：点背板关浮层（对齐底部 tab 页，零动效直接切换）
            if (this.showServers || this.showCache || this.showCollection) {
              Column()
                .width('100%')
                .height('100%')
                .backgroundColor(Tokens.scrim)
                .onClick(() => {
                  if (this.showServers) { this.showServers = false; }
                  if (this.showCache) { this.showCache = false; }
                })
            }

            // 服务端管理 / 缓存面板 / 集合详情：对齐底部 tab 页动画（零动效直接切换）
            if (this.showServers) {
              Column() {
                ServerListPage({ onClose: () => { this.showServers = false; } })
              }
              .width('100%')
              .height('100%')
            }

            if (this.showCache) {
              Column() {
                CachePage({ onClose: () => { this.showCache = false; } })
              }
              .width('100%')
              .height('100%')
            }

            if (this.showCollection) {
              Column() {
                CollectionPage({
                  kind: this.collKind,
                  entryId: this.collId,
                  name: this.collName,
                  onClose: () => { this.showCollection = false; }
                })
              }
              .width('100%')
              .height('100%')
            }
          }
          .layoutWeight(1)

          // 底部 dock（web MobileShell：迷你条浮于 Tab 栏上方；流内置底，
          // 因浮层已收进内层 Stack，dock 天然置顶于所有详情页）
          if (this.hasTrack) {
            Row() { this.playerBar() }
              .width('100%')
              .padding({ left: Dim.s3, right: Dim.s3, top: Dim.s2 })
          }
          this.tabBar()
        }
        .width('100%').height('100%')
        .padding({
          top: this.avoidVp(this.topAvoidHeight),
          bottom: this.avoidVp(this.bottomAvoidHeight)
        })
      }

      // 播放页专属背板：对齐底部 tab 页动画（零动效直接切换）
      if (this.showPlayer) {
        Column()
          .width('100%')
          .height('100%')
          .backgroundColor(Tokens.scrim)
          .onClick(() => {})
      }

      // 全屏播放页：对齐底部 tab 页动画（零动效直接切换）
      if (this.showPlayer) {
        Column() {
          PlayerPage({ onClose: () => { this.showPlayer = false; } })
        }
        .width('100%')
        .height('100%')
      }

      // 自绘轻提示（全局唯一落点，压在一切浮层之上；不吃点击）
      if (this.toastVisible && this.toastText.length > 0) {
        Column() {
          Text(this.toastText)
            .fontSize(Dim.fsBody)
            .fontColor(Tokens.text1)
            .maxLines(3)
            .textAlign(TextAlign.Center)
            .padding({ left: Dim.s4, right: Dim.s4, top: Dim.s3, bottom: Dim.s3 })
            .borderRadius(Dim.radiusMd)
            .backgroundColor(Tokens.panel2)
            .border({ width: Dim.hairline, color: Tokens.line })
            .constraintSize({ maxWidth: '84%' })
        }
        .width('100%')
        .height('100%')
        .justifyContent(FlexAlign.End)
        .alignItems(HorizontalAlign.Center)
        .padding({ bottom: TOAST_BOTTOM_GAP + this.avoidVp(this.bottomAvoidHeight) })
        .hitTestBehavior(HitTestMode.None)
        .transition(TransitionEffect.OPACITY
          .animation({ duration: Motion.fast, curve: Motion.curve }))
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Tokens.bg)
  }
}
