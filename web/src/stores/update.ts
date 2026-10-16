/**
 * 应用更新 store（原生端：安卓 + iOS）。
 *
 * 从 Settings.vue 里抽出来，因为触发时机有两个、且不在同一个组件里：
 *   1. App 启动后（App.vue）静默查一次 —— 没更新不吭声，有更新才弹窗；
 *   2. 设置页「检查更新」按钮 —— 没更新也要给明确反馈。
 * 两处必须共用同一份状态，否则卡片上的版本信息会和弹窗对不上。
 *
 * 两端的**安装形态**不同，分叉点只有 `install()`：
 *   - 安卓：应用内下载 APK → 拉起系统安装界面
 *   - iOS：应用内装不了自己，只能把 IPA 地址交给应用外部（重签工具 / Safari）
 */

import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { getAccessToken, resolveUrl } from '@/api/client.ts';
import * as updateApi from '@/api/update.ts';
import { isIOS, isNativeUpdate, SuenUpdate } from '@/native/update.ts';

/** 被「以后再说」过的版本号。同一版本不再自动弹；出了新版会重新提醒。 */
const SKIPPED_KEY = 'suenmusic.update.skippedVersion';

function readSkipped(): string {
  try {
    return localStorage.getItem(SKIPPED_KEY) ?? '';
  } catch {
    return '';
  }
}

function writeSkipped(version: string): void {
  try {
    localStorage.setItem(SKIPPED_KEY, version);
  } catch {
    /* 隐私模式写不进去：退化成每次启动都提醒，不影响功能 */
  }
}

export const useUpdateStore = defineStore('update', () => {
  const appVersion = ref<{ versionName: string; versionCode: number } | null>(null);
  const result = ref<updateApi.UpdateCheckResult | null>(null);
  const checking = ref(false);
  const installing = ref(false);
  const dialogOpen = ref(false);
  /** 当前弹窗是启动时自动弹的（而不是用户手点的）—— 关掉时要记进已忽略版本 */
  const autoPrompt = ref(false);
  /** 弹窗内的错误（下载失败等）；卡片上的状态另用 message */
  const error = ref('');
  /** 设置页卡片上的状态文字 */
  const message = ref('');

  const available = computed(() => result.value?.available === true);
  const latest = computed(() => result.value?.latest ?? null);

  /**
   * 查一次更新。
   * @param silent 启动时的静默检查：没更新不吭声、出错也不打扰；被忽略过的同一版本也不再弹。
   */
  async function check(silent = false): Promise<void> {
    if (!isNativeUpdate || checking.value) return;
    checking.value = true;
    error.value = '';
    if (!silent) message.value = '';
    try {
      appVersion.value = await SuenUpdate.getAppVersion();
      // 手点「检查更新」必须跳服务端那 5 分钟元数据缓存：刚上传的新包否则会被旧缓存挡住，
      // 表现为「明明放了新版却提示已是最新」。启动静默检查仍用缓存（挡上游压力）。
      // 平台必须随请求带上：服务端按它挑 APK 还是 IPA（各有各的缓存与目录）。
      const checked = await updateApi.checkUpdate(appVersion.value, {
        force: !silent,
        platform: isIOS ? 'ios' : 'android',
      });
      result.value = checked;
      if (!checked.available) {
        // 启动静默：什么都不说；手动点击：明确告诉用户已是最新
        if (!silent) message.value = '当前已是最新版本';
        return;
      }
      message.value = `发现新版本 ${checked.latest.versionName}`;
      // 启动自动提醒：同一版本只弹一次，避免用户说过「以后再说」还每次开机被骚扰
      if (silent && readSkipped() === checked.latest.versionName) return;
      autoPrompt.value = silent;
      dialogOpen.value = true;
    } catch (e) {
      // 启动静默检查失败不弹任何东西：离线开机、还没选好路都很常见
      if (silent) return;
      message.value = e instanceof Error ? e.message : '检查更新失败，请稍后重试';
    } finally {
      checking.value = false;
    }
  }

  /** 关掉弹窗。启动自动弹的那次记下版本，下次开机不再为同一版本弹。 */
  function dismiss(): void {
    if (installing.value) return;
    dialogOpen.value = false;
    error.value = '';
    if (autoPrompt.value && latest.value) writeSkipped(latest.value.versionName);
    autoPrompt.value = false;
  }

  /** 从卡片上的「立即更新」再打开弹窗 —— 用户主动点的，不记入已忽略 */
  function open(): void {
    if (!available.value) return;
    autoPrompt.value = false;
    error.value = '';
    dialogOpen.value = true;
  }

  /**
   * 拉起安装流程。弹窗本身就是那次确认，这里不再二次确认。
   *
   * 带令牌的下载地址两端共用一个：地址里已经含 `?token=`，所以外部工具／Safari
   * 即使发不出请求头也能拉到包（见 server 的 utils/update-token.ts）。
   */
  async function install(): Promise<void> {
    const info = latest.value;
    const current = appVersion.value;
    const checked = result.value;
    if (!isNativeUpdate || !available.value || !info || !current || !checked || installing.value) return;

    installing.value = true;
    error.value = '';
    try {
      const target = isIOS ? 'ios' : 'android';
      const url = resolveUrl(
        `${checked.downloadPath}?platform=${target}&token=${encodeURIComponent(checked.downloadToken)}`
      );

      if (isIOS) {
        // iOS 装不了自己：把地址交给重签工具（优先）/ Safari，安装动作在应用外完成。
        // `external` 不是失败 —— 免费签名下这是唯一可行的路径。
        const opened = await SuenUpdate.openUpdate({ url });
        dialogOpen.value = false;
        autoPrompt.value = false;
        message.value =
          opened.status === 'opened'
            ? '已唤起安装工具，请按提示完成重装'
            : '已在浏览器打开安装包，请用重签工具（AltStore / SideStore）安装';
        return;
      }

      const token = getAccessToken();
      if (!token) {
        error.value = '登录状态已失效，请重新登录后再更新';
        return;
      }
      const opened = await SuenUpdate.downloadAndInstall({
        url,
        accessToken: token,
        fileName: info.fileName,
        expectedVersionName: info.versionName,
        expectedVersionCode: info.versionCode || undefined,
        expectedSha256: info.sha256 || undefined,
      });
      dialogOpen.value = false;
      autoPrompt.value = false;
      message.value =
        opened.status === 'install_permission_required'
          ? '请允许本应用安装未知来源应用，然后再次点击更新'
          : '已打开系统安装界面，请按提示完成安装';
    } catch (e) {
      // 留在弹窗里显示，用户可以原地重试
      error.value = e instanceof Error ? e.message : '更新失败，请稍后重试';
    } finally {
      installing.value = false;
    }
  }

  return {
    appVersion,
    result,
    checking,
    installing,
    dialogOpen,
    error,
    message,
    available,
    latest,
    check,
    dismiss,
    open,
    install,
  };
});
