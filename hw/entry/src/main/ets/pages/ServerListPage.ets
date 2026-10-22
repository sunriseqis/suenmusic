/**
 * 服务端管理页（S3 增量 3）。
 *
 * 列出全部候选 + 可达状态（四态：未知/检测中/可达/不可达，不用布尔红绿灯防闪烁）、
 * 新增（名称/地址）、删除（删当前在用的会先自动切到剩余第一个）、
 * 点「切换」二次确认后走 `APIClient.switchServer` + `MediaPlayerCore.rebindServer`
 * 重建队列保住播放位置。
 */

import { APIClient, ApiError } from '../core/APIClient';
import { MediaPlayerCore } from '../core/MediaPlayerCore';
import { ServerCandidate } from '../core/Models';
import { Tokens } from '../common/Tokens';
import { K_BASE_URL } from '../viewmodel/AppState';

/** 探测四态 */
const ST_UNKNOWN: number = 0;
const ST_CHECKING: number = 1;
const ST_OK: number = 2;
const ST_BAD: number = 3;

@Component
export struct ServerListPage {
  @StorageProp('topAvoidHeight') topAvoidHeight: number = 0;
  @StorageProp('bottomAvoidHeight') bottomAvoidHeight: number = 0;
  @State serverList: ServerCandidate[] = [];
  /** 与 serverList 平行的探测状态数组（整组替换触发刷新） */
  @State status: number[] = [];
  @State currentBase: string = '';
  @State adding: boolean = false;
  /** >= 0 = 表单处于编辑模式（正在编辑该下标的服务器）；-1 = 新增模式 */
  @State editingIndex: number = -1;
  @State newName: string = '';
  @State newUrl: string = '';
  /** 切换中：禁止再次发起切换/删除，防止半切换状态叠加 */
  @State busy: boolean = false;
  @State notice: string = '';

  onClose: () => void = () => {};

  /** 避让区 px → vp（走 UIContext 实例方法，全局 px2vp 已弃用） */
  private avoidVp(px: number): number {
    return this.getUIContext().px2vp(px);
  }

  aboutToAppear(): void {
    const api = APIClient.shared();
    this.serverList = api.getServers().slice();
    this.currentBase = api.getBaseUrl();
    this.resetStatus(ST_CHECKING);
    this.probeAll();
  }

  // ---------------- 数据与操作 ----------------

  private resetStatus(v: number): void {
    const arr: number[] = [];
    for (let i = 0; i < this.serverList.length; i++) {
      arr.push(v);
    }
    this.status = arr;
  }

  private setStatusAt(i: number, v: number): void {
    if (i < 0 || i >= this.status.length) { return; }
    const arr = this.status.slice();
    arr[i] = v;
    this.status = arr;
  }

  private probeAll(): void {
    APIClient.shared().probeAll().then((res: Record<string, boolean>) => {
      for (let i = 0; i < this.serverList.length; i++) {
        const ok = res[this.serverList[i].url] === true;
        this.setStatusAt(i, ok ? ST_OK : ST_BAD);
      }
    }).catch((): void => {
      this.resetStatus(ST_UNKNOWN);
    });
  }

  private probeOne(i: number): void {
    if (i < 0 || i >= this.serverList.length) { return; }
    const url = this.serverList[i].url;
    this.setStatusAt(i, ST_CHECKING);
    APIClient.shared().probeServer(url).then((ok: boolean): void => {
      this.setStatusAt(i, ok ? ST_OK : ST_BAD);
    }).catch((): void => {
      this.setStatusAt(i, ST_BAD);
    });
  }

  private statusText(i: number): string {
    const v = i >= 0 && i < this.status.length ? this.status[i] : ST_UNKNOWN;
    if (v === ST_CHECKING) { return '检测中'; }
    if (v === ST_OK) { return '可达'; }
    if (v === ST_BAD) { return '不可达'; }
    return '未知';
  }

  private statusColor(i: number): string {
    const v = i >= 0 && i < this.status.length ? this.status[i] : ST_UNKNOWN;
    if (v === ST_OK) { return Tokens.accent; }
    if (v === ST_BAD) { return '#E5484D'; }
    return Tokens.text2;
  }

  private normalizeUrl(raw: string): string {
    let s = raw.trim();
    while (s.endsWith('/')) {
      s = s.substring(0, s.length - 1);
    }
    return s;
  }

  private async addServer(): Promise<void> {
    const url = this.normalizeUrl(this.newUrl);
    if (url.length === 0) {
      this.notice = '请输入服务器地址';
      return;
    }
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      this.notice = '地址需以 http:// 或 https:// 开头';
      return;
    }
    let exists = false;
    for (let i = 0; i < this.serverList.length; i++) {
      if (this.serverList[i].url === url) {
        exists = true;
        break;
      }
    }
    if (exists) {
      this.notice = '该地址已在列表中';
      return;
    }
    const name = this.newName.trim().length > 0
      ? this.newName.trim() : '服务器 ' + (this.serverList.length + 1);
    const list = this.serverList.slice();
    list.push({ url: url, name: name });
    await APIClient.shared().setServers(list, this.currentBase);
    this.serverList = list;
    const arr = this.status.slice();
    arr.push(ST_CHECKING);
    this.status = arr;
    this.newName = '';
    this.newUrl = '';
    this.adding = false;
    this.notice = '已添加，正在检测可达性…';
    this.probeOne(list.length - 1);
  }

  /** 表单入口：编辑模式走 saveEdit，新增模式走 addServer */
  private async saveForm(): Promise<void> {
    if (this.editingIndex >= 0) {
      await this.saveEdit();
      return;
    }
    await this.addServer();
  }

  /** 进入编辑模式：预填该条的名称/地址 */
  private startEdit(i: number): void {
    if (this.busy || i < 0 || i >= this.serverList.length) { return; }
    this.editingIndex = i;
    this.newName = this.serverList[i].name;
    this.newUrl = this.serverList[i].url;
    this.adding = true;
  }

  private async saveEdit(): Promise<void> {
    const i = this.editingIndex;
    if (i < 0 || i >= this.serverList.length) { return; }
    const url = this.normalizeUrl(this.newUrl);
    if (url.length === 0) {
      this.notice = '请输入服务器地址';
      return;
    }
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      this.notice = '地址需以 http:// 或 https:// 开头';
      return;
    }
    const old = this.serverList[i];
    const name = this.newName.trim().length > 0 ? this.newName.trim() : old.name;
    const urlChanged = url !== old.url;
    if (urlChanged) {
      for (let k = 0; k < this.serverList.length; k++) {
        if (k !== i && this.serverList[k].url === url) {
          this.notice = '该地址已在列表中';
          return;
        }
      }
    }
    const list = this.serverList.slice();
    list[i] = { url: url, name: name };

    // 改的是当前在用服务器的地址：后果等同切换，先确认再走同一条切换链路
    if (urlChanged && old.url === this.currentBase) {
      this.getUIContext().showAlertDialog({
        title: '修改当前服务器地址',
        message: '该服务器正在使用，保存后将连接新地址，并从当前位置继续播放。',
        primaryButton: {
          value: '取消',
          action: (): void => {}
        },
        secondaryButton: {
          value: '保存并切换',
          action: (): void => {
            this.applyEdit(list, i, old);
          }
        }
      });
      return;
    }
    await this.applyEdit(list, i, old);
  }

  /**
   * 落盘编辑结果。改了地址会重探测；
   * 若改的是当前在用服务器的地址，先走 applySwitch（探测→me 验证→rebind），
   * 切换失败则整笔回滚（API 状态已由 switchServer 回滚，这里不落盘不更新面板）。
   */
  private async applyEdit(list: ServerCandidate[], i: number, old: ServerCandidate): Promise<void> {
    if (this.busy) { return; }
    const urlChanged = list[i].url !== old.url;
    if (urlChanged && old.url === this.currentBase) {
      this.busy = true;
      this.notice = '正在切换到 ' + list[i].url + ' …';
      try {
        await this.applySwitch(list[i].url);
      } catch (e) {
        const err = e as ApiError;
        this.notice = '保存失败：' + err.message;
        this.busy = false;
        return;
      }
      this.busy = false;
    }
    await APIClient.shared().setServers(list, this.currentBase);
    this.serverList = list;
    if (urlChanged) {
      this.probeOne(i);
    }
    this.notice = '已保存';
    this.adding = false;
    this.editingIndex = -1;
    this.newName = '';
    this.newUrl = '';
  }

  /** 切换确认：后果必须说清，不写"确定要切换吗"这种没信息量的 */
  private confirmSwitch(url: string): void {
    if (this.busy || url === this.currentBase) { return; }
    this.getUIContext().showAlertDialog({
      title: '切换服务器',
      message: '切换后将重新加载当前播放，队列会从当前位置继续播放。',
      primaryButton: {
        value: '取消',
        action: (): void => {}
      },
      secondaryButton: {
        value: '切换',
        action: (): void => {
          this.doSwitch(url);
        }
      }
    });
  }

  /** 切换 + 重建队列（保位置）。失败时 switchServer 已回滚，这里只透出原因 */
  private async applySwitch(url: string): Promise<void> {
    await APIClient.shared().switchServer(url);
    this.currentBase = APIClient.shared().getBaseUrl();
    AppStorage.setOrCreate<string>(K_BASE_URL, this.currentBase);
    // 队列里存的是绝对 URL：换服必须重建队列（保曲目/位置/播放意图）
    const core = MediaPlayerCore.shared();
    if (core.length > 0) {
      let token = '';
      try {
        token = (await APIClient.shared().streamSessionToken()).token;
      } catch (e) {
        token = '';
      }
      await core.rebindServer(token);
    }
  }

  private async doSwitch(url: string): Promise<void> {
    if (this.busy) { return; }
    this.busy = true;
    this.notice = '正在切换服务器…';
    try {
      await this.applySwitch(url);
      this.notice = '已切换到 ' + this.currentBase;
    } catch (e) {
      const err = e as ApiError;
      this.notice = err.message.length > 0 ? err.message : '切换失败，已回滚到原服务器';
    }
    this.busy = false;
  }

  private async deleteServer(i: number): Promise<void> {
    if (this.busy) { return; }
    if (i < 0 || i >= this.serverList.length) { return; }
    const target = this.serverList[i];
    const rest: ServerCandidate[] = [];
    for (let k = 0; k < this.serverList.length; k++) {
      if (k !== i) {
        rest.push(this.serverList[k]);
      }
    }

    // 删的是当前在用的：先切到剩余第一个，切换成功才删
    if (target.url === this.currentBase) {
      if (rest.length === 0) {
        this.notice = '这是最后一个服务器，不能删除';
        return;
      }
      this.busy = true;
      this.notice = '正在切换到 ' + rest[0].url + ' …';
      try {
        await this.applySwitch(rest[0].url);
      } catch (e) {
        const err = e as ApiError;
        this.notice = '切换失败，未删除：' + err.message;
        this.busy = false;
        return;
      }
      this.busy = false;
    }

    await APIClient.shared().setServers(rest, this.currentBase);
    this.serverList = rest;
    const arr: number[] = [];
    for (let k = 0; k < this.status.length; k++) {
      if (k !== i) {
        arr.push(this.status[k]);
      }
    }
    this.status = arr;
    this.notice = '已删除 ' + target.name;
  }

  // ---------------- 布局 ----------------

  @Builder
  serverRow(s: ServerCandidate, i: number) {
    Column({ space: 8 }) {
      Row({ space: 8 }) {
        Circle({ width: 8, height: 8 }).fill(this.statusColor(i))
        Text(s.name).fontSize(15).fontColor(Tokens.text1).maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        if (s.url === this.currentBase) {
          Text('当前')
            .fontSize(10)
            .fontColor(Tokens.accent)
            .padding({ left: 6, right: 6, top: 2, bottom: 2 })
            .borderRadius(8)
            .backgroundColor(Tokens.panel2)
        }
        Blank()
        Text(this.statusText(i)).fontSize(11).fontColor(this.statusColor(i))
      }
      .width('100%')

      Text(s.url)
        .fontSize(12)
        .fontColor(Tokens.text2)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })

      Row({ space: 10 }) {
        if (s.url !== this.currentBase) {
          Button('切换')
            .height(30)
            .fontSize(12)
            .backgroundColor(Tokens.panel2)
            .fontColor(Tokens.accent)
            .onClick(() => { this.confirmSwitch(s.url); })
        }
        Button('测试连接')
          .height(30)
          .fontSize(12)
          .backgroundColor(Tokens.panel2)
          .fontColor(Tokens.text1)
          .onClick(() => { this.probeOne(i); })
        Button('编辑')
          .height(30)
          .fontSize(12)
          .backgroundColor(Tokens.panel2)
          .fontColor(Tokens.text1)
          .onClick(() => { this.startEdit(i); })
        Blank()
        Button('删除')
          .height(30)
          .fontSize(12)
          .backgroundColor(Tokens.panel2)
          .fontColor('#E5484D')
          .onClick(() => { this.deleteServer(i); })
      }
      .width('100%')
    }
    .width('100%')
    .padding(14)
    .borderRadius(12)
    .backgroundColor(Tokens.panel)
    .margin({ left: 12, right: 12, top: 8 })
  }

  @Builder
  addForm() {
    Column({ space: 10 }) {
      Text(this.editingIndex >= 0 ? '编辑服务器' : '新增服务器')
        .fontSize(14).fontColor(Tokens.text1)
      TextInput({ text: this.newName, placeholder: '名称（可选，如：客厅主机）' })
        .height(40)
        .fontSize(13)
        .backgroundColor(Tokens.panel2)
        .onChange((v: string) => { this.newName = v; })
      TextInput({ text: this.newUrl, placeholder: '地址，如 http://192.168.1.10:3210' })
        .height(40)
        .fontSize(13)
        .backgroundColor(Tokens.panel2)
        .onChange((v: string) => { this.newUrl = v; })
      Row({ space: 10 }) {
        Button('取消')
          .height(36)
          .fontSize(13)
          .backgroundColor(Tokens.panel2)
          .fontColor(Tokens.text1)
          .onClick(() => {
            this.adding = false;
            this.editingIndex = -1;
            this.newName = '';
            this.newUrl = '';
          })
        Button(this.editingIndex >= 0 ? '保存' : '保存并检测')
          .height(36)
          .fontSize(13)
          .backgroundColor(Tokens.accent)
          .fontColor(Tokens.bg)
          .onClick(() => { this.saveForm(); })
      }
      .width('100%')
    }
    .width('100%')
    .padding(12)
    .borderRadius(12)
    .backgroundColor(Tokens.panel)
    .margin({ left: 12, right: 12, top: 8, bottom: 12 })
  }

  build() {
    Column() {
      Row() {
        Button('返回')
          .height(32)
          .fontSize(13)
          .backgroundColor(Tokens.panel)
          .fontColor(Tokens.text1)
          .onClick(() => { this.onClose(); })
        Blank()
        Text('服务端管理')
          .fontSize(16)
          .fontWeight(FontWeight.Medium)
          .fontColor(Tokens.text1)
        Blank()
        Button('新增')
          .height(32)
          .fontSize(13)
          .backgroundColor(Tokens.panel)
          .fontColor(Tokens.accent)
          .onClick(() => {
            this.editingIndex = -1;
            this.newName = '';
            this.newUrl = '';
            this.adding = !this.adding;
          })
      }
      .width('100%')
      .padding({ left: 12, right: 12, top: 10, bottom: 6 })

      Text('当前：' + (this.currentBase.length > 0 ? this.currentBase : '未设置'))
        .fontSize(12)
        .fontColor(Tokens.text2)
        .width('100%')
        .padding({ left: 14, right: 14, top: 2, bottom: 2 })

      if (this.notice.length > 0) {
        Text(this.notice)
          .fontSize(12)
          .fontColor(Tokens.accent)
          .width('100%')
          .padding({ left: 14, right: 14, top: 2, bottom: 2 })
      }

      if (this.serverList.length === 0) {
        Column({ space: 6 }) {
          Text('还没有配置服务器').fontSize(14).fontColor(Tokens.text2)
          Text('点右上角「新增」添加一个').fontSize(11).fontColor(Tokens.text2)
        }
        .width('100%')
        .layoutWeight(1)
        .justifyContent(FlexAlign.Center)
      } else {
        List() {
          ForEach(this.serverList, (s: ServerCandidate, i: number) => {
            ListItem() {
              this.serverRow(s, i)
            }
          }, (s: ServerCandidate) => s.url + '|' + s.name)
        }
        .width('100%')
        .layoutWeight(1)
      }

      if (this.adding) {
        this.addForm()
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Tokens.bg)
    .padding({
      top: this.avoidVp(this.topAvoidHeight),
      bottom: this.avoidVp(this.bottomAvoidHeight)
    })
  }
}
