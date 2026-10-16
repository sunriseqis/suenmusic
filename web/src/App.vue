<script setup lang="ts">
/**
 * 应用根组件：只负责三件事 —— 选壳、兜住公开页、挂提示条。
 *
 * 公开页（登录）**不套壳**：软拟物的登录页要占据整屏中央，
 * 套上侧边栏与底部导航会让它看起来像一个"内容页"，很怪。
 */
import { computed, watch } from 'vue';
import { useRoute } from 'vue-router';
import AnchorDialog from '@/components/AnchorDialog.vue';
import UpdateDialog from '@/components/UpdateDialog.vue';
import DesktopShell from '@/components/layout/DesktopShell.vue';
import MobileShell from '@/components/layout/MobileShell.vue';
import NeuToast from '@/components/neu/NeuToast.vue';
import { usePlayerStore } from '@/stores/player.ts';
import { useSessionStore } from '@/stores/session.ts';
import { useUiStore } from '@/stores/ui.ts';
import { useUpdateStore } from '@/stores/update.ts';
import { useLyricsStore } from '@/stores/lyrics.ts';

const route = useRoute();
const ui = useUiStore();
const session = useSessionStore();
const player = usePlayerStore();
const update = useUpdateStore();
const lyrics = useLyricsStore();

lyrics.init();

const isPublic = computed(() => route.meta.public === true);

/**
 * 登录态就绪后，把上次的播放队列摆回播放条（**只就位，不自动出声**）。
 *
 * 放在根组件而不是各页面里：刷新任意页面都该恢复，而页面组件是会被卸载的；
 * 这也正是"续播"唯一该出现的地方 —— 用户主动点歌一律从头。
 *
 * 首次登录同样会走到这里，但登出会清掉快照（见 player store 的 reset），
 * 所以不会把上一个账号的队列搬给新用户。
 */
/**
 * 标签标题只有两种形态（2026-09-12 用户拍板）：
 *   真正在出声 → `正在播放 <歌名>`；其余一切情况（暂停 / 停止 / 无曲目）→ `SuenMusic`。
 *
 * 关键在「以 playing 为准，而不是以有没有当前曲目为准」——
 * 暂停时仍有 currentTrack，按它判断会一直显示"正在播放"（实测踩过）。
 * 标题与路由无关：看标签页就知道在听什么，比知道停在哪个页面有用。
 */
watch(
  [() => player.playing, () => player.currentTrack?.name ?? ''],
  ([playing, name]) => {
    document.title = playing && name ? `正在播放 ${name}` : 'SuenMusic';
  },
  { immediate: true }
);

let restoredThisLoad = false;
watch(
  () => session.isLoggedIn,
  loggedIn => {
    if (!loggedIn || restoredThisLoad) return;
    restoredThisLoad = true;
    void player.restoreSession();
  },
  { immediate: true }
);

/**
 * 启动后静默查一次应用更新（原生端：安卓 / iOS，store 内部已判定）。
 *
 * 必须等登录态就绪 —— `/api/update/check` 需要带令牌。这一趟「没更新」和「查失败」
 * 都不打扰用户，只有真的有新版本才弹窗；用户点过「以后再说」的版本也不再重复弹。
 * 判定全在 stores/update.ts，这里只负责挑时机。
 */
let updateChecked = false;
watch(
  () => session.isLoggedIn,
  loggedIn => {
    if (!loggedIn || updateChecked) return;
    updateChecked = true;
    void update.check(true);
  },
  { immediate: true }
);
</script>

<template>
  <NeuToast />
  <!-- 音源锚定弹窗：解析失败（低置信/无候选）时自动弹出，全局唯一 -->
  <AnchorDialog />
  <!-- 应用更新弹窗：启动静默检查或设置页手动检查命中新版本时弹出，全局唯一 -->
  <UpdateDialog />

  <template v-if="isPublic">
    <div class="bare neu-bg">
      <router-view />
    </div>
  </template>

  <template v-else>
    <DesktopShell v-if="ui.isDesktop" />
    <MobileShell v-else />
  </template>
</template>

<style scoped>
.bare {
  min-height: 100dvh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--sp-5);
}
</style>
