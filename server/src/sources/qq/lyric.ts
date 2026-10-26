/**
 * QQ 音乐歌词。
 *
 * 搬运自桌面端 `src/api/qq/lyric.js`，改动与实测结论：
 *
 * 1. **解码换 Buffer**：浏览器端要手搓 `atob` + `Uint8Array` + `TextDecoder`
 *    三段式才能正确解 UTF-8；Node 的 `Buffer.from(x, 'base64').toString('utf8')`
 *    一步到位，且不会在多字节字符边界上出错。
 * 2. **翻译必须显式请求**：上游默认不返回 `trans`，要传 `trans: 1` 才有。
 *    桌面端把 `tlyric` 硬编码成空串，等于白丢了这个字段。
 * 3. **`qrc`（逐字歌词）与 `roma`（罗马音）不提供**：实测这两个字段即便请求了
 *    也是**加密二进制**，需用响应里的 `crypt` 值做 AES 解密。解密属于客户端
 *    渲染增强，暂不实现 —— 与其返回一段乱码，不如不返回。
 */

import { createLogger } from '../../logger.ts';
import { cacheGet, cachePut } from '../../services/upstream-cache.ts';
import { COMM_DEFAULT, requestQQMusic } from './client.ts';

const log = createLogger('qq:lyric');

export interface QQLyric {
  /** 原文歌词（LRC） */
  lrc: { lyric: string };
  /** 翻译歌词（LRC）。无翻译时为空串，客户端需自行判断 */
  tlyric: { lyric: string };
}

const EMPTY: QQLyric = {
  lrc: { lyric: '' },
  tlyric: { lyric: '' },
};

/** L2（表）有效期：歌词内容基本不可变，7 天足够 */
const LYRIC_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 歌词缓存上限。歌词内容不可变，命中率极高，值得常驻内存。 */
const LYRIC_CACHE_MAX = 500;
const cache = new Map<string, QQLyric>();

function remember(key: string, value: QQLyric): void {
  // 超出上限时淘汰最早的条目（Map 保持插入顺序，天然 FIFO）
  if (cache.size >= LYRIC_CACHE_MAX) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, value);
}

/**
 * 解码上游返回的歌词字段。
 *
 * QQ 的 `lyric` / `trans` 都是 UTF-8 文本的 Base64。但**不能无条件解码**：
 * 上游出错时会把错误说明直接明文塞进这个字段，拿明文去做 Base64 解码
 * 会得到一堆乱码。因此先判断像不像 Base64。
 */
function decodeField(raw: unknown): string {
  if (typeof raw !== 'string' || !raw) return '';

  const compact = raw.replace(/\s+/g, '');
  const looksBase64 =
    compact.length >= 8 &&
    compact.length % 4 === 0 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(compact);

  if (!looksBase64) return raw;

  try {
    const decoded = Buffer.from(compact, 'base64').toString('utf8');
    // 解出替换字符说明它不是 UTF-8 文本（可能是加密内容），退回原文更安全
    return decoded.includes('\uFFFD') ? raw : decoded;
  } catch {
    return raw;
  }
}

/**
 * 获取 QQ 音乐歌词。
 *
 * @param mid    QQ 单曲 mid（路由键去掉 `qq_` 前缀）
 * @param songId QQ 数字 songID。上游允许只给 mid，该参数是可选的加速项。
 */
export async function getQQLyric(
  mid: string,
  songId: number | string = 0
): Promise<QQLyric> {
  if (!mid) return EMPTY;

  const key = `${mid}:${Number(songId) || 0}`;
  const hit = cache.get(key);
  if (hit) return hit;

  // L2：表。重启后内存清空，这一层保证不会为同一首歌重复打上游
  const stored = cacheGet<QQLyric>('lyric', key, LYRIC_TTL_MS);
  if (stored) {
    remember(key, stored); // 回填 L1
    return stored;
  }

  try {
    const res = await requestQQMusic<any>(
      {
        lyric: {
          module: 'music.musichallSong.PlayLyricInfo',
          method: 'GetPlayLyricInfo',
          param: {
            songMID: mid,
            songID: Number(songId) || 0,
            // 不传这个，trans 恒为空串
            trans: 1,
          },
        },
      },
      COMM_DEFAULT
    );

    const data = res?.lyric?.data;
    // 无歌词是正常状态（纯音乐），不缓存也不报错
    if (!data) return EMPTY;

    const result: QQLyric = {
      lrc: { lyric: decodeField(data.lyric) },
      tlyric: { lyric: decodeField(data.trans) },
    };

    // 只有确实拿到歌词才缓存，避免把"上游抽风"固化成 500 条空结果
    if (result.lrc.lyric) {
      remember(key, result);
      cachePut('lyric', key, result);
    }

    return result;
  } catch (err) {
    log.warn(`歌词失败 mid=${mid}: ${(err as Error)?.message ?? err}`);
    return EMPTY;
  }
}

/** 仅供验收脚本使用 */
export function clearLyricCache(): void {
  cache.clear();
}
