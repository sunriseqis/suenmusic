<script setup lang="ts">
/**
 * 离线缓存面板（仅安卓壳可用）。
 *
 * v1 是 L1「边播边存」：播过的歌自动落盘，断网时可直接播缓存里的曲目。
 * 容量 4GB、LRU 淘汰（见 android 侧 SuenAudioCache 的注释）。
 * 这里只做两件事：显示占用、让用户显式清空。
 */
import { onMounted, ref } from 'vue';
import NeuButton from '@/components/neu/NeuButton.vue';
import { SuenAudio, isNativeAudio } from '@/native/audio.ts';
import { useUiStore } from '@/stores/ui.ts';

const ui = useUiStore();
const usedBytes = ref(0);
const maxBytes = ref(0);
const loading = ref(false);

function fmt(bytes: number): string {
  if (bytes <= 0) return '0 MB';
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

async function refresh(): Promise<void> {
  if (!isNativeAudio) return;
  loading.value = true;
  try {
    const info = await SuenAudio.getCacheInfo();
    usedBytes.value = info.usedBytes;
    maxBytes.value = info.maxBytes;
  } catch {
    /* 原生未就绪时保持 0 */
  } finally {
    loading.value = false;
  }
}

async function clear(): Promise<void> {
  if (!isNativeAudio || loading.value) return;
  loading.value = true;
  try {
    await SuenAudio.clearCache();
    ui.ok('离线缓存已清空');
    await refresh();
  } catch {
    ui.err('清空失败，请稍后再试');
  } finally {
    loading.value = false;
  }
}

onMounted(refresh);
</script>

<template>
  <div class="cache" data-role="offline-cache">
    <p class="neu-t2 cache-line">
      已用 <strong>{{ fmt(usedBytes) }}</strong> / 上限 {{ fmt(maxBytes || 4 * 1024 ** 3) }}
    </p>
    <div class="cache-actions">
      <NeuButton variant="ghost" :loading="loading" @click="refresh">刷新</NeuButton>
      <NeuButton variant="danger" :disabled="loading || usedBytes <= 0" @click="clear">
        清空缓存
      </NeuButton>
    </div>
  </div>
</template>

<style scoped>
.cache {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.cache-line {
  margin: 0;
  font-size: var(--fs-sm);
}
.cache-actions {
  display: flex;
  gap: var(--sp-2);
  flex-wrap: wrap;
}
</style>
