<script setup lang="ts">
/**
 * 应用更新弹窗（全局唯一，挂在 App.vue 根部）。
 *
 * 两个入口共用它：App 启动后的静默检查、设置页的「检查更新 / 立即更新」。
 * 因为关闭语义不同（启动自动弹的要记住「以后再说」的版本，用户手点的不记），
 * 判定逻辑全部放在 stores/update.ts，这里只负责呈现与交互。
 */
import { computed, onBeforeUnmount, watch } from 'vue';
import NeuButton from '@/components/neu/NeuButton.vue';
import { registerBackHandler } from '@/native/back.ts';
import { isIOS } from '@/native/update.ts';
import { useUpdateStore } from '@/stores/update.ts';

const update = useUpdateStore();

const info = computed(() => update.latest);

const sizeText = computed(() => {
  const bytes = info.value?.size ?? 0;
  if (bytes <= 0) return '';
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
});

let offBack: (() => void) | null = null;

watch(
  () => update.dialogOpen,
  open => {
    offBack?.();
    offBack = null;
    if (!open) return;
    // 后注册的优先级更高，返回键先关弹窗而不是退出应用
    offBack = registerBackHandler(() => {
      update.dismiss();
      return true;
    });
  }
);

onBeforeUnmount(() => {
  offBack?.();
  offBack = null;
});
</script>

<template>
  <Teleport to="body">
    <div v-if="update.dialogOpen && info" class="scrim" @click.self="update.dismiss()">
      <section class="dialog neu-raised-lg" role="dialog" aria-label="发现新版本">
        <header class="head">
          <h2 class="title">发现新版本</h2>
          <p class="sub neu-t2">SuenMusic {{ info.versionName }}</p>
        </header>

        <dl class="meta">
          <div class="row">
            <dt class="neu-t2">当前版本</dt>
            <dd class="neu-num">{{ update.appVersion?.versionName || '未知' }}</dd>
          </div>
          <div class="row">
            <dt class="neu-t2">最新版本</dt>
            <dd class="neu-num">{{ info.versionName }}</dd>
          </div>
          <div v-if="sizeText" class="row">
            <dt class="neu-t2">安装包大小</dt>
            <dd class="neu-num">{{ sizeText }}</dd>
          </div>
        </dl>

        <p v-if="update.error" class="note note-err" role="status">{{ update.error }}</p>
        <p v-else-if="update.installing" class="note neu-t2" role="status">
          {{ isIOS ? '正在唤起安装工具，请稍候…' : '正在下载并准备安装，请稍候…' }}
        </p>
        <!-- iOS 不在应用内安装：提前说明"会被交给重签工具"，避免跳转后无所适从 -->
        <p v-else-if="isIOS" class="note neu-t2">
          会先唤起 AltStore / SideStore 完成重装；都没有则用浏览器打开安装包。
        </p>

        <div class="actions">
          <NeuButton :disabled="update.installing" @click="update.dismiss()">以后再说</NeuButton>
          <NeuButton variant="primary" :loading="update.installing" @click="update.install()">
            立即更新
          </NeuButton>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.scrim {
  position: fixed;
  inset: 0;
  z-index: calc(var(--z-overlay) + 10);
  background: var(--scrim);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--sp-5);
}

.dialog {
  width: min(100%, 420px);
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
  padding: var(--sp-5);
  border-radius: var(--r-lg);
}

.head {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.title {
  margin: 0;
  font-size: var(--fs-lg);
  font-weight: var(--fw-bold);
  color: var(--t1);
}
.sub {
  margin: 0;
  font-size: var(--fs-sm);
}

.meta {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--sp-3);
}
.row dt {
  margin: 0;
  font-size: var(--fs-sm);
}
.row dd {
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--t1);
}

.note {
  margin: 0;
  font-size: var(--fs-sm);
  text-align: center;
}
.note-err {
  color: var(--danger, #cf4f6a);
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-3);
}
</style>
