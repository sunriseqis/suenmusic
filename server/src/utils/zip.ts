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
 * 解析 ZIP 或 .sm 文件，返回解压后的文件条目列表。
 */
export function parseZip(buf: Buffer): ParsedZipEntry[] {
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

  let cur = cdOffset;
  const result: ParsedZipEntry[] = [];

  for (let i = 0; i < totalEntries; i++) {
    if (cur + 46 > buf.length) break;
    if (buf.readUInt32LE(cur) !== 0x02014b50) break;

    const method = buf.readUInt16LE(cur + 10);
    const compSize = buf.readUInt32LE(cur + 20);
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
        const rawData = buf.subarray(dataStart, dataStart + compSize);
        let decompressed: Buffer;
        if (method === 8) {
          decompressed = zlib.inflateRawSync(rawData);
        } else if (method === 0) {
          decompressed = Buffer.from(rawData);
        } else {
          decompressed = zlib.inflateSync(rawData);
        }
        result.push({ name: filename, data: decompressed });
      }
    }

    cur += 46 + nameLen + extraLen + commentLen;
  }

  return result;
}
