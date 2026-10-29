/**
 * 收藏路由。
 *
 * 收藏是幂等布尔关系：重复收藏返回 200 且 `added: false`，
 * 取消一个不存在的收藏同样返回 200 —— 客户端不必先查询再决定写。
 */

import type { FastifyInstance } from 'fastify';
import { requireUser } from '../http/require-auth.ts';
import { badRequest, notFound } from '../http/errors.ts';
import { intParam } from '../http/params.ts';
import { getTracks, upsertTracks } from '../db/repo/tracks.ts';
import { getPlaylistDetail, getSongDetail } from '../sources/qq/home.ts';
import type { Track } from '../sources/qq/adapter.ts';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getDatabase } from '../db/index.ts';
import { getFavoritesSummary, getPersonaDetail, importPersonaSummary, triggerFavoritesSummaryUpdate } from '../services/ai-memory.ts';
import { tagSingleTrack } from '../services/ai-tags.ts';
import { enqueueArtistsFromTracks } from '../services/library-topup.ts';
import { createZip, parseZip } from '../utils/zip.ts';
import { cleanAiText } from '../utils/text.ts';
import { createLogger } from '../logger.ts';
import * as repo from '../db/repo/favorites.ts';

const log = createLogger('favorites');

function asRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
}

export function registerFavoriteRoutes(app: FastifyInstance): void {
  /**
   * 收藏列表（分页，按收藏时间倒序）。
   *
   * 游标是 `(createdAt, trackId)` 复合结构：单用 createdAt 时，
   * 同一毫秒内收藏的多首会在翻页边界上漏掉或重复。
   */
  app.get('/api/favorites', async req => {
    const user = requireUser(req);
    const q = req.query as Record<string, unknown>;

    const limit = intParam(q.limit, 50, { min: 1, max: 200 });
    const cursorRaw = typeof q.cursor === 'string' ? q.cursor : '';
    let cursor: { createdAt: number; trackId: string } | undefined;

    if (cursorRaw) {
      const [createdAt, trackId] = cursorRaw.split(':');
      const ts = Number(createdAt);
      if (!Number.isFinite(ts) || !trackId) {
        throw badRequest('cursor 格式应为 `<createdAt>:<trackId>`', 'invalid_cursor');
      }
      cursor = { createdAt: ts, trackId };
    }

    const page = repo.listFavorites(user.id, {
      limit,
      beforeCreatedAt: cursor?.createdAt,
      beforeTrackId: cursor?.trackId,
    });

    return {
      items: page.items,
      total: repo.countFavorites(user.id),
      nextCursor: page.nextCursor
        ? `${page.nextCursor.createdAt}:${page.nextCursor.trackId}`
        : null,
      summary: getFavoritesSummary(user.id),
    };
  });

  const keyOf = (name: string, artistsJson: string): string => {
    let artists: Array<{ name?: string }> = [];
    try {
      artists = JSON.parse(artistsJson || '[]');
    } catch {
      artists = [];
    }
    const names = artists
      .map(a => String(a?.name ?? '').trim().toLowerCase())
      .filter(Boolean)
      .sort()
      .join('/');
    const n = String(name ?? '').trim().toLowerCase();
    return n && names ? `${n}|${names}` : '';
  };

  /** 某几首是否已收藏（客户端渲染列表时批量查） */
  app.post('/api/favorites/check', async req => {
    const user = requireUser(req);
    const body = asRecord(req.body);
    if (!Array.isArray(body.ids)) throw badRequest('缺少 ids', 'missing_param');
    if (body.ids.length > 500) throw badRequest('ids 最多 500 个', 'too_many_ids');

    const ids = body.ids.filter((x): x is string => typeof x === 'string');
    const result: Record<string, boolean> = {};

    /**
     * 跨源兜底：多源之后同一首歌可能是 qq_ / kg_ / ne_ 三种 id。
     * 用户收藏的是其中一条，搜索召回的是另一条 —— 只按 id 比对会显示「未收藏」。
     * 这里用「歌名 + 排序后歌手名」指纹再判一次，与收藏去重口径保持一致。
     */
    const favKeys = new Set<string>();
    const favRows = getDatabase()
      .prepare(
        `SELECT t.name, t.artists_json
           FROM favorites f JOIN tracks t ON t.id = f.track_id
          WHERE f.user_id = ?`
      )
      .all(user.id) as Array<{ name: string; artists_json: string }>;
    for (const row of favRows) {
      const k = keyOf(row.name, row.artists_json);
      if (k) favKeys.add(k);
    }

    for (const id of ids) {
      if (repo.isFavorite(user.id, id)) {
        result[id] = true;
        continue;
      }
      if (favKeys.size === 0) {
        result[id] = false;
        continue;
      }
      const t = getDatabase()
        .prepare('SELECT name, artists_json FROM tracks WHERE id = ?')
        .get(id) as { name: string; artists_json: string } | undefined;
      result[id] = t ? favKeys.has(keyOf(t.name, t.artists_json)) : false;
    }

    return { favorites: result };
  });

  /**
   * 收藏的歌可能来自字段不全的搜索召回行（歌手只有名字、没有 mid）。
   * 歌手 mid 是推荐种子统计的钥匙 —— 缺了它，这批收藏在每日推荐里会被
   * 整批忽略（真机报障："账号提示没有种子"）。这里回源补一次全量元数据
   * 再入库；回源失败不挡收藏，只是数据仍旧不全（种子统计有名字兜底）。
   *
   * 注意：仅对 `qq_` 曲目尝试 QQ `getSongDetail`；`kg_` / `ne_` 曲目直接入库，
   * 且 QQ 回源失败时若库里尚无该曲目也必须入库，避免 `favorites` 有记录但 `tracks` 为空。
   */
  async function enrichAndStoreTrack(incoming: Track, fallbackId: string): Promise<string> {
    const id = incoming.id || fallbackId;
    const isQQ = !id || id.startsWith('qq_');
    const missingMid = !incoming.ar?.length || incoming.ar.some(a => !a.mid);
    if (isQQ && missingMid && incoming.mid) {
      const full = await getSongDetail(incoming.mid).catch(() => null);
      if (full) {
        upsertTracks([full]);
        return full.id || id;
      }
      if (id && getTracks([id]).length > 0) {
        return id; // 不用不完整的数据覆盖库里已有的更全行
      }
    }
    upsertTracks([incoming]);
    return id;
  }

  /**
   * 收藏。
   * 传 `track`（完整对象）时会顺手写入曲目缓存，避免"收藏了但列表显示空白"。
   */
  app.post('/api/favorites', async (req, reply) => {
    const user = requireUser(req);
    const body = asRecord(req.body);

    let trackId = typeof body.trackId === 'string' ? body.trackId : '';
    if (body.track && typeof (body.track as Track).id === 'string') {
      trackId = await enrichAndStoreTrack(body.track as Track, trackId);
    }
    if (!trackId) throw badRequest('缺少 trackId', 'missing_param');

    const added = repo.addFavorite(user.id, trackId);
    if (added) {
      triggerFavoritesSummaryUpdate(user.id);
      tagSingleTrack(trackId);
      // 用户行为触发建库：收藏即刻把歌手排进 artist_resolve 并 kick 建库循环（不等夜间）
      const t0 = getTracks([trackId])[0];
      if (t0) enqueueArtistsFromTracks(user.id, [t0], 'fav:collect');
    }
    reply.code(added ? 201 : 200);
    return { ok: true, added, trackId };
  });

  app.delete('/api/favorites/:trackId', async req => {
    const user = requireUser(req);
    const trackId = (req.params as any).trackId as string;
    let removed = repo.removeFavorite(user.id, trackId);

    // 跨源取消收藏同步：如果用户收藏的是 qq_ 曲目，但搜索页展示的是同名的 kg_ / ne_ 曲目，
    // check 接口会按「歌名+歌手」指纹返回 true；此时右滑取消收藏传入的是 kg_ / ne_ id，
    // 需要同步移除同一指纹下的跨源收藏记录，否则下次 check 依然会判定为已收藏。
    const targetRow = getDatabase()
      .prepare('SELECT name, artists_json FROM tracks WHERE id = ?')
      .get(trackId) as { name: string; artists_json: string } | undefined;
    if (targetRow) {
      const targetKey = keyOf(targetRow.name, targetRow.artists_json);
      if (targetKey) {
        const favRows = getDatabase()
          .prepare(
            `SELECT f.track_id, t.name, t.artists_json
               FROM favorites f JOIN tracks t ON t.id = f.track_id
              WHERE f.user_id = ?`
          )
          .all(user.id) as Array<{ track_id: string; name: string; artists_json: string }>;
        for (const row of favRows) {
          if (keyOf(row.name, row.artists_json) === targetKey) {
            if (repo.removeFavorite(user.id, row.track_id)) {
              removed = true;
            }
          }
        }
      }
    }

    if (removed) triggerFavoritesSummaryUpdate(user.id);
    return { ok: true, removed };
  });

  /** 用一组完整曲目对象批量替换收藏列表内容（导入场景） */
  app.post('/api/favorites/import', async req => {
    const user = requireUser(req);
    const body = asRecord(req.body);
    if (!Array.isArray(body.tracks)) throw badRequest('缺少 tracks', 'missing_param');
    if (body.tracks.length > 500) throw badRequest('tracks 最多 500 首', 'too_many_tracks');

    upsertTracks(body.tracks as any[]);
    const ids = (body.tracks as any[])
      .map(t => (t && typeof t.id === 'string' ? t.id : ''))
      .filter(Boolean);

    let added = 0;
    for (const id of ids) {
      if (repo.addFavorite(user.id, id)) added++;
    }
    if (added > 0) {
      triggerFavoritesSummaryUpdate(user.id);
      enqueueArtistsFromTracks(user.id, body.tracks as any[], 'fav:import');
    }

    return { ok: true, received: ids.length, added, total: repo.countFavorites(user.id) };
  });

  /** 收藏里的曲目内容（一次补齐，避免客户端逐个请求） */
  app.get('/api/favorites/tracks', async req => {
    const user = requireUser(req);
    const limit = intParam((req.query as any)?.limit, 200, { min: 1, max: 500 });
    const page = repo.listFavorites(user.id, { limit });
    return { tracks: getTracks(page.items.map(i => i.trackId)) };
  });

  /**
   * 从 QQ 音乐歌单链接 / id 导入到收藏（2026-09-12 用户拍板：导入直接进收藏，自动去重）。
   *
   * 支持三种输入形态：
   *   - 完整分享链接：https://y.qq.com/n/ryqq/playlist/{dissid}
   *   - 旧版分享页：...taoge.html?id={dissid}
   *   - 纯数字 dissid
   * 曲目先 upsert 进 tracks 缓存再逐首 addFavorite（已存在的返回 false = 去重）。
   */
  app.post('/api/favorites/import-qq-playlist', async req => {
    const user = requireUser(req);
    const body = asRecord(req.body);
    const link = String(body.link ?? '').trim();
    if (!link) throw badRequest('请粘贴歌单链接或 id', 'missing_param');

    const urlMatch = /playlist\/(\d+)/.exec(link) ?? /[?&]id=(\d+)/.exec(link);
    const dissid = urlMatch ? urlMatch[1] : /^\d+$/.test(link) ? link : '';
    if (!dissid) throw badRequest('没能从输入里解析出歌单 id', 'invalid_param');

    const detail = await getPlaylistDetail(dissid);
    if (!detail) throw notFound('歌单不存在或已下架');
    if (detail.tracks.length === 0) {
      throw badRequest(`歌单「${detail.playlist.name}」里没有曲目`, 'empty_playlist');
    }

    const tracks = detail.tracks.slice(0, 500);
    upsertTracks(tracks);

    let added = 0;
    for (const t of tracks) {
      if (repo.addFavorite(user.id, t.id)) added++;
    }
    if (added > 0) {
      triggerFavoritesSummaryUpdate(user.id);
      enqueueArtistsFromTracks(user.id, tracks, 'fav:playlist');
    }

    return {
      ok: true,
      playlistName: detail.playlist.name,
      received: tracks.length,
      added,
      skipped: tracks.length - added,
      total: repo.countFavorites(user.id),
    };
  });

  /**
   * 导出当前用户收藏歌单 (favorites.json) 与用户画像 (persona.md)，
   * 打包为 .sm 软加密归档文件提供下载。
   */
  app.get('/api/favorites/export', async (req, reply) => {
    const user = requireUser(req);
    const db = getDatabase();

    const rows = db
      .prepare(`
        SELECT f.track_id, f.created_at, t.id, t.mid, t.name, t.artists_json, t.album_id, t.album_mid, t.album_name, t.cover_url, t.duration_ms, t.payload_json
        FROM favorites f
        LEFT JOIN tracks t ON t.id = f.track_id
        WHERE f.user_id = ?
        ORDER BY f.created_at DESC, f.track_id DESC
      `)
      .all(user.id) as Array<{
        track_id: string;
        created_at: number;
        id: string | null;
        mid: string | null;
        name: string | null;
        artists_json: string | null;
        album_id: string | null;
        album_mid: string | null;
        album_name: string | null;
        cover_url: string | null;
        duration_ms: number | null;
        payload_json: string | null;
      }>;

    const tracks = rows.map(r => {
      if (r.payload_json) {
        try {
          const parsed = JSON.parse(r.payload_json);
          if (parsed && typeof parsed === 'object') return parsed;
        } catch {
          // ignore
        }
      }
      let ar: Array<{ id?: string; mid?: string; name: string }> = [];
      try {
        ar = JSON.parse(r.artists_json || '[]');
      } catch {
        // ignore
      }
      return {
        id: r.id || r.track_id,
        mid: r.mid || undefined,
        name: r.name || '',
        ar,
        al: {
          id: r.album_id || undefined,
          mid: r.album_mid || undefined,
          name: r.album_name || undefined,
          picUrl: r.cover_url || undefined,
        },
        dt: r.duration_ms || 0,
        source: 'qq',
      };
    });

    const favPayload = {
      version: 1,
      app: 'suenmusic',
      type: 'favorites_backup',
      exportedAt: new Date().toISOString(),
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
      },
      total: tracks.length,
      tracks,
    };

    const detail = getPersonaDetail(user.id);
    let tasteSummary = (detail.summary || '').trim();
    // 剔除可能存在的“## 音乐口味画像（第N+1版）”等AI幻觉版号前缀
    tasteSummary = tasteSummary.replace(/^#*\s*音乐口味画像\s*(?:（[^）]*版?）|\([^)]*版?\))?\s*\n*/i, '').trim();

    const personaMd = [
      `# 音乐口味画像 · ${user.displayName || user.username}`,
      '',
      `> 导出时间：${new Date().toLocaleString('sv')}`,
      '',
      '## 音乐口味画像',
      tasteSummary || '（暂无音乐口味画像）',
      '',
    ].join('\n');

    const smArchive = createZip([
      { name: 'favorites.json', data: JSON.stringify(favPayload, null, 2) },
      { name: 'persona.md', data: personaMd },
    ]);

    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const filename = `suenmusic_backup_${user.username}_${dateStr}.sm`;

    reply.header('Content-Type', 'application/octet-stream');
    reply.header(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`
    );
    reply.header('Content-Length', smArchive.length);
    return reply.send(smArchive);
  });

  /**
   * 预检 .sm 归档：读取曲目数、是否包含音乐画像及摘要预览
   */
  app.post('/api/favorites/preview-sm', { bodyLimit: 4 * 1024 * 1024 }, async req => {
    requireUser(req);
    const body = asRecord(req.body);
    const b64 = String(body.data ?? '').trim();
    if (!b64) throw badRequest('缺少文件数据', 'missing_param');

    let buf: Buffer;
    try {
      buf = Buffer.from(b64, 'base64');
    } catch {
      throw badRequest('文件数据 base64 解析失败', 'invalid_base64');
    }

    let entries;
    try {
      entries = parseZip(buf);
    } catch (e) {
      throw badRequest(
        `无法解压 .sm 归档：${e instanceof Error ? e.message : '格式损坏'}`,
        'invalid_sm_archive'
      );
    }

    const favEntry = entries.find(
      e => e.name === 'favorites.json' || e.name.endsWith('/favorites.json')
    );
    let totalTracks = 0;
    if (favEntry) {
      try {
        const favData = JSON.parse(favEntry.data.toString('utf8'));
        const rawTracks = Array.isArray(favData.tracks)
          ? favData.tracks
          : Array.isArray(favData)
            ? favData
            : [];
        totalTracks = rawTracks.filter(
          (t: any) => t && typeof t.id === 'string' && typeof t.name === 'string'
        ).length;
      } catch {
        // ignore
      }
    }

    const personaEntry = entries.find(
      e => e.name === 'persona.md' || e.name.endsWith('/persona.md')
    );
    let hasPersona = false;
    let personaPreview = '';
    if (personaEntry && personaEntry.data.length > 0) {
      let rawP = personaEntry.data.toString('utf8').trim();
      const sec = rawP.match(/##\s*音乐口味画像[\s\S]*?(?=\n##|$)/i);
      if (sec) {
        rawP = sec[0].replace(/^##\s*音乐口味画像\s*/i, '').trim();
      } else {
        rawP = rawP
          .replace(/^#\s*音乐口味画像[^\n]*\n*/i, '')
          .replace(/^>\s*导出时间[^\n]*\n*/i, '')
          .replace(/^##\s*[^\n]*\n*/i, '')
          .trim();
      }
      rawP = cleanAiText(rawP);
      if (rawP && rawP !== '（暂无音乐口味画像）') {
        hasPersona = true;
        personaPreview = rawP.slice(0, 120);
      }
    }

    return {
      ok: true,
      totalTracks,
      hasPersona,
      personaPreview,
    };
  });

  /**
   * 导入本应用的 .sm 软加密归档文件（包含 favorites.json 与 persona.md）。
   * 请求体：{ data: base64, importPersona?: boolean }
   */
  app.post('/api/favorites/import-sm', { bodyLimit: 4 * 1024 * 1024 }, async req => {
    const user = requireUser(req);
    const body = asRecord(req.body);
    const b64 = String(body.data ?? '').trim();
    if (!b64) throw badRequest('缺少文件数据', 'missing_param');
    const shouldImportPersona = body.importPersona !== false;

    let buf: Buffer;
    try {
      buf = Buffer.from(b64, 'base64');
    } catch {
      throw badRequest('文件数据 base64 解析失败', 'invalid_base64');
    }

    let entries;
    try {
      entries = parseZip(buf);
    } catch (e) {
      throw badRequest(
        `无法解压 .sm 归档：${e instanceof Error ? e.message : '格式损坏'}`,
        'invalid_sm_archive'
      );
    }

    const favEntry = entries.find(
      e => e.name === 'favorites.json' || e.name.endsWith('/favorites.json')
    );
    if (!favEntry) {
      throw badRequest('归档文件中未找到 favorites.json', 'missing_favorites_json');
    }

    let favData: any;
    try {
      favData = JSON.parse(favEntry.data.toString('utf8'));
    } catch {
      throw badRequest('favorites.json 解析失败，非合法 JSON', 'invalid_json');
    }

    const rawTracks = Array.isArray(favData.tracks)
      ? favData.tracks
      : Array.isArray(favData)
        ? favData
        : [];

    const validTracks = rawTracks.filter(
      (t: any) => t && typeof t.id === 'string' && typeof t.name === 'string'
    );

    const personaEntry = entries.find(
      e => e.name === 'persona.md' || e.name.endsWith('/persona.md')
    );

    if (validTracks.length === 0 && (!personaEntry || personaEntry.data.length === 0)) {
      throw badRequest('归档的 favorites.json 中没有找到有效歌曲', 'empty_favorites');
    }

    let added = 0;
    if (validTracks.length > 0) {
      upsertTracks(validTracks);
      for (const t of validTracks) {
        if (repo.addFavorite(user.id, t.id)) added++;
      }
    }

    let personaImported = false;
    if (shouldImportPersona && personaEntry && personaEntry.data.length > 0) {
      try {
        const rawPersonaStr = personaEntry.data.toString('utf8');
        personaImported = importPersonaSummary(user.id, rawPersonaStr);
      } catch (err) {
        log.warn(`写入用户 ${user.id} 口味画像失败:`, err);
      }
    }

    if (added > 0) {
      triggerFavoritesSummaryUpdate(user.id);
    }

    return {
      ok: true,
      received: validTracks.length,
      added,
      skipped: validTracks.length - added,
      total: repo.countFavorites(user.id),
      personaImported,
    };
  });

  /**
   * 去重预检：扫描当前用户的收藏曲目，按「歌名 + 主歌手」识别重复，
   * 默认保留每组中最早收藏（created_at 最早）的一首。
   */
  app.post('/api/favorites/dedup/preview', async req => {
    const user = requireUser(req);
    const db = getDatabase();

    const rows = db
      .prepare(`
        SELECT f.track_id, f.created_at, t.name, t.artists_json
        FROM favorites f
        JOIN tracks t ON t.id = f.track_id
        WHERE f.user_id = ?
        ORDER BY f.created_at ASC
      `)
      .all(user.id) as Array<{
        track_id: string;
        created_at: number;
        name: string;
        artists_json: string;
      }>;

    const groups = new Map<
      string,
      Array<{ trackId: string; createdAt: number; name: string; artist: string }>
    >();
    for (const r of rows) {
      let mainArtist = '';
      try {
        const ar = JSON.parse(r.artists_json || '[]');
        if (Array.isArray(ar) && ar.length > 0) {
          mainArtist = String(ar[0]?.name || '');
        }
      } catch {
        // ignore
      }
      const normKey = `${(r.name || '').trim().toLowerCase()}::${mainArtist.trim().toLowerCase()}`;
      if (!groups.has(normKey)) {
        groups.set(normKey, []);
      }
      groups.get(normKey)!.push({
        trackId: r.track_id,
        createdAt: r.created_at,
        name: r.name,
        artist: mainArtist,
      });
    }

    let duplicateCount = 0;
    const duplicateGroups: Array<{
      key: string;
      name: string;
      artist: string;
      total: number;
      count?: number;
      keepTrackId: string;
      keepId?: string;
      removeTrackIds: string[];
      removeIds?: string[];
    }> = [];

    for (const [key, items] of groups.entries()) {
      if (items.length > 1) {
        const keep = items[0]!;
        const toRemove = items.slice(1);
        duplicateCount += toRemove.length;
        duplicateGroups.push({
          key,
          name: keep.name,
          artist: keep.artist,
          total: items.length,
          count: items.length,
          keepTrackId: keep.trackId,
          keepId: keep.trackId,
          removeTrackIds: toRemove.map(i => i.trackId),
          removeIds: toRemove.map(i => i.trackId),
        });
      }
    }

    return {
      ok: true,
      duplicateCount,
      groupsCount: duplicateGroups.length,
      duplicateGroups: duplicateGroups.slice(0, 100),
      groups: duplicateGroups.slice(0, 100),
    };
  });

  /**
   * 执行去重：按「歌名 + 主歌手」分组，保留最早收藏的一首，删除其余冗余曲目。
   */
  app.post('/api/favorites/dedup', async req => {
    const user = requireUser(req);
    const db = getDatabase();

    const rows = db
      .prepare(`
        SELECT f.track_id, f.created_at, t.name, t.artists_json
        FROM favorites f
        JOIN tracks t ON t.id = f.track_id
        WHERE f.user_id = ?
        ORDER BY f.created_at ASC
      `)
      .all(user.id) as Array<{
        track_id: string;
        created_at: number;
        name: string;
        artists_json: string;
      }>;

    const groups = new Map<string, string[]>();
    for (const r of rows) {
      let mainArtist = '';
      try {
        const ar = JSON.parse(r.artists_json || '[]');
        if (Array.isArray(ar) && ar.length > 0) {
          mainArtist = String(ar[0]?.name || '');
        }
      } catch {
        // ignore
      }
      const normKey = `${(r.name || '').trim().toLowerCase()}::${mainArtist.trim().toLowerCase()}`;
      if (!groups.has(normKey)) {
        groups.set(normKey, []);
      }
      groups.get(normKey)!.push(r.track_id);
    }

    const idsToRemove: string[] = [];
    for (const trackIds of groups.values()) {
      if (trackIds.length > 1) {
        idsToRemove.push(...trackIds.slice(1));
      }
    }

    if (idsToRemove.length > 0) {
      const deleteStmt = db.prepare('DELETE FROM favorites WHERE user_id = ? AND track_id = ?');
      db.exec('BEGIN');
      try {
        for (const tid of idsToRemove) {
          deleteStmt.run(user.id, tid);
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      triggerFavoritesSummaryUpdate(user.id);
    }

    return {
      ok: true,
      removedCount: idsToRemove.length,
      remainingCount: repo.countFavorites(user.id),
    };
  });
}
