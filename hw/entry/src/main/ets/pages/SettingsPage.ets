import { AppState, K_USER_NAME } from '../viewmodel/AppState';
import { OfflineCache } from '../core/OfflineCache';
import { Tokens } from '../common/Tokens';

/** 我的（S2：账号信息 + 服务端地址 + 退出；完整设置项在 S3） */
@Component
export struct SettingsPage {
  @StorageLink(K_USER_NAME) userName: string = '';

  build() {
    List() {
      ListItem() {
        Column({ space: 4 }) {
          Text(this.userName.length > 0 ? this.userName : '未登录').fontSize(18).fontColor(Tokens.text1)
          Text('服务端：' + AppState.shared().baseUrl()).fontSize(11).fontColor(Tokens.text2)
        }
        .alignItems(HorizontalAlign.Start)
        .width('100%').padding(16)
      }
      ListItem() {
        Text('离线缓存：' + (OfflineCache.shared().isCached('') ? '就绪' : '按需下载'))
          .fontSize(13).fontColor(Tokens.text2).width('100%').padding(16)
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
