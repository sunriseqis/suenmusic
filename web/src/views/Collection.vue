<script setup lang="ts">
/**
 * 集合页：榜单 / QQ 歌单 / 专辑 / 歌手，四种来源共用一套模板。
 *
 * 放在一个组件里而不是拆四个：四者的交互完全一致
 * （标题 + 副标题 + 曲目列表 + 播放全部），拆开只会把同一段模板抄四遍，
 * 而每修一个细节就要改四处。
 *
 * 各来源的**字段名与能力并不一致**，这里如实处理而不是强行统一：
 *   - 榜单：有 `updateFrequency`，没有描述
 *   - QQ 歌单：有描述与创建者，曲目可能为空（歌单被下架）
 *   - 专辑：有发行时间与公司；曲目可能为空（**版权限制**，此时上游会带 `notice`，
 *     要原样显示给用户，不能拿"歌单已下架"那套话术糊弄）
 *   - 歌手：**没有"曲目"概念**，走的是"按歌手名搜索召回"，
 *     所以可能返回 degraded（限流），且上限只有 50 首
 */
import { computed, nextTick, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import NeuIcon from '@/components/neu/NeuIcon.vue';
import NeuIconButton from '@/components/neu/NeuIconButton.vue';
import NeuSkeleton from '@/components/neu/NeuSkeleton.vue';
import TrackRow from '@/components/TrackRow.vue';
import CoverCard from '@/components/CoverCard.vue';
import { ApiError } from '@/api/client.ts';
import {
  fetchAlbum,
  fetchArtist,
  fetchArtistAlbums,
  fetchArtistSongs,
  fetchQQPlaylist,
  fetchSimilarArtists,
  fetchToplist,
} from '@/api/catalog.ts';
import { usePlayerStore } from '@/stores/player.ts';
import { useFavoritesStore } from '@/stores/favorites.ts';
import { artistNames, coverUrl, formatCount } from '@/utils/format.ts';
import type { Album, Track } from '@/api/types.ts';

const props = defineProps<{ kind: 'toplist' | 'playlist' | 'album' | 'artist'; id: string }>();

const route = useRoute();
const router = useRouter();
const player = usePlayerStore();

const title = ref('');
const subtitle = ref('');
const description = ref('');
const cover = ref('');
const tracks = ref<Track[]>([]);

const loading = ref(true);
const errorText = ref('');
/** 上游限流说明。与 errorText 分开：它是"空结果 + 解释"，不是失败 */
const degradedText = ref('');
/**
 * 曲目为空时**上游自己给的原因**（目前只有专辑会有，形如「抱歉，因版权限制…」）。
 * 有它就照抄上游原话 —— 服务端专门为这条去问了老接口，
 * 客户端别再拿"可能需要会员"之类自己猜的话术去覆盖它。
 */
const notice = ref('');

/** 歌手的曲目是按名搜索召回的，与专辑/歌单不是一回事，界面上要说明 */
const isArtist = computed(() => props.kind === 'artist');
const artistName = computed(() => (typeof route.query.name === 'string' ? route.query.name : ''));

/**
 * 歌手专辑列表。**只有歌手页有**。
 *
 * 单独请求、单独兜错：专辑是补充内容，它失败不该把整页变成"加载失败"。
 * 路由参数变化时旧请求可能晚到，所以用 `loadSeq` 判废。
 */
const albums = ref<Album[]>([]);
const albumsLoading = ref(false);
let loadSeq = 0;

/** 歌手页的专辑卡片 → 打开该专辑 */
function openAlbum(id: string) {
  void router.push({ name: 'collection', params: { kind: 'album', id } });
}

// ---------------------------------------------------------------------------
// 分页
// ---------------------------------------------------------------------------
//
// 只给**歌手页**用：歌手的数据是按名搜索召回的，摊成一页要滚很久
// （用户反馈"翻起来累死人"）。专辑/歌单/榜单是上游给的确定列表，一页到底。
//
// **默认只取上游第 1 批**（50 条 = 歌曲 3 页 / 专辑 5 页），
// 翻到已加载的最后一页时才去取下一批 —— 每次翻页都是一次真实的 QQ 搜索请求，
// 而搜索最容易触发 2001 风控，不能一上来就把整只歌手的全部结果翻完。
//
// 页码是**动态增长**的，不能写死 `1 / 3`：
// 取回一批就多出几页，所以总数取决于"已经取了多少"而不是"一共有多少"。

const SONGS_PER_PAGE = 10;
const ALBUMS_PER_PAGE = 12;
/** 每批向上游要多少条 */
const BATCH_SIZE = 50;
/** 最多取几批。给风控兜底：宁可显示"没有更多"，也不要无限翻下去 */
const MAX_BATCH = 10;

const songPage = ref(1);
const albumPage = ref(1);
const songBatch = ref(1);
const albumBatch = ref(1);
const songsHasMore = ref(false);
const albumsHasMore = ref(false);
const songsLoadingMore = ref(false);
const albumsLoadingMore = ref(false);
/** 歌手名，翻页时要带上去省一次详情请求 */
const singerName = ref('');

const songPages = computed(() => Math.max(1, Math.ceil(tracks.value.length / SONGS_PER_PAGE)));
const albumPages = computed(() => Math.max(1, Math.ceil(albums.value.length / ALBUMS_PER_PAGE)));

const pagedSongs = computed(() => {
  const start = (songPage.value - 1) * SONGS_PER_PAGE;
  return tracks.value.slice(start, start + SONGS_PER_PAGE);
});
const pagedAlbums = computed(() => {
  const start = (albumPage.value - 1) * ALBUMS_PER_PAGE;
  return albums.value.slice(start, start + ALBUMS_PER_PAGE);
});

/** 实际渲染的曲目。非歌手页不分页 */
const shownTracks = computed(() => (isArtist.value ? pagedSongs.value : tracks.value));
/** 分页时的绝对序号基准，让"第 21 首"真的是第 21 首 */
const songIndexBase = computed(() => (isArtist.value ? (songPage.value - 1) * SONGS_PER_PAGE : 0));

/** 页码按钮：页数多时只显示首尾与当前附近，中间用省略号，否则会排满一屏 */
function pageNumbers(current: number, total: number): Array<number | 'gap'> {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const out: Array<number | 'gap'> = [1];
  const from = Math.max(2, current - 1);
  const to = Math.min(total - 1, current + 1);
  if (from > 2) out.push('gap');
  for (let i = from; i <= to; i++) out.push(i);
  if (to < total - 1) out.push('gap');
  out.push(total);
  return out;
}
const songPageNumbers = computed(() => pageNumbers(songPage.value, songPages.value));
const albumPageNumbers = computed(() => pageNumbers(albumPage.value, albumPages.value));

const pad2 = (n: number) => String(n).padStart(2, '0');

/** 点「下一页」：还有本地页就翻页，已经到末页且上游还有就去取下一批 */
function nextSong() {
  if (songPage.value < songPages.value) {
    songPage.value += 1;
    return;
  }
  void loadMoreSongs(singerName.value, loadSeq);
}
function nextAlbum() {
  if (albumPage.value < albumPages.value) {
    albumPage.value += 1;
    return;
  }
  void loadMoreAlbums(singerName.value, loadSeq);
}
function goSongPage(dir: number) {
  songPage.value = Math.min(songPages.value, Math.max(1, songPage.value + dir));
}
function goAlbumPage(dir: number) {
  albumPage.value = Math.min(albumPages.value, Math.max(1, albumPage.value + dir));
}

/** 模板里用的无参入口（带上当前歌手名与加载序号） */
function moreSongs() {
  void loadMoreSongs(singerName.value, loadSeq);
}
function moreAlbums() {
  void loadMoreAlbums(singerName.value, loadSeq);
}

/** 取下一批歌曲。追加时按 id 去重：搜索分页并不保证不重叠 */
async function loadMoreSongs(name: string, seq: number) {
  if (songsLoadingMore.value || !songsHasMore.value) return;
  if (songBatch.value >= MAX_BATCH) {
    songsHasMore.value = false;
    return;
  }
  songsLoadingMore.value = true;
  try {
    const next = songBatch.value + 1;
    const res = await fetchArtistSongs(props.id, { name, limit: BATCH_SIZE, page: next });
    if (seq !== loadSeq) return;
    songBatch.value = next;
    const seen = new Set(tracks.value.map(t => t.id));
    const fresh = res.songs.filter(s => !seen.has(s.id));
    if (fresh.length > 0) {
      const pagesBefore = songPages.value;
      tracks.value = [...tracks.value, ...fresh];
      songPage.value = Math.min(songPages.value, pagesBefore + 1);
    }
    // 上游说有更多、但**过滤后一条都没新增**时也要收手，否则会一直空转
    songsHasMore.value = res.hasMore && fresh.length > 0 && next < MAX_BATCH;
  } catch {
    if (seq === loadSeq) songsHasMore.value = false;
  } finally {
    if (seq === loadSeq) songsLoadingMore.value = false;
  }
}

/** 取下一批专辑 */
async function loadMoreAlbums(name: string, seq: number) {
  if (albumsLoadingMore.value || !albumsHasMore.value) return;
  if (albumBatch.value >= MAX_BATCH) {
    albumsHasMore.value = false;
    return;
  }
  albumsLoadingMore.value = true;
  try {
    const next = albumBatch.value + 1;
    const res = await fetchArtistAlbums(props.id, { name, limit: BATCH_SIZE, page: next });
    if (seq !== loadSeq) return;
    albumBatch.value = next;
    const seen = new Set(albums.value.map(a => a.id));
    const fresh = res.albums.filter(a => !seen.has(a.id));
    if (fresh.length > 0) {
      const pagesBefore = albumPages.value;
      albums.value = [...albums.value, ...fresh];
      albumPage.value = Math.min(albumPages.value, pagesBefore + 1);
    }
    albumsHasMore.value = res.hasMore && fresh.length > 0 && next < MAX_BATCH;
  } catch {
    if (seq === loadSeq) albumsHasMore.value = false;
  } finally {
    if (seq === loadSeq) albumsLoadingMore.value = false;
  }
}

async function loadArtistAlbums(name: string, seq: number) {
  albumsLoading.value = true;
  albums.value = [];
  albumsHasMore.value = false;
  try {
    const res = await fetchArtistAlbums(props.id, { name, limit: BATCH_SIZE, page: 1 });
    if (seq !== loadSeq) return;
    albums.value = res.albums;
    albumBatch.value = 1;
    albumsHasMore.value = res.hasMore;
  } catch {
    // 专辑拿不到就当这节不存在，曲目列表照常显示
    if (seq === loadSeq) albums.value = [];
  } finally {
    if (seq === loadSeq) albumsLoading.value = false;
  }
}

/**
 * 相似歌手。**补充内容的补充**：独立请求、静默兜错，
 * 失败/为空就整节不渲染，绝不影响曲目与专辑的正常展示。
 */
const simiArtists = ref<Array<{ id: string; name: string }>>([]);
const simiLoading = ref(false);

async function loadSimilarArtists(name: string, seq: number) {
  simiLoading.value = true;
  simiArtists.value = [];
  try {
    const res = await fetchSimilarArtists(props.id, { name });
    if (seq !== loadSeq) return;
    simiArtists.value = res.artists;
  } catch {
    if (seq === loadSeq) simiArtists.value = [];
  } finally {
    if (seq === loadSeq) simiLoading.value = false;
  }
}

function openArtist(id: string, name: string) {
  void router.push({
    name: 'collection',
    params: { kind: 'artist', id },
    query: { name },
  });
}

// ---------------------------------------------------------------------------
// 专辑介绍：折叠与展开
// ---------------------------------------------------------------------------
//
// 折叠是为了不占掉半个屏幕，但**折叠就必须能展开** ——
// 只有 `max-height + overflow:hidden` 等于把长介绍的后半截永久藏起来。
//
// 是否显示"展开"取决于**真的溢出了没有**：短介绍挂个"展开"按钮是噪音。
const descEl = ref<HTMLElement | null>(null);
const descExpanded = ref(false);
const descOverflow = ref(false);

/**
 * 量是否溢出。
 * **只在收起状态量** —— 展开后 scrollHeight === clientHeight，
 * 量出来必然是"没溢出"，按钮会在展开的瞬间消失，用户就点不到"收起"了。
 */
async function measureDesc() {
  await nextTick();
  const el = descEl.value;
  if (!el) {
    descOverflow.value = false;
    return;
  }
  if (descExpanded.value) return;
  descOverflow.value = el.scrollHeight > el.clientHeight + 2;
}

function toggleDesc() {
  descExpanded.value = !descExpanded.value;
  if (!descExpanded.value) void measureDesc();
}

watch(description, () => {
  descExpanded.value = false;
  void measureDesc();
});

/**
 * 封面加载失败标记。个别专辑/歌手在上游确实没有图，或尺寸档失效。
 * 破了就退回凹陷占位块 —— 留一块空白比"什么都没有"更像页面坏了。
 */
const coverBroken = ref(false);
const coverSrc = computed(() => (coverBroken.value ? '' : coverUrl(cover.value, 500)));

/** 曲目总数未知时（榜单/歌手分页取）不显示条数，避免给出错误印象 */
const showCount = computed(() => !isArtist.value && tracks.value.length > 0);

/** 空曲目状态的标题。分来源说，别拿歌单的话术去说专辑 */
const emptyTitle = computed(() =>
  props.kind === 'album' ? '这张专辑暂不可播放' : '这里还没有曲目'
);

/**
 * 空曲目状态的说明文字。
 *
 * 优先用**上游给的 notice**；没有时才退回按来源的通用话术。
 * 曾经这里只有一句"可能这首歌单已下架，或者该内容需要会员才能读取"，
 * 结果专辑页上也照搬 —— 明明是"版权限制"，却让用户以为要充值。
 */
const emptyHint = computed(() => {
  if (notice.value) return notice.value;
  switch (props.kind) {
    case 'album':
      return '上游没有返回曲目，可能是尚未发行或曲目正在调整。';
    case 'playlist':
      return '上游返回了空列表，这个歌单可能已下架。';
    case 'toplist':
      return '暂时取不到榜单曲目，稍后重试。';
    default:
      return '没有检索到这位歌手的曲目。';
  }
});

async function load() {
  // 递增即作废此前所有在飞的补充请求（专辑），避免旧歌手的数据盖到新页面上
  loadSeq += 1;
  loading.value = true;
  errorText.value = '';
  degradedText.value = '';
  notice.value = '';
  title.value = '';
  subtitle.value = '';
  description.value = '';
  cover.value = '';
  coverBroken.value = false;
  tracks.value = [];
  albums.value = [];
  simiArtists.value = [];
  simiLoading.value = false;
  albumsLoading.value = false;
  // 换歌手/换类型都要回到第一页，否则会停在一个不存在的页码上
  songPage.value = 1;
  albumPage.value = 1;
  songBatch.value = 1;
  albumBatch.value = 1;
  songsHasMore.value = false;
  albumsHasMore.value = false;
  songsLoadingMore.value = false;
  albumsLoadingMore.value = false;
  singerName.value = '';

  try {
    switch (props.kind) {
      case 'toplist': {
        const res = await fetchToplist(props.id, { limit: 200 });
        title.value = res.topInfo?.name || '排行榜';
        subtitle.value = res.topInfo?.updateFrequency || '';
        cover.value = res.topInfo?.picUrl || res.topInfo?.coverImgUrl || '';
        tracks.value = res.tracks;
        break;
      }
      case 'playlist': {
        const res = await fetchQQPlaylist(props.id);
        title.value = res.playlist.name;
        subtitle.value = `${formatCount(res.playlist.playCount)} 次播放 · ${res.playlist.creator?.nickname || 'QQ 音乐'}`;
        description.value = res.playlist.description;
        cover.value = res.playlist.picUrl || res.playlist.coverImgUrl;
        tracks.value = res.tracks;
        break;
      }
      case 'album': {
        const res = await fetchAlbum(props.id);
        title.value = res.album.name;
        subtitle.value = [artistNames(res.album.artists), res.album.company]
          .filter(Boolean)
          .join(' · ');
        description.value = res.album.description;
        cover.value = res.album.picUrl;
        tracks.value = res.songs;
        notice.value = res.notice || '';
        break;
      }
      case 'artist': {
        // 歌手的歌曲要按名字走搜索召回，所以名字能省一次上游请求就省
        const name = artistName.value || (await fetchArtist(props.id)).artist.name;
        singerName.value = name;
        // 默认只取第 1 批；翻到末页时再由 loadMoreSongs 去取下一批
        const res = await fetchArtistSongs(props.id, { name, limit: BATCH_SIZE, page: 1 });
        title.value = res.name || name;
        subtitle.value = '热门歌曲';
        cover.value = pickArtistAvatar(res.songs, props.id, name);
        tracks.value = res.songs;
        songBatch.value = 1;
        songsHasMore.value = res.hasMore;
        if (res.degraded && res.songs.length === 0) {
          degradedText.value = res.degraded.message || 'QQ 音乐检索被限流，请稍后重试';
        }
        void loadArtistAlbums(name, loadSeq);
        void loadSimilarArtists(name, loadSeq);
        break;
      }
    }
  } catch (e) {
    errorText.value =
      e instanceof ApiError
        ? e.isNetworkError
          ? '连不上服务端，请到设置页检查基地址'
          : e.message
        : '加载失败';
  } finally {
    loading.value = false;
  }
}

// 同一个组件实例在路由参数变化时不会重建，必须显式监听
watch(() => [props.kind, props.id] as const, load, { immediate: true });

function playAll(from = 0) {
  if (tracks.value.length > 0) void player.playQueue(tracks.value, from);
}

// ---------------------------------------------------------------------------
// 批量收藏
// ---------------------------------------------------------------------------
const favStore = useFavoritesStore();
const favoriting = ref(false);
/** 是否列表中全部已收藏 */
const allFavorited = computed(() => {
  if (tracks.value.length === 0) return false;
  return tracks.value.every(t => favStore.contains(t.id));
});
/** 收藏结果提示 */
const favToast = ref('');
let favToastTimer: ReturnType<typeof setTimeout> | undefined;

async function favoriteAll() {
  if (favoriting.value || tracks.value.length === 0) return;
  favoriting.value = true;
  favToast.value = '';
  try {
    await favStore.ensureLoaded();
    const added = await favStore.batchAdd(tracks.value);
    if (added > 0) {
      favToast.value = `已收藏 ${added} 首`;
    } else {
      favToast.value = '全部已在收藏中';
    }
  } catch {
    favToast.value = '收藏失败，请重试';
  } finally {
    favoriting.value = false;
    clearTimeout(favToastTimer);
    favToastTimer = setTimeout(() => { favToast.value = ''; }, 3000);
  }
}

/**
 * 歌手头像：**从召回的曲目里就地取**，不额外请求歌手详情。
 *
 * 曲目里的每位歌手都带 T001 头像，与 `/api/artists/:id` 返回的是同一张图。
 * 为了一张头像去请求歌手详情，服务端那边还会连带打一次搜索分片
 * （统计数字只能从搜索回填），而搜索恰恰是最容易被风控的接口 —— 不值当。
 *
 * 优先认路由键完全匹配的那位：歌手页的曲目是按名召回的，
 * 合唱曲目里可能夹着别人，直接取 `ar[0]` 会把头像带偏。
 */
function pickArtistAvatar(songs: Track[], artistId: string, fallbackName: string): string {
  for (const s of songs) {
    const hit = s.ar?.find(a => a.id === artistId);
    if (hit?.picUrl) return hit.picUrl;
  }
  // 没有 id 命中时退回主歌手，但只在名字确实对得上时才敢用
  const first = songs[0]?.ar?.[0];
  return first?.picUrl && first.name === fallbackName ? first.picUrl : '';
}
</script>

<template>
  <div class="collection neu-container">
    <!-- 头部 -->
    <header class="head">
      <div class="art neu-raised-lg">
        <img
          v-if="!loading && coverSrc"
          :src="coverSrc"
          :alt="title"
          @error="coverBroken = true"
        />
        <span v-else class="art-ph" aria-hidden="true" />
      </div>

      <div class="info">
        <span class="kind">{{ { toplist: '排行榜', playlist: '歌单', album: '专辑', artist: '歌手' }[kind] }}</span>

        <template v-if="loading">
          <NeuSkeleton height="30px" width="60%" />
          <NeuSkeleton height="14px" width="40%" />
        </template>

        <template v-else>
          <h1 class="title neu-clamp-2">{{ title || '未找到' }}</h1>
          <p v-if="subtitle" class="sub neu-ellipsis">{{ subtitle }}</p>
          <p v-if="showCount" class="sub neu-num">{{ tracks.length }} 首</p>
        </template>

        <div v-if="!loading && tracks.length > 0" class="head-actions">
          <button type="button" class="play-all" @click="playAll(0)">
            <NeuIcon name="play" :size="14" />
            播放全部
          </button>
          <button
            type="button"
            class="fav-all"
            :class="{ 'is-done': allFavorited }"
            :disabled="favoriting || allFavorited"
            @click="favoriteAll"
          >
            <NeuIcon :name="allFavorited ? 'heart-filled' : 'heart'" :size="14" />
            {{ favoriting ? '收藏中…' : allFavorited ? '已全部收藏' : '收藏全部' }}
          </button>
          <Transition name="toast-fade">
            <span v-if="favToast" class="fav-toast">{{ favToast }}</span>
          </Transition>
        </div>
      </div>
    </header>

    <!-- 专辑介绍。默认折叠，但**必须给展开入口** ——
         上一版只有 `max-height + overflow:hidden`，长介绍永远看不到后半截。 -->
    <div v-if="description && !loading" class="desc-box" data-block="description">
      <p ref="descEl" class="desc" :class="{ 'is-clamped': !descExpanded }">{{ description }}</p>
      <button
        v-if="descOverflow"
        type="button"
        class="desc-toggle"
        :aria-expanded="descExpanded ? 'true' : 'false'"
        data-role="desc-toggle"
        @click="toggleDesc"
      >
        {{ descExpanded ? '收起' : '展开完整介绍' }}
      </button>
    </div>

    <!-- 歌手专辑。只有歌手页有，且是**补充内容**：
         它自己请求、自己兜错，失败就当这节不存在，曲目列表照常显示。 -->
    <section
      v-if="isArtist && (albumsLoading || albums.length > 0)"
      class="albums"
      data-block="artist-albums"
    >
      <h2 class="sec-title">专辑</h2>

      <div v-if="albumsLoading" class="neu-grid">
        <div v-for="i in 4" :key="i" class="sk-card">
          <NeuSkeleton height="0" radius="lg" class="sk-art" />
        </div>
      </div>

      <div v-else class="neu-grid">
        <button
          v-for="a in pagedAlbums"
          :key="a.id"
          type="button"
          class="grid-btn"
          :aria-label="`打开专辑：${a.name}`"
          @click="openAlbum(a.id)"
        >
          <CoverCard :title="a.name" :cover="a.picUrl" :subtitle="artistNames(a.artists)" />
        </button>
      </div>

      <!-- 页码动态增长：取回一批就多几页，不写死总数 -->
      <div v-if="albumPages > 1 || albumsHasMore" class="pager" data-pager="albums">
        <NeuIconButton
          icon="chevron-left"
          label="上一页专辑"
          data-nav="albums-prev"
          size="md"
          :disabled="albumPage <= 1"
          @click="goAlbumPage(-1)"
        />
        <template v-for="(p, i) in albumPageNumbers" :key="`al-${i}`">
          <span v-if="p === 'gap'" class="pager-gap" aria-hidden="true">…</span>
          <button
            v-else
            type="button"
            class="page-num"
            :class="{ 'is-on': p === albumPage }"
            :aria-label="`第 ${p} 页专辑`"
            :aria-current="p === albumPage ? 'true' : undefined"
            @click="albumPage = p"
          >
            {{ pad2(p) }}
          </button>
        </template>
        <button
          v-if="albumsHasMore"
          type="button"
          class="more"
          :disabled="albumsLoadingMore"
          data-role="albums-more"
          @click="moreAlbums"
        >
          {{ albumsLoadingMore ? '加载中' : '加载更多' }}
        </button>
        <NeuIconButton
          icon="chevron-right"
          label="下一页专辑"
          data-nav="albums-next"
          size="md"
          :disabled="!(albumPage < albumPages || albumsHasMore)"
          @click="nextAlbum()"
        />
      </div>
    </section>

    <!-- 状态区 -->
    <div v-if="loading" class="list neu-raised-md">
      <NeuSkeleton :lines="8" height="22px" class="sk" />
    </div>

    <div v-else-if="errorText" class="state neu-raised-md">
      <p class="state-title">加载失败</p>
      <p class="state-msg neu-t2">{{ errorText }}</p>
      <button type="button" class="retry" @click="load">
        <NeuIcon name="refresh" :size="15" />
        重试
      </button>
    </div>

    <!-- 限流：必须显式说明，绝不显示成"这个歌单是空的" -->
    <div v-else-if="degradedText" class="state neu-raised-md warn">
      <p class="state-title">上游限流中</p>
      <p class="state-msg neu-t2">{{ degradedText }} 稍等一下再试，不是歌单本身有问题。</p>
      <button type="button" class="retry" @click="load">
        <NeuIcon name="refresh" :size="15" />
        再试一次
      </button>
    </div>

    <div v-else-if="tracks.length === 0" class="state neu-raised-md" data-block="empty-tracks">
      <p class="state-title">{{ emptyTitle }}</p>
      <p class="state-msg neu-t2" data-block="empty-hint">{{ emptyHint }}</p>
    </div>

    <template v-else>
      <div class="list neu-raised-md">
        <TrackRow
          v-for="(t, i) in shownTracks"
          :key="t.id"
          :track="t"
          :index="songIndexBase + i + 1"
          :list="tracks"
        />
      </div>

      <!-- 只有歌手页分页：其余类型的列表本身就短 -->
      <div
        v-if="isArtist && (songPages > 1 || songsHasMore)"
        class="pager"
        data-pager="songs"
      >
        <NeuIconButton
          icon="chevron-left"
          label="上一页歌曲"
          data-nav="songs-prev"
          size="md"
          :disabled="songPage <= 1"
          @click="goSongPage(-1)"
        />
        <template v-for="(p, i) in songPageNumbers" :key="`so-${i}`">
          <span v-if="p === 'gap'" class="pager-gap" aria-hidden="true">…</span>
          <button
            v-else
            type="button"
            class="page-num"
            :class="{ 'is-on': p === songPage }"
            :aria-label="`第 ${p} 页歌曲`"
            :aria-current="p === songPage ? 'true' : undefined"
            @click="songPage = p"
          >
            {{ pad2(p) }}
          </button>
        </template>
        <button
          v-if="songsHasMore"
          type="button"
          class="more"
          :disabled="songsLoadingMore"
          data-role="songs-more"
          @click="moreSongs"
        >
          {{ songsLoadingMore ? '加载中' : '加载更多' }}
        </button>
        <NeuIconButton
          icon="chevron-right"
          label="下一页歌曲"
          data-nav="songs-next"
          size="md"
          :disabled="!(songPage < songPages || songsHasMore)"
          @click="nextSong()"
        />
      </div>
    </template>

    <!-- 相似歌手。补充内容的补充：静默加载，为空就整节不出现 -->
    <section
      v-if="isArtist && (simiLoading || simiArtists.length > 0)"
      class="simi"
      data-block="artist-similar"
    >
      <h2 class="sec-title">相似歌手</h2>
      <div class="simi-chips">
        <template v-if="simiLoading">
          <NeuSkeleton v-for="i in 4" :key="i" height="32px" width="96px" radius="pill" />
        </template>
        <button
          v-for="a in simiArtists"
          v-else
          :key="a.id"
          type="button"
          class="simi-chip"
          :aria-label="`查看相似歌手 ${a.name}`"
          @click="openArtist(a.id, a.name)"
        >
          {{ a.name }}
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.collection {
  padding-top: var(--sp-5);
  padding-bottom: var(--sp-7);
  display: flex;
  flex-direction: column;
  gap: var(--sp-5);
}

.head {
  display: flex;
  gap: var(--sp-5);
  align-items: flex-end;
}

.art {
  width: 180px;
  height: 180px;
  border-radius: var(--r-xl);
  overflow: hidden;
  flex: none;
}
.art img,
.art-ph {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: inherit;
  background: var(--track);
}
.art-ph {
  display: block;
  background: var(--bg);
  box-shadow:
    inset 4px 4px 10px var(--sd),
    inset -4px -4px 10px var(--sl);
}

.info {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  min-width: 0;
  flex: 1 1 auto;
}
.kind {
  font-size: var(--fs-xs);
  color: var(--t2);
  letter-spacing: 0.8px;
}
.title {
  font-size: var(--fs-3xl);
  color: var(--t1);
  line-height: var(--lh-tight);
}
.sub {
  font-size: var(--fs-sm);
  color: var(--t2);
}

.head-actions {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  margin-top: var(--sp-2);
  flex-wrap: wrap;
}
.play-all {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-3) var(--sp-5);
  border-radius: var(--r-pill);
  color: #fff;
  background: var(--accent);
  font-size: var(--fs-sm);
  font-weight: var(--fw-medium);
  box-shadow:
    2px 2px 5px var(--sd),
    -2px -2px 5px var(--sl);
}
:root[data-theme='dark'] .play-all {
  color: #2b1a0e;
}
.play-all:active {
  box-shadow: 1px 1px 2px var(--sd);
  transform: scale(0.98);
}
.fav-all {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-3) var(--sp-5);
  border-radius: var(--r-pill);
  font-size: var(--fs-sm);
  font-weight: var(--fw-medium);
  color: var(--t1);
  background: var(--bg);
  box-shadow:
    2px 2px 5px var(--sd),
    -2px -2px 5px var(--sl);
  transition: opacity 0.2s, box-shadow 0.2s;
}
.fav-all:active:not(:disabled) {
  box-shadow: 1px 1px 2px var(--sd);
  transform: scale(0.98);
}
.fav-all:disabled {
  opacity: 0.55;
  cursor: default;
}
.fav-all.is-done {
  color: var(--accent);
}
.fav-toast {
  font-size: var(--fs-xs);
  color: var(--accent);
  font-weight: var(--fw-medium);
}
.toast-fade-enter-active,
.toast-fade-leave-active {
  transition: opacity 0.3s;
}
.toast-fade-enter-from,
.toast-fade-leave-to {
  opacity: 0;
}

.desc-box {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.desc {
  font-size: var(--fs-sm);
  color: var(--t2);
  line-height: 1.8;
  white-space: pre-wrap;
  padding: var(--sp-3) var(--sp-4);
  border-radius: var(--r-lg);
  box-shadow:
    inset 1px 1px 3px var(--sd),
    inset -1px -1px 3px var(--sl);
}
/* 折叠只是**默认态**，不是终态 —— 折叠必须配一个展开入口（见 .desc-toggle）。
   上一版只有 max-height + overflow:hidden，长介绍的后半截永远看不到。 */
.desc.is-clamped {
  max-height: 5.4em;
  overflow: hidden;
}
.desc-toggle {
  align-self: flex-start;
  padding: var(--sp-1) var(--sp-3);
  border-radius: var(--r-pill);
  font-size: var(--fs-xs);
  color: var(--accent-text);
  background: var(--bg);
  box-shadow:
    1px 1px 3px var(--sd),
    -1px -1px 3px var(--sl);
}
.desc-toggle:focus-visible {
  outline: 2px solid var(--accent-text);
  outline-offset: 2px;
}

.list {
  padding: var(--sp-2);
  border-radius: var(--r-xl);
}
.sk {
  padding: var(--sp-3);
}

/* ---------- 歌手专辑 ---------- */
.albums {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}
.sec-title {
  font-size: var(--fs-lg);
  font-weight: var(--fw-bold);
  color: var(--t1);
}
/* 与首页一致：卡片型点击区必须是 button + aria-label，
   不能是"看起来像链接、其实点不动"的东西 */
.grid-btn {
  display: block;
  width: 100%;
  text-align: left;
  border-radius: var(--r-lg);
}
.grid-btn:focus-visible {
  outline: 2px solid var(--accent-text);
  outline-offset: 4px;
}
.sk-card {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.sk-art {
  aspect-ratio: 1;
  height: auto;
}

/* ---------- 相似歌手 ---------- */
.simi {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}
.simi-chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-3);
}
.simi-chip {
  padding: var(--sp-2) var(--sp-4);
  border-radius: var(--r-pill);
  font-size: var(--fs-sm);
  color: var(--t1);
  background: var(--bg);
  box-shadow:
    1px 1px 3px var(--sd),
    -1px -1px 3px var(--sl);
  transition: box-shadow var(--dur-fast) var(--ease);
}
.simi-chip:hover {
  color: var(--accent-text);
}
.simi-chip:active {
  box-shadow:
    inset 1px 1px 3px var(--sd),
    inset -1px -1px 3px var(--sl);
}
.simi-chip:focus-visible {
  outline: 2px solid var(--accent-text);
  outline-offset: 2px;
}

/* ---------- 分页 ---------- */
/* 与首页海报位同一套控件语言：两侧圆钮 + 中间页码 */
.pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-4);
  margin-top: var(--sp-4);
}
.pager-hint {
  font-size: var(--fs-sm);
  font-variant-numeric: tabular-nums;
  min-width: 56px;
  text-align: center;
}
/* 页码按钮：当前页拉成小胶囊，与首页指示点同一套语言 */
.page-num {
  min-width: 32px;
  padding: var(--sp-1) var(--sp-2);
  border-radius: var(--r-pill);
  font-size: var(--fs-sm);
  font-variant-numeric: tabular-nums;
  color: var(--t2);
  background: var(--bg);
  box-shadow:
    1px 1px 3px var(--sd),
    -1px -1px 3px var(--sl);
  transition:
    color var(--dur-fast) var(--ease),
    box-shadow var(--dur-fast) var(--ease);
}
.page-num.is-on {
  color: var(--accent-text);
  font-weight: var(--fw-medium);
  box-shadow:
    inset 1px 1px 3px var(--sd),
    inset -1px -1px 3px var(--sl);
}
.page-num:focus-visible,
.more:focus-visible {
  outline: 2px solid var(--accent-text);
  outline-offset: 2px;
}
.pager-gap {
  color: var(--t2);
  font-size: var(--fs-sm);
}
/* 「加载更多」是这一排里唯一会打上游的动作，做成文字按钮以示区别 */
.more {
  padding: var(--sp-2) var(--sp-4);
  border-radius: var(--r-pill);
  font-size: var(--fs-sm);
  color: var(--accent-text);
  background: var(--bg);
  box-shadow:
    1px 1px 3px var(--sd),
    -1px -1px 3px var(--sl);
}
.more:disabled {
  color: var(--t2);
  box-shadow:
    inset 1px 1px 3px var(--sd),
    inset -1px -1px 3px var(--sl);
}

.state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-7) var(--sp-5);
  border-radius: var(--r-xl);
  text-align: center;
}
.warn {
  box-shadow:
    3px 3px 7px var(--sd),
    -3px -3px 7px var(--sl),
    inset 0 0 0 2px var(--accent-text);
}
.state-title {
  font-size: var(--fs-lg);
  font-weight: var(--fw-bold);
  color: var(--t1);
}
.state-msg {
  font-size: var(--fs-sm);
  max-width: 46ch;
  line-height: 1.7;
}
.retry {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  margin-top: var(--sp-2);
  padding: var(--sp-2) var(--sp-5);
  border-radius: var(--r-pill);
  color: var(--accent-text);
  font-size: var(--fs-sm);
  font-weight: var(--fw-medium);
  background: var(--bg);
  box-shadow:
    1px 1px 3px var(--sd),
    -1px -1px 3px var(--sl);
}
.retry:active {
  box-shadow:
    inset 1px 1px 3px var(--sd),
    inset -1px -1px 3px var(--sl);
}

@media (max-width: 767px) {
  .head {
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: var(--sp-4);
  }
  .art {
    width: 148px;
    height: 148px;
  }
  .info {
    align-items: center;
  }
  .title {
    font-size: var(--fs-xl);
  }
}
</style>
