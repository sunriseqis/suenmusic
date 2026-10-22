import { AppState, K_USER_NAME, K_BASE_URL } from '../viewmodel/AppState';
import { Tokens } from '../common/Tokens';

/** 我的（S3：账号信息 + 服务端管理/离线缓存入口 + 退出登录） */
@Component
export struct SettingsPage {
  @StorageLink(K_USER_NAME) userName: string = '';
  @StorageProp(K_BASE_URL) baseUrl: string = '';

  onOpenServers: () => void = () => {};
  onOpenCache: () => void = () => {};

  build() {
    List() {
      ListItem() {
        Column({ space: 4 }) {
          Text(this.userName.length > 0 ? this.userName : '未登录').fontSize(18).fontColor(Tokens.text1)
          Text('服务端：' + (this.baseUrl.length > 0 ? this.baseUrl : '未设置'))
            .fontSize(11).fontColor(Tokens.text2)
        }
        .alignItems(HorizontalAlign.Start)
        .width('100%').padding(16)
      }
      ListItem() {
        Row() {
          Text('服务端管理').fontSize(14).fontColor(Tokens.text1)
          Blank()
          Text('→').fontSize(14).fontColor(Tokens.text2)
        }
        .width('100%').padding(16)
        .onClick(() => { this.onOpenServers(); })
      }
      ListItem() {
        Row() {
          Text('离线缓存').fontSize(14).fontColor(Tokens.text1)
          Blank()
          Text('→').fontSize(14).fontColor(Tokens.text2)
        }
        .width('100%').padding(16)
        .onClick(() => { this.onOpenCache(); })
      }
      ListItem() {
        Button('退出登录')
          .width('100%').height(44)
          .backgroundColor(Tokens.line).fontColor('#E5484D')
          .onClick(() => { AppState.shared().signOut(); })
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Tokens.bg)
  }
}
