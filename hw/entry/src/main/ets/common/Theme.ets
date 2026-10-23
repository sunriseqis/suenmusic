import { common, ConfigurationConstant } from '@kit.AbilityKit';
import { preferences } from '@kit.ArkData';
import { hilog } from '@kit.PerformanceAnalysisKit';

const TAG = 'SuenMusic_Theme';
const DOMAIN = 0x0000;
const PREF_NAME = 'app_theme';
const PREF_KEY = 'theme_mode';

/** AppStorage 键：当前主题模式，供设置页/任何页面读取 */
export const K_THEME_MODE = 'theme_mode';

/** 三态（对齐 web `stores/ui.ts`：system / light / dark，顺序也一致） */
export class ThemeMode {
  static readonly SYSTEM: string = 'system';
  static readonly LIGHT: string = 'light';
  static readonly DARK: string = 'dark';
}

/** 设置页分段控件的标签顺序（web THEME_TABS 同序） */
export const THEME_LABELS: string[] = ['跟随系统', '浅色', '深色'];
/** 与 THEME_LABELS 一一对应的模式值 */
export const THEME_VALUES: string[] = [ThemeMode.SYSTEM, ThemeMode.LIGHT, ThemeMode.DARK];

/**
 * 主题（T12 阶段 2）。
 *
 * 颜色本身由资源目录决定（`resources/base` = 浅色、`resources/dark` = 深色，见 T12 阶段 1），
 * 本类只负责**告诉系统该用哪一套**：`ApplicationContext.setColorMode`。
 *   · system → COLOR_MODE_NOT_SET（跟随系统）
 *   · light  → COLOR_MODE_LIGHT
 *   · dark   → COLOR_MODE_DARK
 * 选择持久化在 preferences，冷启动第一时间应用，避免先闪一次系统主题。
 */
export class Theme {
  private static appCtx: common.ApplicationContext | null = null;
  private static prefs: preferences.Preferences | null = null;
  private static mode: string = ThemeMode.SYSTEM;

  /** EntryAbility.onCreate 调一次（越早越好，赶在窗口内容加载前） */
  static init(ctx: common.UIAbilityContext): void {
    Theme.appCtx = ctx.getApplicationContext();
    try {
      Theme.prefs = preferences.getPreferencesSync(ctx, { name: PREF_NAME });
      const raw = Theme.prefs.getSync(PREF_KEY, ThemeMode.SYSTEM) as string;
      Theme.mode = Theme.normalize(raw);
    } catch (e) {
      Theme.mode = ThemeMode.SYSTEM;
      hilog.warn(DOMAIN, TAG, '读取主题偏好失败: %{public}s', JSON.stringify(e));
    }
    Theme.apply();
    AppStorage.setOrCreate<string>(K_THEME_MODE, Theme.mode);
  }

  static current(): string {
    return Theme.mode;
  }

  /** 设置页选完调这里：立即生效 + 持久化 + 广播 */
  static setMode(mode: string): void {
    Theme.mode = Theme.normalize(mode);
    Theme.apply();
    AppStorage.setOrCreate<string>(K_THEME_MODE, Theme.mode);
    try {
      const p = Theme.prefs;
      if (p !== null) {
        p.putSync(PREF_KEY, Theme.mode);
        p.flush();
      }
    } catch (e) {
      hilog.warn(DOMAIN, TAG, '持久化主题失败: %{public}s', JSON.stringify(e));
    }
  }

  private static normalize(raw: string): string {
    if (raw === ThemeMode.LIGHT || raw === ThemeMode.DARK || raw === ThemeMode.SYSTEM) {
      return raw;
    }
    return ThemeMode.SYSTEM;
  }

  private static apply(): void {
    const ctx = Theme.appCtx;
    if (ctx === null) {
      return;
    }
    let cm: ConfigurationConstant.ColorMode = ConfigurationConstant.ColorMode.COLOR_MODE_NOT_SET;
    if (Theme.mode === ThemeMode.DARK) {
      cm = ConfigurationConstant.ColorMode.COLOR_MODE_DARK;
    } else if (Theme.mode === ThemeMode.LIGHT) {
      cm = ConfigurationConstant.ColorMode.COLOR_MODE_LIGHT;
    }
    try {
      ctx.setColorMode(cm);
      hilog.info(DOMAIN, TAG, '主题模式=%{public}s', Theme.mode);
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'setColorMode 失败: %{public}s', JSON.stringify(e));
    }
  }
}
