/**
 * 封面离线缓存（原生落盘 + 本地 URL 映射）。
 *
 * ## 为什么必须自己做
 *
 * 封面图片走的是上游 CDN（y.gtimg.cn 之类），离线时 WebView **不保证**从它自己的
 * 磁盘缓存里取 —— 实测离线全裂图。所以由原生把图片下载到应用目录，返回
 * `http://localhost/_capacitor_file_<绝对路径>` 这种本地 URL，`<img>` 直接读本地文件。
 *
 * ## 怎么接进现有渲染（只改一个函数）
 *
 * 所有组件都通过 `utils/format.ts` 的 `coverUrl()` 生成图片地址，所以只要在那里
 * 过一层 `coverSrc()`：渲染时**顺手**把没缓存的封面排进队列（300ms 合并成一次原生调用），
 * 缓存完成后替换成本地 URL。不侵入任何组件。
 *
 * 映射表持久化在 localStorage：冷启动且离线时也能立刻拿到本地 URL。
 */
import { ref } from 'vue';
import { Capacitor } from '@capacitor/core';
import { SuenAudio } from '@/native/audio.ts';
import { isNativeAudio } from '@/native/bridge.ts';

const MAP_KEY = 'suenmusic.coverLocalMap';

/** remote url → 本地 URL */
const localMap = new Map<string, string>(
  (() => {
    try {
      const raw = localStorage.getItem(MAP_KEY);
      if (!raw) return [];
      return Object.entries(JSON.parse(raw) as Record<string, string>);
    } catch {
      return [];
    }
  })()
);

/**
 * 响应式版本号：`coverSrc()` 里读一下这个 ref，组件渲染时就建立了依赖；
 * 缓存完成后自增 → 用到封面的组件自动重渲染，图片从远程 URL 换成**本地文件 URL**。
 *
 * ⚠️ 少了这一步会出现"缓存已经落盘、界面还在用远程 URL"（真机验证时踩过：
 * imgLocal=0，磁盘上却有 13 张封面）。
 */
const coverVersion = ref(0);

let pending = new Set<string>();
let flushTimer: number | null = null;
let inflight = false;

function persist(): void {
  try {
    // 只留最近 500 条，避免无限增长
    const entries = [...localMap.entries()].slice(-500);
    localStorage.setItem(MAP_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    /* 写不进去不影响显示（只是冷启动会少一份映射） */
  }
}

async function flush(): Promise<void> {
  flushTimer = null;
  if (inflight || pending.size === 0) return;
  const batch = [...pending];
  pending = new Set();
  inflight = true;
  try {
    const res = await SuenAudio.cacheImages({ urls: batch });
    let changed = false;
    for (const [remote, local] of Object.entries(res ?? {})) {
      if (local && localMap.get(remote) !== local) {
        localMap.set(remote, local);
        changed = true;
      }
    }
    if (changed) {
      persist();
      coverVersion.value += 1;   // 触发用到封面的组件重渲染
    }
  } catch {
    /* 缓存失败就继续用远程 URL（在线时没影响） */
  } finally {
    inflight = false;
    if (pending.size > 0) schedule();
  }
}

function schedule(): void {
  if (flushTimer !== null) return;
  flushTimer = window.setTimeout(() => void flush(), 300);
}

/**
 * 渲染用：返回可直接给 `<img src>` 的地址。
 * 顺手把未缓存的封面排进缓存队列（本地平台才做）。
 */
export function coverSrc(raw: string | undefined | null): string {
  coverVersion.value;   // 建立响应式依赖（缓存更新后自动换成本地 URL）
  const url = String(raw ?? '');
  if (!url) return '';
  const local = localMap.get(url);
  if (local) return local;
  // ⚠️ 平台门控**暂时保持只认安卓**。
  //
  // 2026-09-25 曾把它放开到原生端（iOS 也走本机缓存），结果真机上出现
  // 「部分封面加载不出来」—— 说明 iOS 侧的 CoverCache/URL 拼装这条链路
  // 从未被真正跑通过（在放开之前，prefetchCovers() 全项目无调用点，
  // 所以 SuenAudio.cacheImages 在 iOS 上是死代码）。
  // **"这段代码没被调用过"不等于"它是对的"** —— 重新放开前必须单独验证：
  //   1. cacheImage 落盘的文件是否完整可解码（历史上出现过 WEBP initImage 失败）；
  //   2. 返回的 `capacitor://localhost/_capacitor_file_…` 能否被 WebView 取到。
  if (isNativeAudio && Capacitor.getPlatform() === 'android' && /^https?:/.test(url)) {
    pending.add(url);
    schedule();
  }
  return url;
}
