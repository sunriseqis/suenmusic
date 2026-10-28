import { notificationManager } from '@kit.NotificationKit';
import { common, Want, wantAgent } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

const TAG = 'SuenMusic_Notifier';
const DOMAIN = 0x0000;
/** 固定通知 id：新提示覆盖旧提示，不在通知栏堆一串 */
const NOTICE_ID = 3001;
/** 带跳转的通知单独占一个 id：否则会跟上面的「无音源」提示互相覆盖 */
const ACTION_NOTICE_ID = 3002;
/**
 * 通知点击要带上待打开的地址：放在 want.uri（不是 parameters 里的键，少一层键名常量）。
 * App 被拉到前台后由 EntryAbility 从 onCreate/onNewWant 的 uri 取它，
 * 再用 context.startAbility 拉系统浏览器 —— 见 core/KugouVerify.ets。
 */

/**
 * 系统通知（通知栏）落地口。
 *
 * 用途（2026-10-23 用户裁定）：某首曲目**没有匹配到音源**时，不弹应用内弹窗，
 * 而是发一条**系统通知**明确告知，然后照常播放下一首（既有 advance 语义不变）。
 *
 * 第二个用途（酷狗 20028 风控）：解析结果 reason='need_verification' 时发一条
 * **点得动**的通知 —— 点通知由系统用浏览器打开服务端下发的验证页
 * （拼址与节流见 core/KugouVerify.ets）。这类通知带 WantAgent，与纯文本通知分 id。
 *
 * 授权：首次使用时询问一次（requestEnableNotification）；用户拒绝则**静默降级**
 * （应用内 eyebrow 提示仍在，不重复打扰）。context 由 EntryAbility.onCreate 注入。
 * 但「需要验证」是用户必须动手才能恢复的状态：调用方拿到 send() 的 false 后会改用
 * AppToast 提示，不静默吞掉。
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
    Notifier.send(title, text).catch((e: Object) => {
      hilog.warn(DOMAIN, TAG, '发通知失败: %{public}s', JSON.stringify(e));
    });
  }

  /**
   * 发一条**点得动**的通知：点击 → 系统浏览器打开 url。
   *
   * 选型（带 wantAgent 的通知，而不是「通知里写字 + 播放页给入口」那种退化方案）：
   * 用户此刻多半停在通知栏或桌面，退化方案要先回到 App 再自己找入口，等于多两步。
   * wantAgent 指向**本应用 EntryAbility**（want.parameters 带待打开的 url），App 被
   * 拉到前台后由 EntryAbility 用 context.startAbility 拉系统浏览器：
   *   · 不在通知里直接指向浏览器，是因为 startAbility 需要「应用在前台」，而我们自己
   *     被通知拉起时正好在前台，这条路径不受后台启动限制；
   *   · 也让「指定浏览器不存在」时还有一次退回「任意可浏览应用」的机会（见 KugouVerify）。
   *
   * @returns true = 已发布；false = 未授权 / 构建失败，调用方自行降级提示
   */
  static async notifyAction(title: string, text: string, url: string): Promise<boolean> {
    return Notifier.send(title, text, url);
  }

  private static async send(title: string, text: string, url: string = ''): Promise<boolean> {
    const ok = await Notifier.ensureAllowed();
    if (!ok) {
      return false;
    }
    const request: notificationManager.NotificationRequest = {
      id: url.length > 0 ? ACTION_NOTICE_ID : NOTICE_ID,
      content: {
        notificationContentType: notificationManager.ContentType.NOTIFICATION_CONTENT_BASIC_TEXT,
        normal: {
          title: title,
          text: text
        }
      }
    };
    if (url.length > 0) {
      const agent = await Notifier.buildAgent(url);
      if (agent !== undefined) {
        request.wantAgent = agent;
      }
    }
    try {
      await notificationManager.publish(request);
      return true;
    } catch (e) {
      hilog.warn(DOMAIN, TAG, '发通知失败: %{public}s', JSON.stringify(e));
      return false;
    }
  }

  /**
   * 构建「点通知 → 拉起本应用并带上 url」的 WantAgent。
   * 拿不到自己的 bundleName/abilityName（ctx 未注入）时返回 undefined，通知退化为纯文本。
   *
   * ⚠️ 返回类型**故意留空**：`@kit.AbilityKit` 的 wantAgent 命名空间没有导出
   * `WantAgent` 这个名字（只有 getWantAgent，见 common/AVSessionManager.ets 同款踩坑），
   * 写 `Promise<WantAgent | null>` 会报 'has no exported member named WantAgent'。
   * 交给类型推断 —— getWantAgent() 的返回类型恰好就是 NotificationRequest.wantAgent 的类型。
   * 字段名同样跟 AVSessionManager 走 `actionType` / `actionFlags`（本 SDK 上验证可用）。
   */
  private static async buildAgent(url: string) {
    const ctx = Notifier.ctx;
    const bundleName = ctx === null ? '' : (ctx.abilityInfo?.bundleName ?? '');
    const abilityName = ctx === null ? '' : (ctx.abilityInfo?.name ?? '');
    if (bundleName.length === 0 || abilityName.length === 0) {
      hilog.warn(DOMAIN, TAG, '缺少自身 bundleName/abilityName，无法构建跳转 WantAgent');
      return undefined;
    }
    const viewWant: Want = {
      bundleName: bundleName,
      abilityName: abilityName,
      uri: url
    };
    const info: wantAgent.WantAgentInfo = {
      wants: [viewWant],
      actionType: wantAgent.OperationType.START_ABILITY,
      requestCode: ACTION_NOTICE_ID,
      actionFlags: [wantAgent.WantAgentFlags.UPDATE_PRESENT_FLAG]
    };
    try {
      return await wantAgent.getWantAgent(info);
    } catch (e) {
      hilog.warn(DOMAIN, TAG, '构建 WantAgent 失败: %{public}s', JSON.stringify(e));
      return undefined;
    }
  }
}
