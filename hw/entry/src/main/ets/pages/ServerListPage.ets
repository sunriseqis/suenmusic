/**
 * 服务端管理页（S3 增量 3；S4 打磨：尺寸令牌/热区/无障碍）。
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
import { Dim } from '../common/Dimension';
import { K_BASE_URL } from '../viewmodel/AppState';
import { NeuInput } from './NeuInput';
import { WebIconButton, WebIconName, NeuBtnChrome } from '../common/WebIcons';
import { WebButton, NeuBtnVariant, NeuBtnSize } from '../common/WebButtons';

/** 探测四态 */
const ST_UNKNOWN: number = 0;
const ST_CHECKING: number = 1;
const ST_OK: number = 2;
const ST_BAD: number = 3;

@Component
export struct ServerListPage {
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

  /** 当前在用服务端的显示名（列表只显名称不显地址；找不到回退地址本身） */
  private currentName(): string {
    for (let i = 0; i < this.serverList.length; i++) {
      if (this.serverList[i].url === this.currentBase) {
        return this.serverList[i].name;
      }
    }
    return this.currentBase.length > 0 ? this.currentBase : '未设置';
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
    Column({ space: Dim.s2 }) {
      Row({ space: Dim.s2 }) {
        Circle({ width: Dim.s2, height: Dim.s2 }).fill(this.statusColor(i))
        Text(s.name).fontSize(Dim.fsBody).fontColor(Tokens.text1).maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)
        if (s.url === this.currentBase) {
          Text('当前')
            .fontSize(Dim.fsCaption)
            .fontColor(Tokens.accentText)
            .padding({ left: Dim.s2, right: Dim.s2, top: Dim.s0, bottom: Dim.s0 })
            .borderRadius(Dim.radiusPill)
            .backgroundColor(Tokens.panel2)
        }
        Text(this.statusText(i)).fontSize(Dim.fsCaption).fontColor(this.statusColor(i))
      }
      .width('100%')

      // 行内操作键（第 ⑰ 条统一 WebButton 体系：ghost 切换 / 默认测试编辑 / 红字删除）
      Row({ space: Dim.s2 }) {
        if (s.url !== this.currentBase) {
          WebButton({
            labelStr: '切换',
            variantKind: NeuBtnVariant.GHOST,
            sizeKind: NeuBtnSize.SM,
            onTap: () => { this.confirmSwitch(s.url); }
          })
            .accessibilityText(`切换到 ${s.name}`)
        }
        WebButton({
          labelStr: '测试',
          sizeKind: NeuBtnSize.SM,
          onTap: () => { this.probeOne(i); }
        })
          .accessibilityText(`测试 ${s.name} 的连接`)
        WebButton({
          labelStr: '编辑',
          sizeKind: NeuBtnSize.SM,
          onTap: () => { this.startEdit(i); }
        })
          .accessibilityText(`编辑 ${s.name}`)
        Blank()
        WebButton({
          labelStr: '删除',
          variantKind: NeuBtnVariant.DANGER,
          sizeKind: NeuBtnSize.SM,
          onTap: () => { this.deleteServer(i); }
        })
          .accessibilityText(`删除服务器 ${s.name}`)
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)
    }
    .width('100%')
    .padding({ left: Dim.s4, right: Dim.s4, top: Dim.s3, bottom: Dim.s3 })
    .border(i > 0
      ? { width: { top: Dim.hairline }, color: { top: Tokens.line } }
      : { width: 0 })
  }

  @Builder
  addForm() {
    Column({ space: Dim.s2 }) {
      Text(this.editingIndex >= 0 ? '编辑服务器' : '新增服务器')
        .fontSize(Dim.fsSub)
        .fontWeight(FontWeight.Medium)
        .fontColor(Tokens.text1)
        .width('100%')
      NeuInput({ content: this.newName, placeholder: '名称（可选，如：客厅主机）' })
        .width('100%')
      NeuInput({ content: this.newUrl, placeholder: '地址，如 http://192.168.1.10:3210' })
        .width('100%')
      Row({ space: Dim.s2 }) {
        Column() {
          WebButton({
            labelStr: '取消',
            blockFlag: true,
            sizeKind: NeuBtnSize.MD,
            onTap: () => {
              this.adding = false;
              this.editingIndex = -1;
              this.newName = '';
              this.newUrl = '';
            }
          })
        }
        .layoutWeight(1)
        .accessibilityText('取消编辑')
        Column() {
          WebButton({
            labelStr: this.editingIndex >= 0 ? '保存' : '保存并检测',
            variantKind: NeuBtnVariant.PRIMARY,
            blockFlag: true,
            sizeKind: NeuBtnSize.MD,
            onTap: () => { this.saveForm(); }
          })
        }
        .layoutWeight(1)
        .accessibilityText('保存服务器')
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)
    }
    .width('100%')
    .padding(Dim.s4)
    .borderRadius(Dim.radiusMd)
    .backgroundColor(Tokens.bg)
    .border({ width: Dim.hairline, color: Tokens.line })
  }

  /** 弹层顶把手（与 SettingsPage 四张弹层同款，web Sheet .grip） */
  @Builder
  sheetGrip() {
    Row()
      .width(Dim.gripW)
      .height(Dim.gripH)
      .borderRadius(Dim.radiusPill)
      .backgroundColor(Tokens.line)
  }

  build() {
    Stack({ alignContent: Alignment.Bottom }) {
      Column({ space: Dim.s3 }) {
        this.sheetGrip()

        // 弹层头（与 SettingsPage sheetHead 同族：标题 + 右侧图标钮；
        // 第 ⑱ 条：+ / 收起全部用 web 图标语言，收起 = chevron-down 向下收）
        Row() {
          Text('服务端管理')
            .fontSize(Dim.fsSection)
            .fontWeight(FontWeight.Medium)
            .fontColor(Tokens.text1)
            .layoutWeight(1)
          WebIconButton({
            iconName: WebIconName.PLUS,
            boxSize: 36,
            glyphColor: Tokens.accentText,
            chromeKind: NeuBtnChrome.PLAIN,
            onTap: () => {
              this.editingIndex = -1;
              this.newName = '';
              this.newUrl = '';
              this.adding = !this.adding;
            }
          })
            .accessibilityText('新增服务器')
          WebIconButton({
            iconName: WebIconName.CHEVRON_DOWN,
            boxSize: 36,
            glyphColor: Tokens.text2,
            chromeKind: NeuBtnChrome.PLAIN,
            onTap: () => { this.onClose(); }
          })
            .accessibilityText('收起')
        }
        .width('100%')
        .alignItems(VerticalAlign.Center)

        Text('当前：' + this.currentName())
          .fontSize(Dim.fsMinor)
          .fontColor(Tokens.text2)
          .width('100%')

        if (this.notice.length > 0) {
          Text(this.notice)
            .fontSize(Dim.fsMinor)
            .fontColor(Tokens.accentText)
            .width('100%')
        }

        if (this.serverList.length === 0) {
          Column({ space: Dim.s1 }) {
            Text('还没有配置服务器').fontSize(Dim.fsBody).fontColor(Tokens.text2)
            Text('点右上角「+」添加一个').fontSize(Dim.fsCaption).fontColor(Tokens.text2)
          }
          .width('100%')
          .alignItems(HorizontalAlign.Start)
        } else {
          List() {
            ForEach(this.serverList, (s: ServerCandidate, i: number) => {
              ListItem() {
                this.serverRow(s, i)
              }
            }, (s: ServerCandidate) => s.url + '|' + s.name)
          }
          .width('100%')
          .constraintSize({ maxHeight: Dim.serverListMax })
          .backgroundColor(Tokens.bg)
          .borderRadius(Dim.radiusMd)
          .border({ width: Dim.hairline, color: Tokens.line })
          .clip(true)
        }

        if (this.adding) {
          this.addForm()
        }
      }
      .width('100%')
      .padding({ left: Dim.s4, right: Dim.s4, top: Dim.s3, bottom: Dim.s4 })
      .backgroundColor(Tokens.panel)
      .borderRadius({ topLeft: Dim.radiusLg, topRight: Dim.radiusLg })
    }
    .width('100%')
    .height('100%')
  }
}
