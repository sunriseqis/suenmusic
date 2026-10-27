import { AppState } from '../viewmodel/AppState';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { Tokens } from '../common/Tokens';
import { Copy } from '../common/Copy';
import { Dim } from '../common/Dimension';
import { WebButton, NeuBtnVariant, NeuBtnSize } from '../common/WebButtons';

/** 登录页（S2：地址 + 账号 + 口令；多服务端编辑放 S3；S4：尺寸令牌/按压动效） */
@Component
export struct LoginPage {
  @State address: string = '';
  @State username: string = '';
  @State password: string = '';
  @State busy: boolean = false;
  @State err: string = '';

  // 窗口全屏布局下的系统避让区实时值（刘海/状态栏、底部手势条，随机型动态变化）
  @StorageProp('topAvoidHeight') topAvoidHeight: number = 0;
  @StorageProp('bottomAvoidHeight') bottomAvoidHeight: number = 0;

  /** 避让区 px → vp（走 UIContext 实例方法，全局 px2vp 已弃用） */
  private avoidVp(px: number): number {
    return this.getUIContext().px2vp(px);
  }

  aboutToAppear(): void {
    // 首次启动没有服务端地址时给个占位提示，用户自己填
    this.address = AppState.shared().baseUrl();
  }

  private async submit(): Promise<void> {
    if (this.busy) { return; }
    this.busy = true;
    this.err = '';
    try {
      await AppState.shared().login(this.address, this.username, this.password);
    } catch (e) {
      // 登录页要服务端的原始 message（「用户名或密码错误」这类），
      // 不能被「登录已失效」的会话过期话术覆盖（describeError 第 2 参）
      this.err = Copy.describeError(e, true);
      hilog.warn(0x0000, 'LoginPage', '登录失败: %{public}s', this.err);
    } finally {
      this.busy = false;
    }
  }

  build() {
    Column({ space: Dim.s4 }) {
      Text('SuenMusic').fontSize(Dim.fsBrand).fontWeight(FontWeight.Bold).fontColor(Tokens.text1)
      Text('自托管音乐').fontSize(Dim.fsBody).fontColor(Tokens.text2)

      Column({ space: Dim.s2 }) {
        Text('服务端地址').fontSize(Dim.fsMinor).fontColor(Tokens.text2).width('100%')
        TextInput({ text: this.address, placeholder: 'http://IP:端口 或 https://域名' })
          .type(InputType.Normal)
          .onChange((v: string) => { this.address = v; })

        Text('用户名').fontSize(Dim.fsMinor).fontColor(Tokens.text2).width('100%').margin({ top: Dim.s2 })
        TextInput({ text: this.username, placeholder: '用户名' })
          .onChange((v: string) => { this.username = v; })

        Text('口令').fontSize(Dim.fsMinor).fontColor(Tokens.text2).width('100%').margin({ top: Dim.s2 })
        TextInput({ text: this.password, placeholder: '口令' })
          .type(InputType.Password)
          .onChange((v: string) => { this.password = v; })
      }
      .width('100%')
      .padding(Dim.s4)
      .borderRadius(Dim.radiusMd)
      .backgroundColor(Tokens.panel)

      if (this.err.length > 0) {
        Text(this.err).fontSize(Dim.fsMinor).fontColor(Tokens.danger).width('100%')
      }

      WebButton({
        labelStr: this.busy ? '登录中…' : '登录',
        variantKind: NeuBtnVariant.PRIMARY,
        sizeKind: NeuBtnSize.LG,
        blockFlag: true,
        disabledFlag: this.busy || this.username.length === 0 || this.password.length === 0,
        onTap: () => { this.submit(); }
      })
        .accessibilityText(this.busy ? '正在登录' : '登录')
    }
    .width('100%')
    .height('100%')
    .padding({
      left: Dim.s5,
      right: Dim.s5,
      top: this.avoidVp(this.topAvoidHeight) + Dim.s5,
      bottom: this.avoidVp(this.bottomAvoidHeight) + Dim.s5
    })
    .justifyContent(FlexAlign.Center)
    .backgroundColor(Tokens.bg)
  }
}
