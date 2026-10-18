/**
 * UI store：主题、基地址、提示条、断点。
 *
 * 这些是"跟账号无关"的界面状态，刻意与 session/player 分开 ——
 * 退出登录不该把主题和基地址一起重置掉。
 */

import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { getBaseUrl, setBaseUrl as applyBaseUrl } from '@/api/client.ts';

export type ThemeMode = 'system' | 'light' | 'dark';
export type ToastKind = 'info' | 'ok' | 'err';

const THEME_KEY = 'suenmusic.theme';
const ACCENT_KEY = 'suenmusic.accent';

/**
 * 强调色预设（2026-09-12 用户拍板：给选项而不是取色器）。
 *
 * 每个预设两套值：浅色与深色主题下"填充用"和"文字用"分别调过 ——
 * 填充色当文字用对比度不够（浅色下 3.74:1），所以 --accent / --accent-text
 * 必须分开（tokens.css 的设计前提）。取色器没法自动保证对比度，故只给预设。
 */
export interface AccentPreset {
  key: string;
  label: string;
  light: { fill: string; text: string };
  dark: { fill: string; text: string };
}

export const ACCENT_PRESETS: AccentPreset[] = [
  { key: 'orange', label: '暖橙', light: { fill: '#e0783c', text: '#a84c17' }, dark: { fill: '#ff8b4a', text: '#ff8b4a' } },
  { key: 'blue', label: '雾蓝', light: { fill: '#3b82c4', text: '#1d5c93' }, dark: { fill: '#6aa9e0', text: '#6aa9e0' } },
  { key: 'green', label: '松绿', light: { fill: '#3f9e6a', text: '#1f6b42' }, dark: { fill: '#5fc48c', text: '#5fc48c' } },
  { key: 'purple', label: '藤紫', light: { fill: '#7c5cc4', text: '#553a94' }, dark: { fill: '#a68ae0', text: '#a68ae0' } },
  { key: 'rose', label: '玫红', light: { fill: '#cf4f6a', text: '#97304a' }, dark: { fill: '#f07a92', text: '#f07a92' } },
  { key: 'cyan', label: '青碧', light: { fill: '#2f9fa6', text: '#1c6b70' }, dark: { fill: '#5fc6cc', text: '#5fc6cc' } },
];

function readAccent(): string {
  try {
    const raw = localStorage.getItem(ACCENT_KEY);
    if (raw && ACCENT_PRESETS.some(p => p.key === raw)) return raw;
  } catch {
    /* ignore */
  }
  return ACCENT_PRESETS[0]!.key;
}

export interface Toast {
  id: number;
  text: string;
  kind: ToastKind;
}

/** 从 localStorage 读初始值。隐私模式下会抛异常，静默降级 */
function readTheme(): ThemeMode {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
  } catch {
    /* ignore */
  }
  return 'system';
}

export const useUiStore = defineStore('ui', () => {
  // ---- 主题 ----
  const themeMode = ref<ThemeMode>(readTheme());
  /** 系统是否为深色。仅当 themeMode === 'system' 时起作用 */
  const systemDark = ref(
    typeof window !== 'undefined'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
      : false
  );

  /** 最终生效的主题 —— 非响应式的地方（如 <meta theme-color>）也读它 */
  const resolvedTheme = computed<'light' | 'dark'>(() =>
    themeMode.value === 'system' ? (systemDark.value ? 'dark' : 'light') : themeMode.value
  );

  // ---- 强调色 ----
  const accentKey = ref(readAccent());
  const accent = computed(
    () => ACCENT_PRESETS.find(p => p.key === accentKey.value) ?? ACCENT_PRESETS[0]!
  );

  /**
   * 把强调色写进 CSS 变量。浅/深主题取不同的值，所以主题切换后必须重跑一次
   * （inline style 会盖过 tokens.css 里的主题定义，这正是我们要的）。
   */
  function applyAccent(): void {
    /**
     * 哑光硬件只允许**一个**强调色，颜色由 tokens.css 定义。
     * 这里保留函数是为了兼容调用点，但**不再写 inline 变量** ——
     * 以前那套会在启动时把 --accent 覆盖成用户上次选的色，
     * 导致设计稿的琥珀永远不生效（真机实测：--accent 仍是 #e0783c）。
     */
    void resolvedTheme.value;
  }

  function setAccent(key: string): void {
    if (!ACCENT_PRESETS.some(p => p.key === key)) return;
    accentKey.value = key;
    try {
      localStorage.setItem(ACCENT_KEY, key);
    } catch {
      /* ignore */
    }
    applyAccent();
  }

  function applyTheme(): void {
    const isDark = resolvedTheme.value === 'dark';
    document.documentElement.dataset.theme = resolvedTheme.value;
    applyAccent();

    // 更新 <meta name="theme-color">
    let metaThemeColor = document.querySelector('meta[name="theme-color"]:not([media])');
    if (!metaThemeColor) {
      metaThemeColor = document.createElement('meta');
      metaThemeColor.setAttribute('name', 'theme-color');
      document.head.appendChild(metaThemeColor);
    }
    metaThemeColor.setAttribute('content', isDark ? '#2b313c' : '#e7ecf3');

    // 通知原生 Android 层联动系统状态栏/导航栏深浅色
    try {
      (window as any).SuenNativeTheme?.setDarkMode(isDark);
    } catch {
      /* ignore */
    }
  }

  function setTheme(mode: ThemeMode): void {
    themeMode.value = mode;
    try {
      localStorage.setItem(THEME_KEY, mode);
    } catch {
      /* ignore */
    }
    applyTheme();
  }

  /** 三种模式依次轮转，供一个按钮循环切换 */
  function cycleTheme(): ThemeMode {
    const order: ThemeMode[] = ['system', 'light', 'dark'];
    const next = order[(order.indexOf(themeMode.value) + 1) % order.length] as ThemeMode;
    setTheme(next);
    return next;
  }

  /**
   * 启动时调用一次：订阅系统主题变化。
   * 返回取消订阅函数，虽然应用生命周期内不会用到，但保留可以让测试干净退出。
   */
  function initTheme(): () => void {
    applyTheme();
    applyAccent();
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => {
      systemDark.value = e.matches;
      if (themeMode.value === 'system') applyTheme();
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }

  // ---- 基地址 ----
  const baseUrl = ref(getBaseUrl());
  /** 已登录但服务端不可达（由 App 监听 client 的事件维护） */
  const serverDown = ref(false);
  function setServerDown(v: boolean): void {
    serverDown.value = v;
  }

  function setBaseUrl(url: string): void {
    applyBaseUrl(url);
    baseUrl.value = getBaseUrl();
  }

  // ---- 断点 ----
  //
  // 768–1024px 之间按**移动壳**处理 —— 平板竖屏偏窄，移动布局更舒服（PLAN.md 四）。
  // 用 max-width: 1023px 判定"非桌面"，而不是 <768，就是为了覆盖这一段。
  const isDesktop = ref(
    typeof window !== 'undefined' ? window.matchMedia('(min-width: 1024px)').matches : true
  );

  function initBreakpoint(): () => void {
    const mq = window.matchMedia('(min-width: 1024px)');
    const onChange = (e: MediaQueryListEvent) => {
      isDesktop.value = e.matches;
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }

  // ---- 提示条 ----
  //
  // 纯文字，不使用任何 emoji 图标（项目硬性 UI 规则）。
  const toasts = ref<Toast[]>([]);
  let toastSeq = 0;

  function toast(text: string, kind: ToastKind = 'info', durationMs = 3200): number {
    const id = ++toastSeq;
    toasts.value.push({ id, text, kind });
    if (durationMs > 0) {
      setTimeout(() => dismissToast(id), durationMs);
    }
    return id;
  }

  function dismissToast(id: number): void {
    const idx = toasts.value.findIndex(t => t.id === id);
    if (idx >= 0) toasts.value.splice(idx, 1);
  }

  const ok = (text: string, ms?: number) => toast(text, 'ok', ms);
  const err = (text: string, ms?: number) => toast(text, 'err', ms);

  return {
    themeMode,
    systemDark,
    resolvedTheme,
    setTheme,
    cycleTheme,
    initTheme,
    accentKey,
    accent,
    setAccent,
    baseUrl,
    setBaseUrl,
    serverDown,
    setServerDown,
    isDesktop,
    initBreakpoint,
    toasts,
    toast,
    ok,
    err,
    dismissToast,
  };
});
