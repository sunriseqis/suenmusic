/**
 * 鸿蒙原生客户端入口（S2）。
 *
 * **这里没有 ArkWeb、没有 WebView** —— 全原生迭代的前提。
 * 旧 `pages/Index.ets`（WebView 壳）保留在原处作为回退路径，S2/S3 验收通过后删除。
 */

import { LoginPage } from './LoginPage';
import { HomePage } from './HomePage';
import { SettingsPage } from './SettingsPage';
import { PlayerPage } from './PlayerPage';
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
  // ⚠️ 不能叫 `tabIndex`：ArkUI 的 Tabs 有同名属性修饰符，重名会报类型冲突
  @State currentTab: number = 0;

  private avSession: HarmonyAVSessionManager | null = null;

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
            TabContent() { HomePage() }.tabBar('首页')
            TabContent() { SettingsPage() }.tabBar('我的')
          }
          .onChange((i: number) => { this.currentTab = i; })
          .layoutWeight(1)

          if (this.hasTrack) { this.playerBar() }
        }
        .width('100%').height('100%')
      }

      if (this.showPlayer) {
        PlayerPage({ onClose: () => { this.showPlayer = false; } })
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Tokens.bg)
  }
}
