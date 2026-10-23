import { common, ConfigurationConstant } from '@kit.AbilityKit';
import { preferences } from '@kit.ArkData';
import { hilog } from '@kit.PerformanceAnalysisKit';

const TAG = 'SuenMusic_Theme';
const DOMAIN = 0x0000;
const PREF_NAME = 'app_theme';
const PREF_KEY = 'theme_mode';

/** AppStorage 键：当前主题模式，供设置页/任何页面读取 */
export const K_THEME_MODE = 'theme_mode';
/** AppStorage 键：系统当前是否为深色（仅 system 模式下用来判定卡片/需要自算深浅的地方） */
export const K_SYSTEM_DARK = 'system_dark';

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
  /** 最近一次已知的系统深浅（用于变化去重，避免重复推卡片） */
  private static sysDark: boolean = false;

  /** EntryAbility.onCreate 调一次（越早越好，赶在窗口内容加载前） */
  static init(ctx: common.UIAbilityContext): void {
    Theme.appCtx = ctx.getApplicationContext();
    // 系统深浅：system 模式下要靠它决定「卡片用哪套色」这类需要自算的地方
    const cm0 = ctx.config.colorMode;
    Theme.syncSystemDark(cm0 === undefined ? ConfigurationConstant.ColorMode.COLOR_MODE_NOT_SET : cm0);
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

  /** 系统色模式 → 是否深色（各调用方自己从 context.config 取，避免 Context 类型差异） */
  static isSystemDark(cm: ConfigurationConstant.ColorMode | undefined): boolean {
    return cm === ConfigurationConstant.ColorMode.COLOR_MODE_DARK;
  }

  /** 系统深浅变化时由 EntryAbility.onConfigurationUpdate 调 */
  static syncSystemDark(colorMode: ConfigurationConstant.ColorMode): boolean {
    const dark = colorMode === ConfigurationConstant.ColorMode.COLOR_MODE_DARK;
    const changed = Theme.sysDark !== dark;
    Theme.sysDark = dark;
    AppStorage.setOrCreate<boolean>(K_SYSTEM_DARK, dark);
    return changed;
  }

  /**
   * 当前**实际生效**是不是深色（任何进程都能算）。
   * 卡片（FormExtension 独立进程，没有 AppStorage/UIAbilityContext）用 `darkFor(ctx)`；
   * 应用内（AVSessionManager 等拿不到 context 的地方）用 `darkNow()`。
   */
  static darkNow(): boolean {
    if (Theme.mode === ThemeMode.DARK) {
      return true;
    }
    if (Theme.mode === ThemeMode.LIGHT) {
      return false;
    }
    const sys = AppStorage.get<boolean>(K_SYSTEM_DARK);
    return sys === true;
  }

  /**
   * 任意 Context（含 FormExtensionContext）都能算：读 preferences 里的主题选择，
   * system 模式下用调用方传进来的「系统是否深色」（Context 类型里 config 字段各 API 不一致，
   * 统一从调用方取 `context.config.colorMode` 传进来）。
   */
  static darkFor(ctx: common.Context, systemDark: boolean): boolean {
    let mode = ThemeMode.SYSTEM;
    try {
      const p = preferences.getPreferencesSync(ctx, { name: PREF_NAME });
      mode = Theme.normalize(p.getSync(PREF_KEY, ThemeMode.SYSTEM) as string);
    } catch (e) {
      mode = ThemeMode.SYSTEM;
    }
    if (mode === ThemeMode.DARK) {
      return true;
    }
    if (mode === ThemeMode.LIGHT) {
      return false;
    }
    return systemDark;
  }

  /** 设置页选完调这里：立即生效 + 持久化 + 广播 */
  static setMode(mode: string): void {
    Theme.mode = Theme.normalize(mode);
    Theme.apply();
    AppStorage.setOrCreate<string>(K_THEME_MODE, Theme.mode);
    // 卡片深浅跟着主题走：广播一次刷新信号（NativeRoot 监听后调 AVSessionManager.refreshCard）
    const rev = AppStorage.get<number>('card_refresh');
    AppStorage.setOrCreate<number>('card_refresh', (rev === undefined ? 0 : rev) + 1);
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
