/**
 * 用户可见文案（对应 web 端 `ui.err(...)` 的人话）。
 *
 * 口径与 web 各 catch 分支一致：失败时**优先透出服务端 `ApiError.message`**，
 * 兜底才用这里的字符串 —— 服务端的限流/越权提示往往比固定文案更有用。
 */
import { ApiError } from '../core/APIClient';

export class Copy {
  /** 收藏/取消收藏失败的兜底文案（web `TrackRow.vue` toggleFav 的 catch） */
  static readonly favOpFailed: string = '收藏操作失败，请稍后重试';

  /**
   * 错误 → 用户可读文案。六页（Home/Search/Favorites/Daily/Login/Player）
   * 的 catch 都走这里，页面不再自造错误话术。
   *
   * 映射口径（与 T4 交接单一致）：
   *   · 网络层失败（status 0）        → 连不上服务端，请检查网络或服务器地址
   *   · 401 / unauthorized            → 登录已失效，请重新登录
   *   · 503 + source_unavailable      → 这首暂时找不到可播放音源
   *   · shortfall                     → 曲库还太少，先多听几首再来看看
   *   · 其它 4xx（含 invalid_platform）→ 请求被拒绝：<服务端 message>
   *   · 兜底                          → 出错了，请稍后重试
   *
   * `preferServerMessage`：**登录页专用**。登录失败服务端也回 401 +
   * `unauthorized`（`services/auth.ts:287` "用户名或密码错误"），这时
   * 服务端 message 才是有效信息，不能被"登录已失效"这类会话过期话术覆盖。
   */
  static describeError(e: Object, preferServerMessage: boolean = false): string {
    if (!(e instanceof ApiError)) {
      return '出错了，请稍后重试';
    }
    const err = e as ApiError;
    if (err.isNetwork) {
      return '连不上服务端，请检查网络或服务器地址';
    }
    if (err.isUnauthorized) {
      return preferServerMessage ? err.message : '登录已失效，请重新登录';
    }
    if (err.code === 'shortfall') {
      return '曲库还太少，先多听几首再来看看';
    }
    if (err.status === 503 && err.code === 'source_unavailable') {
      return '这首暂时找不到可播放音源';
    }
    if (err.status >= 400 && err.status < 500) {
      return '请求被拒绝：' + (err.message.length > 0 ? err.message : '请稍后重试');
    }
    return '出错了，请稍后重试';
  }

  /** 只按错误码取人话（拿不到完整 ApiError、只有 code 字符串时用） */
  static describeCode(code: string, fallback: string): string {
    if (code === 'shortfall') { return '曲库还太少，先多听几首再来看看'; }
    if (code === 'source_unavailable') { return '这首暂时找不到可播放音源'; }
    return fallback;
  }

  // ---- 空态文案（S4 §五，统一走 EmptyState，禁止页面自造） ----
  static readonly emptySearchTitle: string = '没找到相关歌曲';
  static readonly emptySearchSub: string = '换个关键词试试';
  static readonly emptyFavTitle: string = '还没有收藏';
  static readonly emptyFavSub: string = '在播放页点心形就能收藏';
  static readonly emptyDailyTitle: string = '曲库还太少';
  static readonly emptyDailySub: string = '先多听几首再来看';
  static readonly emptyLyricTitle: string = '这首歌暂无歌词';
  static readonly emptyQueueTitle: string = '队列是空的';
  static readonly emptyQueueSub: string = '去首页挑一首';
}
