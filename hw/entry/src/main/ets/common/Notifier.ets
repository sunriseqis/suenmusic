import { notificationManager } from '@kit.NotificationKit';
import { common } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

const TAG = 'SuenMusic_Notifier';
const DOMAIN = 0x0000;
/** 固定通知 id：新提示覆盖旧提示，不在通知栏堆一串 */
const NOTICE_ID = 3001;

/**
 * 系统通知（通知栏）落地口。
 *
 * 用途（2026-10-23 用户裁定）：某首曲目**没有匹配到音源**时，不弹应用内弹窗，
 * 而是发一条**系统通知**明确告知，然后照常播放下一首（既有 advance 语义不变）。
 *
 * 授权：首次使用时询问一次（requestEnableNotification）；用户拒绝则**静默降级**
 * （应用内 eyebrow 提示仍在，不重复打扰）。context 由 EntryAbility.onCreate 注入。
 */
export class Notifier {
  private static ctx: common.UIAbilityContext | null = null;
  private static checked: boolean = false;
  private static allowed: boolean = false;

  /** EntryAbility.onCreate 调用一次 */
  static init(ctx: common.UIAbilityContext): void {
    Notifier.ctx = ctx;
  }

  private static async ensureAllowed(): Promise<boolean> {
    if (Notifier.checked) {
      return Notifier.allowed;
    }
    Notifier.checked = true;
    try {
      Notifier.allowed = await notificationManager.isNotificationEnabled();
    } catch (e) {
      Notifier.allowed = false;
      hilog.warn(DOMAIN, TAG, '查询通知授权失败: %{public}s', JSON.stringify(e));
    }
    if (Notifier.allowed) {
      return true;
    }
    const ctx = Notifier.ctx;
    if (ctx === null) {
      return false;
    }
    try {
      await notificationManager.requestEnableNotification(ctx);
      // 弹框走完不代表最终生效，再查一次为准
      Notifier.allowed = await notificationManager.isNotificationEnabled();
    } catch (e) {
      Notifier.allowed = false;
      hilog.warn(DOMAIN, TAG, '请求通知授权失败: %{public}s', JSON.stringify(e));
    }
    return Notifier.allowed;
  }

  /** 发一条基础文本通知（火后不管：通知是锦上添花，不能影响播放主链） */
  static notify(title: string, text: string): void {
    Notifier.send(title, text);
  }

  private static async send(title: string, text: string): Promise<void> {
    const ok = await Notifier.ensureAllowed();
    if (!ok) {
      return;
    }
    const request: notificationManager.NotificationRequest = {
      id: NOTICE_ID,
      content: {
        notificationContentType: notificationManager.ContentType.NOTIFICATION_CONTENT_BASIC_TEXT,
        normal: {
          title: title,
          text: text
        }
      }
    };
    try {
      await notificationManager.publish(request);
    } catch (e) {
      hilog.warn(DOMAIN, TAG, '发通知失败: %{public}s', JSON.stringify(e));
    }
  }
}
