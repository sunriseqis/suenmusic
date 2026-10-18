/**
 * QQ 歌单详情（直连）。
 *
 * 歌单导入是**客户端业务**，不该经过服务端：服务端只负责数据同步。
 * 请求参数与服务端 `sources/qq/home.ts` 完全一致，端口化后行为对齐。
 */
import type { Track } from '@/api/types.ts';
import { qqPost, trackFromRaw } from './home.ts';

export interface DirectPlaylist {
  id: string;
  name: string;
  picUrl: string;
  description: string;
  playCount: number;
  trackCount: number;
  creator: { nickname: string };
  tracks: Track[];
}

export async function directQQPlaylist(tid: string | number): Promise<DirectPlaylist> {
  // 支持纯 id / 分享链接：取最后一段连续数字（链接里可能有别的数字）
  const groups = String(tid).match(/\d{3,}/g) ?? [];
  const numeric = Number(groups[groups.length - 1] ?? 0);
  if (!Number.isFinite(numeric) || numeric <= 0) throw new Error('歌单 id 不合法');

  const res = await qqPost({
    playlist: {
      module: 'music.srfDissInfo.aiDissInfo',
      method: 'uniform_get_Dissinfo',
      param: { disstid: numeric, userinfo: 1, tag: 1 },
    },
  });

  const data = (res.playlist as { data?: Record<string, unknown> } | undefined)?.data;
  if (!data) throw new Error('歌单不存在或已下架');

  const dirinfo = (data.dirinfo ?? {}) as Record<string, unknown>;
  const songlist = (data.songlist ?? []) as unknown[];
  const tracks = songlist.map(trackFromRaw).filter((t): t is Track => !!t);

  return {
    id: `qq_pl_${numeric}`,
    name: String(dirinfo.title ?? 'QQ 音乐歌单'),
    picUrl: String(dirinfo.picurl ?? ''),
    description: String(dirinfo.desc ?? ''),
    playCount: Number(dirinfo.listennum ?? 0) || 0,
    trackCount: tracks.length,
    creator: {
      nickname: String((dirinfo.creator as { name?: string } | undefined)?.name ?? 'QQ 音乐'),
    },
    tracks,
  };
}
