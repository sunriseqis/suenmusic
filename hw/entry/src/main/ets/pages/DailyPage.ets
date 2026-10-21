import { hilog } from '@kit.PerformanceAnalysisKit';
import { APIClient, ApiError } from '../core/APIClient';
import { MediaPlayerCore } from '../core/MediaPlayerCore';
import { DailyRecommend, Track } from '../core/Models';
import { Tokens } from '../common/Tokens';
import { TrackItem } from './TrackItem';

const TAG = 'SuenMusic_Daily';

/**
 * 每日推荐：只读（歌单由服务端每天 00:30 产出，无「换一批」）。
 *
 * **`shortfall` 不是错误** —— 曲库不足是正常业务结果，界面给引导文案
 * （「曲库还太少，先多听几首再来看看」），不重试、不报错。
 * 「播放全部」= 当日歌单整队入 `setQueue`，从第 1 首起播。
 */
@Component
export struct DailyPage {
  @State data: DailyRecommend | null = null;
  @State loading: boolean = false;
  @State err: string = '';

  aboutToAppear(): void { this.load(); }

  private async load(): Promise<void> {
    if (this.loading) { return; }
    this.loading = true;
    this.err = '';
    try {
      this.data = await APIClient.shared().dailyRecommend();
    } catch (e) {
      this.err = (e as ApiError).message === undefined ? '加载失败' : (e as ApiError).message;
    } finally {
      this.loading = false;
    }
  }

  private async playAll(): Promise<void> {
    const data = this.data;
    if (data === null || data.tracks.length === 0) { return; }
    let token = '';
    try {
      token = (await APIClient.shared().streamSessionToken()).token;
    } catch (e) {
      hilog.warn(0x0000, TAG, '取流令牌失败（可能离线），缓存曲走离线播放: %{public}s', JSON.stringify(e));
    }
    try {
      await MediaPlayerCore.shared().setQueue(data.tracks, 0, token);
    } catch (e) {
      this.err = '无法装载音源：' + ((e as ApiError).message ?? '');
      hilog.error(0x0000, TAG, 'setQueue 失败: %{public}s', JSON.stringify(e));
    }
  }

  private async playAt(index: number): Promise<void> {
    const data = this.data;
    if (data === null) { return; }
    let token = '';
    try {
      token = (await APIClient.shared().streamSessionToken()).token;
    } catch (e) {
      hilog.warn(0x0000, TAG, '取流令牌失败（可能离线），缓存曲走离线播放: %{public}s', JSON.stringify(e));
    }
    try {
      await MediaPlayerCore.shared().setQueue(data.tracks, index, token);
    } catch (e) {
      this.err = '无法装载音源：' + ((e as ApiError).message ?? '');
      hilog.error(0x0000, TAG, 'setQueue 失败: %{public}s', JSON.stringify(e));
    }
  }

  build() {
    Column() {
      if (this.loading && this.data === null) {
        Row() { LoadingProgress().width(28).height(28) }
          .width('100%')
          .layoutWeight(1)
          .justifyContent(FlexAlign.Center)
      } else if (this.err.length > 0 && this.data === null) {
        Column({ space: 10 }) {
          Text(this.err).fontSize(13).fontColor('#E5484D')
          Button('重试').onClick(() => { this.load(); })
        }
        .width('100%')
        .layoutWeight(1)
        .justifyContent(FlexAlign.Center)
      } else if (this.data !== null) {
        if (this.data.welcomePhrase !== undefined && this.data.welcomePhrase.length > 0) {
          Text(this.data.welcomePhrase)
            .fontSize(18)
            .fontWeight(FontWeight.Medium)
            .fontColor(Tokens.text1)
            .width('100%')
            .padding({ left: 16, right: 16, top: 12 })
        }
        if (this.data.greeting !== undefined && this.data.greeting.length > 0) {
          Text(this.data.greeting)
            .fontSize(12)
            .fontColor(Tokens.text2)
            .width('100%')
            .padding({ left: 16, right: 16, top: 4 })
        }

        if (this.data.tracks.length > 0) {
          Button('播放全部')
            .width('100%')
            .height(44)
            .fontSize(14)
            .backgroundColor(Tokens.accent)
            .fontColor(Tokens.bg)
            .margin({ left: 16, right: 16, top: 12 })
            .onClick(() => { this.playAll(); })
          List({ space: 0 }) {
            ForEach(this.data.tracks, (t: Track, i: number) => {
              ListItem() {
                TrackItem({
                  track: t,
                  onTap: () => { this.playAt(i); }
                })
              }
            }, (t: Track) => t.id)
          }
          .width('100%')
          .layoutWeight(1)
        } else if (this.data.status === 'shortfall') {
          // 曲库不足：引导文案（服务端 message 优先），不是错误、不重试
          Column() {
            Text(this.data.message === undefined ? '曲库还太少，先多听几首再来看看' : this.data.message)
              .fontSize(13).fontColor(Tokens.text2)
          }
          .width('100%')
          .layoutWeight(1)
          .justifyContent(FlexAlign.Center)
        } else if (this.data.status === 'generating') {
          Column() {
            Text(this.data.message === undefined ? '今日歌单正在生成，稍后再来看看' : this.data.message)
              .fontSize(13).fontColor(Tokens.text2)
          }
          .width('100%')
          .layoutWeight(1)
          .justifyContent(FlexAlign.Center)
        } else if (this.data.status === 'error') {
          Column({ space: 10 }) {
            Text(this.data.message === undefined ? '今日歌单生成失败' : this.data.message)
              .fontSize(13).fontColor(Tokens.text2)
            Button('重试').onClick(() => { this.load(); })
          }
          .width('100%')
          .layoutWeight(1)
          .justifyContent(FlexAlign.Center)
        } else {
          // 状态 ready 但曲目被过滤成空：与 shortfall 同口径的人话
          Column() {
            Text('曲库还太少，先多听几首再来看看')
              .fontSize(13).fontColor(Tokens.text2)
          }
          .width('100%')
          .layoutWeight(1)
          .justifyContent(FlexAlign.Center)
        }
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Tokens.bg)
  }
}
