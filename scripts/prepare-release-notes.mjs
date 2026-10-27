#!/usr/bin/env node
/**
 * 跨端发布说明幂等合并工具。
 *
 * 解决问题：
 *   飞牛端、鸿蒙端、iOS 端独立触发 CI 发布到公开仓库 sunriseqis/suenapp 的同一个 Release（如 v2.0.0）。
 *   若使用 append_body: true，同一端重复构建时会导致同一份说明文本被重复追加多次；
 *   若使用 append_body: false，后构建的端会覆盖前一个端的说明。
 *
 * 本脚本通过带标记的 SECTION 分区，实现：
 *   1. 首次发布该端：追加到 Release 说明中；
 *   2. 重复构建该端：自动定位本端段落并幂等更新替换（同时清理历史无标记重复段落），保持仅一份；
 *   3. 其它端的发布说明完整保留不受影响。
 *
 * 用法：
 *   node scripts/prepare-release-notes.mjs --platform <fnos|harmony|ios> --tag <v2.0.0> --output <path>
 */

import { writeFileSync } from 'node:fs';

const PLATFORMS = {
  fnos: {
    id: 'FNOS',
    titleRegex: /###\s+SuenMusic\s+.*?飞牛私有云[\s\S]*?(?=(?:###\s+SuenMusic|<!-- SECTION:)|$)/gi,
    content: (tag) => `<!-- SECTION:FNOS -->
### SuenMusic ${tag} 飞牛私有云（fnOS）原生套件

- **格式**：\`.fpk\` 纯原生系统运行（免 Docker，零虚拟化损耗）。
- **功能**：内置安装引导向导，支持安装时自定义服务端口并直接初始化第一个管理员账号，开箱即用。
<!-- /SECTION:FNOS -->`
  },
  harmony: {
    id: 'HARMONY',
    titleRegex: /###\s+SuenMusic\s+.*?鸿蒙[\s\S]*?(?=(?:###\s+SuenMusic|<!-- SECTION:)|$)/gi,
    content: (tag) => `<!-- SECTION:HARMONY -->
### SuenMusic ${tag} 鸿蒙 NEXT 原生客户端

- **格式**：\`.hap\` 未签名包。
- **使用方式**：可直接推入鸿蒙 NEXT 模拟器调试，或通过移动端侧载/自签名工具签名后在真机运行。
<!-- /SECTION:HARMONY -->`
  },
  ios: {
    id: 'IOS',
    titleRegex: /###\s+SuenMusic\s+.*?iOS[\s\S]*?(?=(?:###\s+SuenMusic|<!-- SECTION:)|$)/gi,
    content: (tag) => `<!-- SECTION:IOS -->
### SuenMusic ${tag} iOS 原生客户端

- **格式**：\`.ipa\` 未签名包。
- **使用方式**：可直接使用 AltStore、SideStore、爱思助手等工具通过个人证书签名后安装到真机。
<!-- /SECTION:IOS -->`
  }
};

function parseArgs() {
  const args = process.argv.slice(2);
  let platform = '';
  let tag = '';
  let output = '';
  let repo = process.env.RELEASE_REPO || 'sunriseqis/suenapp';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--platform' && args[i + 1]) platform = args[++i];
    if (args[i] === '--tag' && args[i + 1]) tag = args[++i];
    if (args[i] === '--output' && args[i + 1]) output = args[++i];
    if (args[i] === '--repo' && args[i + 1]) repo = args[++i];
  }

  if (!platform || !tag || !output) {
    console.error('用法: node scripts/prepare-release-notes.mjs --platform <fnos|harmony|ios> --tag <vX.Y.Z> --output <file>');
    process.exit(1);
  }

  return { platform, tag, output, repo };
}

async function fetchExistingReleaseBody(repo, tag) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_RELEASE_TOKEN || '';
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'suenmusic-ci',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/tags/${tag}`, { headers });
    if (res.status === 404) return '';
    if (!res.ok) {
      console.warn(`[WARN] 获取现有 Release 失败 (HTTP ${res.status})，将作为全新 Release 处理`);
      return '';
    }
    const data = await res.json();
    return typeof data.body === 'string' ? data.body : '';
  } catch (err) {
    console.warn(`[WARN] 无法连接 GitHub API: ${err.message}，按全新 Release 处理`);
    return '';
  }
}

export function mergeBody(existing, platform, tag) {
  const conf = PLATFORMS[platform];
  if (!conf) throw new Error('Unsupported platform: ' + platform);
  const newContent = conf.content(tag).trim();

  let body = (existing || '').trim();
  const markedRegex = new RegExp(`<!-- SECTION:${conf.id} -->[\\s\\S]*?<!-- /SECTION:${conf.id} -->`, 'gi');
  const titleRegex = new RegExp(conf.titleRegex.source, 'gi');

  if (markedRegex.test(body)) {
    // 替换所有已存在的带标记段落
    markedRegex.lastIndex = 0;
    let replacedFirst = false;
    body = body.replace(markedRegex, () => {
      if (!replacedFirst) {
        replacedFirst = true;
        return newContent;
      }
      return '';
    });
  } else if (titleRegex.test(body)) {
    // 替换历史无标记段落（同时自动清理多次重复文本）
    titleRegex.lastIndex = 0;
    let replacedFirst = false;
    body = body.replace(titleRegex, () => {
      if (!replacedFirst) {
        replacedFirst = true;
        return newContent;
      }
      return '';
    });
  } else {
    // 全新段落追加
    body = body ? `${body}\n\n${newContent}` : newContent;
  }

  return body.replace(/\n{3,}/g, '\n\n').trim();
}

async function main() {
  const { platform, tag, output, repo } = parseArgs();
  console.log(`[Release Notes] 正在合并平台 ${platform} (Tag: ${tag}, Repo: ${repo})...`);

  const existingBody = await fetchExistingReleaseBody(repo, tag);
  const mergedBody = mergeBody(existingBody, platform, tag);

  writeFileSync(output, mergedBody + '\n', 'utf8');
  console.log(`[Release Notes] 成功写入发布说明到: ${output}`);
}

main().catch(err => {
  console.error('[Release Notes] 错误:', err);
  process.exit(1);
});
