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
      const row = getDatabase()
        .prepare("SELECT artists_json FROM tracks WHERE artists_json LIKE ? LIMIT 1")
        .get(`%"mid":"${artistId}"%`) as { artists_json: string } | undefined;
      if (!row) return '';
      const ar = JSON.parse(row.artists_json || '[]') as Array<{ mid?: string; name?: string }>;
      const hit = ar.find(a => String(a?.mid ?? '') === artistId);
      return String(hit?.name ?? '');
    } catch {
      return '';
    }
  };

  /** 名称归一（歌手过滤用）：去空白/括号/小写 */
  const normName = (s: string): string => {
    let out = String(s ?? '').toLowerCase().replace(/\s+/g, '').replace(/[()（）[\]【】]/g, '');
    // 异体字归一：否则「夏日入侵企划」匹配不到「夏日入侵企画」（与 multi-search 同口径）
    out = out.replace(/企画/g, '企划').replace(/計画/g, '计划');
    return out;
  };

  /** 网易云歌手歌曲 → ne_ Track[] */
  const getNeteaseArtistSongs = async (artistId: string, limit: number, page: number) => {
    try {
      const res: any = await netease.artistSongs(
        { id: Number(artistId), limit, offset: (page - 1) * limit, order: 'hot', cookie: currentNeteaseCookie() },
        neteaseRequest,
      );
      const rows = res?.body?.songs ?? [];
      return (rows as Array<Record<string, any>>).map(s => {
        const ar = ((s.ar ?? []) as Array<Record<string, any>>).map(a => ({
          id: 'ne_ar_' + String(a.id ?? ''),
          mid: String(a.id ?? ''),
          name: String(a.name ?? ''),
          picUrl: '',
        }));
        const al = (s.al ?? {}) as Record<string, any>;
        const dt = Number(s.dt ?? 0);
        const album = {
          id: 'ne_al_' + String(al.id ?? '0'),
          mid: String(al.id ?? '0'),
          name: String(al.name ?? ''),
          picUrl: String(al.picUrl ?? ''),
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
    } catch (err) {
      log.warn(`网易云歌手歌曲失败：${(err as Error).message}`);
      return [];
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

    // ---- 多源分流：kg_ar_ / ne_ar_ 走各自上游，qq_ar_ 保持原实现 ----
    if (parsed.source === 'ne') {
      const songs = backfillCovers(await getNeteaseArtistSongs(parsed.value, limit, page));
      if (songs.length > 0) upsertTracks(songs);
      return {
        id: `ne_ar_${parsed.value}`,
        // 客户端没带 name 时用库反查，保证页面标题有歌手名
        name: name || guessArtistName(parsed.value),
        page,
        songs,
        hasMore: songs.length >= limit,
        degraded: null,
      };
    }
    if (parsed.source === 'kg') {
      // 酷狗没有稳定的「按 singerId 取歌」接口，改用聚合搜索后按歌手过滤：
      // 结果同样带 kg_ 前缀与 kugouMeta，点播可直取流。
      // name 缺失时从本地库反查（客户端少传一处也不会 404）。
      const singerName = name || guessArtistName(parsed.value);
      if (!singerName) throw notFound('酷狗歌手页需要带 name 参数（本地库也没有该歌手曲目）');
      const agg = await searchSongsMulti(singerName, limit);
      const target = normName(singerName);
      const songs = backfillCovers(
        agg.songs.filter(t =>
          (t.ar ?? []).some(a => {
            const n = normName(a.name);
            return n.length > 0 && (n.includes(target) || target.includes(n));
          })
        )
      );
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
    const artist = name ? null : await getArtistDetail(parsed.value);
    const singerName = name || artist?.name || '';
    if (!singerName) throw notFound('歌手不存在');

    const result = await getArtistSongs(parsed.value, singerName, limit, page);
    upsertTracks(result.songs);
    await enrichMissingAlbums(result.songs);
    backfillCovers(result.songs);

    return {
      id: `qq_ar_${parsed.value}`,
      name: singerName,
      page,
      songs: result.songs,
      // 用**上游是否填满**而不是"过滤后还剩几条"：本接口按歌手 mid 过滤过，
      // 一页 50 条过滤完可能只剩 8 条，但上游明明还有下一页
      hasMore: result.hasMore,
      // 让客户端能区分"这位歌手真没有歌"与"上游被限流了"
      degraded: result.degradedCode
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

    // 拿不到名字就没法用搜索召回，先取详情（与热门歌曲同一套处理）
    const artist = name ? null : await getArtistDetail(parsed.value);
    const singerName = name || artist?.name || '';
    if (!singerName) throw notFound('歌手不存在');

    const result = await getArtistAlbums(parsed.value, singerName, limit, page);

    return {
      id: `qq_ar_${parsed.value}`,
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

    const name = strParam((req.query as any)?.name);
    if (!name) throw badRequest('缺少歌手名（name）', 'invalid_param');

    const artists = await getSimilarArtists(name, name);
    return { id: `qq_ar_${parsed.value}`, name, artists };
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

    let fetched = await getSongDetail(parsed.value);
    // QQ 查不到（版权下架/地区限制/接口抖动）→ **酷狗元数据兜底**：
    // 以 id 里的关键词不存在——这里按 trackId 无语义，只能靠搜索。
    // 但回源请求方（stream/resolve/favorites）拿到的只是 id，没有歌名，无法搜酷狗。
    // 所以这里的兜底仅当调用方能提供 query 时才可能 —— 单曲回源场景没有，跳过。
    // （真正的酷狗元数据兜底在搜索聚合与每日推荐快照，不在单曲回源。）
    if (!fetched) throw notFound('曲目不存在');

    upsertTracks([fetched]);
    log.debug(`曲目回源：${parsed.raw}`);
    return { track: fetched, source: 'upstream' };
  });

  /**
   * 歌词。
   *
   * `:id` 是曲目的路由键（`qq_<mid>`）。歌词内容对同一 mid 永远不变，
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

    // 四级兜底：QQ 本曲 → QQ 同曲异版本 → 网易云 → 暂无（services/lyric-fallback.ts）
    const track = getTrack(parsed.raw);
    const lyric = track
      ? await getLyricForTrack(track)
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
