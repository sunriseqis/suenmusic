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
import { AppState, K_LOGGED_IN, K_FAV_REV } from '../viewmodel/AppState';
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

/** 迷你条滑动切歌阈值（web SWIPE_TH = 60px） */
const MINI_SWIPE_TH = 60;
/** 迷你条拖拽位移上限（web miniDragX 钳制 ±80px） */
const MINI_DRAG_CLAMP = 80;
/** 手势结束后吞掉合成 click 的时间窗（TrackItem CLICK_GUARD_MS 同款保险） */
const MINI_CLICK_GUARD_MS = 350;

@Entry
@Component
struct NativeRoot {
  @StorageLink(K_LOGGED_IN) loggedIn: boolean = false;
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
  // ⚠️ 不能叫 `tabIndex`：ArkUI 的 Tabs 有同名属性修饰符，重名会报类型冲突
  @State currentTab: number = 0;
  /** 迷你条拖拽实时位移（钳制 ±80，web miniDragX） */
  @State miniDragX: number = 0;
  // 窗口全屏布局（EntryAbility setWindowLayoutFullScreen）后系统避让区实时值：
  // 刘海/状态栏高度、底部手势条高度因机型而异，由 avoidAreaChange 动态推送，禁止硬编码
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
      try {
        this.getUIContext().getPromptAction().showToast({ message: err.message, duration: 2000 });
      } catch (toastErr) {
        // toast 失败不再兜底
      }
    }
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

  /** 返回手势/返回键：先关最上层浮层，全关了才交给系统 */
  onBackPress(): boolean {
    if (this.showPlayer) {
      this.showPlayer = false;
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
    return false;
  }

  // ---------------- 底部 Tab 栏（web MobileShell.vue .tabbar：凹槽导轨 + 纯文字标签） ----------------

  /** 单个 Tab：44 触摸高、active = panel2 底色 + 顶沿内高光 + t1 文字 + 琥珀短指示条 */
  @Builder
  tabItem(label: string, idx: number) {
    Column() {
      Text(label)
        .fontSize(Dim.fsMinor)
        .fontWeight(this.currentTab === idx ? FontWeight.Medium : FontWeight.Normal)
        .fontColor(this.currentTab === idx ? Tokens.text1 : Tokens.text2)
      // active 琥珀指示条（web .tab.active::after 12×2）；非 active 保留占位，文字位置稳定
      Row()
        .width(Dim.tabIndicatorW)
        .height(Dim.tabIndicatorH)
        .backgroundColor(this.currentTab === idx ? Tokens.accent : Color.Transparent)
        .margin({ top: Dim.s2, bottom: Dim.s1 })
    }
    .layoutWeight(1)
    .height(Dim.touchMin)
    .justifyContent(FlexAlign.Center)
    .borderRadius(Dim.radiusTab)
    .backgroundColor(this.currentTab === idx ? Tokens.panel2 : Color.Transparent)
    .border(this.currentTab === idx
      ? { width: { top: Dim.hairline }, color: { top: Tokens.hi } }
      : { width: 0 })
    .accessibilityText(label)
    .onClick(() => {
      this.currentTab = idx;
    })
  }

  /** Tab 栏容器：整条是凹槽导轨（bg 底 + 发丝线描边 + 大圆角；web 内阴影无等价物，以描边近似） */
  @Builder
  tabBar() {
    Row({ space: Dim.s1 }) {
      this.tabItem('发现', 0)
      this.tabItem('专属', 1)
      this.tabItem('收藏', 2)
      this.tabItem('搜索', 3)
      this.tabItem('设置', 4)
    }
    .width('100%')
    .padding(Dim.s1)
    .margin({ left: Dim.s3, right: Dim.s3, top: Dim.s1, bottom: Dim.s2 })
    .borderRadius(Dim.radiusMd)
    .backgroundColor(Tokens.bg)
    .border({ width: Dim.hairline, color: Tokens.line })
  }

  // ---------------- 迷你播放条（web PlayerBar.vue compact 形态逐元素对齐） ----------------

  /** 顶沿内高光（web neu-raised 的 inset hi 等价物，HomePage topSheen 同款） */
  @Builder
  barSheen() {
    Row()
      .height(Dim.hairline)
      .width('100%')
      .backgroundColor(Tokens.hi)
      .position({ x: 0, y: 0 })
  }

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

        // 红心（web mini-action heart，fav-on 点亮 accent）
        Row() {
          SymbolGlyph(this.barFav ? $r('sys.symbol.heart_fill') : $r('sys.symbol.heart'))
            .fontSize(Dim.iconSm)
            .fontColor([this.barFav ? Tokens.accent : Tokens.text2])
        }
        .width(Dim.btnSm)
        .height(Dim.btnSm)
        .justifyContent(FlexAlign.Center)
        .alignItems(VerticalAlign.Center)
        .borderRadius(Dim.radiusPill)
        .border({ width: Dim.hairline, color: Tokens.line })
        .backgroundColor(Tokens.panel)
        .accessibilityText(this.barFav ? '取消收藏' : '收藏')
        .onClick(() => { this.toggleBarFav(); })

        // 播放/暂停图标键（web：播放键必须留在条上，滑动切歌不可发现）
        Row() {
          SymbolGlyph(this.playing ? $r('sys.symbol.pause') : $r('sys.symbol.play_fill'))
            .fontSize(Dim.iconMd)
            .fontColor([Tokens.text1])
        }
        .width(Dim.btnMd)
        .height(Dim.btnMd)
        .justifyContent(FlexAlign.Center)
        .alignItems(VerticalAlign.Center)
        .borderRadius(Dim.radiusPill)
        .border({ width: Dim.hairline, color: Tokens.line })
        .backgroundColor(Tokens.panel)
        .accessibilityText(this.playing ? '暂停' : '播放')
        .onClick(() => { MediaPlayerCore.shared().toggle(); })
      }
      .width('100%')
      .padding({ left: Dim.s3, right: Dim.s3, top: Dim.s2, bottom: Dim.s2 })

      this.barSheen()

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
      if (!this.loggedIn) {
        LoginPage()
      } else {
        Column() {
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
          .layoutWeight(1)

          // 底部 dock（web MobileShell：迷你条叠于 Tab 栏上方；此处为流内堆叠，见回执偏离记录）
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

      // 浮层背板（S4 §二）：scrim 0→1 渐显；点背板不关浮层（避免误触丢输入/状态）
      if (this.showPlayer || this.showServers || this.showCache) {
        Column()
          .width('100%')
          .height('100%')
          .backgroundColor(Tokens.scrim)
          .transition(TransitionEffect.OPACITY.animation({ duration: Motion.standard, curve: Motion.curve }))
          .onClick(() => {})
      }

      // 播放页 / 服务端管理 / 缓存面板：底部上滑转场（S4 §二，200ms EaseOut）
      if (this.showPlayer) {
        Column() {
          PlayerPage({ onClose: () => { this.showPlayer = false; } })
        }
        .width('100%')
        .height('100%')
        .transition(TransitionEffect.translate({ y: '100%' })
          .animation({ duration: Motion.standard, curve: Motion.curve }))
      }

      if (this.showServers) {
        Column() {
          ServerListPage({ onClose: () => { this.showServers = false; } })
        }
        .width('100%')
        .height('100%')
        .transition(TransitionEffect.translate({ y: '100%' })
          .animation({ duration: Motion.standard, curve: Motion.curve }))
      }

      if (this.showCache) {
        Column() {
          CachePage({ onClose: () => { this.showCache = false; } })
        }
        .width('100%')
        .height('100%')
        .transition(TransitionEffect.translate({ y: '100%' })
          .animation({ duration: Motion.standard, curve: Motion.curve }))
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Tokens.bg)
  }
}
