/**
 * 原生音频插件的类型化包装（安卓 Capacitor 桥）。
 *
 * 仅在原生平台可用：`isNativeAudio` 由 `Capacitor.isNativePlatform()` 决定，
 * 浏览器端恒为 false —— player store 据此选择原生音频桥或 HTMLAudioElement。
 */
import { Capacitor, registerPlugin } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';

export const isNativeAudio = Capacitor.isNativePlatform();

const BLUETOOTH_LYRICS_KEY = 'suenmusic.bluetoothLyrics';

export function isBluetoothLyricsEnabled(): boolean {
  try {
    return localStorage.getItem(BLUETOOTH_LYRICS_KEY) === '1';
  } catch {
    return false;
  }
}

export function setBluetoothLyricsEnabled(enabled: boolean): void {
  try {
    if (enabled) localStorage.setItem(BLUETOOTH_LYRICS_KEY, '1');
    else localStorage.removeItem(BLUETOOTH_LYRICS_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * 鸿蒙端「系统歌词」开关：是否把歌词推给系统播控中心 / 锁屏。
 *
 * 与蓝牙歌词那条相反，这里**默认开** —— 锁屏显示歌词是这个端的既有能力，
 * 开关的用途是"屏幕上有歌词嫌乱时把它关掉"，而不是一个要用户主动发现的
 * 车机功能。所以存的是"关闭标记"（'0'），缺省即开。
 */
const HARMONY_LYRICS_KEY = 'suenmusic.harmonyLyrics';

export function isHarmonyLyricsEnabled(): boolean {
  try {
    return localStorage.getItem(HARMONY_LYRICS_KEY) !== '0';
  } catch {
    return true;
  }
}

export function setHarmonyLyricsEnabled(enabled: boolean): void {
  try {
    if (enabled) localStorage.removeItem(HARMONY_LYRICS_KEY);
    else localStorage.setItem(HARMONY_LYRICS_KEY, '0');
  } catch {
    /* ignore */
  }
}

export interface NativeLyricLine {
  startMs: number;
  text: string;
}

export interface NativeTrack {
  id: string;
  title: string;
  artist: string;
  album?: string;
  coverUrl?: string;
  durationMs?: number;
}

export interface NativeQueue {
  baseUrl: string;
  token: string;
  items: NativeTrack[];
  startIndex: number;
  /** 新队列的起播位置（毫秒）：打乱/换路径重发时不打断当前播放位置 */
  startPositionMs?: number;
  /**
   * 装载后是否立刻出声，默认 true。
   *
   * 恢复上次会话时传 false —— **就位但不出声**：打开 App 立刻自己响起来很唐突，
   * 出声只该由用户按播放（或 `play()`）触发。
   */
  autoplay?: boolean;
  /**
   * 只替换 `[startIndex, 队尾)` 这一段（`items` 也只含这一段）。
   *
   * 切播放模式重排"未播部分"时用：正在播的那首不在替换范围内，原生不会重新
   * 装载它 —— 否则每次切模式都要重新缓冲，用户听到"卡一下"。
   */
  tailOnly?: boolean;
}

export interface NativeProgress {
  index: number;
  positionMs: number;
  durationMs: number;
  playing: boolean;
}

export interface NativeTrackChange {
  index: number;
  id: string | null;
  /** Player.MEDIA_ITEM_TRANSITION_REASON：1=AUTO（自动接续）2=SEEK 3=PLAYLIST_CHANGED */
  reason: number;
}

export interface SuenAudioPlugin {
  setQueue(o: NativeQueue): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  seek(o: { positionMs: number }): Promise<void>;
  seekToIndex(o: { index: number; autoplay?: boolean; force?: boolean }): Promise<void>;
  /**
   * 硬重载条目：换音源（锚定/重解析）后**必须走这里**。
   *
   * 与 seekToIndex 的区别是它会 `stop()` 回 IDLE 丢掉内存缓冲、并重建媒体项
   * （重设 URI 与磁盘缓存键），否则播放器会继续放旧音源的缓冲 ——
   * 表现就是"换了源但时长和内容都没变"。
   */
  reloadCurrent(o: { index?: number; positionMs?: number; autoplay?: boolean }): Promise<void>;
  /** 播放模式：让原生队列自己接续时也遵守单曲/列表循环 */
  setRepeatMode(o: { mode: 'off' | 'one' | 'all' }): Promise<void>;
  /** 整首歌词时间轴；原生按 Media3 实际播放位置驱动车机歌词。 */
  setLyricTimeline(o: { trackId: string; revision: number; lines: NativeLyricLine[] }): Promise<void>;
  /** 兼容旧调试路径：推送单行歌词。 */
  setLyricLine(o: { text: string }): Promise<void>;
  /** 请求 Android 13+ 通知权限。 */
  requestNotificationPermission(): Promise<void>;
  getStatus(): Promise<{
    index: number;
    positionMs: number;
    durationMs: number;
    playing: boolean;
    queueLength: number;
  }>;
  stop(o?: { positionMs: number }): Promise<void>;
  /** 离线缓存信息（已用/上限字节） */
  getCacheInfo(): Promise<{ usedBytes: number; maxBytes: number }>;
  /** 这首曲子是否完整在离线缓存里（断网播放判定用） */
  isCached(o: { id: string }): Promise<{ cached: boolean }>;
  /**
   * 封面本地缓存：远程 URL → 可直接给 `<img src>` 的本地文件 URL。
   * 离线时用它避免裂图（WebView 不保证从自己的磁盘缓存取图）。
   */
  cacheImages(o: { urls: string[] }): Promise<Record<string, string>>;
  /** 清空离线缓存（用户显式触发） */
  clearCache(): Promise<void>;
  /**
   * 清掉**单首**曲目的离线缓存。
   *
   * 用途：重新锚定音源后，缓存里旧音源的字节会盖住新音源（缓存键是曲目 id），
   * 必须先驱逐这一首，新音源才真正生效。
   */
  evictCache(o: { id: string }): Promise<void>;
  addListener(
    eventName: 'progress',
    cb: (d: NativeProgress) => void
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'trackChange',
    cb: (d: NativeTrackChange) => void
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'state',
    cb: (d: { playing: boolean }) => void
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'error',
    cb: (d: { message: string }) => void
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'networkChanged',
    cb: (d: { type?: string }) => void
  ): Promise<PluginListenerHandle>;
}

export const SuenAudio = registerPlugin<SuenAudioPlugin>('SuenAudio');
