/**
 * 卡片控制指令的分发中枢（T6 冻结后纯原生实现）。
 *
 * 桌面卡片的按钮通过 postCardAction 的 call 事件 → EntryAbility 的 callee
 * 到达这里，这里直接驱动原生播放内核 MediaPlayerCore。
 *
 * 历史：WebView 壳时代这里把指令翻译成 runJavaScript 注进网页播放器
 * （window.__suenAudioControl）；2026-10-22 T6 删除 pages/Index.ets
 * （S5 §三，用户拍板"没有生产环境，不需要兜底"）后，原生驱动是唯一路径。
 */
import { hilog } from '@kit.PerformanceAnalysisKit';
import { MediaPlayerCore } from '../core/MediaPlayerCore';

const TAG = 'SuenMusic_CardControl';
const DOMAIN = 0x0000;

/** 卡片 call 事件送来的参数形状（postCardAction params，经 JSON 序列化） */
export interface CardControlRequest {
  method?: string;
  control?: string;
  formId?: string;
}

/** 支持的控制指令。与卡片按钮一一对应 */
const VALID_CONTROLS: string[] = ['play', 'pause', 'toggle', 'next', 'prev', 'favorite'];

/**
 * 冷启动期暂存的指令（T10 续播）。
 *
 * 时序坑：卡片 router 冷启动的指令在 EntryAbility.onCreate 就到达，而播放内核
 * 要等 NativeRoot 首帧后（aboutToAppear setTimeout）才 init，且续播要等
 * AppState.bootstrap 恢复 baseUrl/登录态。期间收到的指令先存这里，
 * 由 NativeRoot 在 init + bootstrap 完成后调用 applyPendingCardControl() 应用。
 */
let pendingControl: string | null = null;

/**
 * 收到一条控制指令（EntryAbility callee / want 参数转发而来）。
 * 指令本身是幂等的（play 在播放中是空操作），重放不会造成状态错乱。
 */
export function dispatchCardControl(control: string): void {
  if (VALID_CONTROLS.indexOf(control) < 0) {
    hilog.warn(DOMAIN, TAG, '忽略未知控制指令：%{public}s', control);
    return;
  }
  const core = MediaPlayerCore.shared();
  if (!core.ready) {
    pendingControl = control;
    hilog.info(DOMAIN, TAG, '播放内核未就绪，暂存指令：%{public}s', control);
    return;
  }
  hilog.info(DOMAIN, TAG, '转发控制指令至播放内核：%{public}s', control);
  if (control === 'play') { core.play(); }
  else if (control === 'pause') { core.pause(); }
  else if (control === 'toggle') { core.toggle(); }
  else if (control === 'next') { core.next(); }
  else if (control === 'prev') { core.prev(); }
  else { hilog.info(DOMAIN, TAG, '收藏指令待收藏 API 接线：%{public}s', control); }
}

/** NativeRoot 在 init + bootstrap 完成后调用：应用冷启动期暂存的卡片指令 */
export function applyPendingCardControl(): void {
  if (pendingControl === null) { return; }
  const control = pendingControl;
  pendingControl = null;
  hilog.info(DOMAIN, TAG, '应用暂存的卡片指令：%{public}s', control);
  dispatchCardControl(control);
}
