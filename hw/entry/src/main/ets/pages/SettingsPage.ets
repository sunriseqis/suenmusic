import { AppState, K_USER_NAME, K_BASE_URL, K_LYRIC_TRANS, K_AUTO_FAILOVER } from '../viewmodel/AppState';
import { APIClient } from '../core/APIClient';
import { Tokens } from '../common/Tokens';

/** 我的（S3：账号信息 + 服务端管理/离线缓存入口 + 退出登录；T4：歌词翻译/自动选路开关） */
@Component
export struct SettingsPage {
  @StorageLink(K_USER_NAME) userName: string = '';
  @StorageProp(K_BASE_URL) baseUrl: string = '';
  /** 显示歌词翻译（默认开，LyricView 消费同一 AppStorage 键） */
  @StorageLink(K_LYRIC_TRANS) lyricTrans: boolean = true;
  /** 自动切换服务器（默认开，APIClient.failoverIfNeeded 首行判断） */
  @StorageLink(K_AUTO_FAILOVER) autoFailover: boolean = true;

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
        Row() {
          Column({ space: 2 }) {
            Text('显示歌词翻译').fontSize(14).fontColor(Tokens.text1)
            Text('原文行下方同时显示翻译').fontSize(11).fontColor(Tokens.text2)
          }
          .alignItems(HorizontalAlign.Start)
          .layoutWeight(1)
          Toggle({ type: ToggleType.Switch, isOn: this.lyricTrans })
            .onChange((v: boolean) => {
              this.lyricTrans = v;
              AppState.shared().setLyricTranslation(v);
            })
        }
        .width('100%').padding(16)
      }
      ListItem() {
        Row() {
          Column({ space: 2 }) {
            Text('自动切换服务器').fontSize(14).fontColor(Tokens.text1)
            Text('网络异常时自动尝试其它服务端').fontSize(11).fontColor(Tokens.text2)
          }
          .alignItems(HorizontalAlign.Start)
          .layoutWeight(1)
          Toggle({ type: ToggleType.Switch, isOn: this.autoFailover })
            .onChange((v: boolean) => {
              this.autoFailover = v;
              APIClient.shared().setAutoFailover(v);
            })
        }
        .width('100%').padding(16)
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
