/**
 * 鸿蒙原生客户端入口（S2）。
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

  /** 避让区 px → vp（走 UIContext 实例方法，全局 px2vp 已弃用） */
  private avoidVp(px: number): number {
    return this.getUIContext().px2vp(px);
  }

  aboutToAppear(): void {
    // `getContext(this)` 已弃用；从 UIContext 取宿主 Context
    const ctx = this.getUIContext().getHostContext() as common.UIAbilityContext;
    this.avSession = new HarmonyAVSessionManager(ctx, null);
    this.avSession.init();
    // 播放内核需要 context 拿 filesDir（缓存）与 AVSession（锁屏/长时任务）
    MediaPlayerCore.shared().init(ctx, this.avSession);
    AppState.shared().bootstrap(ctx);
  }

  aboutToDisappear(): void {
    this.avSession?.destroy();
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

  /** 底部导航按钮：系统 Symbol 图标 + 文字，选中态 accent */
  @Builder
  tabBuilder(title: string, icon: Resource, idx: number) {
    Column({ space: 2 }) {
      SymbolGlyph(icon)
        .fontSize(22)
        .fontColor(this.currentTab === idx ? [Tokens.accent] : [Tokens.text2])
      Text(title)
        .fontSize(10)
        .fontColor(this.currentTab === idx ? Tokens.accent : Tokens.text2)
    }
    .justifyContent(FlexAlign.Center)
  }

  @Builder
  playerBar() {
    Row({ space: 10 }) {
      Image(this.cover.length > 0 ? this.cover : $r('app.media.app_icon'))
        .width(40).height(40).borderRadius(6).objectFit(ImageFit.Cover)
      Column({ space: 2 }) {
        Text(this.title).fontSize(14).fontColor(Tokens.text1).maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        Text(this.artist).fontSize(11).fontColor(Tokens.text2).maxLines(1)
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1)
      Button(this.playing ? '暂停' : '播放')
        .height(32).backgroundColor(Tokens.accent).fontColor(Tokens.bg).fontSize(12)
        .onClick(() => { MediaPlayerCore.shared().toggle(); })
    }
    .width('100%')
    .padding({ left: 12, right: 12, top: 8, bottom: 8 })
    .backgroundColor(Tokens.panel)
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
          .onChange((i: number) => { this.currentTab = i; })
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

      if (this.showPlayer) {
        PlayerPage({ onClose: () => { this.showPlayer = false; } })
      }

      if (this.showServers) {
        ServerListPage({ onClose: () => { this.showServers = false; } })
      }

      if (this.showCache) {
        CachePage({ onClose: () => { this.showCache = false; } })
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Tokens.bg)
  }
}
