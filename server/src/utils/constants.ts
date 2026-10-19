/**
 * 上游请求共用的标识与常量。
 * 集中一处，避免散落在各源文件里需要时到处改。
 */

export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export const BILI_REFERER = 'https://www.bilibili.com';

export const QQ_REFERER = 'https://y.qq.com/';

/** QQ 图床，形如 T002R300x300M000{mid}.jpg，尺寸写在路径里 */
export const QQ_PHOTO_BASE = 'https://y.gtimg.cn/music/photo_new';
