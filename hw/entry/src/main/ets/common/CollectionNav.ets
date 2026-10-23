/**
 * 集合详情页导航（T10 批次 D）。
 *
 * 鸿蒙端没有页面路由栈（Tab + 浮层结构），搜索页卡片 / 首页海报要打开
 * 专辑、歌手、歌单、榜单详情，走的是「AppStorage 信号 + NativeRoot 浮层」：
 * 任意页调 `openCollection()` 写参数并自增请求计数，NativeRoot 监听到
 * 计数变化即拉起 CollectionPage 浮层。CollectionPage 内部的嵌套跳转
 * （歌手 → 专辑 → 歌手…）由自己的内部栈管理，不经这里。
 */

/** 集合来源：album / artist / playlist / toplist */
export interface CollectionEntry {
  kind: string;
  id: string;
  /** 展示名（歌手页翻页/相似歌手请求都靠它省一次上游详情请求） */
  name: string;
}

/** 打开请求计数：NativeRoot @Watch 它来拉起/刷新集合浮层 */
export const K_COLLECTION_REQ = 'collection_req';
/** 集合浮层内部栈深度：NativeRoot onBackPress 据此决定「弹内层」还是「关浮层」 */
export const K_COLLECTION_DEPTH = 'collection_depth';
/** 系统返回转发信号：浮层开着且深度 > 1 时，NativeRoot 自增它，CollectionPage 弹一层 */
export const K_COLLECTION_BACK = 'collection_back';

const K_COLLECTION_KIND = 'collection_kind';
const K_COLLECTION_ID = 'collection_id';
const K_COLLECTION_NAME = 'collection_name';

/** 打开集合详情（任意页面可调；重复打开同一目标也会重新拉起刷新） */
export function openCollection(kind: string, id: string, name: string): void {
  AppStorage.setOrCreate(K_COLLECTION_KIND, kind);
  AppStorage.setOrCreate(K_COLLECTION_ID, id);
  AppStorage.setOrCreate(K_COLLECTION_NAME, name);
  const cur = AppStorage.get<number>(K_COLLECTION_REQ);
  AppStorage.setOrCreate(K_COLLECTION_REQ, cur === undefined ? 1 : cur + 1);
}
