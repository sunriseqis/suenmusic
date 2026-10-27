/**
 * QQ 音乐数据适配器。
 *
 * 搬运自桌面端 src/api/qq/adapter.js，两处改动：
 *
 * 1. 去掉 `window.__qqTracksPool` —— 那是浏览器端为跨路由找回 Track 对象搞的
 *    全局缓存，服务端由 HTTP 响应本身承载数据，不需要它。
 * 2. `Track.ar[].id` 与 `Track.al.id` 统一输出**路由键**（`qq_ar_` / `qq_al_`）。
 *    原前端在这里输出 QQ 的数字 id，而跳转组件里又靠 mid 重新拼一次，两边口径
 *    不一致，任何一处漏改就会退化成数字 id 并打到网易云接口。服务端直接输出
 *    路由键后，客户端的转换函数仍然是幂等的（它基于 mid 而非 id）。
 *
 * 字段兼容策略保持不变：QQ 在不同接口里对同一概念使用不同字段名（搜索分片是
 * 扁平结构，详情接口是嵌套结构），全部在这里兼容，调用方不需要关心来源。
 */

export type QQRecord = Record<string, any>;

export interface TrackArtist {
  id: string;
  mid: string;
  name: string;
  picUrl: string;
}

export interface TrackAlbum {
  id: string;
  mid: string;
  name: string;
  picUrl: string;
}

export interface Track {
  /** 形如 qq_<songmid> */
  id: string;
  mid: string;
  name: string;
  ar: TrackArtist[];
  /** 与 ar 相同，保留别名以兼容前端既有代码 */
  artists: TrackArtist[];
  al: TrackAlbum;
  album: { id: string; name: string; picUrl: string };
  /** 时长（毫秒） */
  dt: number;
  /** 时长（秒） */
  duration: number;
  playable: boolean;
  matched: boolean;
  privilege: {
    playMaxbr: number;
    maxbr: number;
    freeTrialPrivilege: { resConsumable: boolean };
  };
  recommendReason?: string;
}

export interface Album {
  id: string;
  mid: string;
  name: string;
  picUrl: string;
  publishTime: string;
  description: string;
  company: string;
  type: string;
  size: number;
  artists: TrackArtist[];
  artist: TrackArtist | { name: string };
}

export interface Artist {
  id: string;
  mid: string;
  name: string;
  picUrl: string;
  img1v1Url: string;
  alias: string[];
  albumSize: number;
  musicSize: number;
  mvSize: number;
  briefDesc: string;
}

export interface Playlist {
  id: string;
  tid: string | number | undefined;
  name: string;
  picUrl: string;
  coverImgUrl: string;
  playCount: number;
  copywriter: string;
  description: string;
  size: number;
  updateFrequency: string;
  type: 'playlist';
}

/**
 * QQ 返回的榜单简介等字段带 HTML 标签（如 `<br>`），而模板普遍使用文本插值，
 * 会把标签原样显示出来，这里统一转成纯文本（`<br>` → 换行）。
 */
export function toPlainText(str: unknown): string {
  if (!str || typeof str !== 'string') return '';
  return str
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * QQ 图床尺寸按路径前缀分档，实测：
 * - T001（歌手头像）/ T002（专辑封面）：150 / 300 / 500 / 800 可用
 * - T003（榜单、歌单封面）：最高只到 500，800 必 404
 * - T015（MV 封面）：16:9 固定 640x360，不可改写
 * 这里只生成 T001 / T002，其余前缀不要套用同一套尺寸表。
 */
export function getAlbumCoverUrl(albumMid: string, size = 300): string {
  if (!albumMid) return '';
  return `https://y.gtimg.cn/music/photo_new/T002R${size}x${size}M000${albumMid}.jpg`;
}

export function getSingerAvatarUrl(singerMid: string, size = 300): string {
  if (!singerMid) return '';
  return `https://y.gtimg.cn/music/photo_new/T001R${size}x${size}M000${singerMid}.jpg`;
}

/**
 * 把回源图片地址统一成 https。
 *
 * QQ 图床对同一张图会按调用方返回 http 或 https（实测两种协议都通），
 * 但**页面一旦部署到 https，页面里的 http 图会被浏览器当作混合内容直接拦掉** ——
 * 表现为"本地开发好好的、上线后封面整片空白"。
 * 上游给什么协议不由我们决定，所以在服务端统一转掉，客户端不必各自处理。
 *
 * 只动 `y.gtimg.cn`：`qpic.y.qq.com` 之类带签名 query 的图床改写协议
 * 可能让签名失效，宁可原样返回。
 */
export function toHttpsImage(url: string): string {
  if (!url) return url;
  return url.replace(/^http:\/\/y\.gtimg\.cn\//, 'https://y.gtimg.cn/');
}

/**
 * 歌手条目 → `TrackArtist`。
 *
 * 曲目内嵌的 `singer`、专辑详情的 `data.singer.singerList` 都是这个形状，
 * 所以导出给调用方复用，免得各处再写一遍字段兼容。
 */
export function adaptQQTrackArtist(s: QQRecord): TrackArtist {
  const mid = s?.mid || s?.singerMID || s?.singer_mid || '';
  return {
    // 输出路由键，避免数字 id 流到客户端后被当成网易云 id 使用
    id: mid ? `qq_ar_${mid}` : String(s?.id || s?.singerID || ''),
    mid,
    name: s?.name || s?.title || s?.singerName || '',
    picUrl: toHttpsImage(s?.picUrl || getSingerAvatarUrl(mid)),
  };
}

/**
 * 将 QQ 音乐单曲标准化为内部 Track 结构。
 */
/**
 * 伴奏版（卡拉 OK 版）的后缀。
 *
 * ⚠️ 必须同时看 **`title`** 和 `name`：QQ 的搜索分片里 `name` 只给主名
 * （"如果爱忘了"），后缀只在 `title` 里（"如果爱忘了 (伴奏)"）。
 * 只看 `name` 会漏判 —— 于是原曲与伴奏曲在列表里**显示成同一个名字**，
 * 既分不清、也不该作为两首歌出现（用户实测反馈）。
 *
 * 这里只收 `伴奏`，不收 `KARAOKE版` / `Live版`：后者可能是该曲唯一的版本，
 * 一刀切会把歌整个删掉；而"伴奏"几乎总是原曲的附赠重复项。
 */
const ACCOMPANIMENT_RE = /[（(][^）)]*伴奏[^）)]*[）)]/i;

/**
 * 把可能带 `songInfo` 包装的条目解包成扁平条目。
 *
 * 专辑详情（`GetAlbumSongList`）返回 `{ songInfo: {...}, listenCount, ... }`，
 * 而搜索分片是扁平的。只在调用点解包容易漏，所以判定与去重都先过这里 ——
 * 漏解包的后果是**静默失效**（读到 undefined，什么都不删），
 * 比报错更难发现：列表看着有数据，只是混进了重复项。
 */
function unwrapRaw<T extends QQRecord | null | undefined>(item: T): T {
  const inner = (item as any)?.songInfo;
  return inner && typeof inner === 'object' ? (inner as T) : item;
}

export function isAccompaniment(raw: QQRecord | null | undefined): boolean {
  const r = unwrapRaw(raw);
  const text = String(r?.title ?? r?.name ?? '');
  return ACCOMPANIMENT_RE.test(text);
}

/**
 * 去掉伴奏版曲目。
 *
 * 若**整张列表全是伴奏**则原样返回 —— 把列表清成空只会得到"这个专辑是空的"，
 * 比留着重复项更糟（空态还容易被误读成版权限制）。
 */
export function withoutAccompaniment<T extends QQRecord | null | undefined>(list: T[]): T[] {
  const kept = list.filter(item => !isAccompaniment(item));
  return kept.length > 0 ? kept : list;
}

/** 从原始条目里取曲目 mid（各接口字段名不统一） */
function rawMid(item: QQRecord | null | undefined): string {
  const r = unwrapRaw(item);
  return String(r?.mid ?? r?.songmid ?? r?.id ?? r?.songid ?? '');
}

/**
 * 按曲目 mid 去重（保留首次出现）。
 *
 * 上游**确实会返回重复项** —— 用户实测周深《大梦归》同一首出现两次，
 * 客户端就渲染出两行一模一样的歌。去重是纯收益：同一 mid 本来就是同一首，
 * 留两条没有任何信息增量。
 *
 * 取不到 mid 的条目原样保留（宁可多显示一条，也不要靠空 key 误删）。
 */
export function dedupeRawByMid<T extends QQRecord | null | undefined>(list: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of list) {
    const key = rawMid(item);
    if (key) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(item);
  }
  return out;
}

/**
 * 把上游的原始曲目列表一次性标准化——**所有列表都应该走这里**。
 *
 * 四步固定顺序，任何一步漏掉都是**静默失效**（列表看着有数据，只是混进了
 * 重复项/伴奏），比报错难发现得多，所以收口成一个函数：
 *
 *   1. 解包 `songInfo`（专辑详情用包装结构，不解包就读不到 mid/name）
 *   2. 去掉伴奏版（原曲的附赠重复项，显示出来与原曲同名）
 *   3. 按 mid 去重（上游确实会返回重复项）
 *   4. 适配并丢掉 null
 */
export function adaptQQTracks(list: unknown[] | null | undefined): Track[] {
  return dedupeRawByMid(withoutAccompaniment(((list ?? []) as QQRecord[]) ?? []))
    .map(adaptQQSong)
    .filter((x): x is Track => x !== null);
}

export function adaptQQSong(song: QQRecord | null | undefined): Track | null {
  if (!song) return null;
  // 兼容专辑详情的 `songInfo` 包装：不解包会读不到 mid/name，输出哑曲目
  const song0 = unwrapRaw(song);

  const mid = song0.mid || song0.songmid || '';
  const rawId = song0.id || song0.songid || mid;
  // 显示名用 `name`（QQ 的主名）。带版本后缀的完整名在 `title` 里
  // （"女孩 (DJ版)"），但这类 DJ 版/综艺版本按用户拍板视为库内噪音：
  // 推荐链路已按"无专辑归属"整体打回，不值得为它们做名字兼容。
  const name = song0.name || song0.songname || song0.title || '';
  const interval = song0.interval || song0.duration || 0;

  // 既无 mid 也无 rawId → 这不是一条可寻址的曲目（详情接口对「原声/上传」类会返回空壳）。
  // 不拦的话会产出 id='qq_' 的垃圾行，落库后还会污染封面兜底与去重。
  if (!mid && !rawId) return null;

  const singers = (song0.singer || song0.singer_list || []).map(adaptQQTrackArtist);

  const albumMid = song0.album?.mid || song0.albummid || '';
  const albumName =
    song0.album?.name || song0.albumname || song0.album?.title || '';
  const albumRouteId = albumMid
    ? `qq_al_${albumMid}`
    : String(song0.album?.id || song0.albumid || '');

  /**
   * 封面：优先专辑图；**没有专辑 mid 时退回歌手头像**。
   *
   * QQ 的「原声/上传」类条目（如「@夏日入侵企画创作的原声…」）没有专辑绑定，
   * `al.mid`/`al.name` 都是空 —— 直接算专辑图会得到空串，列表里就是一片空白。
   * 歌手头像 URL 是确定性的（T001R300x300M000{mid}.jpg），零额外请求。
   */
  const coverUrl = getAlbumCoverUrl(albumMid) || getSingerAvatarUrl(singers[0]?.mid ?? '');

  return {
    id: `qq_${mid || rawId}`,
    mid,
    name,
    ar: singers,
    artists: singers,
    al: {
      id: albumRouteId,
      mid: albumMid,
      name: albumName,
      picUrl: coverUrl,
    },
    album: {
      id: albumRouteId,
      name: albumName,
      picUrl: coverUrl,
    },
    dt: interval * 1000,
    duration: interval,
    playable: true,
    matched: true,
    privilege: {
      playMaxbr: 320000,
      maxbr: 320000,
      freeTrialPrivilege: { resConsumable: true },
    },
  };
}

/**
 * 榜单信息。
 *
 * 首页卡片与详情页**共用这一套字段名** —— 上游这两个接口的字段名并不一样
 * （详情接口给的是 `title` / `frontPicUrl` / `updateTips`），
 * 在这里统一收口，客户端只认一种叫法。
 */
export interface ToplistInfo {
  id: string;
  topId: number;
  name: string;
  picUrl: string;
  coverImgUrl: string;
  updateFrequency: string;
  playCount: number;
  type: 'toplist';
  songList: Array<{ name: string; singer: string }>;
  /** 榜单简介。只有详情接口提供，已转纯文本 */
  intro?: string;
}

/**
 * 将 QQ 音乐榜单适配为排行榜卡片。
 *
 * @param withSongs 详情页自己已经带了完整曲目列表，再附一份精简的
 *   `songList` 只是白白多传几百条，所以详情页传 `false`。
 */
export function adaptQQToplist(
  topItem: QQRecord | null | undefined,
  opts: { withSongs?: boolean } = {}
): ToplistInfo | null {
  if (!topItem) return null;
  const cover = toHttpsImage(topItem.frontPicUrl || topItem.headPicUrl || '');
  return {
    id: `qq_top_${topItem.topId}`,
    topId: topItem.topId,
    name: topItem.title || '',
    picUrl: cover,
    coverImgUrl: cover,
    updateFrequency: topItem.updateTips || '每日更新',
    playCount: topItem.listenNum || 0,
    type: 'toplist',
    songList:
      opts.withSongs === false
        ? []
        : (topItem.song || []).map((s: QQRecord) => ({
            name: s.title,
            singer: s.singerName,
          })),
  };
}

/**
 * 将 QQ 音乐歌手（搜索结果 / 详情）标准化为 Artist。
 *
 * 两种来源字段命名不同：
 * - 搜索结果（search_type=1）是**扁平**结构：singerMID / singerName / singerPic / songNum / albumNum / mvNum
 * - 歌手详情（GetSingerDetail）是 basic_info 嵌套结构，且 **不含任何统计数字**
 */
export function adaptQQArtist(item: QQRecord | null | undefined): Artist | null {
  if (!item) return null;

  const basic = item.basic_info || item;
  const mid =
    basic.singer_mid || basic.singerMID || basic.mid || basic.singerMid || '';
  const pics = item.pic || {};
  const name = basic.name || basic.singerName || '';
  const avatar = toHttpsImage(
    pics.pic ||
      pics.avatar ||
      basic.singerPic ||
      basic.singer_pic ||
      getSingerAvatarUrl(mid)
  );
  const alias = basic.other_name || basic.alias || [];

  return {
    id: `qq_ar_${mid}`,
    mid,
    name,
    picUrl: avatar,
    // 歌手页模板读的是 img1v1Url，必须一并提供，否则头像空白
    img1v1Url: avatar,
    alias: Array.isArray(alias) ? alias : [],
    albumSize: basic.album_num ?? basic.albumNum ?? 0,
    musicSize: basic.song_num ?? basic.songNum ?? 0,
    mvSize: basic.mv_num ?? basic.mvNum ?? 0,
    briefDesc: (item.ex_info && item.ex_info.desc) || basic.desc || '',
  };
}

/**
 * 将 QQ 音乐专辑（搜索结果 / 详情）标准化为 Album 结构。
 */
export function adaptQQAlbum(
  item: QQRecord | null | undefined,
  extra: { size?: number; artists?: TrackArtist[] } = {}
): Album | null {
  if (!item) return null;

  const basic = item.basicInfo || item.basic_info || item;
  const mid = basic.albumMid || basic.albumMID || basic.mid || '';

  // 三处来源的歌手字段名各不相同：
  //   GetAlbumDetail 的 basicInfo **完全不含歌手**，需由调用方从曲目列表回填（extra.artists）
  //   搜索分片是 `singer`
  //   新碟首发（newalbum.NewAlbumServer）是扁平的 `singers`
  const rawSingers =
    basic.singer || basic.singer_list || basic.singers || extra.artists || [];
  let artists: TrackArtist[] = rawSingers.map(adaptQQTrackArtist);

  /**
   * 搜索分片（album）不提供 `singer` 数组，只给 `singerName` / `singerMID` 两个字符串。
   * 不补这一步，歌手页专辑列表就会整列显示「未知歌手」，
   * 而且归属过滤拿不到歌手 mid/名字 → 别人的专辑混进来（实测「夏日入侵企画的救赎（版本1）」）。
   */
  if (artists.length === 0) {
    const names = String(basic.singerName ?? '')
      .split(/[、,，&/]/)
      .map((s: string) => s.trim())
      .filter(Boolean);
    const mids = String(basic.singerMID ?? '')
      .split(/[、,，&/]/)
      .map((s: string) => s.trim())
      .filter(Boolean);
    artists = names.map((n: string, i: number) => ({
      id: `qq_ar_${mids[i] ?? ''}`,
      mid: mids[i] ?? '',
      name: n,
      picUrl: getSingerAvatarUrl(mids[i] ?? ''),
    }));
  }

  return {
    id: `qq_al_${mid}`,
    mid,
    name: basic.albumName || basic.album_name || basic.name || '',
    // 搜索分片的封面字段是 albumPic，详情分片是 pic。
    // 新碟接口**一张图都不给**，只能按 mid 自己拼 T002 图床地址。
    picUrl: toHttpsImage(
      basic.pic || basic.albumPic || basic.album_pic || getAlbumCoverUrl(mid)
    ),
    // `release_time` 只在新碟接口出现，写成 `2026-09-11` 形态
    publishTime:
      basic.publishDate ||
      basic.publish_date ||
      basic.publicTime ||
      basic.release_time ||
      '',
    description: basic.desc || basic.introduction || '',
    company: basic.company || '',
    type: basic.type === 10002 ? 'Single' : basic.albumType || '',
    size: extra.size || basic.songNum || basic.song_count || 0,
    artists,
    artist: artists[0] || { name: '' },
  };
}

/**
 * 将 QQ 音乐歌单标准化为歌单卡片。
 */
export function adaptQQPlaylist(
  item: QQRecord | null | undefined
): Playlist | null {
  if (!item) return null;

  const tid =
    item.tid || item.content_id || item.dissid || item.dissId || item.id;
  const cover =
    item.cover_url_big || item.cover || item.imgurl || item.diss_cover || '';
  const creator = item.creator || {};

  return {
    id: `qq_pl_${tid}`,
    tid,
    name: item.title || item.dissname || item.rcmdcontent || '',
    picUrl: cover,
    coverImgUrl: cover,
    playCount: item.listen_num || item.listennum || item.listenNum || 0,
    copywriter:
      (typeof creator === 'object' ? creator.name : creator) ||
      item.creator_name ||
      'QQ音乐精选',
    description: item.introduction || '',
    size: item.song_count || item.songCount || 0,
    updateFrequency: item.modifytime || '',
    type: 'playlist',
  };
}

export function adaptQQMv(item: QQRecord | null | undefined) {
  if (!item) return null;
  const singer = (item.singer_list || [])[0] || {};
  return {
    id: `qq_mv_${item.mv_id || item.vid}`,
    vid: item.v_id || '',
    name: item.mv_name || '',
    title: item.mv_name || '',
    cover: item.mv_pic_url || '',
    imgurl16v9: item.mv_pic_url || '',
    duration: item.duration || 0,
    playCount: item.play_count || 0,
    publishTime: item.publish_date || '',
    artistName: singer.name || item.singer_name || '',
    artistId: singer.mid ? `qq_ar_${singer.mid}` : '',
  };
}
