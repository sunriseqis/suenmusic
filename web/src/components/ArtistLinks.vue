<script setup lang="ts">
/**
 * 可点击的歌手名。
 *
 * 抽成组件的原因：播放条（桌面/移动两种形态）与全屏播放页都要用，
 * 而且「多位歌手怎么分隔」「没有路由键时怎么办」这两个细节得收在一处。
 *
 * 用 `RouterLink` 而不是自己 `router.push`：它会渲染出**真实的 href**，
 * 中键新标签页、右键复制链接都是现成的，也才谈得上"看起来能点、实际就能点"。
 * （首页焦点图曾经就是栽在这里：渲染成没有 href 的 `<a>`，点了没反应。）
 *
 * `@click.stop` 是因为移动端迷你条整条绑了"展开全屏播放页"——
 * 点歌手名不该顺带把面板推上去。
 */
import { RouterLink } from 'vue-router';
import type { TrackArtist } from '@/api/types.ts';

withDefaults(
  defineProps<{
    artists: TrackArtist[] | undefined | null;
    /** 拿不到歌手信息时显示它 */
    fallback?: string;
  }>(),
  { fallback: '未知歌手' }
);
</script>

<template>
  <span class="artists">
    <template v-if="artists && artists.length > 0">
      <template v-for="(a, i) in artists" :key="a.id || i">
        <RouterLink
          v-if="a.id"
          class="link"
          :to="{
            name: 'collection',
            params: { kind: 'artist', id: a.id },
            query: { name: a.name },
          }"
          :title="`查看 ${a.name}`"
          @click.stop
        >
          {{ a.name }}
        </RouterLink>
        <!-- 没有路由键就没法跳，如实当纯文本，不要做成点了没反应的假链接 -->
        <span v-else>{{ a.name }}</span>

        <span v-if="i < artists.length - 1" class="sep" aria-hidden="true">/</span>
      </template>
    </template>
    <span v-else>{{ fallback }}</span>
  </span>
</template>

<style scoped>
.artists {
  color: inherit;
}

/* 不套蓝色链接色：软拟物下强调的是"按下去"的反馈，而不是换一种颜色 */
.link {
  color: inherit;
  text-decoration: none;
  transition: color var(--dur-fast) var(--ease);
}
.link:hover,
.link:focus-visible {
  color: var(--accent-text);
  text-decoration: underline;
  text-underline-offset: 2px;
}

.sep {
  opacity: 0.65;
  padding: 0 1px;
}
</style>
