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
    const result = await searchQQ(query, { offset, limit, slices });
    upsertTracks(result.songs);

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
        artist: slices.includes('singer') && result.artists.length >= limit,
        playlist: slices.includes('songlist') && result.playlists.length >= limit,
      },
      degraded: result.degraded,
    };
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

    const artist = await getArtistDetail(parsed.value);
    if (!artist) throw notFound('歌手不存在');

    return { artist };
  });

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

    // 拿不到名字就没法用搜索召回，先取详情
    const artist = name ? null : await getArtistDetail(parsed.value);
    const singerName = name || artist?.name || '';
    if (!singerName) throw notFound('歌手不存在');

    const result = await getArtistSongs(parsed.value, singerName, limit, page);
    upsertTracks(result.songs);

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

    const fetched = await getSongDetail(parsed.value);
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
