import { Track, artistLine } from '../core/Models';
import { K_TRACKID } from '../core/MediaPlayerCore';
import { Tokens } from '../common/Tokens';

/**
 * 公共曲目行：封面 / 标题 / 歌手 / 当前播放高亮 / 可选右侧动作按钮。
 *
 * 点歌统一由父组件传入 `onTap`（内部走 `MediaPlayerCore.setQueue`，
 * 组件自己不拼流地址、不碰播放状态机）。
 * 行高 56vp、按压态走 `Tokens.panel`，颜色只走 `Tokens.*`。
 */
@Component
export struct TrackItem {
  /** 当前播放曲目 id 的只读快照，做高亮用 */
  @StorageProp(K_TRACKID) currentTrackId: string = '';
  @State pressed: boolean = false;

  track: Track = { id: '', name: '', ar: [], al: { id: '', name: '', picUrl: '' }, dt: 0 };
  /** 右侧动作图标（如取消收藏的红心），null = 不显示 */
  actionIcon: Resource | null = null;
  actionColor: string = Tokens.text2;
  onAction: (() => void) | null = null;
  onTap: () => void = () => {};

  build() {
    Row({ space: 10 }) {
      Image(this.track.al.picUrl.length > 0 ? this.track.al.picUrl : $r('app.media.app_icon'))
        .width(44).height(44).borderRadius(6).objectFit(ImageFit.Cover)
      Column({ space: 2 }) {
        Text(this.track.name)
          .fontSize(15)
          .fontColor(this.currentTrackId === this.track.id ? Tokens.accent : Tokens.text1)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        Text(artistLine(this.track))
          .fontSize(11)
          .fontColor(Tokens.text2)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1)

      if (this.actionIcon !== null && this.onAction !== null) {
        Image(this.actionIcon)
          .width(22)
          .height(22)
          .fillColor(this.actionColor)
          .onClick(() => {
            const cb = this.onAction;
            if (cb !== null) { cb(); }
          })
      }
    }
    .width('100%')
    .height(56)
    .padding({ left: 16, right: 16 })
    .backgroundColor(this.pressed ? Tokens.panel : Color.Transparent)
    .borderRadius(8)
    .onTouch((e: TouchEvent) => {
      if (e.type === TouchType.Down) {
        this.pressed = true;
      } else if (e.type === TouchType.Up || e.type === TouchType.Cancel) {
        this.pressed = false;
      }
    })
    .onClick(() => { this.onTap(); })
  }
}
