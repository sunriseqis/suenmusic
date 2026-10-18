/**
 * 导航定义。
 *
 * 桌面侧边栏与移动底部导航**共用这一份**，保证两端不会出现
 * "桌面有这一项、手机没有"的不一致。
 */

import type { IconName } from '@/components/neu/NeuIcon.vue';

export interface NavItem {
  name: string;
  label: string;
  icon: IconName;
}

export const NAV_ITEMS: NavItem[] = [
  { name: 'home', label: '发现', icon: 'home' },
  { name: 'daily', label: '专属', icon: 'sparkles' },
  { name: 'favorites', label: '收藏', icon: 'heart-filled' },
  { name: 'search', label: '搜索', icon: 'search' },
  { name: 'settings', label: '设置', icon: 'settings' },
];

/**
 * 当前可用的导航项。
 *
 * 直连模式没有「专属」的数据源（每日推荐需要服务端），
 * 所以直接不展示这一项 —— 不做"点开必然报错"的入口。
 */
export function navItems(hasServer: boolean): NavItem[] {
  return hasServer ? NAV_ITEMS : NAV_ITEMS.filter(i => i.name !== 'daily');
}
