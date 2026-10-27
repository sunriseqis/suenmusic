/**
 * 目录类路由：搜索、首页、榜单、专辑、歌手、单曲、歌词、QQ 歌单。
 * （分类广场与全部榜单列表在 `routes/plaza.ts`）
 *
 * 统一约定：
 *   - 所有返回的 Track / Album / Artist 里的 `id` 都是**路由键**（`qq_` 前缀 + mid），
 *     客户端拿到就能直接跳转，不需要自己拼前缀。
 *   - 拿到曲目就顺手写进 tracks 缓存表，这样收藏/歌单/历史里只存 id 也能显示出内容。
 *   - 上游返回空时区分"真的没有"与"被限流"：后者带上 `degraded`，
 *     客户端据提示用户，而不是干巴巴显示"无结果"。
 *   - **全部端点都要求登录**。这些接口会消耗 QQ 侧的请求配额，公开出去等于
 *     把服务端变成任何人都能白用的 QQ 音乐代理，风控也会因此更容易被触发。
 */

import type { FastifyInstance } from 'fastify';
import { createLogger } from '../logger.ts';
import { getTrack, getTracks, upsertTracks } from '../db/repo/tracks.ts';
import { getAlbumDetail } from '../sources/qq/album.ts';
import { getArtistAlbums, getArtistDetail, getArtistSongs } from '../sources/qq/artist.ts';
import { getSimilarArtists } from '../services/similar-artists.ts';
import { readDailyWelcomePhrase, bootstrapDailyIfEmpty } from '../services/daily-recommend.ts';
import {
  getHomeData,
  getPlaylistDetail,
  getSongDetail,
  getToplistDetail,
} from '../sources/qq/home.ts';
import { getQQLyric } from '../sources/qq/lyric.ts';
import { getLyricForTrack } from '../services/lyric-fallback.ts';
import { isCoverOrInstrumental } from '../services/content-filter.ts';
import { QQ_SEARCH_ALL_SLICES, QQ_SEARCH_TYPE, searchQQ } from '../sources/qq/search.ts';
import { kugouSearchSongs } from '../sources/kugou/source.ts';
import { searchSongsMulti } from '../services/multi-search.ts';
import { netease, neteaseRequest } from '../sources/netease/vendor.ts';
import type { Track } from '../sources/qq/adapter.ts';
import { getDatabase } from '../db/index.ts';
import { currentNeteaseCookie } from '../services/netease-account.ts';
import { getKugouCreds } from '../sources/kugou/stream.ts';
import type { QQSearchSlice } from '../sources/qq/search.ts';
import { badRequest, notFound } from '../http/errors.ts';
import { parseId, parseIdWithFallback } from '../http/ids.ts';
import { intParam, requiredParam, strParam } from '../http/params.ts';
import { requireUser } from '../http/require-auth.ts';

const log = createLogger('routes:catalog');

/** 客户端搜索类型 → QQ 分片集合 */
const SEARCH_TYPE_MAP: Record<string, QQSearchSlice[]> = {
  all: QQ_SEARCH_ALL_SLICES,
  song: ['song'],
  album: ['album'],
  artist: ['singer'],
  playlist: ['songlist'],
  mv: ['mv'],
};

export function registerCatalogRoutes(app: FastifyInstance): void {
  /**
   * 首页聚合。一次往返拿全新碟首发 / 新歌首发 / 巅峰榜。
   */
  app.get('/api/home', async (req, reply) => {
    const user = requireUser(req);
    const data = await getHomeData();
    upsertTracks(data.newSongs);

    // 开屏短语只读；只有「还没有可用歌单」时才补一次首次生成。
    // 原实现在「日期不是今天或没有欢迎语」时就触发生成 —— 那等于把懒加载和手动重建口子留在了首页。
    const welcomePhrase = readDailyWelcomePhrase(user.id);
    bootstrapDailyIfEmpty(user.id);

    // 首页数据变动很慢，允许客户端缓存 5 分钟，减少上游压力。
    // 必须 private：响应随用户鉴权，绝不能让中间层当公共资源缓存。
    reply.header('Cache-Control', 'private, max-age=300');
    return { ...data, welcomePhrase };
  });

  /**
   * 搜索。
   *
   * `type` 只在需要时请求对应分片 —— QQ 的每个分片都是一次独立请求，
   * 综合搜索会并发 4 次，单类型搜索只发 1 次。
   */
  app.get('/api/search', async (req, reply) => {
    requireUser(req);
    const query = requiredParam((req.query as any)?.q, 'q');
    const type = strParam((req.query as any)?.type) || 'all';
    const page = intParam((req.query as any)?.page, 1, { min: 1, max: 100 });
    const limit = intParam((req.query as any)?.limit, 30, { min: 1, max: 50 });

    const slices = SEARCH_TYPE_MAP[type];
    if (!slices) {
      throw badRequest(
        `不支持的 type：${type}（可选 all / song / album / artist / playlist / mv）`,
        'invalid_type'
      );
    }

    const offset = (page - 1) * limit;

    /**
     * 单曲分片走多源聚合（酷狗为主 + QQ 兜底，带零翻唱过滤）。
     *
     * 只在第一页生效：酷狗搜索没有可靠的翻页游标，翻页仍交给 QQ 保持行为可预期。
     * 其余分片（专辑/歌手/歌单/MV）维持 QQ —— 那是门面数据，权威度更高。
     */
    const multi = slices.includes('song') && page === 1 ? await searchSongsMulti(query, limit) : null;
    const qqSlices = multi ? slices.filter(s => s !== 'song') : slices;
    const result = await searchQQ(query, { offset, limit, slices: qqSlices });
    log.debug(
      `多源搜索 q=${query} page=${page} multi=${multi ? multi.songs.length + '/' + multi.sources.join(',') : 'null'}`,
    );
    if (multi) {
      result.songs = multi.songs;
      result.degraded = result.degraded || multi.degraded;
    } else {
      upsertTracks(result.songs);
    }

    reply.header('Cache-Control', 'private, max-age=60');

    return {
      query,
      type,
      page,
      limit,
      songs: result.songs,
      albums: result.albums,
      artists: result.artists,
      playlists: result.playlists,
      mvs: result.mvs,
      /*
       * 分片级 hasMore。**不能只用一个顶层布尔值**：
       * 原来写成 `songs.length >= limit`，于是搜歌手/专辑/歌单时 songs 恒为空，
       * hasMore 永远是 false —— 明明还有下一页，客户端却翻不动。
       *
       * 另外它只表示"上游这一页被填满了 = 大概还有下一页"，**不是总数** ——
       * QQ 搜索响应里根本没有总数字段（每个分片只有 list），所以别拿它当总数。
       */
      hasMore: {
        song: slices.includes('song') && result.songs.length >= limit,
        album: slices.includes('album') && result.albums.length >= limit,
        artist: slices.includes('singer') && result.artists.length >= Math.min(limit, 30),
        playlist: slices.includes('songlist') && result.playlists.length >= limit,
      },
      degraded: result.degraded,
    };
  });

  /**
   * 酷狗搜索（独立端点，探索用）。
   *
   * 为什么不直接并进 /api/search：酷狗曲目 id 是 `kg_<albumAudioId>`，与全站
   * `qq_<songmid>` 路由约定不同——硬塞进同一响应需要三端改 id 语义（风险大）。
   * 独立端点先服务「QQ 搜不到时的探索」，后续做 id 双向映射后再聚合。
   */
  app.get('/api/search/kugou', async req => {
    requireUser(req);
    const query = requiredParam((req.query as any)?.q, 'q');
    const limit = intParam((req.query as any)?.limit, 30, { min: 1, max: 50 });
    const creds = getKugouCreds();
    const songs = await kugouSearchSongs(query, limit, creds ?? undefined);
    return { query, songs };
  });

  /** 榜单详情。id 接受 `qq_top_26` 或裸 `26`。 */
  app.get('/api/toplist/:id', async req => {
    requireUser(req);
    const raw = (req.params as any).id as string;
    const parsed = parseIdWithFallback(raw, 'toplist');
    const topId = Number(parsed?.value);
    if (!Number.isFinite(topId) || topId <= 0) {
      throw badRequest(`榜单 id 不合法：${raw}`, 'invalid_id');
    }

    const offset = intParam((req.query as any)?.offset, 0, { min: 0, max: 10_000 });
    const limit = intParam((req.query as any)?.limit, 100, { min: 1, max: 200 });

    const detail = await getToplistDetail(topId, offset, limit);
    upsertTracks(detail.tracks);

    return {
      id: `qq_top_${topId}`,
      topInfo: detail.topInfo,
      tracks: detail.tracks,
      hasMore: detail.tracks.length >= limit,
    };
  });

  /** QQ 官方歌单详情（与用户的歌单 `/api/playlists` 区分开） */
  app.get('/api/qq/playlist/:tid', async req => {
    requireUser(req);
    const raw = (req.params as any).tid as string;
    const parsed = parseIdWithFallback(raw, 'playlist');
    const tid = parsed?.value;
    if (!tid) throw badRequest(`歌单 id 不合法：${raw}`, 'invalid_id');

    const detail = await getPlaylistDetail(tid);
    if (!detail) throw notFound('歌单不存在或已下架');

    upsertTracks(detail.tracks);
    return detail;
  });

  /** 专辑详情 + 曲目 */
  app.get('/api/albums/:id', async req => {
    requireUser(req);
    const raw = (req.params as any).id as string;
    const parsed = parseIdWithFallback(raw, 'album');
    if (!parsed) throw badRequest(`专辑 id 不合法：${raw}`, 'invalid_id');
    if (parsed.kind !== 'album') {
      throw badRequest(`这不是专辑 id：${raw}`, 'invalid_id');
    }

    const limit = intParam((req.query as any)?.limit, 100, { min: 1, max: 200 });

    // ---- 多源专辑页 ----
    if (parsed.source === 'ne') {
      const detail = await getNeteaseAlbumDetail(parsed.value, limit);
      if (!detail) throw notFound('网易云专辑不存在');
      if (detail.songs.length > 0) upsertTracks(detail.songs);
      return { album: detail.album, songs: backfillCovers(detail.songs), notice: null };
    }
    if (parsed.source === 'kg') {
      const detail = await getKugouAlbumDetail(parsed.value, limit, strParam((req.query as any)?.name));
      if (!detail) throw notFound('酷狗专辑不存在（本地库无该专辑曲目，且未提供 name 无法回源）');
      return { album: detail.album, songs: backfillCovers(detail.songs), notice: null };
    }

    const detail = await getAlbumDetail(parsed.value, limit);
    if (!detail) throw notFound('专辑不存在');

    upsertTracks(detail.songs);
    return { album: detail.album, songs: detail.songs, notice: detail.notice };
  });

  /** 歌手详情。统计数字（专辑数 / MV 数）来自搜索分片补取。 */
  app.get('/api/artists/:id', async req => {
    requireUser(req);
    const raw = (req.params as any).id as string;
    const parsed = parseIdWithFallback(raw, 'artist');
    if (!parsed) throw badRequest(`歌手 id 不合法：${raw}`, 'invalid_id');
    if (parsed.kind !== 'artist') {
      throw badRequest(`这不是歌手 id：${raw}`, 'invalid_id');
    }

    // 多源：kg_ar_ / ne_ar_ 上游没有可用的「歌手详情」接口，
    // 用客户端带来的 name 组一个最小对象，避免点进歌手页直接 404。
    // picUrl 留给客户端用搜索结果里的歌手图（或首字母占位）。
    if (parsed.source !== 'qq') {
      const name = strParam((req.query as any)?.name) || guessArtistName(parsed.value);
      if (!name) throw notFound('歌手不存在（该源需要带 name 参数）');
      return {
        artist: {
          id: raw,
          mid: parsed.value,
          name,
          picUrl: strParam((req.query as any)?.picUrl) || '',
          img1v1Url: '',
          alias: [],
          albumSize: 0,
          musicSize: 0,
          mvSize: 0,
          briefDesc: '',
        },
      };
    }

    const artist = await getArtistDetail(parsed.value);
    if (!artist) throw notFound('歌手不存在');

    return { artist };
  });

  /** 网易云专辑详情 + 曲目（/api/v1/album/{id} 一次返回 album 与 songs） */
  const getNeteaseAlbumDetail = async (albumId: string, limit: number) => {
    try {
      const res: any = await netease.album(
        { id: Number(albumId), cookie: currentNeteaseCookie() },
        neteaseRequest,
      );
      const body = res?.body ?? {};
      const al = body.album ?? {};
      if (body.code !== 200 || !al.id) return null;
      const songs = ((body.songs ?? []) as Array<Record<string, any>>).slice(0, limit).map(s => {
        const ar = ((s.ar ?? []) as Array<Record<string, any>>).map(a => ({
          id: 'ne_ar_' + String(a.id ?? ''),
          mid: String(a.id ?? ''),
          name: String(a.name ?? ''),
          picUrl: '',
        }));
        const sal = (s.al ?? {}) as Record<string, any>;
        const dt = Number(s.dt ?? 0);
        const album = {
          id: 'ne_al_' + String(sal.id ?? '0'),
          mid: String(sal.id ?? '0'),
          name: String(sal.name ?? ''),
          picUrl: String(sal.picUrl ?? '').replace(/^http:/, 'https:'),
        };
        return {
          id: 'ne_' + String(s.id),
          mid: String(s.id),
          name: String(s.name ?? ''),
          ar,
          artists: ar,
          al: album,
          album,
          dt,
          duration: Math.round(dt / 1000),
          playable: true,
          matched: true,
          privilege: { playMaxbr: 0, maxbr: 0, freeTrialPrivilege: { resConsumable: false } },
        };
      });
      return {
        album: {
          id: 'ne_al_' + String(al.id),
          mid: String(al.id),
          name: String(al.name ?? ''),
          picUrl: String(al.picUrl ?? '').replace(/^http:/, 'https:'),
          publishTime: String(al.publishTime ?? ''),
          description: String(al.description ?? ''),
          company: String(al.company ?? ''),
          type: '',
          size: Number(al.size ?? songs.length),
          artists: ((al.artists ?? []) as Array<Record<string, any>>).map(a => ({
            id: 'ne_ar_' + String(a.id ?? ''),
            mid: String(a.id ?? ''),
            name: String(a.name ?? ''),
            picUrl: '',
          })),
          artist: { name: String(((al.artist ?? {}) as Record<string, any>).name ?? '') },
        },
        songs,
      };
    } catch (err) {
      log.warn(`网易云专辑详情失败 id=${albumId}: ${(err as Error).message}`);
      return null;
    }
  };

  /**
   * 酷狗专辑详情。
   *
   * 酷狗没有稳定的「按 albumId 取整张专辑」接口，所以走两步：
   *   ① 本地库已有该专辑的曲目（搜索阶段落过库）→ 直接用；
   *   ② 库里没有 → 用 name 回源聚合搜索，再按 al.mid 过滤。
   * 两者都不成返回 null（路由给出明确提示）。
   */
  const getKugouAlbumDetail = async (albumId: string, limit: number, name?: string) => {
    const albumRouteId = `kg_al_${albumId}`;
    const collect = (rows: Track[]) =>
      rows
        .filter(t => String(t.al?.id ?? '') === albumRouteId)
        .slice(0, limit);

    try {
      const local = getDatabase()
        .prepare("SELECT payload_json FROM tracks WHERE payload_json LIKE ? LIMIT 200")
        .all(`%"id":"${albumRouteId}"%`) as Array<{ payload_json: string }>;
      const localTracks = local
        .map(r => JSON.parse(r.payload_json) as unknown as Track)
        .filter(t => String(t.al?.id ?? '') === albumRouteId);
      let songs = localTracks;
      if (songs.length === 0 && name) {
        const agg = await searchSongsMulti(name, limit + 10);
        songs = collect(agg.songs);
      }
      if (songs.length === 0) return null;
      const first = songs[0];
      return {
        album: {
          id: albumRouteId,
          mid: albumId,
          name: String(first.al?.name ?? ''),
          picUrl: String(first.al?.picUrl ?? ''),
          publishTime: '',
          description: '',
          company: '',
          type: '',
          size: songs.length,
          artists: first.ar ?? [],
          artist: { name: String((first.ar ?? [])[0]?.name ?? '') },
        },
        songs,
      };
    } catch (err) {
      log.warn(`酷狗专辑详情失败 id=${albumId}: ${(err as Error).message}`);
      return null;
    }
  };

  /**
   * 详情回源补专辑/封面。
   *
   * 事实澄清（2026-10-26 实测）：QQ **搜索分片**对部分条目不带专辑（`al.mid`/`al.name` 皆空），
   * 但 **详情接口**（`get_song_detail_yqq`）通常是有的 —— 这也解释了用户观察到的
   * 「点播放后封面就补上了」：播放链路会触发详情回源并落库。
   * 所以这里在列表阶段就补一次，而不是靠用户点播放来补齐。
   *
   * 限量 N 条：每次回源是一次上游请求，一页几十条全补会打爆风控。
   */
  const enrichMissingAlbums = async (songs: Track[], max = 10): Promise<Track[]> => {
    const targets = songs.filter(s => s.mid && (!s.al?.mid || !s.al?.name)).slice(0, max);
    if (targets.length === 0) return songs;
    await Promise.all(
      targets.map(async t => {
        try {
          const full = await getSongDetail(t.mid, { bypassCache: true });
          if (!full?.al?.mid) return;
          t.al = { ...t.al, ...full.al };
          t.album = { ...t.album, ...(full.album ?? full.al) };
          if (!t.dt && full.dt) t.dt = full.dt;
        } catch {
          // 单条失败不影响列表
        }
      }),
    );
    return songs;
  };

  /**
   * 封面兜底：库里同一首歌若已有封面（多源别的条目带过），直接补上。
   *
   * QQ 歌手页的召回行有相当比例不带专辑封面（实测「夏日入侵企划」27 条里 14 条空封面），
   * 而同一首歌在酷狗/网易云侧是有图的 —— 用「歌名 + 主歌手」在本地库回填，零额外上游请求。
   */
  const backfillCovers = (songs: Track[]): Track[] => {
    if (songs.length === 0) return songs;
    const missing = songs.filter(s => !s.al?.picUrl);
    if (missing.length === 0) return songs;
    try {
      const rows = getDatabase()
        .prepare("SELECT name, artists_json, cover_url FROM tracks WHERE cover_url <> '' ")
        .all() as Array<{ name: string; artists_json: string; cover_url: string }>;
      const keyOf = (name: string, artistsJson: string): string => {
        let ar: Array<{ name?: string }> = [];
        try {
          ar = JSON.parse(artistsJson || '[]');
        } catch {
          ar = [];
        }
        const artists = ar.map(a => normName(a?.name ?? '')).filter(Boolean).sort().join('/');
        const n = normName(name);
        return n && artists ? `${n}|${artists}` : '';
      };
      const coverByKey = new Map<string, string>();
      for (const r of rows) {
        const k = keyOf(r.name, r.artists_json);
        if (k && !coverByKey.has(k)) coverByKey.set(k, r.cover_url);
      }
      for (const s of missing) {
        const artistsJson = JSON.stringify((s.ar ?? []).map(a => ({ name: a.name })));
        const k = keyOf(s.name, artistsJson);
        const cover = k ? coverByKey.get(k) : undefined;
        if (cover && s.al) s.al.picUrl = cover;
        if (cover && s.album && !s.album.picUrl) s.album.picUrl = cover;
      }
    } catch {
      // 兜底失败不挡主流程
    }
    return songs;
  };

  /**
   * 从本地库反查歌手名（多源歌手页的 name 兜底）。
   *
   * `kg_ar_` / `ne_ar_` 的上游没有「按歌手 id 取详情」的稳定接口，之前要求客户端必须带 `name`，
   * 少传一处就 404。这里改为：库里任何一条该歌手的曲目都能反推出名字，客户端不必强依赖。
   */
  const guessArtistName = (artistId: string): string => {
    if (!artistId) return '';
    try {
      const db = getDatabase();
      const libRow = db
        .prepare('SELECT name FROM library_artists WHERE mid = ? LIMIT 1')
        .get(artistId) as { name: string } | undefined;
      if (libRow?.name) return String(libRow.name);

      for (const table of ['tracks', 'playlist_pool_items']) {
        const row = db
          .prepare(`SELECT artists_json FROM ${table} WHERE artists_json LIKE ? LIMIT 1`)
          .get(`%${artistId}%`) as { artists_json: string } | undefined;
        if (!row) continue;
        const ar = JSON.parse(row.artists_json || '[]') as Array<{ id?: string; mid?: string; name?: string }>;
        const hit = ar.find(
          a => String(a?.mid ?? '') === artistId || String(a?.id ?? '').endsWith(`_${artistId}`),
        );
        if (hit?.name) return String(hit.name);
      }
      return '';
    } catch {
      return '';
    }
  };

  /** 变种/翻唱清洗：与 multi-search 保持同一零翻唱口径 */
  const ARTIST_VARIANT_RE =
    /(伴奏|纯音乐|钢琴|吉他|器乐|dj|慢摇|变速|remix|片段|消音|和声|翻唱|cover|intro|outro|demo|不插电|串烧|填词|翻填|戏腔版|女声版|男声版|女生版|男生版|烟嗓版|高潮版|唢呐版)/i;
  /** 综艺翻唱合辑过滤：QQ 曲目无原唱标记，综艺竞演专辑几乎全为翻唱 */
  const VARIETY_COVER_ALBUM_RE =
    /(声生不息|天赐的声音|我是歌手|歌手·当打之年|歌手202|中国好声音|蒙面唱将|时光音乐会|我们的歌|乐队的夏天|披荆斩棘|乘风破浪|音乐缘计划|舞台2023|闪光的乐队|为歌而赞|谁是宝藏歌手)/i;

  /**
   * 歌手页统一去重与零翻唱清洗。
   *
   * 去重键 = 歌名(去括号后缀) + 是否 Live + **拆分后排序的歌手集合**。
   * 关键在「拆分」：多源回同一首合作曲时，歌手串可能是 `房东的猫、夏日入侵企画` 也可能是
   * `房东的猫/夏日入侵企画`，不拆词会被判成两个不同歌手 → 同一首歌出现两行。
   * 同名同歌手同 Live 状态的曲目严格只保留第一条（高优认证源在前），若首条缺封面/专辑名则由后续同曲补齐。
   */
  const dedupeArtistSongs = (songs: Track[], limit: number): Track[] => {
    const keyOf = (t: Track): string => {
      const live = /(live|现场|演唱会)/i.test(t.name) ? '1' : '0';
      const base = normName(t.name.replace(/\([^)]*\)|（[^）]*）|\[[^\]]*\]/g, ''));
      const tokens = (t.ar ?? [])
        .flatMap(a => String(a.name ?? '').split(/[、,，&/／+]/))
        .map(x => normName(x))
        .filter(Boolean)
        .sort();
      return `${base}|${live}|${tokens.join('/')}`;
    };
    /**
     * 同名组内剔除「明显短于最长版本」的条目。
     *
     * 实测歌手页里的同名条目时长差异极大（真空 229s vs 91s、以渺小之名 206s vs 111s/129s），
     * 短的那些是片段/改编/花絮，不是正规版本。阈值取最长版本的 70%（且最长需 ≥120s），
     * 这样「录音室版 vs Live 版」这类正常差异会被保留，残片会被清掉。
     */
    const SHORT_RATIO = 0.7;
    const maxDtByName = new Map<string, number>();
    for (const t of songs) {
      if (!t.dt) continue;
      const n = normName(t.name.replace(/\([^)]*\)|（[^）]*）|\[[^\]]*\]/g, ''));
      if ((maxDtByName.get(n) ?? 0) < t.dt) maxDtByName.set(n, t.dt);
    }
    const isOutlier = (t: Track): boolean => {
      if (!t.dt) return false;
      const n = normName(t.name.replace(/\([^)]*\)|（[^）]*）|\[[^\]]*\]/g, ''));
      const max = maxDtByName.get(n) ?? 0;
      if (max < 120_000) return false;
      return t.dt < max * SHORT_RATIO;
    };

    const byKey = new Map<string, Track>();
    const out: Track[] = [];
    for (const t of songs) {
      // 零翻唱/零伴奏硬过滤（含综艺翻唱专辑）
      if (ARTIST_VARIANT_RE.test(t.name) || isCoverOrInstrumental(t)) continue;
      if (VARIETY_COVER_ALBUM_RE.test(String(t.al?.name ?? ''))) continue;
      // 极短条目不是歌（试听片段/花絮/音效）：45 秒以下直接丢弃。
      if (t.dt > 0 && t.dt < 45_000) continue;
      if (isOutlier(t)) continue;
      const k = keyOf(t);
      const prev = byKey.get(k);
      if (prev) {
        // 用后续同曲补齐首条可能缺失的封面或专辑名
        if (prev.al && t.al) {
          if (!prev.al.picUrl && t.al.picUrl) prev.al.picUrl = t.al.picUrl;
          if (!prev.al.name && t.al.name) prev.al.name = t.al.name;
        }
        if (prev.album && t.al) {
          if (!prev.album.picUrl && t.al.picUrl) prev.album.picUrl = t.al.picUrl;
          if (!prev.album.name && t.al.name) prev.album.name = t.al.name;
        }
        continue;
      }
      byKey.set(k, t);
      out.push(t);
      if (out.length >= limit) break;
    }
    return out;
  };

  /** 名称归一（歌手过滤用）：去空白/括号/小写 */
  const normName = (s: string): string => {
    let out = String(s ?? '').toLowerCase().replace(/\s+/g, '').replace(/[()（）[\]【】]/g, '');
    // 异体字归一：否则「夏日入侵企划」匹配不到「夏日入侵企画」（与 multi-search 同口径）
    out = out.replace(/企画/g, '企划').replace(/計画/g, '计划');
    return out;
  };

  /**
   * 网易云歌手歌曲 → ne_ Track[]（零翻唱：通过 cloudsearch 校验 originCoverType === 1）。
   *
   * 为什么不直接裸用 `/api/v1/artist/songs`：
   *   `artistSongs` 接口不返回 `originCoverType` 字段，会把歌手在综艺/电台里的翻唱
   *   （如《张三的歌》《恼人的秋风》《勇气》，在 cloudsearch 中均为 originCoverType=2）
   *   以及未标原唱的合集重录版（如《奇形怪状的云》originCoverType=0）一并返回。
   */
  const getNeteaseArtistSongs = async (
    artistId: string,
    singerName: string,
    limit: number,
    page: number,
  ): Promise<{ songs: Track[]; resolvedName: string }> => {
    try {
      const cookie = currentNeteaseCookie();
      let resolvedName = singerName || guessArtistName(artistId);
      if (!resolvedName && artistId) {
        const probe: any = await netease.artistSongs(
          { id: Number(artistId), limit: 5, offset: 0, order: 'hot', cookie },
          neteaseRequest,
        );
        const probeRows = (probe?.body?.songs ?? []) as Array<Record<string, any>>;
        for (const s of probeRows) {
          const hit = ((s.ar ?? []) as Array<Record<string, any>>).find(
            a => String(a.id ?? '') === String(artistId) && a.name,
          );
          if (hit?.name) {
            resolvedName = String(hit.name);
            break;
          }
        }
      }
      if (!resolvedName) return { songs: [], resolvedName: '' };

      const target = normName(resolvedName);
      const fetchLimit = Math.min(Math.max(limit * 2, 60), 100);
      const res: any = await netease.cloudsearch(
        {
          keywords: resolvedName,
          type: 1,
          limit: fetchLimit,
          offset: (page - 1) * limit,
          cookie,
        },
        neteaseRequest,
      );
      const rows = (res?.body?.result?.songs ?? []) as Array<Record<string, any>>;
      const out: Track[] = [];
      for (const s of rows) {
        if (Number(s.originCoverType ?? 0) !== 1) continue;
        const songName = String(s.name ?? '');
        if (ARTIST_VARIANT_RE.test(songName)) continue;

        const ar = ((s.ar ?? []) as Array<Record<string, any>>).map(a => ({
          id: 'ne_ar_' + String(a.id ?? ''),
          mid: String(a.id ?? ''),
          name: String(a.name ?? ''),
          picUrl: '',
        }));
        const belongs = ar.some(a => {
          if (artistId && a.mid === String(artistId)) return true;
          const n = normName(a.name);
          return n.length > 0 && (n.includes(target) || target.includes(n));
        });
        if (!belongs) continue;

        const al = (s.al ?? {}) as Record<string, any>;
        const dt = Number(s.dt ?? 0);
        const album = {
          id: 'ne_al_' + String(al.id ?? '0'),
          mid: String(al.id ?? '0'),
          name: String(al.name ?? ''),
          picUrl: String(al.picUrl ?? '').replace(/^http:/, 'https:'),
        };
        const track: Track = {
          id: 'ne_' + String(s.id),
          mid: String(s.id),
          name: songName,
          ar,
          artists: ar,
          al: album,
          album,
          dt,
          duration: Math.round(dt / 1000),
          playable: true,
          matched: true,
          privilege: { playMaxbr: 0, maxbr: 0, freeTrialPrivilege: { resConsumable: false } },
        };
        if (isCoverOrInstrumental(track)) continue;
        out.push(track);
      }
      return { songs: out, resolvedName };
    } catch (err) {
      log.warn(`网易云歌手歌曲失败：${(err as Error).message}`);
      return { songs: [], resolvedName: singerName };
    }
  };

  /** 歌手热门歌曲 */
  app.get('/api/artists/:id/songs', async req => {
    requireUser(req);
    const raw = (req.params as any).id as string;
    const parsed = parseIdWithFallback(raw, 'artist');
    if (!parsed || parsed.kind !== 'artist') {
      throw badRequest(`歌手 id 不合法：${raw}`, 'invalid_id');
    }

    const limit = intParam((req.query as any)?.limit, 50, { min: 1, max: 100 });
    // 分页：默认只给第一页，客户端翻到已加载的最后一页时再来要下一页。
    // 上限 20 页是为了给风控兜底 —— 每次翻页都是一次真实的 QQ 搜索请求。
    const page = intParam((req.query as any)?.page, 1, { min: 1, max: 20 });
    const name = strParam((req.query as any)?.name);

    const filterBelongsTo = (list: Track[], singerName: string): Track[] => {
      const target = normName(singerName);
      if (!target) return list;
      return list.filter(t =>
        (t.ar ?? []).some(a => {
          const n = normName(a.name);
          return n.length > 0 && (n.includes(target) || target.includes(n));
        }),
      );
    };

    // ---- 多源分流：kg_ar_ / ne_ar_ / qq_ar_ 首屏均优先聚合酷狗+网易云官方原唱 ----
    if (parsed.source === 'ne') {
      const neRes = await getNeteaseArtistSongs(parsed.value, name, limit, page);
      const resolvedName = neRes.resolvedName || name || guessArtistName(parsed.value);
      let combined = neRes.songs;
      if (page === 1 && resolvedName) {
        try {
          const agg = await searchSongsMulti(resolvedName, limit);
          combined = [...filterBelongsTo(agg.songs, resolvedName), ...neRes.songs];
        } catch (err) {
          log.warn(`网易云歌手页多源合并失败 ${resolvedName}：${(err as Error).message}`);
        }
      }
      const songs = backfillCovers(dedupeArtistSongs(combined, limit));
      if (songs.length > 0) upsertTracks(songs);
      return {
        id: `ne_ar_${parsed.value}`,
        name: resolvedName,
        page,
        songs,
        hasMore: neRes.songs.length >= limit,
        degraded: null,
      };
    }
    if (parsed.source === 'kg') {
      const singerName = name || guessArtistName(parsed.value);
      if (!singerName) throw notFound('酷狗歌手页需要带 name 参数（本地库也没有该歌手曲目）');
      const [agg, neRes] = await Promise.all([
        searchSongsMulti(singerName, limit),
        page === 1 ? getNeteaseArtistSongs('', singerName, limit, 1) : Promise.resolve({ songs: [], resolvedName: singerName }),
      ]);
      const songs = backfillCovers(
        dedupeArtistSongs([...filterBelongsTo(agg.songs, singerName), ...neRes.songs], limit),
      );
      if (songs.length > 0) upsertTracks(songs);
      return {
        id: `kg_ar_${parsed.value}`,
        name: singerName,
        page,
        songs,
        hasMore: false,
        degraded: null,
      };
    }

    // 拿不到名字就没法用搜索召回，先取详情
    const localName = name || guessArtistName(parsed.value);
    const artist = localName ? null : await getArtistDetail(parsed.value);
    const singerName = localName || artist?.name || '';
    if (!singerName) throw notFound('歌手不存在');

    const result: { songs: Track[]; hasMore: boolean; degradedCode: number | null } = {
      songs: [],
      hasMore: false,
      degradedCode: null,
    };

    /**
     * 歌手页「多源合一 + 原唱优先」：
     *   1. 第 1 页优先并发拉酷狗（IsOriginal===1）+ 网易云（originCoverType===1）认证原唱；
     *   2. 若认证原唱已 ≥ 8 首，则第 1 页直接采用认证原唱（0 次 QQ 搜索消耗，且彻底杜绝 QQ 无原唱标记带来的综艺翻唱/野鸡重传）；
     *   3. 仅当认证原唱不足 8 首或翻到 page > 1 时，才调用 QQ `getArtistSongs` 兜底补充。
     */
    if (page === 1 && singerName) {
      try {
        const [agg, neRes] = await Promise.all([
          searchSongsMulti(singerName, limit),
          getNeteaseArtistSongs('', singerName, limit, 1),
        ]);
        const certified = dedupeArtistSongs(
          [...filterBelongsTo(agg.songs, singerName), ...neRes.songs],
          limit,
        );
        if (certified.length >= 8) {
          result.songs = certified;
          result.hasMore = false;
        } else {
          const qqRes = await getArtistSongs(parsed.value, singerName, limit, page);
          upsertTracks(qqRes.songs);
          const qqFiltered =
            certified.length > 0
              ? qqRes.songs.filter(t => Boolean(t.al?.name?.trim()))
              : qqRes.songs;
          result.songs = dedupeArtistSongs([...certified, ...qqFiltered], limit);
          result.hasMore = qqRes.hasMore;
          result.degradedCode = qqRes.degradedCode ?? null;
        }
      } catch (err) {
        log.warn(`歌手页多源合并失败 ${singerName}：${(err as Error).message}`);
        const qqRes = await getArtistSongs(parsed.value, singerName, limit, page);
        upsertTracks(qqRes.songs);
        result.songs = dedupeArtistSongs(qqRes.songs, limit);
        result.hasMore = qqRes.hasMore;
        result.degradedCode = qqRes.degradedCode ?? null;
      }
    } else {
      const qqRes = await getArtistSongs(parsed.value, singerName, limit, page);
      upsertTracks(qqRes.songs);
      result.songs = dedupeArtistSongs(qqRes.songs, limit);
      result.hasMore = qqRes.hasMore;
      result.degradedCode = qqRes.degradedCode ?? null;
    }

    await enrichMissingAlbums(result.songs);
    backfillCovers(result.songs);

    // 统一对齐主歌手的路由 id / mid 为当前 qq_ar_<mid>：
    //   1. 从歌手页点播 kg_ / ne_ 曲目后，在播放页再点歌手名能跳回完整歌手页（带专辑/简介/相似歌手）；
    //   2. 收藏该曲目时自带真实歌手 mid，每日推荐种子统计不丢。
    const targetNorm = normName(singerName);
    const fullArtistId = `qq_ar_${parsed.value}`;
    for (const s of result.songs) {
      for (const list of [s.ar, s.artists]) {
        if (!Array.isArray(list)) continue;
        for (const a of list) {
          const n = normName(a?.name ?? '');
          if (n && (n.includes(targetNorm) || targetNorm.includes(n))) {
            a.id = fullArtistId;
            a.mid = parsed.value;
          }
        }
      }
    }

    if (result.songs.length > 0) upsertTracks(result.songs);

    return {
      id: `qq_ar_${parsed.value}`,
      name: singerName,
      page,
      songs: result.songs,
      // 用**上游是否填满**而不是"过滤后还剩几条"：本接口按歌手 mid 过滤过，
      // 一页 50 条过滤完可能只剩 8 条，但上游明明还有下一页
      hasMore: result.hasMore,
      // 让客户端能区分"这位歌手真没有歌"与"上游被限流了"
      degraded:
        result.degradedCode && result.songs.length === 0
          ? { code: result.degradedCode, message: 'QQ 音乐检索被限流，请稍后重试' }
          : null,
    };
  });

  /**
   * 歌手专辑列表。
   *
   * 与「热门歌曲」分成两个接口而不是塞进 `/api/artists/:id`：
   * 两者都要各打一次搜索分片，而搜索是**最容易被风控**的一环 ——
   * 合在一起会让歌手页首屏风险翻倍，也会让"歌曲限流了但专辑正常"
   * 这种情况无法表达。
   */
  app.get('/api/artists/:id/albums', async req => {
    requireUser(req);
    const raw = (req.params as any).id as string;
    const parsed = parseIdWithFallback(raw, 'artist');
    if (!parsed || parsed.kind !== 'artist') {
      throw badRequest(`歌手 id 不合法：${raw}`, 'invalid_id');
    }

    const limit = intParam((req.query as any)?.limit, 50, { min: 1, max: 100 });
    const page = intParam((req.query as any)?.page, 1, { min: 1, max: 20 });
    const name = strParam((req.query as any)?.name);

    const localName = name || guessArtistName(parsed.value);
    const artist = !localName && parsed.source === 'qq' ? await getArtistDetail(parsed.value) : null;
    const singerName = localName || artist?.name || '';
    const fullId = `${parsed.source}_ar_${parsed.value}`;
    if (!singerName) {
      if (parsed.source !== 'qq') {
        return { id: fullId, name: '', page, albums: [], hasMore: false, degraded: null };
      }
      throw notFound('歌手不存在');
    }

    const qqMid = parsed.source === 'qq' ? parsed.value : '';
    const result = await getArtistAlbums(qqMid, singerName, limit, page);

    return {
      id: fullId,
      name: singerName,
      page,
      albums: result.albums,
      hasMore: result.hasMore,
      degraded: result.degradedCode
        ? { code: result.degradedCode, message: 'QQ 音乐检索被限流，请稍后重试' }
        : null,
    };
  });

  /**
   * 相似歌手（歌手页底部）。
   *
   * 链路：QQ 歌手名 → 网易云 simi_artist → 名字 → QQ 搜索换 mid。
   * 名字必须带上（与 songs/albums 接口同理，省一次详情请求）；
   * 上游任何一步失败都返回空数组，前端整节隐藏。
   */
  app.get('/api/artists/:id/similar', async req => {
    requireUser(req);
    const raw = (req.params as any).id as string;
    const parsed = parseIdWithFallback(raw, 'artist');
    if (!parsed || parsed.kind !== 'artist') {
      throw badRequest(`歌手 id 不合法：${raw}`, 'invalid_id');
    }

    const name = strParam((req.query as any)?.name) || guessArtistName(parsed.value);
    if (!name) throw badRequest('缺少歌手名（name）', 'invalid_param');

    const artists = await getSimilarArtists(name, name);
    return { id: `${parsed.source}_ar_${parsed.value}`, name, artists };
  });

  /**
   * 单曲详情。
   *
   * 先查本地缓存（搜索/专辑/歌单都会写入），miss 时才回源 QQ。
   * 这条路径是"客户端收藏了但缓存被清理"时的兜底。
   */
  app.get('/api/tracks/:id', async req => {
    requireUser(req);
    const raw = (req.params as any).id as string;
    const parsed = parseId(raw);
    if (!parsed) throw badRequest(`曲目 id 不合法：${raw}`, 'invalid_id');
    if (parsed.kind !== 'track') {
      throw badRequest(`这不是曲目 id：${raw}`, 'invalid_id');
    }

    const cached = getTrack(parsed.raw);
    if (cached) return { track: cached, source: 'cache' };

    const fetched = parsed.source === 'qq' ? await getSongDetail(parsed.value) : null;
    if (!fetched) throw notFound('曲目不存在');

    upsertTracks([fetched]);
    log.debug(`曲目回源：${parsed.raw}`);
    return { track: fetched, source: 'upstream' };
  });

  /**
   * 歌词。
   *
   * `:id` 是曲目的路由键（`qq_<mid>` / `ne_<id>` / `kg_<id>`）。歌词内容对同一曲目永远不变，
   * 允许客户端长缓存 —— 但必须 `private`，它仍是按用户鉴权的数据面。
   */
  app.get('/api/lyrics/:id', async (req, reply) => {
    requireUser(req);
    const raw = (req.params as any).id as string;
    const parsed = parseId(raw);
    if (!parsed) throw badRequest(`曲目 id 不合法：${raw}`, 'invalid_id');
    if (parsed.kind !== 'track') {
      throw badRequest(`这不是曲目 id：${raw}`, 'invalid_id');
    }

    // 多源歌词链路：ne_ 直取网易云 lyricNew；其余走四级兜底（services/lyric-fallback.ts）
    const track = getTrack(parsed.raw);
    const lyric = track
      ? await getLyricForTrack(track)
      : parsed.source === 'ne'
        ? await getLyricForTrack({ id: parsed.raw, mid: parsed.value, name: '', ar: [], dt: 0 } as unknown as Track)
        : await getQQLyric(parsed.value, strParam((req.query as any)?.songId));

    reply.header('Cache-Control', 'private, max-age=86400');
    return { id: parsed.raw, ...lyric };
  });

  /**
   * 批量取曲目（客户端恢复歌单/历史时用）。
   * 缺失的 id 会被跳过，返回顺序与入参一致。
   *
   * 只读本地缓存，不消耗上游配额，但仍需登录 —— 曲目内容属于用户数据面。
   */
  app.post('/api/tracks/batch', async req => {
    requireUser(req);
    const body = (req.body ?? {}) as { ids?: unknown };
    const ids = Array.isArray(body.ids) ? body.ids.filter(x => typeof x === 'string') : [];
    if (ids.length === 0) throw badRequest('缺少 ids', 'missing_param');
    if (ids.length > 500) throw badRequest('ids 最多 500 个', 'too_many_ids');

    const tracks = getTracks(ids as string[]);
    const found = new Set(tracks.map(t => t.id));

    return {
      tracks,
      missing: (ids as string[]).filter(id => !found.has(id)),
    };
  });
}
