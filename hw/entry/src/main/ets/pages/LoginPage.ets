import { AppState } from '../viewmodel/AppState';
import { APIClient, ApiError } from '../core/APIClient';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { Tokens } from '../common/Tokens';

/** 登录页（S2：地址 + 账号 + 口令；多服务端编辑放 S3） */
@Component
export struct LoginPage {
  @State address: string = '';
  @State username: string = '';
  @State password: string = '';
  @State busy: boolean = false;
  @State err: string = '';

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
      const apiErr = e as ApiError;
      this.err = apiErr.message === undefined ? '登录失败' : apiErr.message;
      hilog.warn(0x0000, 'LoginPage', '登录失败: %{public}s', this.err);
    } finally {
      this.busy = false;
    }
  }

  build() {
    Column({ space: 16 }) {
      Text('SuenMusic').fontSize(28).fontWeight(FontWeight.Bold)
      Text('自托管音乐').fontSize(13).fontColor(Tokens.text2)

      Column({ space: 10 }) {
        Text('服务端地址').fontSize(12).fontColor(Tokens.text2).width('100%')
        TextInput({ text: this.address, placeholder: 'http://192.168.1.10:3210' })
          .type(InputType.Normal)
          .onChange((v: string) => { this.address = v; })

        Text('用户名').fontSize(12).fontColor(Tokens.text2).width('100%').margin({ top: 6 })
        TextInput({ text: this.username, placeholder: '用户名' })
          .onChange((v: string) => { this.username = v; })

        Text('口令').fontSize(12).fontColor(Tokens.text2).width('100%').margin({ top: 6 })
        TextInput({ text: this.password, placeholder: '口令' })
          .type(InputType.Password)
          .onChange((v: string) => { this.password = v; })
      }
      .width('100%')
      .padding(16)
      .borderRadius(12)
      .backgroundColor(Tokens.panel)

      if (this.err.length > 0) {
        Text(this.err).fontSize(12).fontColor('#E5484D').width('100%')
      }

      Button(this.busy ? '登录中…' : '登录')
        .width('100%')
        .height(44)
        .enabled(!this.busy && this.username.length > 0 && this.password.length > 0)
        .onClick(() => { this.submit(); })
    }
    .width('100%')
    .height('100%')
    .padding(24)
    .justifyContent(FlexAlign.Center)
    .backgroundColor(Tokens.bg)
  }
}
