/**
 * 极简 ZIP 压缩与解压工具（零第三方依赖，基于 Node 内置 node:zlib）。
 *
 * 用于本应用 .sm 软加密备份文件的打包与解压：
 * 内含 favorites.json（收藏歌单）与 persona.md（用户画像）。
 */
import zlib from 'node:zlib';

export interface ZipEntry {
  name: string;
  data: Buffer | string;
}

export interface ParsedZipEntry {
  name: string;
  data: Buffer;
}

/**
 * 将一组文件打包为标准 ZIP 格式的 Buffer（可保存为 .sm）。
 */
export function createZip(files: ZipEntry[]): Buffer {
  const localHeaders: Buffer[] = [];
  const centralHeaders: Buffer[] = [];
  let offset = 0;

  const now = new Date();
  const time =
    (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const date =
    ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    const dataBuf = Buffer.isBuffer(file.data)
      ? file.data
      : Buffer.from(file.data, 'utf8');
    const compressed = zlib.deflateRawSync(dataBuf);
    const crc = zlib.crc32(dataBuf);

    // Local file header: 30 bytes + nameLen
    const lh = Buffer.alloc(30 + nameBuf.length);
    lh.writeUInt32LE(0x04034b50, 0); // signature
    lh.writeUInt16LE(20, 4); // version needed to extract (2.0)
    lh.writeUInt16LE(0x0800, 6); // general purpose bit flag (UTF-8 filename)
    lh.writeUInt16LE(8, 8); // compression method (deflate)
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(compressed.length, 18);
    lh.writeUInt32LE(dataBuf.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28); // extra field length
    nameBuf.copy(lh, 30);

    localHeaders.push(lh, compressed);

    // Central directory file header: 46 bytes + nameLen
    const ch = Buffer.alloc(46 + nameBuf.length);
    ch.writeUInt32LE(0x02014b50, 0); // signature
    ch.writeUInt16LE(20, 4); // version made by
    ch.writeUInt16LE(20, 6); // version needed
    ch.writeUInt16LE(0x0800, 8); // flags (UTF-8)
    ch.writeUInt16LE(8, 10); // compression method
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(compressed.length, 20);
    ch.writeUInt32LE(dataBuf.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30); // extra field len
    ch.writeUInt16LE(0, 32); // comment len
    ch.writeUInt16LE(0, 34); // disk number
    ch.writeUInt16LE(0, 36); // internal file attributes
    ch.writeUInt32LE(0, 38); // external file attributes
    ch.writeUInt32LE(offset, 42); // relative offset of local header
    nameBuf.copy(ch, 46);

    centralHeaders.push(ch);
    offset += lh.length + compressed.length;
  }

  const cdBuf = Buffer.concat(centralHeaders);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // start disk
  eocd.writeUInt16LE(files.length, 8); // records on this disk
  eocd.writeUInt16LE(files.length, 10); // total records
  eocd.writeUInt32LE(cdBuf.length, 12); // size of central directory
  eocd.writeUInt32LE(offset, 16); // offset of central directory
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localHeaders, cdBuf, eocd]);
}

/**
 * 解压防护上限。
 *
 * 这个解析器面对的是**用户上传的文件**，而 deflate 的压缩比可以做到 1000:1
 * 以上 —— 20MB 的全零数据能压到几十 KB，解压时却要真分配几十 GB。
 * 服务端是单进程 + 单 SQLite（每日推荐、打标任务都跑在同一进程里），
 * 一次 OOM 就是全部用户掉线，所以上限必须在这里设死，不能靠 bodyLimit 兜。
 *
 * 本应用的 .sm 归档只装 `favorites.json` 与 `persona.md` 两个条目，
 * 所以条目数与体积都可以给得很紧。
 */
export interface ParseZipLimits {
  /** 条目数上限（本格式只有 2 个） */
  maxEntries?: number;
  /** 单条目解压后字节上限 */
  maxEntryBytes?: number;
  /** 全部条目解压后累计字节上限 */
  maxTotalBytes?: number;
  /** 单条目压缩比上限（解压后 ÷ 压缩后） */
  maxRatio?: number;
}

const DEFAULT_LIMITS: Required<ParseZipLimits> = {
  maxEntries: 8,
  maxEntryBytes: 8 * 1024 * 1024,
  maxTotalBytes: 16 * 1024 * 1024,
  maxRatio: 100,
};

/**
 * 压缩比闸的最小生效体积。
 *
 * 低于这个体积的条目即便压缩比很夸张（重复文本能到 200:1）也撑不爆内存，
 * 为它拒绝一份合法备份并不划算 —— 真正的风险来自"大体积高压缩比"。
 */
const RATIO_CHECK_MIN_BYTES = 1024 * 1024;

/**
 * 解析 ZIP 或 .sm 文件，返回解压后的文件条目列表。
 *
 * 所有输出都受 `limits` 约束：条目数、单条体积、累计体积、压缩比四道闸，
 * 外加 `inflateRawSync` 的 `maxOutputLength` 作为最后一道保险（即使头部
 * 声明的解压后大小是伪造的，zlib 也会在超限时直接抛错）。
 */
export function parseZip(buf: Buffer, limits: ParseZipLimits = {}): ParsedZipEntry[] {
  const maxEntries = limits.maxEntries ?? DEFAULT_LIMITS.maxEntries;
  const maxEntryBytes = limits.maxEntryBytes ?? DEFAULT_LIMITS.maxEntryBytes;
  const maxTotalBytes = limits.maxTotalBytes ?? DEFAULT_LIMITS.maxTotalBytes;
  const maxRatio = limits.maxRatio ?? DEFAULT_LIMITS.maxRatio;

  if (buf.length < 22) {
    throw new Error('文件过小，不是有效的归档文件');
  }

  // 从末尾寻找 EOCD 标识 (0x06054b50)
  let eocdOffset = -1;
  const searchLimit = Math.max(0, buf.length - 65535 - 22);
  for (let i = buf.length - 22; i >= searchLimit; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }

  if (eocdOffset === -1) {
    throw new Error('未检测到有效 ZIP/SM 归档签名');
  }

  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);

  // 先按声明值拦一次：不合法就不进解压循环，一个字节都不分配
  if (totalEntries > maxEntries) {
    throw new Error(`归档条目数 ${totalEntries} 超过上限 ${maxEntries}`);
  }

  let cur = cdOffset;
  const result: ParsedZipEntry[] = [];
  let totalOut = 0;

  for (let i = 0; i < totalEntries; i++) {
    if (cur + 46 > buf.length) break;
    if (buf.readUInt32LE(cur) !== 0x02014b50) break;

    const method = buf.readUInt16LE(cur + 10);
    const compSize = buf.readUInt32LE(cur + 20);
    const uncompSize = buf.readUInt32LE(cur + 24);
    const nameLen = buf.readUInt16LE(cur + 28);
    const extraLen = buf.readUInt16LE(cur + 30);
    const commentLen = buf.readUInt16LE(cur + 32);
    const localOffset = buf.readUInt32LE(cur + 42);

    const filename = buf.toString('utf8', cur + 46, cur + 46 + nameLen);

    if (localOffset + 30 <= buf.length) {
      const lhNameLen = buf.readUInt16LE(localOffset + 26);
      const lhExtraLen = buf.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + lhNameLen + lhExtraLen;

      if (dataStart + compSize <= buf.length) {
        // 声明值先筛：超限直接拒绝，不进 zlib
        if (uncompSize > maxEntryBytes) {
          throw new Error(
            `归档条目「${filename}」解压后 ${uncompSize} 字节，超过单条上限 ${maxEntryBytes}`
          );
        }
        if (totalOut + uncompSize > maxTotalBytes) {
          throw new Error(`归档解压总量超过上限 ${maxTotalBytes} 字节`);
        }
        // 压缩比闸：全零数据能到 1000:1，正常备份文本只有个位数。
        // ⚠️ 只对大条目生效 —— 一个 4KB 的 "xxxx…" 文本也能压到 200:1，
        // 但它撑不爆内存，为它拒绝合法备份不值得。小条目由体积闸兜着。
        if (
          method !== 0 &&
          compSize > 0 &&
          uncompSize > RATIO_CHECK_MIN_BYTES &&
          uncompSize / compSize > maxRatio
        ) {
          throw new Error(
            `归档条目「${filename}」压缩比 ${Math.round(uncompSize / compSize)}:1 异常，已拒绝解压`
          );
        }

        const rawData = buf.subarray(dataStart, dataStart + compSize);
        let decompressed: Buffer;
        // maxOutputLength：即使头部声明的 uncompSize 被伪造，zlib 也会在超限时抛错
        const inflateOpts = { maxOutputLength: maxEntryBytes };
        if (method === 8) {
          decompressed = zlib.inflateRawSync(rawData, inflateOpts);
        } else if (method === 0) {
          decompressed = Buffer.from(rawData);
        } else {
          decompressed = zlib.inflateSync(rawData, inflateOpts);
        }

        totalOut += decompressed.length;
        if (totalOut > maxTotalBytes) {
          throw new Error(`归档解压总量超过上限 ${maxTotalBytes} 字节`);
        }
        result.push({ name: filename, data: decompressed });
      }
    }

    cur += 46 + nameLen + extraLen + commentLen;
  }

  return result;
}
