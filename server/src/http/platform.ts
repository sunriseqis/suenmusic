import { strParam } from './params.ts';

type PlatformReq = { headers?: Record<string, any>; query?: any };

/**
 * 平台身份：这台设备是不是 iOS 客户端。
 *
 * ⚠️ 只看**平台标识**（?platform=ios / x-platform / UA），不把 ?format=mp3 当身份 ——
 * 那只是「要 mp3 容器」的偏好（见 wantsMp3Container）。两者混在一起时，任何带 format=mp3 的
 * 网页/安卓请求都会被当成 iOS（限速豁免、缓存键全跟着变）。
 * iOS 客户端本身固定带 ?platform=ios（ios/SuenMusic/Net/APIClient.swift:349），
 * 所以拆开不会让它丢掉 mp3 偏好。
 *
 * ⚠️ 身份**不再决定缺省音质**（2026-10-28）：iOS 播放内核换成 libmpv（ffmpeg 解码），
 * 实测 FLAC / OGG / fMP4 / MP3 全部可播（docs/memory/2026-10-28-iOS音频格式实测矩阵.md 第五节），
 * 「iOS 缺省 exhigh」这个为绕开 AVPlayer 的降档已经撤销 —— 现在所有端缺省 lossless。
 */
export function isIosClient(req: PlatformReq): boolean {
  const p = strParam(req.query?.platform).toLowerCase();
  if (p === 'ios') return true;
  const headerPlatform = String(req.headers?.['x-platform'] ?? '').toLowerCase();
  if (headerPlatform === 'ios') return true;
  const ua = String(req.headers?.['user-agent'] ?? '').toLowerCase();
  return (
    ua.includes('suenmusic-ios') ||
    (ua.includes('suenmusic') && ua.includes('ios')) ||
    ua.includes('iphone') ||
    ua.includes('ipad') ||
    ua.includes('ipod') ||
    (ua.includes('cfnetwork') && ua.includes('darwin'))
  );
}

/**
 * 「要 mp3 容器」偏好：iOS 身份，或任意客户端显式 `?format=mp3`。
 *
 * 与 isIosClient 拆开：身份决定平台差异（限速豁免等），偏好只决定容器。
 * ⚠️ 它**不决定码率档位**：要 mp3 容器的客户端照样可以拿 lossless（FLAC）。
 * 名字刻意带上 Container —— 旧名 `preferMp3` 被读成「要低码率 mp3」，
 * 于是 iOS 连无损一起被剔掉了（2026-10-28 撤销）。
 */
export function wantsMp3Container(req: PlatformReq): boolean {
  if (isIosClient(req)) return true;
  return strParam(req.query?.format).toLowerCase() === 'mp3';
}

/**
 * 平台显示标签（运维日志用）：iOS / 鸿蒙 / 安卓 / Web。
 * iOS 复用 isIosClient；鸿蒙看 UA 里的 harmony / hmos / huawei 标识（仅观测用途）。
 */
export function clientPlatformLabel(req: PlatformReq): string {
  if (isIosClient(req)) return 'iOS';
  const ua = String(req.headers?.['user-agent'] ?? '').toLowerCase();
  if (ua.includes('harmony') || ua.includes('hmos') || ua.includes('huawei')) return '鸿蒙';
  if (ua.includes('android') || ua.includes('capacitor')) return '安卓';
  return 'Web';
}
