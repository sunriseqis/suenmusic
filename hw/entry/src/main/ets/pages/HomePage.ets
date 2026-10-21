import { AppState } from '../viewmodel/AppState';
import { MediaPlayerCore, K_TRACKID, K_HAS_TRACK } from '../core/MediaPlayerCore';
import { HomeData, Track, Toplist, StreamSessionToken, artistLine } from '../core/Models';
import { ApiError, APIClient } from '../core/APIClient';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { Tokens } from '../common/Tokens';

/** 首页：新歌/榜单（S2 只做能点播的列表，视觉在 S4 打磨） */
@Component
export struct HomePage {
  @State home: HomeData | null = null;
  @State loading: boolean = false;
  @State err: string = '';
  @StorageLink(K_TRACKID) currentTrackId: string = '';
  @StorageLink(K_HAS_TRACK) hasTrack: boolean = false;

  aboutToAppear(): void { this.load(); }

  private async load(): Promise<void> {
    this.loading = true;
    this.err = '';
    try {
      this.home = await AppState.shared().home();
    } catch (e) {
      this.err = (e as ApiError).message === undefined ? '加载失败' : (e as ApiError).message;
    } finally {
      this.loading = false;
    }
  }

  private async playAt(list: Track[], index: number): Promise<void> {
    /**
     * 断网（飞行模式）时取不到流令牌 —— 不能因此拦截点击：
     * 缓存命中的曲目走 `fd://` 离线播根本不需要令牌，所以这里降级成
     * 空令牌继续 setQueue；真正无网又无缓存的曲目由播放内核的失败
     * 自愈（failStreak ≥ 3 停下）给出人话提示，不会无限连跳。
     */
    let token = '';
    try {
      token = (await APIClientToken()).token;
    } catch (e) {
      hilog.warn(0x0000, 'HomePage', '取流令牌失败（可能离线），缓存曲走离线播放: %{public}s', JSON.stringify(e));
    }
    try {
      await MediaPlayerCore.shared().setQueue(list, index, token);
    } catch (e) {
      this.err = '无法装载音源：' + ((e as ApiError).message ?? '');
      hilog.error(0x0000, 'HomePage', 'setQueue 失败: %{public}s', JSON.stringify(e));
    }
  }

  @Builder
  trackRow(track: Track, list: Track[], index: number) {
    Row({ space: 10 }) {
      Image(track.al.picUrl.length > 0 ? track.al.picUrl : $r('app.media.app_icon'))
        .width(44).height(44).borderRadius(6).objectFit(ImageFit.Cover)
      Column({ space: 2 }) {
        Text(track.name)
          .fontSize(15)
          .fontColor(this.currentTrackId === track.id ? Tokens.accent : Tokens.text1)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        Text(artistLine(track))
          .fontSize(11)
          .fontColor(Tokens.text2)
          .maxLines(1)
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1)
    }
    .width('100%')
    .padding({ left: 16, right: 16, top: 8, bottom: 8 })
    .onClick(() => { this.playAt(list, index); })
  }

  build() {
    Column() {
      if (this.loading && this.home === null) {
        Row() { LoadingProgress().width(28).height(28) }.width('100%').justifyContent(FlexAlign.Center).margin({ top: 40 })
      } else if (this.err.length > 0 && this.home === null) {
        Column({ space: 10 }) {
          Text(this.err).fontSize(13).fontColor('#E5484D')
          Button('重试').onClick(() => { this.load(); })
        }.width('100%').margin({ top: 40 })
      } else if (this.home !== null) {
        List({ space: 0 }) {
          if (this.home.welcomePhrase !== undefined && this.home.welcomePhrase.length > 0) {
            ListItem() {
              Text(this.home.welcomePhrase).fontSize(16).fontWeight(FontWeight.Medium)
                .width('100%').padding({ left: 16, right: 16, top: 12, bottom: 4 })
            }
          }
          if (this.home.newSongs.length > 0) {
            ListItem() {
              Text('新歌首发').fontSize(12).fontColor(Tokens.text2)
                .width('100%').padding({ left: 16, top: 12, bottom: 4 })
            }
            ForEach(this.home.newSongs, (t: Track, i: number) => {
              ListItem() { this.trackRow(t, this.home === null ? [] : this.home.newSongs, i) }
            }, (t: Track) => t.id)
          }
          if (this.home.toplists.length > 0) {
            ListItem() {
              Text('榜单').fontSize(12).fontColor(Tokens.text2)
                .width('100%').padding({ left: 16, top: 16, bottom: 4 })
            }
            ForEach(this.home.toplists, (l: Toplist) => {
              ListItem() {
                Row() {
                  Text(l.name).fontSize(15).fontColor(Tokens.text1)
                  Blank()
                  Text(l.updateFrequency === undefined ? '' : l.updateFrequency)
                    .fontSize(11).fontColor(Tokens.text2)
                }
                .width('100%').padding({ left: 16, right: 16, top: 10, bottom: 10 })
              }
            }, (l: Toplist) => l.id)
          }
        }
        .width('100%')
        .layoutWeight(1)
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Tokens.bg)
  }
}

/** 取流会话令牌的小包装（避免在页面里堆 try/catch） */
async function APIClientToken(): Promise<StreamSessionToken> {
  return APIClient.shared().streamSessionToken();
}
