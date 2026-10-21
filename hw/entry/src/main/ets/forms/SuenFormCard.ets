/**
 * 桌面卡片 v5 —— 仪表盘方向（2026-10-19 定稿）。
 *
 * 布局：
 *   2*2 = 封面 52 + 歌名两行 + 歌手；时间在进度线右上；下方三键（上一首/播放/下一首）
 *   2*4 = 三格：封面 / 信息（歌名、歌手、三行歌词、进度）/ 运输轨（三键纵向）
 *   收藏只在 2*4 的信息格右上角。
 *   没有翻转：歌词直接在 2*4 正面显示。
 *   空态：标题「暂无歌曲播放」，不显示歌手与歌词，控制键灰掉。
 *
 * ⚠️ 卡片页 API 白名单：@LocalStorageProp / postCardAction / animateTo 等可用，
 *    getUIContext / router / AppStorage 不可用（11706006）。
 * ⚠️ 接收的数据一律是 string（含数字），比较与转换都按字符串处理。
 * ⚠️ @Builder 按值传参的 UI 不随状态刷新 —— 图标/颜色/尺寸全部在 builder
 *    体内经 this.xxx 计算（上一版播放键永远显示 play 就是踩了这条）。
 */
let cardStorage = new LocalStorage();

@Entry(cardStorage)
@Component
struct SuenFormCard {
  @LocalStorageProp('suen_title') title: string = '暂无歌曲播放';
  @LocalStorageProp('suen_artist') artist: string = '';
  @LocalStorageProp('suen_cover') coverUrl: string = '';
  @LocalStorageProp('suen_playing') playing: string = 'false';
  @LocalStorageProp('suen_favorite') favorite: string = 'false';
  @LocalStorageProp('suen_lyric') lyric: string = '';
  @LocalStorageProp('suen_lyric_active') lyricActive: string = '-1';
  // ⚠️ 不能叫 `position`：那是 CustomComponent 的内置属性（用于设位置），
  // 同名在 ArkTS 里会报「Property 'position' is not assignable to base type」。
  @LocalStorageProp('suen_position') posText: string = '0';
  @LocalStorageProp('suen_duration') duration: string = '0';
  @LocalStorageProp('suen_alive') alive: string = 'false';
  @LocalStorageProp('suen_dimension') dimension: string = '2';
  @LocalStorageProp('formId') formId: string = '';

  // ---- 状态 ----

  private isWide(): boolean {
    return this.dimension === '3';
  }

  private isIdle(): boolean {
    return this.title.length === 0 || this.title === '暂无歌曲播放';
  }

  private hasCover(): boolean {
    return this.coverUrl.length > 0;
  }

  private isPlaying(): boolean {
    return this.playing === 'true';
  }

  private isFav(): boolean {
    return this.favorite === 'true';
  }

  // ---- 进度与歌词 ----

  private num(v: string): number {
    const n = Number(v);
    return isNaN(n) ? 0 : n;
  }

  private progressPct(): number {
    const d = this.num(this.duration);
    const p = this.num(this.posText);
    if (d <= 0) {
      return 0;
    }
    const pct = (p / d) * 100;
    if (pct < 0) {
      return 0;
    }
    return pct > 100 ? 100 : pct;
  }

  private fmt(ms: number): string {
    if (ms <= 0) {
      return '--:--';
    }
    const sec = Math.floor(ms / 1000);
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    const ss = s < 10 ? `0${s}` : `${s}`;
    return `${m}:${ss}`;
  }

  private elapsedText(): string {
    const p = this.num(this.posText);
    return p > 0 ? this.fmt(p) : '0:00';
  }

  private totalText(): string {
    return this.fmt(this.num(this.duration));
  }

  private lyricLines(): string[] {
    if (this.isIdle() || this.lyric.length === 0) {
      return [];
    }
    return this.lyric.split('\n');
  }

  private activeIndex(): number {
    const i = parseInt(this.lyricActive);
    return isNaN(i) ? -1 : i;
  }

  // ---- 控制按钮取值（必须在 @Builder 体内调用） ----

  private btnSize(btn: string): number {
    if (btn === 'toggle') {
      return this.isWide() ? 34 : 30;
    }
    return 22;
  }

  private btnIconSize(btn: string): number {
    if (btn === 'toggle') {
      return this.isWide() ? 16 : 14;
    }
    return 12;
  }

  private btnIcon(btn: string): Resource {
    if (btn === 'prev') {
      return $r('app.media.card_prev');
    }
    if (btn === 'next') {
      return $r('app.media.card_next');
    }
    if (btn === 'favorite') {
      return this.isFav() ? $r('app.media.card_heart_filled') : $r('app.media.card_heart');
    }
    return this.isPlaying() ? $r('app.media.card_pause') : $r('app.media.card_play');
  }

  private btnColor(btn: string): ResourceColor {
    if (btn === 'favorite' && this.isFav()) {
      return $r('app.color.card_accent_text');
    }
    return $r('app.color.card_t2');
  }

  // ---- 交互 ----

  /**
   * 控制按钮 → 应用：alive=true 走 call（后台直达，不惊动前台），
   * 否则走 router（用户点击豁免，完整拉起）。
   */
  private sendControl(control: string): void {
    if (this.alive === 'true') {
      postCardAction(this, {
        action: 'call',
        abilityName: 'EntryAbility',
        params: {
          method: 'control',
          control: control,
          formId: this.formId
        }
      });
    } else {
      postCardAction(this, {
        action: 'router',
        abilityName: 'EntryAbility',
        params: {
          control: control,
          formId: this.formId
        }
      });
    }
  }

  /** 点击非按钮区：打开应用 */
  private openApp(): void {
    postCardAction(this, {
      action: 'router',
      abilityName: 'EntryAbility',
      params: {
        formId: this.formId
      }
    });
  }

  // ---- 布局 ----

  build() {
    Stack() {
      if (this.isWide()) {
        this.wideFront()
      } else {
        this.squareFront()
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor($r('app.color.card_bg'))
    .borderRadius(16)
    .clip(true)
    .onClick(() => this.openApp())
  }

  /** 2*2：封面 52 + 两行歌名 + 歌手；时间在进度线右上；下方三键 */
  @Builder
  squareFront() {
    Column() {
      Row() {
        if (this.hasCover()) {
          Image(this.coverUrl)
            .width(52)
            .height(52)
            .borderRadius(6)
            .objectFit(ImageFit.Cover)
        } else {
          Column() {
            Image($r('app.media.card_note'))
              .width(20)
              .height(20)
              .fillColor($r('app.color.card_t2'))
              .opacity(0.4)
          }
          .width(52)
          .height(52)
          .borderRadius(6)
          .backgroundColor($r('app.color.card_well'))
          .justifyContent(FlexAlign.Center)
        }

        Column() {
          Text(this.title)
            .fontSize(12.5)
            .fontWeight(FontWeight.Medium)
            .fontColor($r('app.color.card_t1'))
            .lineHeight(16)
            .maxLines(2)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .width('100%')

          if (!this.isIdle()) {
            Text(this.artist)
              .fontSize(9.5)
              .fontColor($r('app.color.card_t2'))
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
              .width('100%')
              .margin({ top: 3 })
          }
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Start)
        .margin({ left: 10 })
      }
      .layoutWeight(1)
      .width('100%')
      .padding({ left: 10, right: 10, top: 10 })
      .alignItems(VerticalAlign.Center)

      Column() {
        Row() {
          Text(this.elapsedText())
            .fontSize(9)
            .fontColor($r('app.color.card_t2'))
        }
        .width('100%')
        .height(12)
        .justifyContent(FlexAlign.End)
        .padding({ right: 10 })

        Stack({ alignContent: Alignment.Start }) {
          Row()
            .width('100%')
            .height(2)
            .backgroundColor($r('app.color.card_line'))
          Row()
            .width(`${this.progressPct()}%`)
            .height(2)
            .backgroundColor($r('app.color.card_accent'))
        }
        .width('100%')
        .height(2)
      }
      .width('100%')

      Row({ space: 10 }) {
        this.ctrlBtn('prev')
        this.ctrlBtn('toggle')
        this.ctrlBtn('next')
      }
      .width('100%')
      .height(52)
      .justifyContent(FlexAlign.Center)
      .opacity(this.isIdle() ? 0.35 : 1)
    }
    .width('100%')
    .height('100%')
  }

  /** 2*4：封面 / 信息 / 运输轨 三格 */
  @Builder
  wideFront() {
    Row() {
      Column() {
        if (this.hasCover()) {
          Image(this.coverUrl)
            .width(84)
            .height(84)
            .borderRadius(8)
            .objectFit(ImageFit.Cover)
        } else {
          Column() {
            Image($r('app.media.card_note'))
              .width(26)
              .height(26)
              .fillColor($r('app.color.card_t2'))
              .opacity(0.4)
          }
          .width(84)
          .height(84)
          .borderRadius(8)
          .backgroundColor($r('app.color.card_well'))
          .justifyContent(FlexAlign.Center)
        }
      }
      .width(112)
      .height('100%')
      .justifyContent(FlexAlign.Center)

      Column()
        .width(1)
        .height('100%')
        .backgroundColor($r('app.color.card_line'))

      Column() {
        Row() {
          Column() {
            Text(this.title)
              .fontSize(14)
              .fontWeight(FontWeight.Medium)
              .fontColor($r('app.color.card_t1'))
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
              .width('100%')

            if (!this.isIdle()) {
              Text(this.artist)
                .fontSize(10)
                .fontColor($r('app.color.card_t2'))
                .maxLines(1)
                .textOverflow({ overflow: TextOverflow.Ellipsis })
                .width('100%')
                .margin({ top: 2 })
            }
          }
          .layoutWeight(1)
          .alignItems(HorizontalAlign.Start)

          // 收藏：只在宽卡、且只在信息格右上角
          this.ctrlBtn('favorite')
        }
        .width('100%')
        .alignItems(VerticalAlign.Top)

        Column() {
          ForEach(this.lyricLines(), (line: string, idx: number) => {
            Text(line)
              .fontSize(idx === this.activeIndex() ? 11 : 10)
              .fontWeight(idx === this.activeIndex() ? FontWeight.Bold : FontWeight.Normal)
              .fontColor(idx === this.activeIndex()
                ? $r('app.color.card_accent_text')
                : $r('app.color.card_t2'))
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
              .width('100%')
              .padding({ left: idx === this.activeIndex() ? 8 : 0 })
              .margin({ top: idx === 0 ? 0 : 3 })
          }, (line: string, idx: number) => `${idx}_${line}`)
        }
        .layoutWeight(1)
        .width('100%')
        .justifyContent(FlexAlign.Center)

        Row() {
          Text(this.elapsedText())
            .fontSize(9)
            .fontColor($r('app.color.card_t2'))

          Stack({ alignContent: Alignment.Start }) {
            Row()
              .width('100%')
              .height(2)
              .backgroundColor($r('app.color.card_line'))
            Row()
              .width(`${this.progressPct()}%`)
              .height(2)
              .backgroundColor($r('app.color.card_accent'))
          }
          .layoutWeight(1)
          .height(2)
          .margin({ left: 8, right: 8 })

          Text(this.totalText())
            .fontSize(9)
            .fontColor($r('app.color.card_t2'))
        }
        .width('100%')
        .margin({ top: 8 })
      }
      .layoutWeight(1)
      .height('100%')
      .padding({ left: 14, right: 12, top: 12, bottom: 12 })

      Column()
        .width(1)
        .height('100%')
        .backgroundColor($r('app.color.card_line'))

      Column({ space: 12 }) {
        this.ctrlBtn('prev')
        this.ctrlBtn('toggle')
        this.ctrlBtn('next')
      }
      .width(56)
      .height('100%')
      .justifyContent(FlexAlign.Center)
      .opacity(this.isIdle() ? 0.35 : 1)
    }
    .width('100%')
    .height('100%')
  }

  /**
   * 单个控制键。图标/颜色/尺寸都在体内按状态计算 —— 按值传参会固化。
   * 空态：播放键换成灰底，整排还会额外降透明度。
   */
  @Builder
  ctrlBtn(btn: string) {
    if (btn === 'toggle') {
      Stack() {
        Column()
          .width(this.btnSize(btn))
          .height(this.btnSize(btn))
          .borderRadius(this.btnSize(btn) / 2)
          .backgroundColor(this.isIdle()
            ? $r('app.color.card_well')
            : $r('app.color.card_accent'))
        Image(this.btnIcon(btn))
          .width(this.btnIconSize(btn))
          .height(this.btnIconSize(btn))
          .fillColor(this.isIdle()
            ? $r('app.color.card_t2')
            : $r('app.color.card_accent_on'))
      }
      .width(this.btnSize(btn))
      .height(this.btnSize(btn))
      .onClick(() => this.sendControl(btn))
    } else {
      Stack() {
        Image(this.btnIcon(btn))
          .width(this.btnIconSize(btn))
          .height(this.btnIconSize(btn))
          .fillColor(this.btnColor(btn))
      }
      .width(this.btnSize(btn))
      .height(this.btnSize(btn))
      .onClick(() => this.sendControl(btn))
    }
  }
}
