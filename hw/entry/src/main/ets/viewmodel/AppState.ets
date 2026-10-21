/**
 * 应用级状态：登录态 + 首页数据。
 *
 * 刻意做得薄：跨组件共享的少量值走 `AppStorage`（登录态、用户名），
 * 播放状态全在 `MediaPlayerCore`，页面自己持有列表数据。
 */

import { hilog } from '@kit.PerformanceAnalysisKit';
import { common } from '@kit.AbilityKit';
import { APIClient, ApiError } from '../core/APIClient';
import { HomeData, PublicUser, ServerCandidate } from '../core/Models';

const TAG = 'SuenMusic_State';
const DOMAIN = 0x0000;

export const K_LOGGED_IN = 'logged_in';
export const K_USER_NAME = 'user_name';

export class AppState {
  private static instance: AppState | null = null;
  static shared(): AppState {
    if (AppState.instance === null) { AppState.instance = new AppState(); }
    return AppState.instance;
  }

  private api: APIClient = APIClient.shared();
  user: PublicUser | null = null;

  /** UIAbility 启动时调一次：读偏好 → 有刷新令牌就恢复登录 */
  async bootstrap(context: common.Context): Promise<void> {
    await this.api.init(context);
    if (!this.api.isLoggedIn()) {
      AppStorage.setOrCreate<boolean>(K_LOGGED_IN, false);
      return;
    }
    try {
      this.user = await this.api.me();
      AppStorage.setOrCreate<boolean>(K_LOGGED_IN, true);
      AppStorage.setOrCreate<string>(K_USER_NAME, this.user.username);
      hilog.info(DOMAIN, TAG, '恢复登录成功: %{public}s', this.user.username);
    } catch (e) {
      // 刷新令牌失效才真的回登录页；网络不通不该把用户踢出去
      const err = e as ApiError;
      if (err.isUnauthorized) {
        this.api.signOut();
        AppStorage.setOrCreate<boolean>(K_LOGGED_IN, false);
      }
    }
  }

  async login(address: string, username: string, password: string): Promise<void> {
    let addr = address.trim();
    while (addr.endsWith('/')) { addr = addr.substring(0, addr.length - 1); }
    const list: ServerCandidate[] = [{ url: addr, name: '默认' }];
    await this.api.setServers(list, addr);
    const session = await this.api.login(username, password);
    this.api.adopt(session);
    this.user = session.user;
    AppStorage.setOrCreate<boolean>(K_LOGGED_IN, true);
    AppStorage.setOrCreate<string>(K_USER_NAME, session.user.username);
  }

  signOut(): void {
    this.api.signOut();
    this.user = null;
    AppStorage.setOrCreate<boolean>(K_LOGGED_IN, false);
    AppStorage.setOrCreate<string>(K_USER_NAME, '');
  }

  async home(): Promise<HomeData> {
    return this.api.home();
  }

  baseUrl(): string { return this.api.getBaseUrl(); }
}
