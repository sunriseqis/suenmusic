import { strParam } from './params.ts';

type PlatformReq = { headers?: Record<string, any>; query?: any };

/**
 * 平台身份：这台设备是不是 iOS 客户端。
 *
 * ⚠️ 只看**平台标识**（?platform=ios / x-platform / UA），不把 ?format=mp3 当身份 ——
 * 那只是「要 mp3 容器」的偏好（见 wantsMp3）。两者混在一起时，任何带 format=mp3 的
 * 网页/安卓请求都会被当成 iOS（限速豁免、缺省音质、缓存键全跟着变）。
 * iOS 客户端本身固定带 ?platform=ios（ios/SuenMusic/Net/APIClient.swift:349），
 * 所以拆开不会让它丢掉 mp3 偏好。
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
 * 与 isIosClient 拆开：身份决定缺省音质/限速豁免，偏好只决定容器与码率取舍。
 */
export function wantsMp3(req: PlatformReq): boolean {
  if (isIosClient(req)) return true;
  return strParam(req.query?.format).toLowerCase() === 'mp3';
}
