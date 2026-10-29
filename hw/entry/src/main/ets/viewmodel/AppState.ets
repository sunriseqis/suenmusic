/**
 * 应用级状态：登录态 + 首页数据 + 首页离线快照。
 *
 * 刻意做得薄：跨组件共享的少量值走 `AppStorage`（登录态、用户名），
 * 播放状态全在 `MediaPlayerCore`，页面自己持有列表数据。
 *
 * T4 新增：首页快照（离线可用）与两个设置开关（歌词翻译/自动选路）的
 * `AppStorage` 通道 + 偏好持久化都收在这里，页面不各自开 preferences。
 */

import { hilog } from '@kit.PerformanceAnalysisKit';
import { common } from '@kit.AbilityKit';
import { preferences } from '@kit.ArkData';
import { APIClient, ApiError } from '../core/APIClient';
import { HomeData, PublicUser, ServerCandidate } from '../core/Models';

const TAG = 'SuenMusic_State';
const DOMAIN = 0x0000;
const PREF_NAME = 'suenmusic';

export const K_LOGGED_IN = 'logged_in';
/** 启动引导完成标记（AppStorage 通道，T10）：false 期间 NativeRoot 显示启动占位而非登录页，防冷启动闪登录页 */
export const K_BOOTSTRAP_DONE = 'bootstrap_done';
export const K_USER_NAME = 'user_name';
/** 用户昵称（displayName，可空）—— 首页欢迎区第一行；空则回退 username */
export const K_USER_DISPLAY = 'user_display';
/** 账号角色（'admin' / 'user'）：设置页账号区显示「管理员」用（T8） */
export const K_USER_ROLE = 'user_role';
/** 收藏集合版本号：任何页面收藏/取消成功后 +1，收藏页监听它做跨页即时刷新 */
export const K_FAV_REV = 'fav_rev';
/** 当前服务端地址（AppStorage 通道）：设置页/服务端管理页跨组件即时显示 */
export const K_BASE_URL = 'base_url';
/** 歌词翻译开关（AppStorage 通道，T4）：设置页 Toggle ↔ LyricView 消费 */
export const K_LYRIC_TRANS = 'lyric_translation';
/** 自动选路开关（AppStorage 通道，T4）：设置页 Toggle ↔ APIClient 持久化值 */
export const K_AUTO_FAILOVER = 'auto_failover';
/** 首页刷新信号（AppStorage 通道，T4）：NativeRoot 热启动回前台时 +1，HomePage @Watch 后重拉 */
export const K_HOME_REFRESH = 'home_refresh';
/** 每日推荐刷新信号（AppStorage 通道，T10）：播放页 dislike 当前曲后 +1，DailyPage @Watch 后重拉 */
export const K_DAILY_REFRESH = 'daily_refresh';
/** 上一次画像调优提示词（AppStorage 通道，T10 批次 C）：调优区左侧回显，跨页面存活 */
export const K_LAST_TUNE = 'last_tune_prompt';
/** 收藏内搜索关键词（AppStorage 通道，T10 批次 E）：FavoritesPage 与 NativeRoot 返回手势共享——
 *  页面 @StorageLink 双向绑定，NativeRoot onBackPress 读到非空先清它（web Favorites.vue
 *  registerBackHandler：返回第一下退出筛选态而不是退出应用），清完再让系统处理 */
export const K_FAV_KEYWORD = 'fav_search_keyword';
/** 播放页内部浮层层级（T10 批次 F，web FullPlayer 返回键层级）：
 *  'none' | 'dislike' | 'more' | 'queue' | 'lyrics' | 'anchor'，PlayerPage 唯一写入方，
 *  NativeRoot onBackPress 读到非 'none' 先清它（返回第一下关浮层而不是关播放页） */
export const K_PLAYER_SHEET = 'np_player_sheet';

/** 首页快照的偏好键（成功拉取 /api/home 后写入，离线启动时先渲染它） */
const PREF_HOME_SNAPSHOT = 'home_snapshot';
const PREF_HOME_SNAPSHOT_AT = 'home_snapshot_at';
const PREF_LYRIC_TRANS = 'lyric_translation';
/** 快照里 newSongs 的上限：离线首屏够用即可，不把整页 100 首都塞进 preferences */
const SNAPSHOT_NEW_SONGS_MAX = 50;

export class AppState {
  private static instance: AppState | null = null;
  static shared(): AppState {
    if (AppState.instance === null) { AppState.instance = new AppState(); }
    return AppState.instance;
  }

  private api: APIClient = APIClient.shared();
  private pref: preferences.Preferences | null = null;
  user: PublicUser | null = null;

  /** UIAbility 启动时调一次：读偏好 → 有刷新令牌就恢复登录 */
  async bootstrap(context: common.Context): Promise<void> {
    try {
      await this.bootstrapInner(context);
    } catch (e) {
      // bootstrap 整体异常（如 api.init 抛错）：登录态按未登录渲染，不拦启动
      hilog.warn(DOMAIN, TAG, 'bootstrap 异常: %{public}s', JSON.stringify(e));
    } finally {
      // 无论走到哪条分支都要放行启动占位：否则 NativeRoot 永远停在启动屏
      AppStorage.setOrCreate<boolean>(K_BOOTSTRAP_DONE, true);
    }
  }

  private async bootstrapInner(context: common.Context): Promise<void> {
    if (this.pref === null) {
      try {
        this.pref = await preferences.getPreferences(context, PREF_NAME);
      } catch (e) {
        // 偏好存储打不开（极端情况）：快照/开关全部退化为默认值，不拦启动
        hilog.warn(DOMAIN, TAG, '打开偏好存储失败: %{public}s', JSON.stringify(e));
      }
    }
    await this.api.init(context);
    AppStorage.setOrCreate<string>(K_BASE_URL, this.api.getBaseUrl());
    AppStorage.setOrCreate<boolean>(K_AUTO_FAILOVER, this.api.isAutoFailover());
    AppStorage.setOrCreate<boolean>(K_LYRIC_TRANS, this.readLyricTransPref());
    if (!this.api.isLoggedIn()) {
      AppStorage.setOrCreate<boolean>(K_LOGGED_IN, false);
      return;
    }
    try {
      this.user = await this.api.me();
      AppStorage.setOrCreate<boolean>(K_LOGGED_IN, true);
      AppStorage.setOrCreate<string>(K_USER_NAME, this.user.username);
      AppStorage.setOrCreate<string>(K_USER_DISPLAY, this.user.displayName);
      AppStorage.setOrCreate<string>(K_USER_ROLE, this.user.role);
      hilog.info(DOMAIN, TAG, '恢复登录成功: %{public}s', this.user.username);
    } catch (e) {
      // 刷新令牌失效才真的回登录页；网络不通不该把用户踢出去
      const err = e as ApiError;
      if (err.isUnauthorized) {
        this.api.signOut();
        AppStorage.setOrCreate<boolean>(K_LOGGED_IN, false);
      } else {
        // 飞行模式冷启动：有刷新令牌就先乐观进首页（离线快照可看），
        // 否则 NativeRoot 读到 loggedIn=false 会把人踢到登录页。
        // 网络恢复后任意请求的 401 会经 failover/refresh 路径自然纠正登录态。
        AppStorage.setOrCreate<boolean>(K_LOGGED_IN, true);
      }
    }
  }

  async login(address: string, username: string, password: string): Promise<void> {
    let addr = address.trim();
    while (addr.endsWith('/')) { addr = addr.substring(0, addr.length - 1); }
    const list: ServerCandidate[] = [{ url: addr, name: '默认' }];
    await this.api.setServers(list, addr);
    AppStorage.setOrCreate<string>(K_BASE_URL, this.api.getBaseUrl());
    const session = await this.api.login(username, password);
    this.api.adopt(session);
    this.user = session.user;
    AppStorage.setOrCreate<boolean>(K_LOGGED_IN, true);
    AppStorage.setOrCreate<string>(K_USER_NAME, session.user.username);
    AppStorage.setOrCreate<string>(K_USER_DISPLAY, session.user.displayName);
    AppStorage.setOrCreate<string>(K_USER_ROLE, session.user.role);
  }

  signOut(): void {
    this.api.signOut();
    this.user = null;
    AppStorage.setOrCreate<boolean>(K_LOGGED_IN, false);
    AppStorage.setOrCreate<string>(K_USER_NAME, '');
    AppStorage.setOrCreate<string>(K_USER_DISPLAY, '');
    AppStorage.setOrCreate<string>(K_USER_ROLE, '');
  }

  async home(): Promise<HomeData> {
    return this.api.home();
  }

  baseUrl(): string { return this.api.getBaseUrl(); }

  /** 收藏集合版本号 +1（版本号只给 UI 做刷新通知，不进播放内核） */
  bumpFavRev(): void {
    const rev = AppStorage.get<number>(K_FAV_REV) ?? 0;
    AppStorage.setOrCreate<number>(K_FAV_REV, rev + 1);
  }

  /** 首页刷新信号 +1（NativeRoot 热启动回前台时调，HomePage 监听它重拉数据） */
  bumpHomeRefresh(): void {
    const rev = AppStorage.get<number>(K_HOME_REFRESH) ?? 0;
    AppStorage.setOrCreate<number>(K_HOME_REFRESH, rev + 1);
  }

  /** 每日推荐刷新信号 +1（播放页 dislike 当前曲后调，DailyPage 监听它重拉当日歌单） */
  bumpDailyRefresh(): void {
    const rev = AppStorage.get<number>(K_DAILY_REFRESH) ?? 0;
    AppStorage.setOrCreate<number>(K_DAILY_REFRESH, rev + 1);
  }

  // ---------------- 首页离线快照（T4 第 1 项） ----------------

  /** 读快照（无/损坏返回 null）。离线冷启动先渲染它，再后台尝试刷新 */
  readHomeSnapshot(): HomeData | null {
    const pref = this.pref;
    if (pref === null) { return null; }
    try {
      const raw = pref.getSync(PREF_HOME_SNAPSHOT, '') as string;
      if (raw.length === 0) { return null; }
      return JSON.parse(raw) as HomeData;
    } catch (e) {
      hilog.warn(DOMAIN, TAG, '读取首页快照失败: %{public}s', JSON.stringify(e));
      return null;
    }
  }

  /** 快照写入时刻（epoch ms，0 = 从未写入）。首页离线提示行显示用 */
  homeSnapshotAt(): number {
    const pref = this.pref;
    if (pref === null) { return 0; }
    try {
      return pref.getSync(PREF_HOME_SNAPSHOT_AT, 0) as number;
    } catch (e) {
      return 0;
    }
  }

  /** 成功拉到首页数据后落快照。只存首页真正渲染的字段（newAlbums 首页不展示、置空） */
  saveHomeSnapshot(data: HomeData): void {
    const pref = this.pref;
    if (pref === null) { return; }
    const capped: HomeData = {
      newAlbums: [],
      newSongs: data.newSongs.slice(0, SNAPSHOT_NEW_SONGS_MAX),
      toplists: data.toplists,
      welcomePhrase: data.welcomePhrase ?? ''
    };
    try {
      pref.putSync(PREF_HOME_SNAPSHOT, JSON.stringify(capped));
      pref.putSync(PREF_HOME_SNAPSHOT_AT, Date.now());
      pref.flush();
    } catch (e) {
      hilog.warn(DOMAIN, TAG, '写首页快照失败: %{public}s', JSON.stringify(e));
    }
  }

  // ---------------- 设置开关（T4 第 2/3 项） ----------------

  /** 歌词翻译开关（设置页 Toggle → AppStorage + 偏好持久化，LyricView 只读 AppStorage） */
  setLyricTranslation(enabled: boolean): void {
    AppStorage.setOrCreate<boolean>(K_LYRIC_TRANS, enabled);
    const pref = this.pref;
    if (pref === null) { return; }
    try {
      pref.putSync(PREF_LYRIC_TRANS, enabled);
      pref.flush();
    } catch (e) {
      hilog.warn(DOMAIN, TAG, '写歌词翻译开关失败: %{public}s', JSON.stringify(e));
    }
  }

  private readLyricTransPref(): boolean {
    const pref = this.pref;
    if (pref === null) { return true; }
    try {
      return pref.getSync(PREF_LYRIC_TRANS, true) as boolean;
    } catch (e) {
      return true;
    }
  }

}
