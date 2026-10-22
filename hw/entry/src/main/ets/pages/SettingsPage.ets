import { AppState, K_USER_NAME, K_BASE_URL, K_LYRIC_TRANS, K_AUTO_FAILOVER } from '../viewmodel/AppState';
import { APIClient } from '../core/APIClient';
import { Tokens } from '../common/Tokens';
import { Dim } from '../common/Dimension';

/** 我的（S3：账号信息 + 服务端管理/离线缓存入口 + 退出登录；T4：歌词翻译/自动选路开关；S4：尺寸令牌） */
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
        Column({ space: Dim.s1 }) {
          Text(this.userName.length > 0 ? this.userName : '未登录').fontSize(Dim.fsHeadline).fontColor(Tokens.text1)
          Text('服务端：' + (this.baseUrl.length > 0 ? this.baseUrl : '未设置'))
            .fontSize(Dim.fsCaption).fontColor(Tokens.text2)
        }
        .alignItems(HorizontalAlign.Start)
        .width('100%').padding(Dim.s4)
      }
      ListItem() {
        Row() {
          Text('服务端管理').fontSize(Dim.fsSub).fontColor(Tokens.text1)
          Blank()
          Text('→').fontSize(Dim.fsSub).fontColor(Tokens.text2)
        }
        .width('100%').padding(Dim.s4)
        .accessibilityText('打开服务端管理')
        .onClick(() => { this.onOpenServers(); })
      }
      ListItem() {
        Row() {
          Text('离线缓存').fontSize(Dim.fsSub).fontColor(Tokens.text1)
          Blank()
          Text('→').fontSize(Dim.fsSub).fontColor(Tokens.text2)
        }
        .width('100%').padding(Dim.s4)
        .accessibilityText('打开离线缓存')
        .onClick(() => { this.onOpenCache(); })
      }
      ListItem() {
        Row() {
          Column({ space: Dim.s0 }) {
            Text('显示歌词翻译').fontSize(Dim.fsSub).fontColor(Tokens.text1)
            Text('原文行下方同时显示翻译').fontSize(Dim.fsCaption).fontColor(Tokens.text2)
          }
          .alignItems(HorizontalAlign.Start)
          .layoutWeight(1)
          Toggle({ type: ToggleType.Switch, isOn: this.lyricTrans })
            .accessibilityText('显示歌词翻译')
            .onChange((v: boolean) => {
              this.lyricTrans = v;
              AppState.shared().setLyricTranslation(v);
            })
        }
        .width('100%').padding(Dim.s4)
      }
      ListItem() {
        Row() {
          Column({ space: Dim.s0 }) {
            Text('自动切换服务器').fontSize(Dim.fsSub).fontColor(Tokens.text1)
            Text('网络异常时自动尝试其它服务端').fontSize(Dim.fsCaption).fontColor(Tokens.text2)
          }
          .alignItems(HorizontalAlign.Start)
          .layoutWeight(1)
          Toggle({ type: ToggleType.Switch, isOn: this.autoFailover })
            .accessibilityText('自动切换服务器')
            .onChange((v: boolean) => {
              this.autoFailover = v;
              APIClient.shared().setAutoFailover(v);
            })
        }
        .width('100%').padding(Dim.s4)
      }
      ListItem() {
        Button('退出登录')
          .width('100%').height(Dim.touchMin)
          .backgroundColor(Tokens.line).fontColor('#E5484D')
          .fontSize(Dim.fsSub)
          .accessibilityText('退出登录')
          .onClick(() => { AppState.shared().signOut(); })
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Tokens.bg)
  }
}
