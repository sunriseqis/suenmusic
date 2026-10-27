import { strParam } from './params.ts';

export function isIosClient(req: { headers?: Record<string, any>; query?: any }): boolean {
  const p = strParam(req.query?.platform).toLowerCase();
  if (p === 'ios') return true;
  const fmt = strParam(req.query?.format).toLowerCase();
  if (fmt === 'mp3') return true;
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
