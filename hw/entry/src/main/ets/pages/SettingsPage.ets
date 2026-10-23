/**
 * 设置页（T10 批次 C 重排：对齐 web Settings.vue 移动断点的「本机 / 智能 / 高级」三 tab）。
 *
 * 取舍（逐项对齐 web 移动版）：
 *   - 本机：播放（缓存 + 歌词翻译）/ 资料库（黑名单 / QQ 歌单导入 / 去重 / 数据备份）/ 账号
 *   - 智能：画像（展开摘要 + 特征行）/ 调优（guidance 文本框）
 *   - 高级：多服务端（服务端管理 + 自动选路开关）/ 音源授权（只读状态）
 *   - web 的 AI 模型 / 账号管理 / 数据维护 / 更新通道（WebPanel 管理员专属）不出现
 *   - web 的「应用更新」按 S5 裁决 A 不做鸿蒙更新通道；「主题」见回执（缺全端浅色体系）
 *   - 黑名单 / 导入 / 去重 / 备份四张底部弹层在页内 Stack 实现
 *
 * @Builder 响应性注意：状态值一律在 builder 体内直接引用 `this.xxx`，
 * 经参数传值不会建立依赖、状态变了 UI 不刷（T10 实测口径，与 NativeRoot tabItem 同款）。
 */

import { AppState, K_USER_NAME, K_USER_DISPLAY, K_USER_ROLE, K_LYRIC_TRANS, K_AUTO_FAILOVER, K_LAST_TUNE } from '../viewmodel/AppState';
import { APIClient, ApiError } from '../core/APIClient';
import { WebDavClient } from '../core/WebDavClient';
import { Tokens } from '../common/Tokens';
import { Dim, Motion } from '../common/Dimension';
import { AppToast } from '../common/AppToast';
import { DislikeRow, DedupeGroup, PersonaDetail, Track } from '../core/Models';
import { picker, fileIo } from '@kit.CoreFileKit';
import { bundleManager, common } from '@kit.AbilityKit';
import { formProvider, formInfo } from '@kit.FormKit';
import { util } from '@kit.ArkTS';
import { NeuInput } from './NeuInput';
import { NeuTabs } from '../common/NeuTabs';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { Theme, ThemeMode, K_THEME_MODE, THEME_LABELS, THEME_VALUES } from '../common/Theme';
import { Copy } from '../common/Copy';
import { OfflineCache } from '../core/OfflineCache';
import { WebIcon, WebIconButton, WebIconName, NeuBtnChrome } from '../common/WebIcons';
import { WebButton, NeuBtnVariant, NeuBtnSize } from '../common/WebButtons';

/** WebDAV 配置的持久化形态（JSON 三字段） */
interface DavCfg {
  url: string;
  user: string;
  pass: string;
}

/** 备份文件导出形态（web SmBackup 同构） */
interface SmBackupFile {
  version: number;
  app: string;
  type: string;
  exportedAt: string;
  total: number;
  tracks: Track[];
  dislikes: DislikeRow[];
  webdav: DavCfg;
}

/** 画像 md 行解析结果（kind：0 正文 / 1 标题 / 2 列表项 / 3 分隔线；minor = 次级行） */
class MdLine {
  kind: number;
  text: string;
  minor: boolean;

  constructor(kind: number, text: string, minor: boolean) {
    this.kind = kind;
    this.text = text;
    this.minor = minor;
  }
}

@Component
export struct SettingsPage {
  @StorageLink(K_USER_NAME) userName: string = '';
  /** 账号昵称（第 ⑪ 条：账号行优先显示昵称，回退登录名） */
  @StorageLink(K_USER_DISPLAY) userDisplay: string = '';
  /** 显示歌词翻译（默认开，LyricView 消费同一 AppStorage 键；hw 专属条目，web 设置页无此项） */
  @StorageLink(K_LYRIC_TRANS) lyricTrans: boolean = true;
  /** 自动切换服务器（默认开，APIClient.failoverIfNeeded 首行判断；hw 专属条目） */
  @StorageLink(K_AUTO_FAILOVER) autoFailover: boolean = true;

  /** 0 = 本机 / 1 = 智能 / 2 = 高级（web NeuTabs） */
  @State seg: number = 0;
  /** 当前弹层：'' / dislikes / import / dedupe / backup */
  @State sheet: string = '';

  @State dislikes: DislikeRow[] = [];
  @State dislikeTab: string = 'track';
  @State importLink: string = '';
  @State importing: boolean = false;
  @State importMsg: string = '';
  @State dupBusy: boolean = false;
  @State dupMsg: string = '';
  @State dupGroups: DedupeGroup[] = [];
  @State backupBusy: boolean = false;
  @State backupMsg: string = '';
  @State davUrl: string = '';
  @State davUser: string = '';
  @State davPass: string = '';
  @State persona: PersonaDetail | null = null;
  @State personaOpen: boolean = false;
  @State guidance: string = '';
  @State tuning: boolean = false;
  /** 上一次提交成功的调优提示词（调优区左侧回显） */
  @StorageLink(K_LAST_TUNE) lastTune: string = '';
  // 离线缓存用量（在设置页行内直接显示 已用/上限，用户 2026-10-23 裁定：不再进弹层看）
  @State cacheUsed: number = 0;
  @State cacheQuota: number = 0;
  /** 清空缓存确认弹窗 */
  @State clearCacheAsk: boolean = false;
  /** 当前主题模式（Theme 写入 AppStorage，这里只读来点亮分段） */
  @StorageProp(K_THEME_MODE) themeMode: string = ThemeMode.SYSTEM;
  // 检查更新（T7）：'' = 只显示当前版本；'checking'；'latest'；'new=x.y.z'；'error:文案'
  @State updState: string = '';
  /** 防重入（检查中） */
  @State checkingUpd: boolean = false;

  // ---- T8：账号卡 / 改口令 / 登出确认 / 关于 ----
  @StorageProp(K_USER_ROLE) userRole: string = '';
  @State pwOld: string = '';
  @State pwNew: string = '';
  @State pwNew2: string = '';
  @State pwBusy: boolean = false;
  @State signOutAsk: boolean = false;
  @State aboutOpen: boolean = false;

  // ---- T9：桌面卡片管理 ----
  /** 已添加的桌面卡片张数（-1 = 还没查） */
  @State cardCount: number = -1;
  @State cardHelpOpen: boolean = false;
  @State biliLabel: string = '未授权';
  @State neteaseLabel: string = '未授权';

  onOpenServers: () => void = () => {};
  onOpenCache: () => void = () => {};

  aboutToAppear(): void {
    this.loadCacheUsage();
    this.loadCardCount();
    this.loadWebdavFields();
    this.loadDislikes();
    this.loadPersona();
    this.loadSources();
  }

  // ---------------- 数据 ----------------

  private toast(msg: string): void {
    AppToast.show(msg);
  }

  // ---------------- 离线缓存（行内用量 + 点击确认清空） ----------------

  private loadCacheUsage(): void {
    try {
      const c = OfflineCache.shared();
      this.cacheUsed = c.usedBytes();
      this.cacheQuota = c.quotaBytes();
    } catch (e) {
      // 读不到用量只是不显示，不影响其它设置项
    }
  }

  /** 紧凑容量文案：100M / 2G（web 缓存面板同口径，整数展示） */
  private fmtShort(b: number): string {
    const gb = 1024 * 1024 * 1024;
    const mb = 1024 * 1024;
    if (b <= 0) {
      return '0M';
    }
    if (b >= gb) {
      const v = b / gb;
      return (v >= 10 ? Math.round(v).toString() : v.toFixed(1)) + 'G';
    }
    return Math.round(b / mb).toString() + 'M';
  }

  // ---------------- 检查更新（T7，按用户指示「交给系统浏览器下载」） ----------------

  /** 本机版本（bundleManager 自带，不需要 context） */
  private selfVersion(): string {
    try {
      const info = bundleManager.getBundleInfoForSelfSync(bundleManager.BundleFlag.GET_BUNDLE_INFO_DEFAULT);
      return info.versionName;
    } catch (e) {
      return '';
    }
  }

  private selfVersionCode(): number {
    try {
      const info = bundleManager.getBundleInfoForSelfSync(bundleManager.BundleFlag.GET_BUNDLE_INFO_DEFAULT);
      return info.versionCode;
    } catch (e) {
      return 0;
    }
  }

  /**
   * 行尾文案（用户裁定：**只有三种形态**）
   *   ① 未检查 → 版本号 `v1.6.0`
   *   ② 检查后无新包（含后端无产物/私有仓库读不到，后端统一回 available=false）→ `已是最新`
   *   ③ 后端有新包 → `新版本 x.y.z`
   * 检查中与失败**不占第四种文案**：检查中仍显示版本号，失败只弹 toast。
   */
  private updLabel(): string {
    if (this.updState === 'latest') {
      return '已是最新';
    }
    if (this.updState.startsWith('new=')) {
      return '新版本 ' + this.updState.slice(4);
    }
    return 'v' + this.selfVersion();
  }

  /**
   * 检查更新：服务端比对版本 → 有新版本就把下载直链交给**系统浏览器**（用户自己侧载安装）。
   * 不做应用内下载/静默安装：HAP 仍是未签名产物，由用户用移动端侧载工具安装。
   */
  private async checkUpdate(): Promise<void> {
    if (this.checkingUpd) {
      return;
    }
    this.checkingUpd = true;
    // 检查期间保持当前形态不变（不引入「检查中…」这第四种文案）
    try {
      const r = await APIClient.shared().checkUpdate(this.selfVersion(), this.selfVersionCode(), true);
      if (!r.available || r.latest === undefined) {
        this.updState = 'latest';
        this.toast('已是最新版本');
        return;
      }
      const ver = r.latest.versionName;
      this.updState = 'new=' + ver;
      const url = APIClient.shared().buildUpdateDownloadUrl(r.downloadPath, r.downloadToken);
      const ctx = this.getUIContext().getHostContext() as common.UIAbilityContext;
      await ctx.startAbility({ action: 'ohos.want.action.viewData', uri: url });
      this.toast('新版本 ' + ver + '：已交给浏览器下载，装好后自行侧载安装');
    } catch (e) {
      // 失败不占行尾形态：回落到「版本号」，原因只弹 toast
      this.updState = '';
      this.toast(Copy.describeError(e, true));
    } finally {
      this.checkingUpd = false;
    }
  }

  // ---------------- T8：账号卡 / 修改口令 / 关于 ----------------

  /** 角色文案（admin → 管理员） */
  private roleLabel(): string {
    return this.userRole === 'admin' ? '管理员' : '用户';
  }

  /** 头像位文字：昵称/账号首字符（本项目没有头像上传，用首字母圆牌，T8 §①） */
  private avatarText(): string {
    const n = this.userDisplay.length > 0 ? this.userDisplay : this.userName;
    return n.length > 0 ? n.substring(0, 1).toUpperCase() : '?';
  }

  private pwReady(): boolean {
    return this.pwOld.length > 0 && this.pwNew.length >= 6 && this.pwNew === this.pwNew2;
  }

  /** 修改口令：服务端会签发新会话（旧令牌失效），成功后必须 adopt 新令牌 */
  private async doChangePassword(): Promise<void> {
    if (this.pwBusy || !this.pwReady()) {
      return;
    }
    this.pwBusy = true;
    try {
      const session = await APIClient.shared().changePassword(this.pwOld, this.pwNew);
      APIClient.shared().adopt(session);
      this.sheet = '';
      this.pwOld = '';
      this.pwNew = '';
      this.pwNew2 = '';
      this.toast('口令已更新');
    } catch (e) {
      this.toast(Copy.describeError(e, true));
    } finally {
      this.pwBusy = false;
    }
  }

  /** 关于文案（版本取自 bundleManager；仓库是私有仓，不放进 UI） */
  private aboutText(): string {
    return 'SuenMusic v' + this.selfVersion()
      + '（build ' + this.selfVersionCode() + '）\n\n'
      + '单仓构建：服务端 + Web 面板 + 鸿蒙/iOS 原生客户端。\n'
      + '本包未签名，用移动端侧载工具安装；数据只存在你自己的服务端上。';
  }

  // ---------------- T9：桌面卡片管理 ----------------

  /** 查已发布到桌面的卡片张数（拿不到就是 -1，UI 不硬编 0） */
  private loadCardCount(): void {
    formProvider.getPublishedRunningFormInfos()
      .then((infos: Array<formInfo.RunningFormInfo>) => {
        this.cardCount = infos.length;
      })
      .catch(() => {
        this.cardCount = -1;
      });
  }

  private cardCountLabel(): string {
    if (this.cardCount < 0) {
      return '查看';
    }
    return this.cardCount === 0 ? '未添加' : '已添加 ' + this.cardCount + ' 张';
  }

  private cardHelpText(): string {
    return '在桌面长按空白处 →「服务卡片」→ 找到 SuenMusic → 选 2×2 或 2×4 拖到桌面。\n\n'
      + '· 尺寸：2×2 只显示封面/歌名/播放键；2×4 多显示歌手与滚动歌词。\n'
      + '· 按钮：播放/暂停、上一首、下一首，点击即生效（App 未运行时走冷启动）。\n'
      + '· 主题：「浅色/深色」按设置里的主题走；「跟随系统」时随系统深浅切换。';
  }

  /** 主题分段当前下标（跟随系统 / 浅色 / 深色） */
  private themeIndex(): number {
    for (let i = 0; i < THEME_VALUES.length; i++) {
      if (THEME_VALUES[i] === this.themeMode) {
        return i;
      }
    }
    return 0;
  }

  /** 确认后清空（正在播放的那首不动，OfflineCache 内建保护） */
  private clearCache(): void {
    try {
      OfflineCache.shared().clearAll();
      this.toast('已清空离线缓存');
    } catch (e) {
      this.toast(Copy.describeError(e));
    }
    this.loadCacheUsage();
  }

  private async loadDislikes(): Promise<void> {
    try {
      this.dislikes = await APIClient.shared().fetchDislikes();
    } catch (e) {
      // 静默：拉不到只是计数不显示
    }
  }

  private dislikeCountOf(type: string): number {
    let n = 0;
    for (let i = 0; i < this.dislikes.length; i++) {
      if (this.dislikes[i].type === type) { n++; }
    }
    return n;
  }

  private visibleDislikes(): DislikeRow[] {
    const out: DislikeRow[] = [];
    for (let i = 0; i < this.dislikes.length; i++) {
      if (this.dislikes[i].type === this.dislikeTab) { out.push(this.dislikes[i]); }
    }
    return out;
  }

  private async undoDislike(row: DislikeRow): Promise<void> {
    try {
      await APIClient.shared().undoDislike(row.type, row.targetId);
      await this.loadDislikes();
      // 黑名单变化会影响每日推荐的过滤口径
      AppState.shared().bumpDailyRefresh();
    } catch (e) {
      this.toast((e as ApiError).message);
    }
  }

  private async doImport(): Promise<void> {
    const raw = this.importLink.trim();
    if (raw.length === 0 || this.importing) { return; }
    this.importing = true;
    this.importMsg = '';
    try {
      const res = await APIClient.shared().importQQPlaylist(raw);
      this.importMsg = `${res.playlistName} · 新增 ${res.added} 首（共 ${res.total} 首）`;
      this.importLink = '';
      AppState.shared().bumpFavRev();
    } catch (e) {
      this.importMsg = (e as ApiError).message;
    } finally {
      this.importing = false;
    }
  }

  /** 点「去重」行直接开查，弹层只显示结果（web openDedupe 同口径：行本身就是触发点） */
  private async openDedupe(): Promise<void> {
    this.dupGroups = [];
    this.dupMsg = '';
    this.sheet = 'dedupe';
    await this.previewDup();
  }

  private async previewDup(): Promise<void> {
    if (this.dupBusy) { return; }
    this.dupBusy = true;
    this.dupMsg = '';
    try {
      const res = await APIClient.shared().dedupePreview();
      this.dupGroups = res.groups;
      this.dupMsg = res.duplicateCount > 0 ? `发现 ${res.duplicateCount} 首重复` : '没有重复';
    } catch (e) {
      this.dupMsg = (e as ApiError).message;
    } finally {
      this.dupBusy = false;
    }
  }

  private dupRemoveTotal(): number {
    let n = 0;
    for (let i = 0; i < this.dupGroups.length; i++) {
      n += this.dupGroups[i].removeTrackIds.length;
    }
    return n;
  }

  private async runDedup(): Promise<void> {
    if (this.dupBusy || this.dupGroups.length === 0) { return; }
    this.dupBusy = true;
    try {
      const res = await APIClient.shared().dedupeApply();
      this.dupGroups = [];
      this.dupMsg = `已清理 ${res.removedCount} 首`;
      AppState.shared().bumpFavRev();
    } catch (e) {
      this.dupMsg = (e as ApiError).message;
    } finally {
      this.dupBusy = false;
    }
  }

  // ---------------- 备份（文件 + WebDAV，web backup.ts 同口径） ----------------

  private saveDav(): void {
    const cfg: DavCfg = { url: this.davUrl, user: this.davUser, pass: this.davPass };
    AppState.shared().saveWebdav(JSON.stringify(cfg));
  }

  private loadWebdavFields(): void {
    const raw = AppState.shared().readWebdav();
    if (raw.length === 0) { return; }
    try {
      const cfg = JSON.parse(raw) as DavCfg;
      this.davUrl = cfg.url ?? '';
      this.davUser = cfg.user ?? '';
      this.davPass = cfg.pass ?? '';
    } catch (e) {
      // 损坏静默，按空配置处理
    }
  }

  /** 组装备份 JSON（web SmBackup 同构：tracks + dislikes + webdav 自包含） */
  private async buildBackupJson(): Promise<string> {
    let tracks: Track[] = [];
    try {
      tracks = await APIClient.shared().favoriteTracks();
    } catch (e) {
      tracks = [];
    }
    let dislikes: DislikeRow[] = [];
    try {
      dislikes = await APIClient.shared().fetchDislikes();
    } catch (e) {
      dislikes = [];
    }
    const backup: SmBackupFile = {
      version: 1,
      app: 'suenmusic',
      type: 'favorites_backup',
      exportedAt: new Date().toISOString(),
      total: tracks.length,
      tracks: tracks,
      dislikes: dislikes,
      webdav: { url: this.davUrl, user: this.davUser, pass: this.davPass }
    };
    return JSON.stringify(backup, null, 2);
  }

  /** 备份 JSON 的解析形态（字段全部可缺省，校验后再用） */
  private parseBackup(text: string): Object {
    interface SmBackupRaw {
      type?: string;
      tracks?: Track[];
      dislikes?: DislikeRow[];
      webdav?: DavCfg;
    }
    let data: SmBackupRaw;
    try {
      data = JSON.parse(text) as SmBackupRaw;
    } catch (e) {
      throw new ApiError(0, 'invalid', '不是有效的备份文件');
    }
    if (data.type !== 'favorites_backup' || !Array.isArray(data.tracks)) {
      throw new ApiError(0, 'invalid', '备份结构不正确（缺少 tracks）');
    }
    return data as Object;
  }

  /** 回写备份到服务端（导入文件 / WebDAV 下载共用路径） */
  private async applyBackupText(text: string): Promise<void> {
    const raw = this.parseBackup(text) as Record<string, Object>;
    const tracks = raw['tracks'] as Track[];
    let added = 0;
    if (tracks.length > 0) {
      added = await APIClient.shared().importFavorites(tracks);
    }
    const dislikes = (raw['dislikes'] ?? []) as DislikeRow[];
    for (let i = 0; i < dislikes.length; i++) {
      const d = dislikes[i];
      if (d.type !== 'track' && d.type !== 'artist') { continue; }
      try {
        await APIClient.shared().dislike(d.type, d.targetId, d.name);
      } catch (e) {
        // 单条恢复失败不阻断整份备份
      }
    }
    const dav = raw['webdav'] as DavCfg | undefined;
    if (dav !== undefined && dav.url !== undefined && dav.url.length > 0) {
      this.davUrl = dav.url;
      this.davUser = dav.user ?? '';
      this.davPass = dav.pass ?? '';
      this.saveDav();
    }
    AppState.shared().bumpFavRev();
    AppState.shared().bumpDailyRefresh();
    this.backupMsg = `新增 ${added} 首 · 跳过 ${Math.max(0, tracks.length - added)}`;
  }

  private async exportBackup(): Promise<void> {
    if (this.backupBusy) { return; }
    this.backupBusy = true;
    this.backupMsg = '';
    try {
      const text = await this.buildBackupJson();
      const ctx = this.getUIContext().getHostContext();
      if (ctx === undefined) {
        this.backupMsg = '无法获取应用上下文';
        return;
      }
      const docPicker = new picker.DocumentViewPicker(ctx);
      const options = new picker.DocumentSaveOptions();
      const now = new Date();
      const mm = now.getMonth() + 1 < 10 ? '0' + (now.getMonth() + 1) : '' + (now.getMonth() + 1);
      const dd = now.getDate() < 10 ? '0' + now.getDate() : '' + now.getDate();
      options.newFileNames = [`suenmusic_backup_${now.getFullYear()}-${mm}-${dd}.sm`];
      const uris: string[] = await docPicker.save(options);
      if (uris.length === 0) { return; }
      const file = fileIo.openSync(uris[0], fileIo.OpenMode.READ_WRITE);
      try {
        fileIo.writeSync(file.fd, text);
      } finally {
        fileIo.closeSync(file);
      }
      this.backupMsg = '已导出';
    } catch (e) {
      this.backupMsg = (e as ApiError).message;
    } finally {
      this.backupBusy = false;
    }
  }

  private readTextFromUri(uri: string): string {
    let file: fileIo.File | undefined = undefined;
    try {
      file = fileIo.openSync(uri, fileIo.OpenMode.READ_ONLY);
      const stat = fileIo.statSync(file.fd);
      const buf = new ArrayBuffer(stat.size);
      fileIo.readSync(file.fd, buf);
      const decoder = util.TextDecoder.create('utf-8');
      return decoder.decodeToString(new Uint8Array(buf));
    } catch (e) {
      throw new ApiError(0, 'file', '读取备份文件失败');
    } finally {
      if (file !== undefined) {
        try {
          fileIo.closeSync(file);
        } catch (e) {
          // 关闭失败不影响读取结果
        }
      }
    }
  }

  private async pickBackup(): Promise<void> {
    if (this.backupBusy) { return; }
    this.backupBusy = true;
    this.backupMsg = '';
    try {
      const ctx = this.getUIContext().getHostContext();
      if (ctx === undefined) {
        this.backupMsg = '无法获取应用上下文';
        return;
      }
      const docPicker = new picker.DocumentViewPicker(ctx);
      const options = new picker.DocumentSelectOptions();
      options.fileSuffixFilters = ['.sm', '.json'];
      options.maxSelectNumber = 1;
      const uris: string[] = await docPicker.select(options);
      if (uris.length === 0) { return; }
      const text = this.readTextFromUri(uris[0]);
      await this.applyBackupText(text);
    } catch (e) {
      this.backupMsg = (e as ApiError).message;
    } finally {
      this.backupBusy = false;
    }
  }

  private async uploadWebdav(): Promise<void> {
    if (this.backupBusy) { return; }
    if (this.davUrl.trim().length === 0) {
      this.backupMsg = '请填写 WebDAV 地址';
      return;
    }
    this.backupBusy = true;
    this.backupMsg = '';
    try {
      this.saveDav();
      const text = await this.buildBackupJson();
      await WebDavClient.put(this.davUrl, this.davUser, this.davPass, text);
      this.backupMsg = '已上传';
    } catch (e) {
      this.backupMsg = (e as ApiError).message;
    } finally {
      this.backupBusy = false;
    }
  }

  private async downloadWebdav(): Promise<void> {
    if (this.backupBusy) { return; }
    if (this.davUrl.trim().length === 0) {
      this.backupMsg = '请填写 WebDAV 地址';
      return;
    }
    this.backupBusy = true;
    this.backupMsg = '';
    try {
      this.saveDav();
      const text = await WebDavClient.get(this.davUrl, this.davUser, this.davPass);
      await this.applyBackupText(text);
    } catch (e) {
      this.backupMsg = (e as ApiError).message;
    } finally {
      this.backupBusy = false;
    }
  }

  // ---------------- 画像 / 调优 / 音源 ----------------

  private async loadPersona(): Promise<void> {
    try {
      this.persona = await APIClient.shared().fetchPersona();
    } catch (e) {
      this.persona = null;
    }
  }

  private personaHasSummary(): boolean {
    return this.persona !== null && this.persona.summary.length > 0;
  }

  /** 去掉 md 行内记号（**、*、`）：hw Text 不渲染富文本，裸记号非常刺眼 */
  private mdStripInline(s: string): string {
    return s.replace(/\*\*/g, '').replace(/\*/g, '').replace(/`/g, '').trim();
  }

  /** 解析一段 md 文本为结构行（#/## 标题、- 列表、--- 分隔、普通行；anchor 行内嵌 \n 一并拆开） */
  private mdPush(raw: string, minor: boolean, out: MdLine[]): void {
    const lines = raw.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (t.length === 0) {
        continue;
      }
      if (t === '---' || t === '***' || t === '___') {
        out.push(new MdLine(3, '', minor));
      } else if (t.startsWith('#')) {
        out.push(new MdLine(1, this.mdStripInline(t.replace(/^#+\s*/, '')), minor));
      } else if (t.startsWith('- ') || t.startsWith('* ') || t.startsWith('• ')) {
        out.push(new MdLine(2, this.mdStripInline(t.substring(2)), minor));
      } else {
        out.push(new MdLine(0, this.mdStripInline(t), minor));
      }
    }
  }

  /** 画像三段 md（summary / profileLines / ledgerLines）合并解析，summary 与特征段之间补分隔线 */
  private personaMdLines(): MdLine[] {
    const out: MdLine[] = [];
    if (this.persona === null) {
      return out;
    }
    this.mdPush(this.persona.summary, false, out);
    const hasSummary = out.length > 0;
    const mark = out.length;
    for (let i = 0; i < this.persona.profileLines.length; i++) {
      this.mdPush(this.persona.profileLines[i], true, out);
    }
    if (hasSummary && mark < out.length) {
      out.splice(mark, 0, new MdLine(3, '', false));
    }
    for (let i = 0; i < this.persona.ledgerLines.length; i++) {
      this.mdPush(this.persona.ledgerLines[i], true, out);
    }
    return out;
  }

  private async submitTune(): Promise<void> {
    const text = this.guidance.trim();
    if (text.length === 0 || this.tuning) { return; }
    this.tuning = true;
    try {
      const res = await APIClient.shared().tunePersona(text);
      this.persona = res.persona;
      this.lastTune = text;
      this.guidance = '';
      this.toast('画像已更新');
    } catch (e) {
      this.toast((e as ApiError).message);
    } finally {
      this.tuning = false;
    }
  }

  private async loadSources(): Promise<void> {
    try {
      const st = await APIClient.shared().bilibiliStatus();
      this.biliLabel = st.account !== null && st.account.name !== undefined && st.account.name.length > 0
        ? st.account.name
        : (st.configured ? '已授权' : '未授权');
    } catch (e) {
      this.biliLabel = '未授权';
    }
    try {
      const st = await APIClient.shared().neteaseStatus();
      // 第 ⑫ 条（2026-10-23 验收）：服务端 netease 的 account 元数据可能缺失（account: null）
      // 但 configured: true（curl 实测）—— 授权与否以 configured 为准；
      // 有名字显示名字，缺名字但已配置显示「已授权」（web neteaseOn=!!st.account 的同款 bug 记档）
      this.neteaseLabel = st.account !== null && st.account.name !== undefined && st.account.name.length > 0
        ? st.account.name
        : (st.configured ? '已授权' : '未授权');
    } catch (e) {
      this.neteaseLabel = '未授权';
    }
  }

  // ---------------- 通用 builder ----------------

  /** 分区标签：小字 + 右侧延伸发丝线（web .label::after） */
  @Builder
  secLabel(title: string) {
    Row({ space: Dim.s3 }) {
      Text(title)
        .fontSize(Dim.fsCaption)
        .fontWeight(FontWeight.Medium)
        .fontColor(Tokens.text2)
      Row()
        .layoutWeight(1)
        .height(Dim.hairline)
        .backgroundColor(Tokens.line)
    }
    .width('100%')
  }

  /** 面板容器（web .panel：panel 底 + 发丝描边 + 中圆角） */
  @Builder
  panel() {
  }

  /** 可点击行（web .row.row-btn：44 高 + 名/值两端对齐；first = 组内首行不加顶线） */
  @Builder
  rowBtn(name: string, val: string, first: boolean) {
    Row() {
      Text(name)
        .fontSize(Dim.fsBody)
        .fontColor(Tokens.text1)
        .layoutWeight(1)
      if (val.length > 0) {
        Text(val)
          .fontSize(Dim.fsMinor)
          .fontColor(Tokens.text2)
      }
    }
    .width('100%')
    .height(Dim.touchMin)
    .padding({ left: Dim.s4, right: Dim.s4 })
    .border(first
      ? { width: 0 }
      : { width: { top: Dim.hairline }, color: { top: Tokens.line } })
  }

  /** 静态展示行（名/值两端对齐，不可点） */
  @Builder
  rowStatic(name: string, val: string, first: boolean) {
    Row() {
      Text(name)
        .fontSize(Dim.fsBody)
        .fontColor(Tokens.text1)
        .layoutWeight(1)
      Text(val)
        .fontSize(Dim.fsMinor)
        .fontColor(Tokens.text2)
    }
    .width('100%')
    .height(Dim.touchMin)
    .padding({ left: Dim.s4, right: Dim.s4 })
    .border(first
      ? { width: 0 }
      : { width: { top: Dim.hairline }, color: { top: Tokens.line } })
  }

  /** 弹层顶把手（web Sheet .grip：36×3 圆头浅条） */
  @Builder
  sheetGrip() {
    Row()
      .width(Dim.gripW)
      .height(Dim.gripH)
      .borderRadius(Dim.radiusPill)
      .backgroundColor(Tokens.line)
  }

  /**
   * 弹层头：标题 + 收起钮。
   * 第 ⑱ 条全局令：浮窗关闭一律「向下收起」（chevron-down），不再是 X ——
   * 底部抽屉的语义是「滑下去」，收起图标与动效方向一致。
   */
  @Builder
  sheetHead(title: string) {
    Row() {
      Text(title)
        .fontSize(Dim.fsSection)
        .fontWeight(FontWeight.Medium)
        .fontColor(Tokens.text1)
        .layoutWeight(1)
      WebIconButton({
        iconName: WebIconName.CHEVRON_DOWN,
        boxSize: 36,
        glyphColor: Tokens.text2,
        chromeKind: NeuBtnChrome.PLAIN,
        onTap: () => {
          this.sheet = '';
        }
      })
        .accessibilityText('收起')
    }
    .width('100%')
    .alignItems(VerticalAlign.Center)
  }

  /** 弹层容器通用样式（底部圆角面板 + 上滑转场） */
  @Builder
  sheetShell() {
  }

  // ---------------- 三个 tab 的分区 ----------------

  /** 歌词翻译开关行（状态必须直引 this，经参数传值不刷新） */
  @Builder
  lyricTransRow() {
    Row() {
      Column({ space: Dim.s0 }) {
        Text('显示歌词翻译')
          .fontSize(Dim.fsBody)
          .fontColor(Tokens.text1)
        Text('原文行下方同时显示翻译')
          .fontSize(Dim.fsCaption)
          .fontColor(Tokens.text2)
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
    .width('100%')
    .constraintSize({ minHeight: Dim.touchMin })
    .padding({ left: Dim.s4, right: Dim.s4 })
    .border({ width: { top: Dim.hairline }, color: { top: Tokens.line } })
  }

  /** 自动选路开关行（同上，直引状态） */
  @Builder
  failoverRow() {
    Row() {
      Column({ space: Dim.s0 }) {
        Text('自动切换服务器')
          .fontSize(Dim.fsBody)
          .fontColor(Tokens.text1)
        Text('网络异常时自动尝试其它服务端')
          .fontSize(Dim.fsCaption)
          .fontColor(Tokens.text2)
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
    .width('100%')
    .constraintSize({ minHeight: Dim.touchMin })
    .padding({ left: Dim.s4, right: Dim.s4 })
    .border({ width: { top: Dim.hairline }, color: { top: Tokens.line } })
  }

  /** 黑名单入口行（计数直引 this.dislikes 才能刷新） */
  @Builder
  dislikesEntryRow() {
    Row() {
      Text('黑名单')
        .fontSize(Dim.fsBody)
        .fontColor(Tokens.text1)
        .layoutWeight(1)
      Text(`歌曲 ${this.dislikeCountOf('track')} · 歌手 ${this.dislikeCountOf('artist')}`)
        .fontSize(Dim.fsMinor)
        .fontColor(Tokens.text2)
    }
    .width('100%')
    .height(Dim.touchMin)
    .padding({ left: Dim.s4, right: Dim.s4 })
    .accessibilityText('黑名单')
    .onClick(() => {
      this.loadDislikes();
      this.sheet = 'dislikes';
    })
  }

  /** 画像分区（展开式：行点击展开摘要 + 特征行，web personaOpen 同口径） */
  @Builder
  personaSection() {
    Column() {
      Row() {
        Text(this.personaHasSummary() ? '音乐画像' : '尚未生成')
          .fontSize(Dim.fsBody)
          .fontColor(Tokens.text1)
          .layoutWeight(1)
        WebIcon(this.personaOpen ? WebIconName.CHEVRON_UP : WebIconName.CHEVRON_DOWN, 18, Tokens.text2)
      }
      .width('100%')
      .height(Dim.touchMin)
      .padding({ left: Dim.s4, right: Dim.s4 })
      .accessibilityText(this.personaOpen ? '收起画像' : '展开画像')
      .onClick(() => {
        this.personaOpen = !this.personaOpen;
      })

      if (this.personaOpen) {
        Column({ space: Dim.s2 }) {
          if (this.personaMdLines().length === 0) {
            Text('暂无')
              .fontSize(Dim.fsBody)
              .fontColor(Tokens.text2)
          } else {
            ForEach(this.personaMdLines(), (l: MdLine) => {
              if (l.kind === 3) {
                Row()
                  .width('100%')
                  .height(Dim.hairline)
                  .backgroundColor(Tokens.line)
              } else if (l.kind === 1) {
                Text(l.text)
                  .fontSize(l.minor ? Dim.fsBody : Dim.fsSub)
                  .fontWeight(FontWeight.Medium)
                  .fontColor(Tokens.text1)
                  .lineHeight(22)
                  .width('100%')
              } else if (l.kind === 2) {
                Text('· ' + l.text)
                  .fontSize(l.minor ? Dim.fsMinor : Dim.fsBody)
                  .fontColor(Tokens.text2)
                  .lineHeight(20)
                  .width('100%')
              } else {
                Text(l.text)
                  .fontSize(l.minor ? Dim.fsMinor : Dim.fsBody)
                  .fontColor(l.minor ? Tokens.text2 : Tokens.text1)
                  .lineHeight(l.minor ? 20 : 22)
                  .width('100%')
              }
            }, (l: MdLine) => `${l.kind}|${l.minor}|${l.text}`)
          }
        }
        .alignItems(HorizontalAlign.Start)
        .width('100%')
        .padding({ left: Dim.s4, right: Dim.s4, top: Dim.s0, bottom: Dim.s3 })
        .border({ width: { top: Dim.hairline }, color: { top: Tokens.line } })
      }
    }
    .width('100%')
    .backgroundColor(Tokens.panel)
    .borderRadius(Dim.radiusMd)
    .border({ width: Dim.hairline, color: Tokens.line })
  }

  // ---------------- 四张弹层 ----------------

  /** 黑名单弹层：歌曲/歌手分片 + 列表 + 恢复 */
  @Builder
  dislikesSheet() {
    Column({ space: Dim.s3 }) {
      this.sheetGrip()
      this.sheetHead('黑名单')
      Row({ space: Dim.s5 }) {
        Column() {
          Text(`歌曲 ${this.dislikeCountOf('track')}`)
            .fontSize(Dim.fsMinor)
            .fontColor(this.dislikeTab === 'track' ? Tokens.text1 : Tokens.text2)
            .padding({ top: Dim.s1, bottom: Dim.s3 })
            .animation({ duration: Motion.fast, curve: Motion.curve })
        }
        .border({
          width: { bottom: Dim.tabIndicatorH },
          color: { bottom: this.dislikeTab === 'track' ? Tokens.accent : Color.Transparent }
        })
        .animation({ duration: Motion.fast, curve: Motion.curve })
        .accessibilityText('歌曲黑名单')
        .onClick(() => {
          this.dislikeTab = 'track';
        })

        Column() {
          Text(`歌手 ${this.dislikeCountOf('artist')}`)
            .fontSize(Dim.fsMinor)
            .fontColor(this.dislikeTab === 'artist' ? Tokens.text1 : Tokens.text2)
            .padding({ top: Dim.s1, bottom: Dim.s3 })
            .animation({ duration: Motion.fast, curve: Motion.curve })
        }
        .border({
          width: { bottom: Dim.tabIndicatorH },
          color: { bottom: this.dislikeTab === 'artist' ? Tokens.accent : Color.Transparent }
        })
        .animation({ duration: Motion.fast, curve: Motion.curve })
        .accessibilityText('歌手黑名单')
        .onClick(() => {
          this.dislikeTab = 'artist';
        })
      }
      .alignItems(VerticalAlign.Bottom)
      .width('100%')
      .border({ width: { bottom: Dim.hairline }, color: { bottom: Tokens.line } })

      if (this.visibleDislikes().length === 0) {
        Text('没有记录')
          .fontSize(Dim.fsBody)
          .fontColor(Tokens.text2)
          .width('100%')
          .padding({ top: Dim.s3, bottom: Dim.s3 })
      } else {
        Scroll() {
          Column() {
            ForEach(this.visibleDislikes(), (row: DislikeRow) => {
              Row() {
                Text(row.name.length > 0 ? row.name : row.targetId)
                  .fontSize(Dim.fsBody)
                  .fontColor(Tokens.text1)
                  .maxLines(1)
                  .textOverflow({ overflow: TextOverflow.Ellipsis })
                  .layoutWeight(1)
                WebButton({
                  labelStr: '恢复',
                  sizeKind: NeuBtnSize.SM,
                  onTap: () => {
                    this.undoDislike(row);
                  }
                })
                  .accessibilityText('恢复 ' + row.name)
              }
              .width('100%')
              .height(Dim.touchMin)
            }, (row: DislikeRow) => row.type + '|' + row.targetId + '|' + row.name)
          }
          .width('100%')
        }
        .align(Alignment.Top)
        .scrollBar(BarState.Off)
        .layoutWeight(1)
      }
    }
    .width('100%')
    .height('62%')
    .padding({ left: Dim.s4, right: Dim.s4, top: Dim.s3, bottom: Dim.s4 })
    .backgroundColor(Tokens.panel)
    .borderRadius({ topLeft: Dim.radiusLg, topRight: Dim.radiusLg })
    .transition(TransitionEffect.translate({ y: '100%' })
      .animation({ duration: Motion.standard, curve: Motion.curve }))
  }

  /** QQ 歌单导入弹层 */
  @Builder
  importSheet() {
    Column({ space: Dim.s3 }) {
      this.sheetGrip()
      this.sheetHead('歌单导入')
      NeuInput({ content: this.importLink, placeholder: 'QQ 歌单链接或 id' })
        .width('100%')
      WebButton({
        labelStr: this.importing ? '导入中…' : '导入',
        variantKind: NeuBtnVariant.PRIMARY,
        blockFlag: true,
        sizeKind: NeuBtnSize.MD,
        disabledFlag: this.importing || this.importLink.trim().length === 0,
        onTap: () => {
          this.doImport();
        }
      })
        .accessibilityText(this.importing ? '正在导入' : '导入')
      if (this.importMsg.length > 0) {
        Text(this.importMsg)
          .fontSize(Dim.fsMinor)
          .fontColor(Tokens.text2)
          .width('100%')
      }
    }
    .width('100%')
    .padding({ left: Dim.s4, right: Dim.s4, top: Dim.s3, bottom: Dim.s4 })
    .backgroundColor(Tokens.panel)
    .borderRadius({ topLeft: Dim.radiusLg, topRight: Dim.radiusLg })
    .transition(TransitionEffect.translate({ y: '100%' })
      .animation({ duration: Motion.standard, curve: Motion.curve }))
  }

  /** 修改口令弹层（T8）：旧口令 + 新口令 ×2，服务端回新会话 */
  @Builder
  passwordSheet() {
    Column({ space: Dim.s3 }) {
      this.sheetGrip()
      this.sheetHead('修改口令')
      NeuInput({ content: this.pwOld, placeholder: '当前口令', password: true })
        .width('100%')
      NeuInput({ content: this.pwNew, placeholder: '新口令（至少 6 位）', password: true })
        .width('100%')
      NeuInput({ content: this.pwNew2, placeholder: '再输一次新口令', password: true })
        .width('100%')
      if (this.pwNew2.length > 0 && this.pwNew !== this.pwNew2) {
        Text('两次输入的新口令不一致')
          .fontSize(Dim.fsMinor)
          .fontColor(Tokens.danger)
          .width('100%')
      }
      WebButton({
        labelStr: this.pwBusy ? '提交中…' : '确认修改',
        variantKind: NeuBtnVariant.PRIMARY,
        blockFlag: true,
        sizeKind: NeuBtnSize.MD,
        disabledFlag: this.pwBusy || !this.pwReady(),
        onTap: () => {
          this.doChangePassword();
        }
      })
        .accessibilityText('确认修改口令')
      Text('改完会用新会话继续（其它设备上的登录会失效）')
        .fontSize(Dim.fsCaption)
        .fontColor(Tokens.text2)
        .width('100%')
    }
    .width('100%')
    .padding({ left: Dim.s4, right: Dim.s4, top: Dim.s3, bottom: Dim.s4 })
    .backgroundColor(Tokens.panel)
    .borderRadius({ topLeft: Dim.radiusLg, topRight: Dim.radiusLg })
    .transition(TransitionEffect.translate({ y: '100%' })
      .animation({ duration: Motion.standard, curve: Motion.curve }))
  }

  /** 去重弹层（打开即自动预检，重复组明细 + 一键清理） */
  @Builder
  dedupeSheet() {
    Column({ space: Dim.s3 }) {
      this.sheetGrip()
      this.sheetHead('去重')
      if (this.dupBusy) {
        Text('检查中…')
          .fontSize(Dim.fsMinor)
          .fontColor(Tokens.text2)
          .width('100%')
      } else if (this.dupMsg.length > 0) {
        Text(this.dupMsg)
          .fontSize(Dim.fsMinor)
          .fontColor(Tokens.text2)
          .width('100%')
      }
      if (!this.dupBusy && this.dupGroups.length > 0) {
        Scroll() {
          Column() {
            ForEach(this.dupGroups, (g: DedupeGroup, i: number) => {
              Row({ space: Dim.s2 }) {
                Column({ space: Dim.s0 }) {
                  Text(g.name)
                    .fontSize(Dim.fsBody)
                    .fontColor(Tokens.text1)
                    .maxLines(1)
                    .textOverflow({ overflow: TextOverflow.Ellipsis })
                  Text(g.artist)
                    .fontSize(Dim.fsCaption)
                    .fontColor(Tokens.text2)
                    .maxLines(1)
                    .textOverflow({ overflow: TextOverflow.Ellipsis })
                }
                .alignItems(HorizontalAlign.Start)
                .layoutWeight(1)
                Text(`清理 ${g.removeTrackIds.length} 首`)
                  .fontSize(Dim.fsMinor)
                  .fontColor(Tokens.text2)
              }
              .width('100%')
              .padding({ top: Dim.s2, bottom: Dim.s2 })
              .border(i > 0
                ? { width: { top: Dim.hairline }, color: { top: Tokens.line } }
                : { width: 0 })
            }, (g: DedupeGroup, i: number) => `${g.key}|${i}`)
          }
          .width('100%')
        }
        .align(Alignment.Top)
        .scrollBar(BarState.Off)
        .constraintSize({ maxHeight: Dim.sheetListMax })
        .width('100%')

        WebButton({
          labelStr: `清理 ${this.dupRemoveTotal()} 首`,
          variantKind: NeuBtnVariant.PRIMARY,
          blockFlag: true,
          sizeKind: NeuBtnSize.MD,
          onTap: () => {
            this.runDedup();
          }
        })
          .accessibilityText('清理重复收藏')
      }
    }
    .width('100%')
    .padding({ left: Dim.s4, right: Dim.s4, top: Dim.s3, bottom: Dim.s4 })
    .backgroundColor(Tokens.panel)
    .borderRadius({ topLeft: Dim.radiusLg, topRight: Dim.radiusLg })
    .transition(TransitionEffect.translate({ y: '100%' })
      .animation({ duration: Motion.standard, curve: Motion.curve }))
  }

  /** 数据备份弹层：文件导出/导入 + WebDAV 三栏（label + 输入，web .field 同构） */
  @Builder
  backupSheet() {
    Column({ space: Dim.s3 }) {
      this.sheetGrip()
      this.sheetHead('数据备份')
      Row({ space: Dim.s2 }) {
        Column() {
          WebButton({
            labelStr: this.backupBusy ? '处理中…' : '导出文件',
            blockFlag: true,
            sizeKind: NeuBtnSize.MD,
            disabledFlag: this.backupBusy,
            onTap: () => {
              this.exportBackup();
            }
          })
        }
        .layoutWeight(1)
        .accessibilityText('导出备份文件')
        Column() {
          WebButton({
            labelStr: '导入文件',
            blockFlag: true,
            sizeKind: NeuBtnSize.MD,
            disabledFlag: this.backupBusy,
            onTap: () => {
              this.pickBackup();
            }
          })
        }
        .layoutWeight(1)
        .accessibilityText('导入备份文件')
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)

      if (this.backupMsg.length > 0) {
        Text(this.backupMsg)
          .fontSize(Dim.fsMinor)
          .fontColor(Tokens.text2)
          .width('100%')
      }

      Row()
        .width('100%')
        .height(Dim.hairline)
        .backgroundColor(Tokens.line)

      Row({ space: Dim.s2 }) {
        Text('WebDAV')
          .fontSize(Dim.fsBody)
          .fontColor(Tokens.text2)
          .width(Dim.fieldLabelW)
        NeuInput({ content: this.davUrl, placeholder: 'https://dav.example.com/music' })
          .layoutWeight(1)
      }
      .width('100%')

      Row({ space: Dim.s2 }) {
        Text('账号')
          .fontSize(Dim.fsBody)
          .fontColor(Tokens.text2)
          .width(Dim.fieldLabelW)
        NeuInput({ content: this.davUser, placeholder: 'WebDAV 账号' })
          .layoutWeight(1)
      }
      .width('100%')

      Row({ space: Dim.s2 }) {
        Text('口令')
          .fontSize(Dim.fsBody)
          .fontColor(Tokens.text2)
          .width(Dim.fieldLabelW)
        NeuInput({ content: this.davPass, placeholder: 'WebDAV 口令', password: true })
          .layoutWeight(1)
      }
      .width('100%')

      Row({ space: Dim.s2 }) {
        Column() {
          WebButton({
            labelStr: '上传',
            blockFlag: true,
            sizeKind: NeuBtnSize.MD,
            onTap: () => {
              this.uploadWebdav();
            }
          })
        }
        .layoutWeight(1)
        .accessibilityText('上传备份到 WebDAV')
        Column() {
          WebButton({
            labelStr: '下载',
            variantKind: NeuBtnVariant.PRIMARY,
            blockFlag: true,
            sizeKind: NeuBtnSize.MD,
            onTap: () => {
              this.downloadWebdav();
            }
          })
        }
        .layoutWeight(1)
        .accessibilityText('从 WebDAV 下载备份')
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)
    }
    .width('100%')
    .padding({ left: Dim.s4, right: Dim.s4, top: Dim.s3, bottom: Dim.s4 })
    .backgroundColor(Tokens.panel)
    .borderRadius({ topLeft: Dim.radiusLg, topRight: Dim.radiusLg })
    .transition(TransitionEffect.translate({ y: '100%' })
      .animation({ duration: Motion.standard, curve: Motion.curve }))
  }

  // ---------------- 页面 ----------------

  build() {
    Stack({ alignContent: Alignment.Bottom }) {
      Scroll() {
        Column({ space: Dim.s4 }) {
          Text('设置')
            .fontSize(Dim.fsHeadline)
            .fontWeight(FontWeight.Bold)
            .fontColor(Tokens.text1)
            .width('100%')

          // 三分段（第 ⑰⑱ 条统一：共享 NeuTabs，与搜索页四分片同质感）
          NeuTabs({
            labels: ['本机', '智能', '高级'],
            activeIndex: this.seg,
            onSelect: (i: number) => { this.seg = i; }
          })
            .width('100%')

          // ==================== 本机 ====================
          if (this.seg === 0) {
            this.secLabel('播放')
            Column() {
              Row() {
                Text('缓存')
                  .fontSize(Dim.fsBody)
                  .fontColor(Tokens.text1)
                  .layoutWeight(1)
                // 行内直接给用量（用户 2026-10-23 裁定：不再「管理」弹层看，改成 100M/2G 直显）
                Text(this.fmtShort(this.cacheUsed) + '/' + this.fmtShort(this.cacheQuota))
                  .fontSize(Dim.fsMinor)
                  .fontColor(Tokens.text2)
              }
              .width('100%')
              .height(Dim.touchMin)
              .padding({ left: Dim.s4, right: Dim.s4 })
              .accessibilityText('清空离线缓存：已用 ' + this.fmtShort(this.cacheUsed)
                + '，上限 ' + this.fmtShort(this.cacheQuota))
              .onClick(() => {
                this.loadCacheUsage();
                this.clearCacheAsk = true;
              })

              this.lyricTransRow()
            }
            .width('100%')
            .backgroundColor(Tokens.panel)
            .borderRadius(Dim.radiusMd)
            .border({ width: Dim.hairline, color: Tokens.line })

            // 主题（T12 阶段 2）：三态对齐 web `stores/ui.ts`（跟随系统 / 浅色 / 深色）
            this.secLabel('主题')
            Column() {
              NeuTabs({
                labels: THEME_LABELS,
                activeIndex: this.themeIndex(),
                onSelect: (i: number) => {
                  Theme.setMode(THEME_VALUES[i]);
                  this.toast('主题：' + THEME_LABELS[i]);
                }
              })
                .width('100%')
            }
            .width('100%')
            .padding(Dim.s3)
            .backgroundColor(Tokens.panel)
            .borderRadius(Dim.radiusMd)
            .border({ width: Dim.hairline, color: Tokens.line })

            this.secLabel('资料库')
            Column() {
              this.dislikesEntryRow()
              Column() {
                Row() {
                  Text('歌单导入')
                    .fontSize(Dim.fsBody)
                    .fontColor(Tokens.text1)
                    .layoutWeight(1)
                  Text('QQ 歌单')
                    .fontSize(Dim.fsMinor)
                    .fontColor(Tokens.text2)
                }
                .width('100%')
                .height(Dim.touchMin)
                .padding({ left: Dim.s4, right: Dim.s4 })
                .accessibilityText('打开歌单导入')
                .onClick(() => {
                  this.sheet = 'import';
                })
              }
              .width('100%')
              .border({ width: { top: Dim.hairline }, color: { top: Tokens.line } })

              Column() {
                Row() {
                  Text('去重')
                    .fontSize(Dim.fsBody)
                    .fontColor(Tokens.text1)
                    .layoutWeight(1)
                  Text('本机收藏')
                    .fontSize(Dim.fsMinor)
                    .fontColor(Tokens.text2)
                }
                .width('100%')
                .height(Dim.touchMin)
                .padding({ left: Dim.s4, right: Dim.s4 })
                .accessibilityText('打开去重')
                .onClick(() => {
                  this.openDedupe();
                })
              }
              .width('100%')
              .border({ width: { top: Dim.hairline }, color: { top: Tokens.line } })

              Column() {
                Row() {
                  Text('数据备份')
                    .fontSize(Dim.fsBody)
                    .fontColor(Tokens.text1)
                    .layoutWeight(1)
                  Text('文件 · WebDAV')
                    .fontSize(Dim.fsMinor)
                    .fontColor(Tokens.text2)
                }
                .width('100%')
                .height(Dim.touchMin)
                .padding({ left: Dim.s4, right: Dim.s4 })
                .accessibilityText('打开数据备份')
                .onClick(() => {
                  this.sheet = 'backup';
                })
              }
              .width('100%')
              .border({ width: { top: Dim.hairline }, color: { top: Tokens.line } })
            }
            .width('100%')
            .backgroundColor(Tokens.panel)
            .borderRadius(Dim.radiusMd)
            .border({ width: Dim.hairline, color: Tokens.line })

            this.secLabel('账号')
            Column() {
              if (this.userName.length > 0) {
                // 账号卡（T8 §①）：头像位 + 昵称 + 角色，独立面板卡而不是列表行
                Row({ space: Dim.s3 }) {
                  Text(this.avatarText())
                    .fontSize(Dim.fsSection)
                    .fontWeight(FontWeight.Medium)
                    .fontColor(Tokens.badgeInk)
                    .width(Dim.coverSm)
                    .height(Dim.coverSm)
                    .textAlign(TextAlign.Center)
                    .borderRadius(Dim.radiusAvatar)
                    .backgroundColor(Tokens.accent)
                  Column({ space: Dim.s0 }) {
                    // 第 ⑪ 条：优先显示服务端昵称（K_USER_DISPLAY），缺失回退登录名
                    Text(this.userDisplay.length > 0 ? this.userDisplay : this.userName)
                      .fontSize(Dim.fsSub)
                      .fontWeight(FontWeight.Medium)
                      .fontColor(Tokens.text1)
                      .maxLines(1)
                      .textOverflow({ overflow: TextOverflow.Ellipsis })
                    Text('@' + this.userName + ' · ' + this.roleLabel())
                      .fontSize(Dim.fsCaption)
                      .fontColor(Tokens.text2)
                      .maxLines(1)
                  }
                  .alignItems(HorizontalAlign.Start)
                  .layoutWeight(1)
                }
                .width('100%')
                .padding({ left: Dim.s4, right: Dim.s4, top: Dim.s3, bottom: Dim.s3 })
                .accessibilityText('账号 ' + this.userName + '，' + this.roleLabel())

                // 修改口令（PATCH /api/auth/password，服务端回新会话）
                Column() {
                  Row() {
                    Text('修改口令')
                      .fontSize(Dim.fsBody)
                      .fontColor(Tokens.text1)
                      .layoutWeight(1)
                    WebIcon(WebIconName.CHEVRON_RIGHT, Dim.icon16, Tokens.text2)
                  }
                  .width('100%')
                  .height(Dim.touchMin)
                  .padding({ left: Dim.s4, right: Dim.s4 })
                  .accessibilityText('修改登录口令')
                  .onClick(() => {
                    this.pwOld = '';
                    this.pwNew = '';
                    this.pwNew2 = '';
                    this.sheet = 'password';
                  })
                }
                .width('100%')
                .border({ width: { top: Dim.hairline }, color: { top: Tokens.line } })

                // 关于（T8 §通用）
                Column() {
                  Row() {
                    Text('关于 SuenMusic')
                      .fontSize(Dim.fsBody)
                      .fontColor(Tokens.text1)
                      .layoutWeight(1)
                    Text('v' + this.selfVersion())
                      .fontSize(Dim.fsMinor)
                      .fontColor(Tokens.text2)
                  }
                  .width('100%')
                  .height(Dim.touchMin)
                  .padding({ left: Dim.s4, right: Dim.s4 })
                  .accessibilityText('关于 SuenMusic')
                  .onClick(() => {
                    this.aboutOpen = true;
                  })
                }
                .width('100%')
                .border({ width: { top: Dim.hairline }, color: { top: Tokens.line } })

                // 退出登录（红字行 + 二次确认）
                Column() {
                  Row() {
                    Text('退出登录')
                      .fontSize(Dim.fsBody)
                      .fontColor(Tokens.danger)
                      .layoutWeight(1)
                  }
                  .width('100%')
                  .height(Dim.touchMin)
                  .padding({ left: Dim.s4, right: Dim.s4 })
                  .accessibilityText('退出登录')
                  .onClick(() => {
                    this.signOutAsk = true;
                  })
                }
                .width('100%')
                .border({ width: { top: Dim.hairline }, color: { top: Tokens.line } })
              } else {
                this.rowStatic('未登录', '', true)
              }
            }
            .width('100%')
            .backgroundColor(Tokens.panel)
            .borderRadius(Dim.radiusMd)
            .border({ width: Dim.hairline, color: Tokens.line })
          }

          // ==================== 智能 ====================
          if (this.seg === 1) {
            this.secLabel('画像')
            this.personaSection()

            this.secLabel('调优')
            Column({ space: Dim.s2 }) {
              NeuInput({ content: this.guidance, placeholder: '例如：少一点电音' })
                .width('100%')
              Row({ space: Dim.s3 }) {
                Column({ space: Dim.s0 }) {
                  Text('上一次')
                    .fontSize(Dim.fsCaption)
                    .fontColor(Tokens.text2)
                  Text(this.lastTune.length > 0 ? this.lastTune : '还没有记录')
                    .fontSize(Dim.fsBody)
                    .fontColor(Tokens.text1)
                    .maxLines(2)
                    .textOverflow({ overflow: TextOverflow.Ellipsis })
                }
                .alignItems(HorizontalAlign.Start)
                .layoutWeight(1)
                WebButton({
                  labelStr: this.tuning ? '调优中…' : '提交',
                  variantKind: NeuBtnVariant.PRIMARY,
                  sizeKind: NeuBtnSize.MD,
                  disabledFlag: this.tuning || this.guidance.trim().length === 0,
                  onTap: () => {
                    this.submitTune();
                  }
                })
                  .accessibilityText(this.tuning ? '正在调优' : '提交调优意见')
              }
              .width('100%')
              .alignItems(VerticalAlign.Center)
            }
            .width('100%')
            .padding(Dim.s3)
            .backgroundColor(Tokens.panel)
            .borderRadius(Dim.radiusMd)
            .border({ width: Dim.hairline, color: Tokens.line })
            .alignItems(HorizontalAlign.Start)
          }

          // ==================== 高级 ====================
          if (this.seg === 2) {
            // 设备（T7：检查更新 → 有新版本交给系统浏览器下载，包未签名、由用户自行侧载）
            this.secLabel('设备')
            Column() {
              Row() {
                Text('检查更新')
                  .fontSize(Dim.fsBody)
                  .fontColor(Tokens.text1)
                  .layoutWeight(1)
                Text(this.updLabel())
                  .fontSize(Dim.fsMinor)
                  .fontColor(this.updState.startsWith('new=') ? Tokens.accentText : Tokens.text2)
              }
              .width('100%')
              .height(Dim.touchMin)
              .padding({ left: Dim.s4, right: Dim.s4 })
              .accessibilityText('检查更新，当前 ' + this.updLabel())
              .onClick(() => {
                this.checkUpdate();
              })
            }
            .width('100%')
            .backgroundColor(Tokens.panel)
            .borderRadius(Dim.radiusMd)
            .border({ width: Dim.hairline, color: Tokens.line })

            // 卡片（T9）：已添加张数 + 添加/使用说明
            this.secLabel('卡片')
            Column() {
              Row() {
                Text('桌面卡片')
                  .fontSize(Dim.fsBody)
                  .fontColor(Tokens.text1)
                  .layoutWeight(1)
                Text(this.cardCountLabel())
                  .fontSize(Dim.fsMinor)
                  .fontColor(Tokens.text2)
              }
              .width('100%')
              .height(Dim.touchMin)
              .padding({ left: Dim.s4, right: Dim.s4 })
              .accessibilityText('桌面卡片：' + this.cardCountLabel())
              .onClick(() => {
                this.loadCardCount();
                this.cardHelpOpen = true;
              })
            }
            .width('100%')
            .backgroundColor(Tokens.panel)
            .borderRadius(Dim.radiusMd)
            .border({ width: Dim.hairline, color: Tokens.line })

            this.secLabel('多服务端')
            Column() {
              Row() {
                Text('服务端管理')
                  .fontSize(Dim.fsBody)
                  .fontColor(Tokens.text1)
                  .layoutWeight(1)
                WebIcon(WebIconName.CHEVRON_RIGHT, Dim.icon16, Tokens.text2)
              }
              .width('100%')
              .height(Dim.touchMin)
              .padding({ left: Dim.s4, right: Dim.s4 })
              .accessibilityText('打开服务端管理')
              .onClick(() => {
                this.onOpenServers();
              })

              this.failoverRow()
            }
            .width('100%')
            .backgroundColor(Tokens.panel)
            .borderRadius(Dim.radiusMd)
            .border({ width: Dim.hairline, color: Tokens.line })

            this.secLabel('音源授权')
            Column() {
              this.rowStatic('bilibili', this.biliLabel, true)
              this.rowStatic('网易云', this.neteaseLabel, false)
            }
            .width('100%')
            .backgroundColor(Tokens.panel)
            .borderRadius(Dim.radiusMd)
            .border({ width: Dim.hairline, color: Tokens.line })
          }
        }
        .width('100%')
        .alignItems(HorizontalAlign.Start)
        .padding({ left: Dim.s4, right: Dim.s4, top: Dim.s4, bottom: Dim.s5 })
      }
      .width('100%')
      .height('100%')
      .align(Alignment.Top)
      .scrollBar(BarState.Off)

      // ==================== 弹层 ====================
      if (this.sheet.length > 0) {
        Column()
          .width('100%')
          .height('100%')
          .backgroundColor(Tokens.scrim)
          .transition(TransitionEffect.OPACITY
            .animation({ duration: Motion.standard, curve: Motion.curve }))
          .onClick(() => {
            this.sheet = '';
          })
      }
      if (this.sheet === 'dislikes') {
        this.dislikesSheet()
      }
      if (this.sheet === 'import') {
        this.importSheet()
      }
      if (this.sheet === 'dedupe') {
        this.dedupeSheet()
      }
      if (this.sheet === 'backup') {
        this.backupSheet()
      }
      if (this.sheet === 'password') {
        this.passwordSheet()
      }

      // T8：登出二次确认
      if (this.signOutAsk) {
        ConfirmDialog({
          titleStr: '退出登录',
          messageStr: '退出后本机缓存与离线快照保留，重新登录即可继续收听。',
          confirmLabel: '退出',
          dangerFlag: true,
          onConfirm: (): void => {
            this.signOutAsk = false;
            AppState.shared().signOut();
          },
          onCancel: (): void => {
            this.signOutAsk = false;
          }
        })
      }

      // T8：关于
      if (this.aboutOpen) {
        ConfirmDialog({
          titleStr: '关于 SuenMusic',
          messageStr: this.aboutText(),
          confirmLabel: '知道了',
          singleFlag: true,
          onConfirm: (): void => {
            this.aboutOpen = false;
          },
          onCancel: (): void => {
            this.aboutOpen = false;
          }
        })
      }

      // T9：卡片添加/使用说明
      if (this.cardHelpOpen) {
        ConfirmDialog({
          titleStr: '桌面卡片',
          messageStr: this.cardHelpText(),
          confirmLabel: '知道了',
          singleFlag: true,
          onConfirm: (): void => {
            this.cardHelpOpen = false;
          },
          onCancel: (): void => {
            this.cardHelpOpen = false;
          }
        })
      }

      // 清空缓存二次确认（自绘哑光弹窗，不用系统 AlertDialog）
      if (this.clearCacheAsk) {
        ConfirmDialog({
          titleStr: '清空离线缓存',
          messageStr: '将删除全部 ' + this.fmtShort(this.cacheUsed) + ' 离线缓存（正在播放的除外），'
            + '之后播放会重新联网下载。',
          confirmLabel: '清空',
          dangerFlag: true,
          onConfirm: (): void => {
            this.clearCacheAsk = false;
            this.clearCache();
          },
          onCancel: (): void => {
            this.clearCacheAsk = false;
          }
        })
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Tokens.bg)
  }
}
