/**
 * 酷狗源被 20028 风控拦下时的**端侧落地口**。
 *
 * 服务端解析失败会带 reason = 'need_verification' 与一个**相对路径** verifyUrl
 * （/verify/kugou?t=<token>）。端侧只做三件事，不碰播放主流程：
 *   1. 命中这个 reason → 发一条系统通知（Notifier.notifyAction）；
 *   2. 点通知 → App 被拉到前台 → context.startAbility 用**系统浏览器**打开
 *      「当前生效的服务端地址 + verifyUrl」（openInBrowser）；
 *   3. 节流：同一 eventId 只提示一次，另外 10 分钟内最多一次
 *      （否则连播时每首歌的解析都会撞同一次风控，通知栏会被刷屏）。
 *
 * 通知发不出去（用户关了通知权限 / WantAgent 构建失败）时退化为 AppToast ——
 * 这是用户必须动手才能恢复的状态，不能静默吞掉。
 */

import { common, Want } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { ResolveResponse } from './Models';
import { APIClient } from './APIClient';
import { Notifier } from '../common/Notifier';
import { AppToast } from '../common/AppToast';

const TAG = 'SuenMusic_KugouVerify';
const DOMAIN = 0x0000;
/** 与契约一致：只有这个 reason 才走本模块 */
const REASON_NEED_VERIFICATION = 'need_verification';
/** 10 分钟窗口：同一事件之外，也压住「短时间连续不同事件」的刷屏 */
const THROTTLE_MS = 10 * 60 * 1000;
const TITLE = '酷狗账号需要验证';
const TEXT = '点击前往浏览器完成验证';
/** 系统浏览器（用户规格指定：华为浏览器）；找不到时退回「任意可看网址的应用」 */
const BROWSER_BUNDLE = 'com.huawei.hmos.browser';
const ACTION_VIEW_DATA = 'ohos.want.action.viewData';
const ENTITY_BROWSABLE = 'entity.system.browsable';

/** 上次提示的事件 id（空 = 没提示过） */
let lastEventId: string = '';
/** 上次提示的时间戳（ms；0 = 没提示过） */
let lastPromptAt: number = 0;

export class KugouVerify {
  /**
   * 解析结果的唯一消费入口（refreshSourceLabel / resolveDirect 各调一次）。
   * 非该 reason 立刻返回，等于给主流程挂了个 0 成本判断。
   */
  static consume(r: ResolveResponse): void {
    if (r.reason !== REASON_NEED_VERIFICATION) {
      return;
    }
    const rel = r.verifyUrl === undefined ? '' : r.verifyUrl.trim();
    if (rel.length === 0) {
      hilog.warn(DOMAIN, TAG, '需要验证但服务端没给 verifyUrl，跳过提示');
      return;
    }
    const url = KugouVerify.absoluteUrl(rel);
    if (url.length === 0) {
      hilog.warn(DOMAIN, TAG, '当前没有生效的服务端地址，无法拼出验证链接');
      return;
    }
    const eventId = r.eventId === undefined ? '' : r.eventId;
    if (!KugouVerify.shouldPrompt(eventId)) {
      return;
    }
    hilog.info(DOMAIN, TAG, '酷狗需要验证，提示用户前往浏览器（event=%{public}s）', eventId);
    KugouVerify.prompt(url);
  }

  /**
   * 用**系统浏览器**打开 url —— 唯一的打开方式（通知点击后由 EntryAbility 转进来）。
   *
   * 两次尝试：① 锁死华为浏览器 bundleName，不让系统弹选择器；② 该包不在（卸载/别家 ROM）
   * 就退回「action=viewData + entity=browsable」的隐式跳转，由系统选一个能看网址的应用。
   * 两次都失败才提示用户自己复制地址，绝不静默。
   */
  static openInBrowser(ctx: common.UIAbilityContext, url: string): void {
    const explicit: Want = {
      bundleName: BROWSER_BUNDLE,
      action: ACTION_VIEW_DATA,
      entities: [ENTITY_BROWSABLE],
      uri: url
    };
    ctx.startAbility(explicit)
      .catch((): Promise<void> => {
        hilog.warn(DOMAIN, TAG, '指定浏览器拉不起来，退回隐式浏览意图');
        const fallback: Want = {
          action: ACTION_VIEW_DATA,
          entities: [ENTITY_BROWSABLE],
          uri: url
        };
        return ctx.startAbility(fallback);
      })
      .catch((e: BusinessError): void => {
        hilog.warn(DOMAIN, TAG, '打开浏览器失败: %{public}s', JSON.stringify(e));
        AppToast.show('没找到可用的浏览器，请手动访问 ' + url);
      });
  }

  /**
   * 拼绝对地址：baseUrl 用 APIClient 里**当前生效**的那个（不写死、不缓存）。
   * 首尾斜杠都归一（http://h:1/ + /verify/x → http://h:1/verify/x）。
   */
  static absoluteUrl(relative: string): string {
    const raw = relative.trim();
    // 服务端哪天给了绝对地址就直接用，不再重复拼
    if (raw.indexOf('://') > 0) {
      return raw;
    }
    const base = APIClient.shared().getBaseUrl().trim();
    if (base.length === 0) {
      return '';
    }
    let origin = base;
    while (origin.length > 0 && origin.endsWith('/')) {
      origin = origin.slice(0, origin.length - 1);
    }
    let path = raw;
    while (path.startsWith('/')) {
      path = path.slice(1);
    }
    if (origin.length === 0 || path.length === 0) {
      return '';
    }
    return origin + '/' + path;
  }

  /**
   * 节流判定（**带副作用**：通过即记账）。
   * 同一 eventId 重复解析只提示一次；不同 eventId 也要隔 10 分钟。
   */
  private static shouldPrompt(eventId: string): boolean {
    const now = Date.now();
    if (eventId.length > 0 && eventId === lastEventId) {
      return false;
    }
    if (lastPromptAt > 0 && now - lastPromptAt < THROTTLE_MS) {
      return false;
    }
    lastEventId = eventId;
    lastPromptAt = now;
    return true;
  }

  /** 先系统通知；发不出去（未授权）再退应用内轻提示，绝不静默 */
  private static prompt(url: string): void {
    Notifier.notifyAction(TITLE, TEXT, url)
      .then((sent: boolean): void => {
        if (!sent) {
          AppToast.show('酷狗账号需要验证，请用浏览器打开 ' + url);
        }
      })
      .catch((e: Object): void => {
        hilog.warn(DOMAIN, TAG, '提示失败: %{public}s', JSON.stringify(e));
        AppToast.show('酷狗账号需要验证，请用浏览器打开 ' + url);
      });
  }
}
