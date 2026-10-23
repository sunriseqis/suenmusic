/** 轻提示文本（AppStorage 通道） */
export const K_TOAST_TEXT = 'np_toast_text';
/** 轻提示序号（自增即触发显示；同文案连点也能再弹一次） */
export const K_TOAST_SEQ = 'np_toast_seq';

/**
 * 全端轻提示（**自绘**，底部居中）。
 *
 * 为什么不用系统 `promptAction.showToast`（用户 2026-10-23 反馈「提示漂移」）：
 * 沉浸式全屏窗口下系统 toast 实测会漂到屏幕顶部偏右，且样式与本端哑光体系不一致。
 * 自绘后位置/圆角/描边/字号全部可控，且与 Dialogs 同一套 Tokens。
 *
 * 渲染唯一落点：`NativeRoot` 根 Stack 最后一层（永远在最上面，不被任何浮层盖住）。
 */
export class AppToast {
  /** 弹一条提示（2200ms 自动消失，新提示顶掉旧提示） */
  static show(text: string): void {
    if (text.length === 0) {
      return;
    }
    const seq = AppStorage.get<number>(K_TOAST_SEQ);
    AppStorage.setOrCreate<string>(K_TOAST_TEXT, text);
    AppStorage.setOrCreate<number>(K_TOAST_SEQ, (seq === undefined ? 0 : seq) + 1);
  }
}
