/**
 * 用户可见文案（对应 web 端 `ui.err(...)` 的人话）。
 *
 * 口径与 web 各 catch 分支一致：失败时**优先透出服务端 `ApiError.message`**，
 * 兜底才用这里的字符串 —— 服务端的限流/越权提示往往比固定文案更有用。
 */
export class Copy {
  /** 收藏/取消收藏失败的兜底文案（web `TrackRow.vue` toggleFav 的 catch） */
  static readonly favOpFailed: string = '收藏操作失败，请稍后重试';
}
