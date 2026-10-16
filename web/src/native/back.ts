/**
 * 安卓返回手势（返回键）的统一分发。
 *
 * 为什么需要这一层：Capacitor 核心**不接管**返回键 —— 返回事件是
 * `@capacitor/app` 插件的职责，没装它时一次返回手势会直接走到 Activity
 * 的默认实现，也就是**立刻退出应用**。真机反馈原话：
 * "在收藏里搜了某首歌，结束搜索必须手动删掉搜索框的关键词，按返回直接退出应用。"
 *
 * 分工：
 * - 原生（MainActivity）只负责"截住"，把决定权交给 `window.__suenBack`；
 * - 页面/浮层用 `registerBackHandler` 表态自己要不要吃掉这次返回，
 *   **后注册的优先**（挂载越晚 = 层级越靠内）；
 * - 谁都没吃就先收起软键盘（键盘开着时返回的第一下永远先关键盘）；
 * - 还轮不到就交给原生做历史后退，历史也到底了原生把任务丢到后台。
 */
import { Capacitor } from '@capacitor/core';

type BackHandler = () => boolean;

/** 注册表按注册顺序排列，分发时从后往前问 */
const handlers: BackHandler[] = [];

/**
 * 注册一个返回处理器；返回注销函数。
 *
 * 处理器返回 `true` = 这次返回已被消费，原生不再做任何事；
 * 返回 `false` = 让给更外一层。**必须在组件卸载时注销**，
 * 否则离开页面后返回键还会去动已卸载页面的状态。
 */
export function registerBackHandler(fn: BackHandler): () => void {
  handlers.push(fn);
  return () => {
    const i = handlers.indexOf(fn);
    if (i >= 0) handlers.splice(i, 1);
  };
}

/** 收起软键盘：让当前聚焦的输入框失焦。返回本次是否真的收了一次 */
export function blurActiveInput(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el || (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA')) return false;
  el.blur();
  return true;
}

/** 分发：返回 true 表示已被消费 */
function dispatchBack(): boolean {
  for (let i = handlers.length - 1; i >= 0; i--) {
    const fn = handlers[i];
    if (fn && fn()) return true;
  }
  return blurActiveInput();
}

declare global {
  interface Window {
    __suenBack?: () => boolean;
  }
}

/**
 * 把分发器挂到 window 上供原生调用（仅原生平台）。
 *
 * 原生侧用 `evaluateJavascript("…window.__suenBack() === true")` 求值：
 * 表达式**必须返回布尔值**，返回字符串会被 JSON 引号包一层（`"\"true\""`），
 * 原生那边按 `"true"` 比较就永远判为"没消费"。
 */
export function installBackBridge(): void {
  if (!Capacitor.isNativePlatform()) return;
  window.__suenBack = dispatchBack;
}
