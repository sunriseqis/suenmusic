/**
 * 本机锚点表（无服务端时的等价物）。
 *
 * 锚定的语义没变：用户手工指定「这首曲 = 这个 B 站视频」，之后解析**直接用它**，
 * 不再走搜索与打分。服务端把锚点存库并跨设备共享；这里存在本机 localStorage，
 * 只对本机生效 —— 这正是直连模式的定义。
 */
import type { Track } from '@/api/types.ts';
import type { BiliCandidate } from '@/api/playback.ts';
import { biliSearch } from './upstream.ts';
import { scoreCandidate } from './matcher.ts';

const KEY = 'suenmusic.anchors';

export interface LocalAnchor {
  bvid: string;
  title: string;
  author: string;
  durationSec: number;
  pinned: boolean;
  at: number;
}

function readAll(): Record<string, LocalAnchor> {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Record<string, LocalAnchor>) : {};
  } catch {
    return {};
  }
}

function writeAll(all: Record<string, LocalAnchor>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* 写不进去时锚点只在本会话生效，不阻断播放 */
  }
}

export function getLocalAnchor(trackId: string): LocalAnchor | null {
  return readAll()[trackId] ?? null;
}

export function setLocalAnchor(
  trackId: string,
  a: Omit<LocalAnchor, 'at' | 'pinned'>
): void {
  const all = readAll();
  all[trackId] = { ...a, pinned: true, at: Date.now() };
  writeAll(all);
}

export function removeLocalAnchor(trackId: string): void {
  const all = readAll();
  delete all[trackId];
  writeAll(all);
}

/**
 * 客户端候选搜索：B 站搜索 + 与服务端完全相同的打分器。
 * 返回结构与服务端 `/api/playback/candidates` 对齐，弹窗不用分支。
 */
export async function searchLocalCandidates(
  track: Track,
  keyword: string
): Promise<{
  keyword: string;
  rejected: boolean;
  message?: string;
  track: {
    id: string;
    name: string;
    artists: string[];
    durationMs: number;
    albumName: string;
    albumPic: string;
  };
  candidates: BiliCandidate[];
}> {
  const artists = (track.ar ?? []).map(a => a.name).filter(Boolean);
  const q = keyword.trim() || [track.name, artists[0] ?? ''].filter(Boolean).join(' ');

  const list = await biliSearch(q);
  const matchTrack = { name: track.name, artists, durationMs: track.dt || 0 };
  const scored = list
    .map(c => {
      const s = scoreCandidate(matchTrack, c);
      return { ...c, score: s.finalScore, durationDiff: s.durationDiff };
    })
    .sort((a, b) => b.score - a.score);

  return {
    keyword: q,
    rejected: false,
    track: {
      id: track.id,
      name: track.name,
      artists,
      durationMs: track.dt || 0,
      albumName: track.al?.name ?? '',
      albumPic: track.al?.picUrl ?? '',
    },
    candidates: scored.slice(0, 10).map(c => ({
      bvid: c.bvid,
      title: c.title,
      author: c.author,
      durationSec: c.durationSec,
      score: c.score,
      durationDiff: c.durationDiff,
      pic: c.pic,
      // 直连模式没有服务端代理流，试听时再按需解析真实地址
      previewUrl: '',
    })),
  };
}
