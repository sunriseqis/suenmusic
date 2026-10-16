# SuenMusic 文档

单仓后，**记忆文件、开发文档、计划文档统一放这里**，不再散落在各子目录。

## 目录约定

```
docs/
├── memory/       长期记忆（跨会话有效的事实与口径）
│   ├── MEMORY.md          索引，一行一条指向具体文件
│   └── YYYY-MM-DD.md      某一天的排查/开发流水
├── dev/          开发文档（架构、环境搭建、构建与发布流程）
└── plan/         计划文档（尚未落地的方案、待验证的假设）
```

## 为什么集中在这里

原先拆成 `suenmusic-server/docs/` 与 `suenmusic-mobile/docs/` 两份，
同一个问题（比如「ArkTS 本地能不能编译」）在两边都可能有记录且容易互相矛盾。
合并后 `docs/memory/MEMORY.md` 是**唯一**的记忆索引。

## 迁入计划

以下两份将在对应代码迁入时合并进来（本轮只迁了 web + hw）：

- `suenmusic-server/docs/memory/` → `docs/memory/`（服务端与 Web 侧）
- `suenmusic-mobile/docs/memory/` → `docs/memory/`（三端壳）
- `suenmusic-mobile/docs/` 其余内容 → `docs/dev/`