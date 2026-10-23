import { Track, artistLine, formatDuration } from '../core/Models';
import { K_TRACKID } from '../core/MediaPlayerCore';
import { Tokens } from '../common/Tokens';
import { Dim, Motion } from '../common/Dimension';
import { WebIcon, WebIconName } from '../common/WebIcons';

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

// ---------------------------------------------------------------------------
// 在播指示三竖条（web TrackRow .bars：高 60%/100%/45% × 容器 14px，
// bounce 1s 无限循环、相位差 0/160/320ms）。循环指示灯不受 S4 §二 300ms
// 过渡禁令约束（那是针对转场动效；这里是不间断的播放状态灯）。
// ---------------------------------------------------------------------------
const BOUNCE_MS = 1000;
const BAR_BOX = 14;
const BAR_H_TALL = 14;
const BAR_H_MID = 8;
const BAR_H_SHORT = 6;
const BAR_DELAY_MID = 160;
const BAR_DELAY_SHORT = 320;
/** web @keyframes bounce：scaleY 0.5 ↔ 1 */
const SCALE_LOW = 0.5;
const SCALE_HIGH = 1;
/** 在播行琥珀薄染浓度（web color-mix(accent 7%, panel)） */
const CUR_TINT = 0.07;
/** 行尾时长列宽（web 移动端 .dur 46px） */
const DUR_W = 46;
/** 行尾「不喜欢」双钮图标尺寸（web 移动端 NeuIcon dislike-* 16px） */
const DISLIKE_ICON = 16;

/**
 * 在播三竖条（web TrackRow .bars）：序号列的播放指示灯。
 * 三根条各跑一段无限 alternate 动画（相位差 0/160/320ms），组件销毁自动停。
 */
@Component
struct PlayingBars {
  @State sLeft: number = SCALE_LOW;
  @State sCenter: number = SCALE_LOW;
  @State sRight: number = SCALE_LOW;
  private started: boolean = false;

  private startBars(): void {
    if (this.started) { return; }
    this.started = true;
    this.getUIContext().animateTo(
      { duration: BOUNCE_MS, curve: Motion.curve, iterations: -1, playMode: PlayMode.Alternate },
      () => { this.sLeft = SCALE_HIGH; });
    this.getUIContext().animateTo(
      { duration: BOUNCE_MS, curve: Motion.curve, iterations: -1, playMode: PlayMode.Alternate, delay: BAR_DELAY_MID },
      () => { this.sCenter = SCALE_HIGH; });
    this.getUIContext().animateTo(
      { duration: BOUNCE_MS, curve: Motion.curve, iterations: -1, playMode: PlayMode.Alternate, delay: BAR_DELAY_SHORT },
      () => { this.sRight = SCALE_HIGH; });
  }

  build() {
    Row({ space: Dim.s0 }) {
      Column().width(Dim.s0).height(BAR_H_MID).borderRadius(Dim.hairline).backgroundColor(Tokens.accent)
        .scale({ x: 1, y: this.sLeft, centerX: '50%', centerY: '100%' })
      Column().width(Dim.s0).height(BAR_H_TALL).borderRadius(Dim.hairline).backgroundColor(Tokens.accent)
        .scale({ x: 1, y: this.sCenter, centerX: '50%', centerY: '100%' })
      Column().width(Dim.s0).height(BAR_H_SHORT).borderRadius(Dim.hairline).backgroundColor(Tokens.accent)
        .scale({ x: 1, y: this.sRight, centerX: '50%', centerY: '100%' })
    }
    .height(BAR_BOX)
    .alignItems(VerticalAlign.Bottom)
    .onAppear(() => { this.startBars(); })
  }
}

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
  /** 封面边长（vp）。移动端统一 40（web 移动端 .cov 40px，T10 收官第 ① 条） */
  coverSize: number = Dim.coverBar;
  /** 当前曲目是否已收藏：决定动作区文案、底色与序号染色 */
  @Prop isFav: boolean = false;
  /** 已收藏时把序号染琥珀；收藏页传 false（每行都是收藏，全染没有信息量） */
  markFav: boolean = true;
  /** 收藏页专用：右滑过阈值 = 取消收藏且行滑出消失 */
  swipeRemoveOnUnfavorite: boolean = false;
  /** 过阈值回调（松手且 swipeX ≥ 85 时触发一次） */
  onSwipeToggle: (() => Promise<boolean>) | null = null;
  onTap: () => void = () => {};
  /** 专属页（每日推荐）行：行尾常显「不喜欢」双图标钮（web TrackRow act-wide 同构，时长列让位、双钮常显） */
  dislikeable: boolean = false;
  /** 行尾时长列（web 移动端行尾 .dur 46px；每日推荐行因双钮常显自动让位，与 web 一致） */
  showDur: boolean = false;
  /** 「不喜欢这首歌」（web dislike-track） */
  onDislikeTrack: () => void = () => {};
  /** 「不喜欢该歌手」（web dislike-artist） */
  onDislikeArtist: () => void = () => {};

  /** 单「不喜欢」钮按压染色（accent 反馈；T11 第 4 条：双钮合并为单钮 + 弹窗选范围） */
  @State disPressed: boolean = false;

  /** 最近一次手势结束时间：吞掉手势结束后的合成 click */
  private lastSwipeEndAt: number = 0;

  private animateSwipeTo(target: number): void {
    this.getUIContext().animateTo({ duration: SWIPE_ANIM_MS, curve: Motion.curve }, () => {
      this.swipeX = target;
    });
  }

  /**
   * 「不喜欢」单钮 → 弹窗选范围（T11 第 4 条）。
   * 只负责选范围；落地动作仍由父级 onDislikeTrack / onDislikeArtist 承担
   * （toast / 队列摘除 / 通知每日页重拉都在父级）。
   * 没有歌手信息时「这位歌手」置灰（web dislike-artist 同口径：拿不到 mid 不能提交）。
   */
  private openDislikeDialog(): void {
    const artist = this.track.ar.length > 0 ? this.track.ar[0].name : '';
    const hasArtist = artist.length > 0;
    this.getUIContext().showAlertDialog({
      title: '不喜欢',
      message: hasArtist
        ? '《' + this.track.name + '》· 歌手「' + artist + '」'
        : '《' + this.track.name + '》没有歌手信息，只能不喜欢这首歌',
      buttons: [
        {
          value: '不喜欢这首歌',
          action: (): void => {
            this.onDislikeTrack();
          }
        },
        {
          value: '不喜欢这位歌手',
          enabled: hasArtist,
          action: (): void => {
            this.onDislikeArtist();
          }
        },
        {
          value: '取消',
          action: (): void => {}
        }
      ]
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
      .borderRadius(Dim.radiusMd)

      // 行内容：底色必须不透明 —— 下面就是动作区，透明会整行透出那条色。
      // 外层 Stack：在播时叠加 7% 琥珀薄染（web color-mix(accent 7%, panel) 等价物）
      Stack() {
        Row({ space: Dim.s2 }) {
          if (this.index >= 0) {
            if (this.currentTrackId === this.track.id) {
              // 在播：序号列换成三根跳动竖条（web .bars 播放指示灯）
              Column() {
                PlayingBars()
              }
              .width(Dim.seqW)
              .justifyContent(FlexAlign.Center)
            } else {
              Text(this.index.toString())
                .fontSize(Dim.fsMinor)
                .fontColor(this.isFav && this.markFav ? Tokens.accent : Tokens.text2)
                .width(Dim.seqW)
                .textAlign(TextAlign.Center)
            }
          }
          Image(this.track.al.picUrl.length > 0 ? this.track.al.picUrl : $r('app.media.app_icon'))
            .width(this.coverSize).height(this.coverSize).borderRadius(Dim.radiusSm).objectFit(ImageFit.Cover)
          Column({ space: Dim.s0 }) {
            Text(this.track.name)
              .fontSize(Dim.fsSub)
              .fontWeight(this.currentTrackId === this.track.id ? FontWeight.Medium : FontWeight.Normal)
              .fontColor(this.currentTrackId === this.track.id ? Tokens.accentText : Tokens.text1)
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
            Text(artistLine(this.track))
              .fontSize(Dim.fsMinor)
              .fontColor(Tokens.text2)
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
          }
          .alignItems(HorizontalAlign.Start)
          .layoutWeight(1)
          // 行尾时长列（web 移动端 .dur 46px）：每日推荐行让位给双「不喜欢」钮，与 web 同口径
          if (this.showDur && !this.dislikeable) {
            Text(formatDuration(this.track.dt))
              .fontSize(Dim.fsMinor)
              .fontColor(Tokens.text2)
              .width(DUR_W)
              .textAlign(TextAlign.End)
          }
        // 每日推荐行：行尾**单**「不喜欢」钮（T11 第 4 条：两个图标不好区分 → 合并为 1 个，
        // 点击弹窗选「不喜欢这首歌 / 这位歌手」）。点击吞掉冒泡，不触发行点击切歌。
        if (this.dislikeable) {
          // WebIcon 是全局 @Builder（void 返回），不能链属性 —— 触摸区/按压态由外层 Row 承载
          Row() {
            WebIcon(WebIconName.DISLIKE_SONG, DISLIKE_ICON,
              this.disPressed ? Tokens.accent : Tokens.text2)
          }
            .constraintSize({ minWidth: Dim.touchMin })
            .height('100%')
            .padding({ left: Dim.s2, right: Dim.s2 })
            .justifyContent(FlexAlign.Center)
            .alignSelf(ItemAlign.Center)
            .accessibilityText('不喜欢')
            .onClick(() => {
              this.openDislikeDialog();
            })
            .onTouch((e: TouchEvent) => {
              if (e.type === TouchType.Down) {
                this.disPressed = true;
              } else if (e.type === TouchType.Up || e.type === TouchType.Cancel) {
                this.disPressed = false;
              }
            })
        }
        }
        .width('100%')
        .height('100%')
        .padding({ left: Dim.s2, right: Dim.s2 })
        .backgroundColor(this.pressed ? Tokens.panel : Tokens.bg)
        // 在播薄染层（叠最上：7% 琥珀罩整行，视觉=掺进底色）
        if (this.currentTrackId === this.track.id) {
          Column()
            .width('100%')
            .height('100%')
            .backgroundColor(Tokens.accent)
            .opacity(CUR_TINT)
        }
      }
      .width('100%')
      .height(Dim.rowHeight)
      .border({
        // 左 2px 在播琥珀条（web inset 2px box-shadow）+ 底沿发丝分割线（web border-bottom）
        width: { left: this.currentTrackId === this.track.id ? Dim.s0 : 0, bottom: Dim.hairline },
        color: { left: Tokens.accent, bottom: Tokens.line }
      })
      .translate({ x: this.swipeX })
    }
    .width('100%')
    .height(Dim.rowHeight)
    .clip(true)
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
