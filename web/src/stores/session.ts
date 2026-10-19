/**
 * 会话 store。
 *
 * **令牌不在这里**。访问令牌、刷新令牌、localStorage 持久化都归
 * `api/client.ts` 管（原因见那边的注释：避免 store ↔ client 循环依赖）。
 * 这个 store 只做两件事：
 *
 *   1. 把 client 的令牌状态**镜像**成响应式数据，供界面使用
 *   2. 暴露 login / register / logout / changePassword 这些业务动作
 */

import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import {
  ApiError,
  clearSession,
  getCachedUser,
  restoreCachedUser,
  getRefreshToken,
  hasBackend,
  hasUsableRefreshToken,
  isWebPlatform,
  onBaseUrlChanged,
  onSessionChanged,
  refreshSession,
  resetUnreachableNotice,
  setSession,
} from '@/api/client.ts';
import * as authApi from '@/api/auth.ts';
import type { AuthConfig, PublicUser } from '@/api/types.ts';

export const useSessionStore = defineStore('session', () => {
  const user = ref<PublicUser | null>(getCachedUser());
  /** 冷启动时判断出的离线模式：界面据此走本地快照，不弹"登录失效" */
  const offline = ref(false);
  const authConfig = ref<AuthConfig | null>(null);

  /** 启动引导是否完成。路由守卫必须等它，否则刷新页面会被误判成未登录 */
  const bootstrapped = ref(false);
  /** 正在登录/注册，用于禁用按钮防重复提交 */
  const busy = ref(false);

  const isLoggedIn = computed(() => user.value !== null);
  const displayName = computed(() => user.value?.displayName || user.value?.username || '');
  /** 首个账号永远可注册，所以不能用 `allowRegistration` 单独判断 */
  const canRegister = computed(() => authConfig.value?.registrationOpen ?? false);
  const passwordMinLength = computed(() => authConfig.value?.passwordMinLength ?? 8);
  /**
   * 服务配置是否获取失败。
   *
   * 失败 ≠ 关闭：authConfig 为 null 时 canRegister 也是 false，
   * 登录页若不区分这两种情况，会把"连不上服务端"误报成"已关闭注册"
   * （用户实测踩过：配置请求因为基地址不可达而失败，注册入口消失）。
   */
  const authConfigFailed = ref(false);

  // -------------------------------------------------------------------------
  // 与 client 的令牌状态同步
  // -------------------------------------------------------------------------

  /**
   * 订阅 client 的会话与基地址变化。
   *
   * 这一步让"client 内部悄悄刷新了令牌"能反映到界面上（比如用户名可能更新）。
   * 同时基地址一旦配置或切换，立刻重新拉取服务端 authConfig，保证注册入口及时呈现。
   * 返回取消订阅函数。
   */
  function install(): () => void {
    const unSession = onSessionChanged(session => {
      user.value = session ? session.user : null;
    });
    const unBaseUrl = onBaseUrlChanged(() => {
      void loadAuthConfig();
    });
    return () => {
      unSession();
      unBaseUrl();
    };
  }

  // -------------------------------------------------------------------------
  // 启动引导
  // -------------------------------------------------------------------------

  /**
   * 页面启动时调用一次。
   *
   * 拿到刷新令牌就**尝试静默续期** —— 这样刷新浏览器不会掉登录态。
   * 失败不是错误（令牌可能已过期），静默降级为未登录即可，
   * 不要弹提示，否则每次打开页面都要被吓一下。
   */
  async function bootstrap(): Promise<void> {
    // 公开配置先取，登录页要用；失败也不阻塞（可能服务端还没起来）
    void loadAuthConfig();

    // 浏览器：同源 cookie 会话，没有令牌可续期
    if (isWebPlatform) {
      try {
        const res = await authApi.sessionMe();
        user.value = res.user;
      } catch {
        user.value = null;
      }
      bootstrapped.value = true;
      return;
    }

    /**
     * 离线冷启动必须能进 App（真机报障："没网时杀进程重开，登不进"）。
     *
     * 两个坑：
     *   1. 直接发续期请求会**先等 15 秒超时**才失败 —— 用户看到的就是"卡住进不去"；
     *   2. 网络类失败不是"登录失效"（401 才是），本地有缓存的登录态就该放行进离线模式。
     */
    if (hasUsableRefreshToken()) {
      if (navigator.onLine === false) {
        offline.value = true;   // 离线：不撞网络，直接用本地登录态
        user.value = restoreCachedUser();
      } else {
        try {
          await refreshSession();
        } catch (err) {
          if (err instanceof ApiError && err.isNetworkError) {
            offline.value = true;   // 服务端不可达：离线模式，保留本地登录态
            user.value = restoreCachedUser();
          }
          /* 401 之类的真失效：交给路由守卫去登录 */
        }
      }
    }
    bootstrapped.value = true;
  }

  async function loadAuthConfig(): Promise<AuthConfig | null> {
    /**
     * 没配服务器时**不要发这个请求**。
     * 基地址为空时 `/api/auth/config` 会变成相对路径，打到静态服务器或
     * 开发代理上 —— 前者返回 index.html 让 JSON.parse 抛错，后者产生一条
     * 无意义的 ECONNREFUSED 日志。两种情况都只会让人以为"服务端出问题了"。
     */
    if (!hasBackend()) {
      authConfigFailed.value = false;
      return null;
    }
    try {
      authConfig.value = await authApi.fetchAuthConfig();
      authConfigFailed.value = false;
      return authConfig.value;
    } catch {
      // 服务端不可达时不要卡住登录页 —— 让它照常渲染，提交时再报错。
      // 但"获取失败"要单独记账：登录页据此区分「关闭注册」与「连不上」
      authConfigFailed.value = true;
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // 动作
  // -------------------------------------------------------------------------

  async function login(username: string, password: string): Promise<void> {
    busy.value = true;
    try {
      if (isWebPlatform) {
        const res = await authApi.sessionLogin(username.trim(), password);
        user.value = res.user;
        return;
      }
      const session = await authApi.login(username.trim(), password);
      setSession(session);
      user.value = session.user;
    } finally {
      busy.value = false;
    }
  }

  async function register(
    username: string,
    password: string,
    displayName?: string
  ): Promise<void> {
    busy.value = true;
    try {
      await authApi.register(username.trim(), password, displayName?.trim());
      if (isWebPlatform) {
        // 注册响应里带的是令牌；Web 需要的是 cookie，重新走一次会话登录
        const res = await authApi.sessionLogin(username.trim(), password);
        user.value = res.user;
      } else {
        const session = await authApi.login(username.trim(), password);
        setSession(session);
        user.value = session.user;
      }
      // 建完第一个号，注册开关状态可能就变了
      void loadAuthConfig();
    } finally {
      busy.value = false;
    }
  }

  /**
   * 退出当前设备。
   *
   * **无论服务端调用成功与否都要清本地** —— 否则网络抖动会让人退不出去，
   * 只能手动清 localStorage，那体验很糟。服务端那边本来也是幂等的。
   */
  async function logout(): Promise<void> {
    resetUnreachableNotice();
    try {
      if (isWebPlatform) await authApi.sessionLogout();
      else await authApi.logout(getRefreshToken());
    } catch {
      /* 忽略：本地清理才是关键 */
    } finally {
      clearSession();
      user.value = null;
    }
  }

  /** 退出所有设备。会删掉**包括当前设备**的全部会话，需要重新登录 */
  async function logoutAll(): Promise<void> {
    await authApi.logoutAll();
    clearSession();
    user.value = null;
  }

  /**
   * 修改口令。
   *
   * 服务端返回一对新令牌（旧会话全部吊销，当前设备自动续上），
   * 所以这里必须把新会话写回去，否则请求层还拿着已作废的旧令牌，
   * 下一个请求就会 401 并被踢回登录页。
   */
  async function changePassword(oldPassword: string, newPassword: string): Promise<void> {
    await authApi.changePassword(oldPassword, newPassword);
    if (isWebPlatform) {
      // 改密会吊销所有刷新令牌；cookie 也失效了，用新口令重建会话
      const name = user.value?.username ?? '';
      const res = await authApi.sessionLogin(name, newPassword);
      user.value = res.user;
      return;
    }
    const session = await authApi.login(user.value?.username ?? '', newPassword);
    setSession(session);
    user.value = session.user;
  }

  /** 拉一次最新的自己（改动显示名等场景用） */
  async function refreshProfile(): Promise<void> {
    const res = await authApi.fetchMe();
    user.value = res.user;
  }

  /**
   * 会话彻底失效时的收尾。
   * 由 `client.onAuthLost` 触发 —— 路由跳转交给 App 层做，store 不碰 router。
   */
  function markLoggedOut(): void {
    clearSession();
    user.value = null;
  }

  /** 把任意异常转成可以直接往界面上写的中文文案 */
  function describeError(e: unknown): string {
    if (e instanceof ApiError) {
      if (e.isNetworkError) {
        return e.code === 'timeout'
          ? '请求超时，请检查网络后重试'
          : '连不上服务端，请到设置页检查基地址';
      }
      return e.message;
    }
    return e instanceof Error ? e.message : '发生了未知错误';
  }

  return {
    user,
    authConfig,
    bootstrapped,
    offline,
    busy,
    isLoggedIn,
    displayName,
    canRegister,
    authConfigFailed,
    passwordMinLength,
    install,
    bootstrap,
    loadAuthConfig,
    login,
    register,
    logout,
    logoutAll,
    changePassword,
    refreshProfile,
    markLoggedOut,
    describeError,
  };
});
