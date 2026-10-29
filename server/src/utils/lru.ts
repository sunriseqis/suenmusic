/**
 * 极简 LRU（不引依赖，修复批 4 · P2-B）。
 *
 * 背景：ai-recall 里几张「专辑/最新专辑」缓存都是裸 `Map`，只增不删 —— key 不冲突
 * （设计本身正确），但长跑时条目数无界增长，属内存缓慢泄漏的资源隐患。
 *
 * 实现口径：**直接利用 Map 的插入顺序**（最早插入的在队首，`keys().next()` 就是最旧的），
 * 写入/命中时把 key 挪到队尾，超上限就从队首删。不引入 lru-cache 之类的新依赖。
 *
 * ⚠️ 语义边界：淘汰**只影响性能，不影响正确性** —— 被淘汰的条目下次会重新取上游
 * （TTL 仍然各自生效），所以上限可以取得比较保守。
 */

/** 写入并维持上限：已存在则先删再插（刷新到队尾），超过 `max` 时从最旧开始淘汰 */
export function lruSet<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  // max 非法（<=0）时至少保留刚写入的一条，避免"写进去立刻被删"的退化行为
  const cap = max > 0 ? max : 1;
  while (map.size > cap) {
    const oldest = map.keys().next();
    if (oldest.done === true) break;
    map.delete(oldest.value);
  }
}

/**
 * 读取并把命中的 key 刷新到队尾（真 LRU：长期不用的先被淘汰）。
 * 未命中返回 `undefined`（调用侧照旧按 miss 处理，自己去取上游）。
 */
export function lruGet<K, V>(map: Map<K, V>, key: K): V | undefined {
  const value = map.get(key);
  if (value === undefined) return undefined;
  map.delete(key);
  map.set(key, value);
  return value;
}
