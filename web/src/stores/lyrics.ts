import { computed, ref, watch } from 'vue';
import { defineStore } from 'pinia';
import { fetchLyrics } from '@/api/catalog.ts';
import { parseLyrics, activeLineIndex } from '@/utils/lyric.ts';
import { artistNames, coverUrl } from '@/utils/format.ts';
import { usePlayerStore } from '@/stores/player.ts';
import {
  SuenAudio,
  isNativeAudio,
  isBluetoothLyricsEnabled,
  isHarmonyLyricsEnabled,
  type NativeLyricLine,
} from '@/native/audio.ts';
import { isIOS } from '@/native/update.ts';
import type { LyricLine } from '@/utils/lyric.ts';

/**
 * 推给鸿蒙原生的歌词消息。
 *
 * **它带着完整元数据**（不只是歌词）：原生侧「元数据」与「歌词」两条路互相
 * 独立，任何一条先到都能把播控中心建立起来。历史上原生只认元数据那条 ——
 * 那条一旦没到，整个控件就消失了；歌词消息带全量信息是给这件事兜底。
 */
interface HarmonyLyricPayload {
  assetId: string;
  title: string;
  artist: string;
  album: string;
  coverUrl: string;
  durationMs: number;
  lyric: string;
}

export const useLyricsStore = defineStore('lyrics', () => {
  const player = usePlayerStore();
  const lines = ref<LyricLine[]>([]);
  const rawLrc = ref('');
  const loading = ref(false);
  const failed = ref(false);
  const loadedForId = ref('');
  let abort: AbortController | null = null;
  let revision = 0;
  let initialized = false;

  const currentId = computed(() => player.currentTrack?.id ?? null);
  const activeIdx = computed(() => {
    const id = currentId.value;
    const current = lines.value;
    if (!id || loadedForId.value !== id || current.length === 0) return -1;
    return activeLineIndex(current, player.positionMs);
  });

  /**
   * 组装鸿蒙歌词消息。只有"当前正在播的这首"的元数据才可信，
   * 不匹配时只发 id 与歌词（让原生侧别拿错曲目的信息）。
   */
  function harmonyPayload(assetId: string, lyric: string): HarmonyLyricPayload {
    const t = player.currentTrack;
    const same = !!t && assetId !== '' && t.id === assetId;
    return {
      assetId,
      title: same && t ? t.name || '' : '',
      artist: same && t ? artistNames(t.ar) : '',
      album: same && t ? t.al?.name || '' : '',
      coverUrl: same && t ? coverUrl(t.al?.picUrl, 500) : '',
      durationMs: same && t ? t.dt || 0 : 0,
      lyric,
    };
  }

  /**
   * 把歌词推给鸿蒙原生（系统播控中心 / 锁屏显示）。
   *
   * `force` 专供"关掉开关时把已经显示出去的歌词收回来" —— 那种调用必须绕过
   * 开关判断本身，否则一关开关，屏幕上的歌词就再也清不掉了。
   */
  function syncHarmonyLyric(assetId: string, lyric: string, force = false): void {
    if (!force && !isHarmonyLyricsEnabled()) return;
    if (typeof window !== 'undefined' && window.SuenHarmony?.updateLyric) {
      try {
        window.SuenHarmony.updateLyric(JSON.stringify(harmonyPayload(assetId, lyric)));
      } catch {
        /* ignore */
      }
    }
  }

  async function sendTimeline(trackId: string, lyricLines: LyricLine[]): Promise<void> {
    // iOS 的 Widget 需要歌词时间轴，无论蓝牙歌词开关如何；
    // Android 仍只在蓝牙歌词开启时推送，避免无谓的桥调用。
    if (!isNativeAudio || (!isBluetoothLyricsEnabled() && !isIOS)) return;
    const payload: NativeLyricLine[] = lyricLines
      .map(line => ({ startMs: Math.max(0, Math.round(line.time)), text: line.text.trim() }))
      .filter(line => line.text.length > 0);
    await SuenAudio.setLyricTimeline({ trackId, revision: ++revision, lines: payload }).catch(() => {});
  }

  async function clearNative(trackId = '', force = false): Promise<void> {
    if (!trackId || !isNativeAudio || (!force && !isBluetoothLyricsEnabled())) return;
    await SuenAudio.setLyricTimeline({ trackId, revision: ++revision, lines: [] }).catch(() => {});
  }

  async function loadForCurrent(): Promise<void> {
    const id = currentId.value;
    abort?.abort();
    if (!id) {
      lines.value = [];
      rawLrc.value = '';
      loadedForId.value = '';
      failed.value = false;
      await clearNative();
      syncHarmonyLyric('', '');
      return;
    }

    await clearNative(id);
    syncHarmonyLyric(id, '');
    const controller = new AbortController();
    abort = controller;
    loading.value = true;
    failed.value = false;
    lines.value = [];
    rawLrc.value = '';
    loadedForId.value = '';
    try {
      const res = await fetchLyrics(id, controller.signal);
      if (controller.signal.aborted || currentId.value !== id) return;
      const lrcText = res.lrc?.lyric || '';
      rawLrc.value = lrcText;
      const parsed = parseLyrics(lrcText, res.tlyric?.lyric);
      lines.value = parsed.lines;
      loadedForId.value = id;
      await sendTimeline(id, parsed.lines);
      syncHarmonyLyric(id, lrcText);
    } catch {
      if (controller.signal.aborted) return;
      failed.value = true;
      await clearNative(id);
      syncHarmonyLyric(id, '');
    } finally {
      if (!controller.signal.aborted) loading.value = false;
    }
  }

  function init(): void {
    if (initialized) return;
    initialized = true;
    watch(currentId, () => void loadForCurrent(), { immediate: true });
  }

  function refresh(): void {
    if (initialized) void loadForCurrent();
  }

  function setEnabled(enabled: boolean): void {
    if (!enabled) {
      void clearNative(currentId.value ?? '', true);
      // 鸿蒙这条链路没有"原生时间轴"可撤，但它已经把歌词推给系统 UI 了，
      // 必须显式收回 —— 否则关了开关锁屏上还挂着歌词。force 绕过开关本身。
      syncHarmonyLyric(currentId.value ?? '', '', true);
    } else {
      refresh();
    }
  }

  return {
    lines,
    rawLrc,
    loading,
    failed,
    currentId,
    activeIdx,
    init,
    refresh,
    setEnabled,
  };
});
