/**
 * 多路径服务端：候选列表 + 探测选路 + 失败自动切换。
 *
 * 场景（用户的实际部署）：同一套后端有四条网络路径 ——
 *   ① 内网 http://192.168.89.11:3210   ② 反代 https://域名:端口
 *   ③ FRP 付费公网                      ④ CF 隧道兜底
 * 期望：在家走内网（快、不占公网上行），出门自动走公网路径，
 * 某条路断了自动换下一条 —— 用户无感。
 *
 * 策略（2026-09-14 用户拍板）：
 *   - **保守**：当前路径可用就不动（不做"内网一可用就切回"的激进策略）
 *   - 启动时按优先级探测一次（此刻切换代价最小）；运行期只在失败时切换
 *   - 探测：第 1 个候选短超时独占（在家几乎瞬时命中），失败则其余并行按优先级取
 *   - 播放中允许切换，由播放层负责重载当前曲（见 stores/player.ts 的重绑逻辑）
 *
 * 前提：四条路径指向**同一套后端**（同 DB、同 JWT 密钥），所以切换后登录态与
 * 数据完全一致，不需要重新登录。
 */
import { getBaseUrl, registerFailoverHook, setBaseUrl } from './client.ts';

export interface ServerCandidate {
  /** 展示用标签（内网 / 反代 / FRP / 隧道…），可空 */
  label: string;
  url: string;
}

const LIST_KEY = 'suenmusic.servers';
const LEGACY_KEY = 'suenmusic.baseUrl';

/** 探测超时：第 1 个候选更短（内网在家几乎瞬时），其余放宽一点 */
const PROBE_TIMEOUT_FIRST_MS = 1500;
const PROBE_TIMEOUT_REST_MS = 3000;
/** 切换冷却：并发请求同时失败时只触发一轮探测，避免探测风暴 */
const FAILOVER_COOLDOWN_MS = 3000;

function normalize(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

function sanitize(raw: unknown): ServerCandidate[] {
  if (!Array.isArray(raw)) return [];
  const out: ServerCandidate[] = [];
  for (const item of raw) {
    const url = normalize(String((item as ServerCandidate)?.url ?? ''));
    if (!url) continue;
    const label = String((item as ServerCandidate)?.label ?? '').trim() || url;
    out.push({ label, url });
  }
  return out;
}

/** 读取候选列表（首次调用会把旧的单地址迁移成列表首项） */
export function getServerList(): ServerCandidate[] {
  try {
    const raw = localStorage.getItem(LIST_KEY);
    if (raw) return sanitize(JSON.parse(raw));

    // 迁移：旧的单一基地址 → 列表首项
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy && legacy.trim()) {
      const list = [{ label: '默认', url: normalize(legacy) }];
      try {
        localStorage.setItem(LIST_KEY, JSON.stringify(list));
      } catch {
        /* 写不进去也不影响本次使用 */
      }
      return list;
    }
  } catch {
    /* 隐私模式等：按空列表处理 */
  }
  return [];
}

export function setServerList(list: ServerCandidate[]): void {
  const cleaned = sanitize(list);
  try {
    localStorage.setItem(LIST_KEY, JSON.stringify(cleaned));
  } catch {
    /* 忽略 */
  }
  // 当前基地址不在列表里（例如被删掉了）时，回落到首项
  const current = getBaseUrl();
  const head = cleaned[0];
  if (head && !cleaned.some(c => c.url === current)) setBaseUrl(head.url);
}

/** 探测某条路径是否可用（`/api/health` 免鉴权、服务端 CORS 已放通） */
export function probeServer(url: string, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    const ctl = new AbortController();
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => {
      try {
        ctl.abort();
      } catch {
        /* 忽略 */
      }
      done(false);
    }, timeoutMs);

    fetch(`${url}/api/health`, { signal: ctl.signal, cache: 'no-store' })
      .then(res => done(res.ok))
      .catch(() => done(false));
  });
}

function apply(url: string): string {
  if (getBaseUrl() !== url) setBaseUrl(url);
  return url;
}

let selecting: Promise<string | null> | null = null;
let lastFailoverAt = 0;

/** 判断 URL 是否指向局域网私有 IP 或本地回环 */
export function isPrivateIpUrl(url: string): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url.includes('://') ? url : `http://${url}`);
    const host = parsed.hostname;
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      /^192\.168\./.test(host) ||
      /^10\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    );
  } catch {
    return false;
  }
}

/**
 * 按优先级选路。返回选中的地址；全不可用返回 null。
 *
 * 启动时、网络变化时（WiFi 切换 / 恢复联网）调用。
 */
export async function selectBestServer(): Promise<string | null> {
  const list = getServerList();
  if (list.length === 0) return null;

  // 第 1 个候选（最高优先级，通常是内网）短超时独占探测
  const first = list[0];
  if (!first) return null;
  if (await probeServer(first.url, PROBE_TIMEOUT_FIRST_MS)) return apply(first.url);
  if (list.length === 1) return null;

  // 其余并行探测，按优先级取第一个可用
  const rest = list.slice(1);
  const results = await Promise.all(
    rest.map(async c => ({ c, ok: await probeServer(c.url, PROBE_TIMEOUT_REST_MS) }))
  );
  const hit = results.find(r => r.ok);
  return hit ? apply(hit.c.url) : null;
}

let lastAutoSelectAt = 0;
/** 网络环境发生变化（如断开 WiFi 切到 4G/5G，或离开电梯恢复网络）时快速重选 */
export async function onNetworkEnvironmentChanged(): Promise<string | null> {
  const list = getServerList();
  if (list.length < 2) return null;
  const now = Date.now();
  if (now - lastAutoSelectAt < 2000) return null;
  lastAutoSelectAt = now;
  return selectBestServer();
}

/**
 * 请求失败时调用：探测并用可用路径接管。
 *
 * @returns true = 存在可用路径（调用方应当重放一次请求）
 */
export function failoverIfNeeded(): Promise<boolean> {
  const list = getServerList();
  if (list.length < 2) return Promise.resolve(false);

  if (selecting) return selecting.then(picked => picked !== null);

  const now = Date.now();
  if (now - lastFailoverAt < FAILOVER_COOLDOWN_MS) return Promise.resolve(false);
  lastFailoverAt = now;

  selecting = (async () => {
    const current = getBaseUrl();
    const isPrivate = isPrivateIpUrl(current);

    // 当前路径是非内网（公网/域名/FRP）时，才探测 1s 确认是否瞬时抖动；
    // 如果当前就是局域网私有 IP，既然已经发生网络连接失败，说明离开内网，
    // 绝不再等探测内网！直接并行探测其余公网备选，避免卡死几十秒。
    if (!isPrivate && current && (await probeServer(current, 1000))) return current;

    // 当前路径不可用 → 并行探测其余，按优先级取第一个可用
    const others = list.filter(c => c.url !== current);
    const results = await Promise.all(
      others.map(async c => ({ c, ok: await probeServer(c.url, PROBE_TIMEOUT_REST_MS) }))
    );
    const hit = results.find(r => r.ok);
    return hit ? apply(hit.c.url) : null;
  })();

  const pending = selecting;
  return pending
    .then(picked => picked !== null)
    .finally(() => {
      if (selecting === pending) selecting = null;
    });
}

/** 供设置页"测试"按钮使用：逐条探测并回传结果 */
export async function probeAll(): Promise<Array<ServerCandidate & { ok: boolean }>> {
  const list = getServerList();
  const results = await Promise.all(
    list.map(async c => ({ ...c, ok: await probeServer(c.url, PROBE_TIMEOUT_REST_MS) }))
  );
  return results;
}

// 注册到客户端：请求遇到网络层失败时触发选路（见 client.ts 的 registerFailoverHook）
registerFailoverHook(failoverIfNeeded);
