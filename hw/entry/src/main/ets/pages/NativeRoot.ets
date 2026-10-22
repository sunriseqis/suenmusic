/**
 * 鸿蒙原生客户端入口（S2；S4 打磨：Tab 切换动效/浮层转场/冷启动延后）。
 *
 * **这里没有 ArkWeb、没有 WebView** —— 全原生迭代的前提。
 * 旧 `pages/Index.ets`（WebView 壳）保留在原处作为回退路径，S2/S3 验收通过后删除。
 * S3 增量 2 起 Tab 扩为 5 个：首页 / 搜索 / 收藏 / 每日 / 我的（顺序与名称固定）。
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
import { AppState, K_LOGGED_IN } from '../viewmodel/AppState';
import { MediaPlayerCore, K_TITLE, K_ARTIST, K_COVER, K_PLAYING, K_HAS_TRACK, K_POS, K_DUR } from '../core/MediaPlayerCore';
import { HarmonyAVSessionManager } from '../common/AVSessionManager';
import { common } from '@kit.AbilityKit';
import { Tokens } from '../common/Tokens';
import { Dim, Motion } from '../common/Dimension';

@Entry
@Component
struct NativeRoot {
  @StorageLink(K_LOGGED_IN) loggedIn: boolean = false;
  @StorageLink(K_HAS_TRACK) hasTrack: boolean = false;
  @StorageLink(K_TITLE) title: string = '';
  @StorageLink(K_ARTIST) artist: string = '';
  @StorageLink(K_COVER) cover: string = '';
  @StorageLink(K_PLAYING) playing: boolean = false;
  @State showPlayer: boolean = false;
  @State showServers: boolean = false;
  @State showCache: boolean = false;
  // ⚠️ 不能叫 `tabIndex`：ArkUI 的 Tabs 有同名属性修饰符，重名会报类型冲突
  @State currentTab: number = 0;
  // 窗口全屏布局（EntryAbility setWindowLayoutFullScreen）后系统避让区实时值：
  // 刘海/状态栏高度、底部手势条高度因机型而异，由 avoidAreaChange 动态推送，禁止硬编码
  @StorageProp('topAvoidHeight') topAvoidHeight: number = 0;
  @StorageProp('bottomAvoidHeight') bottomAvoidHeight: number = 0;

  private avSession: HarmonyAVSessionManager | null = null;
  /** onPageShow 首次触发（应用首亮）不算热启动，避免与 aboutToAppear 的 load 重复 */
  private uiShown: boolean = false;

  /** 避让区 px → vp（走 UIContext 实例方法，全局 px2vp 已弃用） */
  private avoidVp(px: number): number {
    return this.getUIContext().px2vp(px);
  }

  aboutToAppear(): void {
    // 冷启动（S4 §四验收#4）：AVSession/播放内核/bootstrap 都是首帧之后才需要的
    // 初始化，让出主线程先把登录页首帧画出来（<1.5s 目标）
    setTimeout(() => {
      // `getContext(this)` 已弃用；从 UIContext 取宿主 Context
      const ctx = this.getUIContext().getHostContext() as common.UIAbilityContext;
      this.avSession = new HarmonyAVSessionManager(ctx, null);
      this.avSession.init();
      // 播放内核需要 context 拿 filesDir（缓存）与 AVSession（锁屏/长时任务）
      MediaPlayerCore.shared().init(ctx, this.avSession);
      AppState.shared().bootstrap(ctx);
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

  /** 底部导航按钮：系统 Symbol 图标 + 文字，选中态 accent；选中图标轻微弹大 */
  @Builder
  tabBuilder(title: string, icon: Resource, idx: number) {
    Column({ space: Dim.s0 }) {
      SymbolGlyph(icon)
        .fontSize(Dim.iconLg)
        .fontColor(this.currentTab === idx ? [Tokens.accent] : [Tokens.text2])
        .scale({
          x: this.currentTab === idx ? 1.15 : 1,
          y: this.currentTab === idx ? 1.15 : 1
        })
        .animation({ duration: Motion.standard, curve: Motion.curve })
      Text(title)
        .fontSize(Dim.fsCaption)
        .fontColor(this.currentTab === idx ? Tokens.accent : Tokens.text2)
    }
    .justifyContent(FlexAlign.Center)
  }

  @Builder
  playerBar() {
    Row({ space: Dim.s2 }) {
      Image(this.cover.length > 0 ? this.cover : $r('app.media.app_icon'))
        .width(Dim.coverBar).height(Dim.coverBar).borderRadius(Dim.radiusSm).objectFit(ImageFit.Cover)
      Column({ space: Dim.s0 }) {
        Text(this.title).fontSize(Dim.fsSub).fontColor(Tokens.text1).maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        Text(this.artist).fontSize(Dim.fsCaption).fontColor(Tokens.text2).maxLines(1)
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1)
      Button(this.playing ? '暂停' : '播放')
        .height(Dim.touchMin).backgroundColor(Tokens.accent).fontColor(Tokens.bg).fontSize(Dim.fsMinor)
        .accessibilityText(this.playing ? '暂停' : '播放')
        .onClick(() => { MediaPlayerCore.shared().toggle(); })
    }
    .width('100%')
    .padding({ left: Dim.s3, right: Dim.s3, top: Dim.s2, bottom: Dim.s2 })
    .backgroundColor(Tokens.panel)
    .accessibilityText('打开播放页')
    .onClick(() => { this.showPlayer = true; })
  }

  build() {
    Stack() {
      if (!this.loggedIn) {
        LoginPage()
      } else {
        Column() {
          Tabs({ index: this.currentTab, barPosition: BarPosition.End }) {
            TabContent() { HomePage() }
              .tabBar(this.tabBuilder('首页', $r('sys.symbol.house'), 0))
            TabContent() { SearchPage() }
              .tabBar(this.tabBuilder('搜索', $r('sys.symbol.magnifyingglass'), 1))
            TabContent() { FavoritesPage() }
              .tabBar(this.tabBuilder('收藏', $r('sys.symbol.heart'), 2))
            TabContent() { DailyPage() }
              .tabBar(this.tabBuilder('专属', $r('sys.symbol.calendar'), 3))
            TabContent() {
              SettingsPage({
                onOpenServers: (): void => { this.showServers = true; },
                onOpenCache: (): void => { this.showCache = true; }
              })
            }
              .tabBar(this.tabBuilder('我的', $r('sys.symbol.person'), 4))
          }
          .onChange((i: number) => {
            // 页面零动效：任何整页位移/透明度变化都会读成"抖动/闪屏"。
            // 动效只保留在 tab 按钮上（选中图标弹跳 + 变色）
            this.currentTab = i;
          })
          // 禁用 Tabs 自带的横滑切页：它会抢走列表行右滑收藏手势的横向位移
          // （Tab 仍可通过底部 tabBar 点击切换，与 web 移动端行为一致）
          .scrollable(false)
          .layoutWeight(1)

          if (this.hasTrack) { this.playerBar() }
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
