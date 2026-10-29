/**
 * 尺寸 / 间距 / 字号 / 动效常量（S4 §一）。
 *
 * 页面里 `padding/margin/borderRadius/fontSize/height` 一律走 `Dim`，禁止裸数字（0 除外）；
 * 动效时长 / 曲线 / 缩放走 `Motion`（统一 200ms，快动效 100ms，禁止 >300ms；
 * 曲线只允许 EaseOut / Friction）。验收会 grep 页面里的裸数字模式。
 * 颜色不在本文件 —— 颜色只走 `Tokens.*`。
 */
export class Dim {
  // ---- 间距（vp，4 的倍数节奏） ----
  static readonly s0 = 2;
  static readonly s1 = 4;
  static readonly s2 = 8;
  static readonly s3 = 12;
  static readonly s4 = 16;
  static readonly s5 = 24;
  static readonly s6 = 32;

  // ---- 圆角（vp） ----
  static readonly radiusSm = 6;
  static readonly radiusRow = 8;
  static readonly radiusMd = 12;
  static readonly radiusPill = 14;
  static readonly radiusLg = 16;
  static readonly radiusAvatar = 22;

  // ---- 字号（fp） ----
  /** 最小字号：再小牺牲可读性（S4 §九） */
  static readonly fsCaption = 11;
  static readonly fsMinor = 12;
  static readonly fsBody = 13;
  static readonly fsSub = 14;
  static readonly fsTitle = 15;
  static readonly fsSection = 16;
  static readonly fsHeadline = 18;
  static readonly fsDisplay = 20;
  /** 播放页曲名（web FullPlayer `.t-name` 24px，T10 批次 F） */
  static readonly fsHero = 24;
  static readonly fsBrand = 28;

  // ---- 行高 / 可点区域（vp） ----
  static readonly rowHeight = 56;
  static readonly touchMin = 44;

  // ---- 封面 / 图标（vp） ----
  static readonly coverSm = 44;
  static readonly coverBar = 40;
  static readonly coverXl = 280;
  /** 有推荐理由卡时的收缩封面（web `.has-reco .cover-wrap`：min(52vw,208px) 按比例折算） */
  static readonly coverReco = 194;
  /** 迷你条封面（web mini-cover 42px） */
  static readonly coverMini = 42;
  /** web 行内裸图标档位（NeuIcon 移动断点实际用值；按钮档位见 WebIconButton 的 28/36/44/60） */
  static readonly icon12 = 12;
  static readonly icon13 = 13;
  static readonly icon14 = 14;
  static readonly icon16 = 16;
  static readonly icon18 = 18;
  static readonly iconSm = 15;
  static readonly iconMd = 20;
  static readonly iconLg = 22;
  static readonly iconXl = 28;

  // ---- 控件（vp） ----
  static readonly btnSm = 28;
  static readonly btnMd = 36;
  static readonly btnBar = 40;
  static readonly btnPlayW = 96;
  /** 播放页主播放键圆形直径（web FullPlayer `.play-btn` 64px，T10 批次 F） */
  static readonly btnPlayCircle = 64;
  /** 播放页环境光晕模糊半径（web `.ambient` blur 60px，T10 批次 F） */
  static readonly glowBlur = 60;
  /** 播放页歌词 peek 区最小高（web `.lyric-wrap` min-height 58px，T10 批次 F） */
  static readonly peekH = 58;
  static readonly inputH = 40;
  /** 序号列宽（web 移动端 .idx 26px） */
  static readonly seqW = 26;
  /** 两级不喜欢浮层宽（web dislike-popover 210px） */
  static readonly popW = 210;
  /** 迷你条底部内嵌进度条高（web mini-progress 2px） */
  static readonly miniProgressH = 2;
  /** Tab 栏内格圆角（web calc(r-md - 3px) = 9px） */
  static readonly radiusTab = 9;
  /** Tab active 琥珀指示条（web .tab.active::after 12×2） */
  static readonly tabIndicatorW = 12;
  static readonly tabIndicatorH = 2;
  /** 分段控件（NeuTabs）格子高（web .tab min-height 32px） */
  static readonly segH = 32;

  // ---- 哑光质感（T5.5，web neu.css 同款语义） ----
  /** 发丝线宽（1px 描边/顶沿内高光条的厚度） */
  static readonly hairline = 1;
  /** 海报大卡占屏宽比例（web ≤767px 一屏 2 张 → 露出下一张边缘的视觉暗示） */
  static readonly posterRatio = 0.62;
  /** 海报压字渐变区占卡高比例（web poster-meta 的渐变覆盖带） */
  static readonly posterScrimRatio = 0.5;
  /** 指示点边长（web rail-dot 6px 方点） */
  static readonly dot = 6;

  /** 弹层顶把手（web Sheet .grip 36×3） */
  static readonly gripW = 36;
  static readonly gripH = 3;
  /** 弹层内明细列表最大高（超出滚动；备份/去重弹层共用） */
  static readonly sheetListMax = 320;
  /** 服务端管理弹层列表上限（约 3 条服务器行的高度，超出滚动） */
  static readonly serverListMax = 330;

  // ---- 歌词上下留白（vp）：让第一行 / 最后一行也能滚到屏幕中间 ----
  static readonly lyricPadTop = 120;
  static readonly lyricPadBottom = 160;
}

export class Motion {
  /** 交互动效统一时长（ms），禁止超过 300ms（S4 §二） */
  static readonly standard = 200;
  /** 快动效（ms）：交叉淡入 / 按压回弹 */
  static readonly fast = 100;
  /** 允许的曲线只有 EaseOut / Friction */
  static readonly curve = Curve.EaseOut;
  /** 按钮按压缩放（scale） */
  static readonly pressScale = 0.96;
  /** Tab 切换内容轻微上移量（vp） */
  static readonly tabLift = 8;
}
