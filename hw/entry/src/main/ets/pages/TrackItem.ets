import { Track, artistLine } from '../core/Models';
import { K_TRACKID } from '../core/MediaPlayerCore';
import { Tokens } from '../common/Tokens';
import { Dim, Motion } from '../common/Dimension';

// ---------------------------------------------------------------------------
// 移动端右滑：收藏 / 取消收藏（§一点六，与 web TrackRow.vue 逐一对齐，单位 vp≈web CSS px）
// 只认右滑：动作区在行的左侧被拉出来；左滑不消耗（留给未来的左滑操作）。
// ---------------------------------------------------------------------------
/** 判定为水平滑动所需的最小位移 */
const SWIPE_GATE = 8;
/**
 * 竖直方向的「认输」阈值：手势还没变成水平前就明显向下拉了，整个让位给
 * 列表滚动/下拉刷新。原生由 `PanDirection.Horizontal` 的手势仲裁实现等价
 * 语义 —— 竖直位移占优时 PanGesture 根本不会响应，滚动照常接管。
 */
const VERTICAL_COMMIT = 24;
/** 超过这个位移后加阻尼，避免行被拉得过远 */
const SWIPE_DAMP_AT = 150;
const SWIPE_DAMP_FACTOR = 0.25;
/** 松手触发动作的阈值 */
const SWIPE_THRESHOLD = 85;
/** 触发后（收藏页）的滑出距离 */
const SWIPE_OUT = 360;
/** 滑出/弹回动画时长（走 Motion 统一时长） */
const SWIPE_ANIM_MS = Motion.standard;
/** 手势结束后吞掉合成 click 的时间窗（手势仲裁之外再加一道保险，防误切歌） */
const CLICK_GUARD_MS = 350;

/**
 * 公共曲目行：序号 / 封面 / 标题 / 歌手 / 当前播放高亮 / 右滑收藏手势。
 *
 * 点歌统一由父组件传入 `onTap`（内部走 `MediaPlayerCore.setQueue`，
 * 组件自己不拼流地址、不碰播放状态机）。
 * 右滑过阈值回调 `onSwipeToggle`：普通页 = 切换收藏；收藏页传
 * `swipeRemoveOnUnfavorite`，先滑出 360、动画走完再回调（父级随后剪行）。
 * 回调返回 `true` = 状态已落地（收藏页会剪掉本行），`false` = 失败（行弹回）。
 * 行高 `Dim.rowHeight`、颜色只走 `Tokens.*`（动作区 danger 红除外 —— web 同款语义色）。
 * 按压高亮 = 列表项点击反馈（S4 §二：Tokens.panel，不用透明度）。
 */
@Component
export struct TrackItem {
  /** 当前播放曲目 id 的只读快照，做高亮用 */
  @StorageProp(K_TRACKID) currentTrackId: string = '';
  @State pressed: boolean = false;
  /** 右滑实时位移（阻尼后） */
  @State swipeX: number = 0;
  /** 已过阈值、行正在滑出（收藏页随后被父级剪掉） */
  @State vanishing: boolean = false;

  track: Track = { id: '', name: '', ar: [], al: { id: '', name: '', picUrl: '' }, dt: 0 };
  /** 序号（1 起）；< 0 不显示序号列 */
  index: number = -1;
  /** 当前曲目是否已收藏：决定动作区文案、底色与序号染色 */
  @Prop isFav: boolean = false;
  /** 已收藏时把序号染琥珀；收藏页传 false（每行都是收藏，全染没有信息量） */
  markFav: boolean = true;
  /** 收藏页专用：右滑过阈值 = 取消收藏且行滑出消失 */
  swipeRemoveOnUnfavorite: boolean = false;
  /** 过阈值回调（松手且 swipeX ≥ 85 时触发一次） */
  onSwipeToggle: (() => Promise<boolean>) | null = null;
  onTap: () => void = () => {};

  /** 最近一次手势结束时间：吞掉手势结束后的合成 click */
  private lastSwipeEndAt: number = 0;

  private animateSwipeTo(target: number): void {
    this.getUIContext().animateTo({ duration: SWIPE_ANIM_MS, curve: Motion.curve }, () => {
      this.swipeX = target;
    });
  }

  build() {
    Stack() {
      // 右滑拉出的动作区：出现在行的左侧，文案 = 当前状态的反义。
      // 底色按 web：未收藏→琥珀（accentText + 白字）；已收藏→danger 红 + 浅红字。
      Row({ space: Dim.s1 }) {
        Image(this.isFav ? $r('app.media.card_heart_filled') : $r('app.media.card_heart'))
          .width(Dim.iconSm)
          .height(Dim.iconSm)
          .fillColor(this.isFav ? '#FFDAD6' : Color.White)
        Text(this.isFav ? '取消收藏' : '收藏')
          .fontSize(Dim.fsBody)
          .fontWeight(FontWeight.Medium)
          .fontColor(this.isFav ? '#FFDAD6' : Color.White)
      }
      .width('100%')
      .height('100%')
      .padding({ left: Dim.s5 })
      .alignItems(VerticalAlign.Center)
      .justifyContent(FlexAlign.Start)
      .backgroundColor(this.isFav ? '#8A1F18' : Tokens.accentText)
      .borderRadius(Dim.radiusRow)

      // 行内容：底色必须不透明 —— 下面就是动作区，透明会整行透出那条色
      Row({ space: Dim.s2 }) {
        if (this.index >= 0) {
          Text(this.index.toString())
            .fontSize(Dim.fsMinor)
            .fontColor(this.isFav && this.markFav ? Tokens.accent : Tokens.text2)
            .width(Dim.seqW)
            .textAlign(TextAlign.Center)
        }
        Image(this.track.al.picUrl.length > 0 ? this.track.al.picUrl : $r('app.media.app_icon'))
          .width(Dim.coverSm).height(Dim.coverSm).borderRadius(Dim.radiusSm).objectFit(ImageFit.Cover)
        Column({ space: Dim.s0 }) {
          Text(this.track.name)
            .fontSize(Dim.fsTitle)
            .fontColor(this.currentTrackId === this.track.id ? Tokens.accent : Tokens.text1)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
          Text(artistLine(this.track))
            .fontSize(Dim.fsCaption)
            .fontColor(Tokens.text2)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }
        .alignItems(HorizontalAlign.Start)
        .layoutWeight(1)
      }
      .width('100%')
      .height(Dim.rowHeight)
      .padding({ left: Dim.s4, right: Dim.s4 })
      .backgroundColor(this.pressed ? Tokens.panel : Tokens.bg)
      .borderRadius(Dim.radiusRow)
      .translate({ x: this.swipeX })
    }
    .width('100%')
    .height(Dim.rowHeight)
    .clip(true)
    .borderRadius(Dim.radiusRow)
    .onTouch((e: TouchEvent) => {
      if (e.type === TouchType.Down) {
        this.pressed = true;
      } else if (e.type === TouchType.Up || e.type === TouchType.Cancel) {
        this.pressed = false;
      }
    })
    .onClick(() => {
      // 手势刚结束的合成 click 一律吞掉（ArkUI 手势仲裁已拦 tap，这里再加一道保险）
      if (Date.now() - this.lastSwipeEndAt < CLICK_GUARD_MS) { return; }
      this.onTap();
    })
    .gesture(
      PanGesture({ fingers: 1, direction: PanDirection.Horizontal, distance: SWIPE_GATE })
        .onActionUpdate((e: GestureEvent) => {
          if (this.vanishing) { return; }
          const dx = e.offsetX;
          // 只认右滑：左滑不消耗
          if (dx <= 0) {
            this.swipeX = 0;
            return;
          }
          this.swipeX = dx > SWIPE_DAMP_AT ? SWIPE_DAMP_AT + (dx - SWIPE_DAMP_AT) * SWIPE_DAMP_FACTOR : dx;
        })
        .onActionEnd(() => {
          this.lastSwipeEndAt = Date.now();
          if (this.vanishing) { return; }
          if (this.swipeX < SWIPE_THRESHOLD) {
            // 没过阈值：弹回，不触发任何动作
            this.animateSwipeTo(0);
            return;
          }
          if (this.swipeRemoveOnUnfavorite && this.isFav) {
            // 收藏页：先滑出去，动画走完再让父级改状态剪行（顺序反了看不到滑出）
            this.vanishing = true;
            this.animateSwipeTo(SWIPE_OUT);
            setTimeout(() => {
              const cb = this.onSwipeToggle;
              if (cb === null) { return; }
              cb().then((removed: boolean) => {
                // 失败兜底：父级没剪掉就把行弹回来（成功时组件已被销毁，走不到可见效果）
                if (!removed) {
                  this.vanishing = false;
                  this.animateSwipeTo(0);
                }
              }).catch(() => {
                this.vanishing = false;
                this.animateSwipeTo(0);
              });
            }, SWIPE_ANIM_MS);
            return;
          }
          // 普通页：行留在原地，弹回后由序号染色/文案变化确认结果
          const cb = this.onSwipeToggle;
          if (cb !== null) { cb(); }
          this.animateSwipeTo(0);
        })
        .onActionCancel(() => {
          // 手势被系统打断（来电、返回手势接管）：只复位，绝不当作「已触发」
          this.lastSwipeEndAt = Date.now();
          if (this.vanishing) { return; }
          this.animateSwipeTo(0);
        })
    )
  }
}
