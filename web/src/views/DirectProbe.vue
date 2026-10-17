<script setup lang="ts">
/**
 * 无后端直连诊断页。
 *
 * 目的：在真机上一次性回答三个问题 ——
 *   ① 不配服务端能不能用（元数据拿得到吗）
 *   ② 数据能不能存（本地持久化）
 *   ③ 音频能不能播（原生直连 + Referer）
 *
 * 它**不依赖任何服务端**，也不要求登录（路由 meta.public）。
 * 每一项独立跑、独立显示结论，失败不会中断后面的项 —— 因为要的正是
 * "哪一步不行"的定位，而不是一个总的成败。
 */
import { ref, computed } from 'vue';
import {
  qqSearch,
  biliSearch,
  biliSearchProbe,
  biliResolveAudio,
  audioCdnProbeAll,
  getBuvid,
  type HttpProbe,
  type QqSong,
  type BiliCandidate,
} from '@/api/direct/upstream';
import { saveOffline, loadOffline } from '@/offline/snapshot';
import { SuenAudio, isNativeAudio } from '@/native/audio';

interface Item {
  name: string;
  state: 'idle' | 'run' | 'ok' | 'fail';
  detail: string;
}
const items = ref<Item[]>([
  { name: '① 取游客标识 buvid3/buvid4', state: 'idle', detail: '' },
  { name: '① QQ音乐 搜索（元数据）', state: 'idle', detail: '' },
  { name: '① B站 搜索（请求头组合对照）', state: 'idle', detail: '' },
  { name: '② 本地存储读写', state: 'idle', detail: '' },
  { name: '③ 解析音频地址', state: 'idle', detail: '' },
  { name: '③ 音频 CDN 是否要 Referer', state: 'idle', detail: '' },
  { name: '③ 原生播放器播放直连地址', state: 'idle', detail: '' },
]);

function set(i: number, state: Item['state'], detail: string): void {
  const cur = items.value[i];
  if (!cur) return;
  items.value[i] = { name: cur.name, state, detail };
}

const qqSongs = ref<QqSong[]>([]);
const biliCands = ref<BiliCandidate[]>([]);
const biliProbes = ref<HttpProbe[]>([]);
const cdnProbes = ref<HttpProbe[]>([]);
const audioUrl = ref('');
const audioBandwidth = ref(0);
const running = ref(false);

const env = computed(() => {
  const cap = (globalThis as { Capacitor?: { getPlatform?: () => string } }).Capacitor;
  return {
    platform: cap?.getPlatform?.() ?? 'web',
    nativeAudio: isNativeAudio,
    origin: location.origin,
  };
});

async function run(): Promise<void> {
  if (running.value) return;
  running.value = true;

  // ①-1 buvid
  let buvid = { b3: '', b4: '' };
  try {
    set(0, 'run', '');
    buvid = await getBuvid();
    set(0, 'ok', `buvid3=${buvid.b3.slice(0, 18)}…`);
  } catch (e) {
    set(0, 'fail', e instanceof Error ? e.message : String(e));
  }

  // ①-2 QQ 搜索
  try {
    set(1, 'run', '');
    qqSongs.value = await qqSearch('周杰伦 晴天', 5);
    set(1, 'ok', `命中 ${qqSongs.value.length} 首`);
  } catch (e) {
    set(1, 'fail', e instanceof Error ? e.message : String(e));
  }

  // ①-3 B站搜索 —— 多种请求头组合一起打，看哪种能过
  try {
    set(2, 'run', '');
    biliProbes.value = await biliSearchProbe('周杰伦 晴天');
    const pass = biliProbes.value.filter((p) => p.status === 200);
    set(2, pass.length > 0 ? 'ok' : 'fail', `${pass.length}/${biliProbes.value.length} 种组合可用`);
    if (pass.length > 0) {
      biliCands.value = await biliSearch('周杰伦 晴天');
    }
  } catch (e) {
    set(2, 'fail', e instanceof Error ? e.message : String(e));
  }

  // ② 本地存储
  try {
    set(3, 'run', '');
    const stamp = Date.now();
    await saveOffline('probe.local', { stamp, hello: '本地存储' });
    const back = await loadOffline<{ stamp: number }>('probe.local');
    if (back?.stamp === stamp) {
      set(3, 'ok', `写入并读回成功（key=probe.local）`);
    } else {
      set(3, 'fail', '读回内容与写入不一致');
    }
  } catch (e) {
    set(3, 'fail', e instanceof Error ? e.message : String(e));
  }

  // ③-1 解析音频地址
  try {
    set(4, 'run', '');
    const bvid = biliCands.value[0]?.bvid ?? '';
    if (!bvid) throw new Error('没有可用 bvid（上一步 B站搜索没成功）');
    const r = await biliResolveAudio(bvid);
    audioUrl.value = r.url;
    audioBandwidth.value = r.bandwidth;
    set(4, 'ok', `bandwidth=${r.bandwidth} codecs=${r.codecs}`);
  } catch (e) {
    set(4, 'fail', e instanceof Error ? e.message : String(e));
  }

  // ③-2 CDN Referer 校验
  try {
    if (!audioUrl.value) throw new Error('上一步没拿到地址');
    set(5, 'run', '');
    cdnProbes.value = await audioCdnProbeAll(audioUrl.value);
    const withRef = cdnProbes.value.find((p) => p.label === '带 Referer');
    const noRef = cdnProbes.value.find((p) => p.label === '不带 Referer');
    set(
      5,
      withRef?.status === 206 || withRef?.status === 200 ? 'ok' : 'fail',
      `带 Referer=${withRef?.status} / 不带=${noRef?.status}`
    );
  } catch (e) {
    set(5, 'fail', e instanceof Error ? e.message : String(e));
  }

  // ③-3 原生播放器直连播放
  try {
    set(6, 'run', '');
    if (!audioUrl.value) throw new Error('没有可用音频地址');
    if (!isNativeAudio) throw new Error('当前不是原生环境（浏览器里无法验证播放）');
    await SuenAudio.setQueue({
      baseUrl: '',
      token: '',
      items: [
        {
          id: 'probe-1',
          title: qqSongs.value[0]?.name ?? '诊断曲目',
          artist: qqSongs.value[0]?.artist ?? '未知',
          directUrl: audioUrl.value,
        },
      ],
      startIndex: 0,
      autoplay: true,
    });
    set(6, 'ok', '已交给原生播放器（应听到声音）');
  } catch (e) {
    set(6, 'fail', e instanceof Error ? e.message : String(e));
  }

  running.value = false;
}

const badge = (s: Item['state']): string =>
  ({ idle: '○', run: '…', ok: '✓', fail: '✗' })[s];
const color = (s: Item['state']): string =>
  ({ idle: '#94A3B8', run: '#3B82F6', ok: '#16A34A', fail: '#DC2626' })[s];
</script>

<template>
  <div class="probe">
    <h2>无后端直连诊断</h2>
    <p class="sub">
      平台 <b>{{ env.platform }}</b> · 原生音频 <b>{{ env.nativeAudio ? '可用' : '不可用' }}</b>
      · 页面源 <code>{{ env.origin }}</code>
    </p>

    <button :disabled="running" @click="run">
      {{ running ? '执行中…' : '开始诊断' }}
    </button>

    <ol class="list">
      <li v-for="(it, i) in items" :key="i">
        <span class="badge" :style="{ color: color(it.state) }">{{ badge(it.state) }}</span>
        <span class="name">{{ it.name }}</span>
        <span class="detail">{{ it.detail }}</span>
      </li>
    </ol>

    <section v-if="qqSongs.length">
      <h3>QQ音乐 搜索命中</h3>
      <ul>
        <li v-for="s in qqSongs" :key="s.mid">{{ s.name }} — {{ s.artist }}</li>
      </ul>
    </section>

    <section v-if="biliProbes.length">
      <h3>B站搜索请求头对照</h3>
      <table>
        <tr><th>组合</th><th>HTTP</th><th>结果</th></tr>
        <tr v-for="p in biliProbes" :key="p.label">
          <td>{{ p.label }}</td>
          <td :style="{ color: p.status === 200 ? '#16A34A' : '#DC2626' }">{{ p.status }}</td>
          <td>{{ p.note }}</td>
        </tr>
      </table>
    </section>

    <section v-if="biliCands.length">
      <h3>B站候选</h3>
      <ul>
        <li v-for="c in biliCands.slice(0, 5)" :key="c.bvid">{{ c.bvid }} {{ c.title }}</li>
      </ul>
    </section>

    <section v-if="cdnProbes.length">
      <h3>音频 CDN 对 Referer 的要求</h3>
      <table>
        <tr><th>请求方式</th><th>HTTP</th><th>类型</th></tr>
        <tr v-for="p in cdnProbes" :key="p.label">
          <td>{{ p.label }}</td>
          <td :style="{ color: p.status === 206 ? '#16A34A' : '#DC2626' }">{{ p.status }}</td>
          <td>{{ p.note }}</td>
        </tr>
      </table>
    </section>

    <section v-if="audioUrl">
      <h3>音频地址</h3>
      <p class="url">{{ audioUrl.slice(0, 120) }}…</p>
      <p class="url">声明码率 {{ audioBandwidth }}</p>
    </section>

    <a class="back" href="/settings">返回设置</a>
  </div>
</template>

<style scoped>
.probe {
  padding: 16px;
  font-size: 13px;
  line-height: 1.7;
  color: #1e293b;
}
h2 { font-size: 17px; margin: 0 0 6px; }
h3 { font-size: 14px; margin: 16px 0 6px; }
.sub { color: #64748b; margin: 0 0 12px; }
button {
  padding: 8px 16px; border-radius: 8px; border: none;
  background: #e0783c; color: #fff; font-size: 14px;
}
button:disabled { opacity: 0.6; }
.list { list-style: none; padding: 0; margin: 14px 0; }
.list li { display: flex; gap: 6px; align-items: baseline; padding: 4px 0; }
.badge { width: 14px; flex: none; font-weight: 700; }
.name { flex: none; }
.detail { color: #64748b; word-break: break-all; }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
th, td { text-align: left; padding: 3px 6px; border-bottom: 1px solid #e2e8f0; }
.url { word-break: break-all; color: #64748b; font-size: 12px; margin: 4px 0; }
.back { display: inline-block; margin-top: 20px; color: #e0783c; }
</style>
