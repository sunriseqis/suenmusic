import { existsSync } from 'node:fs';

export type DeployMode = 'fnos' | 'docker';

/**
 * 判定服务端当前的部署方式：
 * - 'fnos': 飞牛私有云（fnOS）原生套件应用
 * - 'docker': Docker 容器或通用容器化部署（默认）
 */
export function getDeployMode(): DeployMode {
  const env = (process.env.SUENMUSIC_DEPLOY_ENV || '').trim().toLowerCase();
  if (env === 'fnos' || process.env.TRIM_APPDEST || process.env.TRIM_PKGVAR) {
    return 'fnos';
  }
  if (env === 'docker' || existsSync('/.dockerenv') || existsSync('/run/.containerenv')) {
    return 'docker';
  }
  return 'docker';
}
