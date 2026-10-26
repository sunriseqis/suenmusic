/**
 * 酷狗概念版会员「续签编排」。
 *
 * 边界（重要）：
 *   · 每日领取的实现**留在用户自己的工具里**（EchoVIP-Headless 等），
 *     本项目不复制、不重写领取协议 —— 领取由账号本人每天执行一次，
 *     涉及广告播放上报等平台行为，必须由用户自建的工具与账号自行承担；
 *   · 本项目只做三件事：**按日程拉起那条命令**、**读回会员状态**、**把结果暴露给面板**。
 *
 * 为什么必须做：VIP 到期会直接让 VIP 曲取流拿不到 url（实测：会员生效前
 * 淘金小镇/突然好想你只有 128kbps，FLAC 只回 bitrate 不回 url），
 * 而用户不会天天记得手动跑一次领取。
 */

import { exec } from 'node:child_process';
import { createLogger } from '../logger.ts';
import { getSetting, setSetting } from '../db/repo/settings.ts';
import { readKugouVipStatus } from './kugou-vip.ts';

const log = createLogger('kugou:claim');

const KEY_ENABLED = 'kugou.claim.enabled';
const KEY_COMMAND = 'kugou.claim.command';
const KEY_HOUR = 'kugou.claim.hour';
const KEY_LAST = 'kugou.claim.last';

export interface KugouClaimSettings {
  /** 是否启用自动续签调度 */
  enabled: boolean;
  /** 要执行的命令（用户自己的领取工具，例如 `node /opt/EchoVIP-Headless/dist/cli.js`） */
  command: string;
  /** 每天几点执行（业务本地时间，0-23） */
  hour: number;
}

export interface KugouClaimResult {
  at: number;
  ok: boolean;
  /** 命令输出尾部（截断，便于面板显示失败原因） */
  output: string;
  /** 执行后复查到的会员到期时间 */
  vipEndTime: string;
  isVip: boolean;
}

export function readClaimSettings(): KugouClaimSettings {
  return {
    enabled: getSetting(KEY_ENABLED) === '1',
    command: getSetting(KEY_COMMAND) ?? '',
    hour: Number(getSetting(KEY_HOUR) ?? 7),
  };
}

export function saveClaimSettings(patch: Partial<KugouClaimSettings>): KugouClaimSettings {
  if (patch.enabled !== undefined) setSetting(KEY_ENABLED, patch.enabled ? '1' : '0');
  if (patch.command !== undefined) setSetting(KEY_COMMAND, patch.command.trim());
  if (patch.hour !== undefined) {
    const h = Math.max(0, Math.min(23, Math.floor(patch.hour)));
    setSetting(KEY_HOUR, String(h));
  }
  return readClaimSettings();
}

export function readLastClaim(): KugouClaimResult | null {
  const raw = getSetting(KEY_LAST);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as KugouClaimResult;
  } catch {
    return null;
  }
}

/**
 * 执行一次续签：跑命令 → 复查会员状态 → 记录结果。
 *
 * 命令超时 120 秒；失败不抛（调度器不该被一次失败打断），错误写进结果与日志。
 */
export async function runKugouClaim(): Promise<KugouClaimResult> {
  const { command } = readClaimSettings();
  const at = Date.now();
  if (!command) {
    const result: KugouClaimResult = { at, ok: false, output: '未配置续签命令', vipEndTime: '', isVip: false };
    setSetting(KEY_LAST, JSON.stringify(result));
    return result;
  }

  log.info(`开始执行续签命令：${command}`);
  const output = await new Promise<string>(resolve => {
    exec(command, { timeout: 120_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const text = `${stdout ?? ''}\n${stderr ?? ''}`.trim();
      if (err) resolve(`命令失败：${(err as Error).message}\n${text}`.slice(-1200));
      else resolve(text.slice(-1200));
    });
  });

  // 命令跑完再查会员，避免读到执行前的旧状态
  const vip = await readKugouVipStatus();
  const ok = vip.ok && vip.isVip;
  const result: KugouClaimResult = { at, ok, output, vipEndTime: vip.endTime, isVip: vip.isVip };
  setSetting(KEY_LAST, JSON.stringify(result));
  log.info(`续签完成：isVip=${vip.isVip} 到期=${vip.endTime || '未知'}`);
  return result;
}

/** 每天该执行的下一次时间戳（业务本地时间 hour:00 由 index.ts 的排程器使用） */
export function nextClaimDelayMs(hour: number): number {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}
