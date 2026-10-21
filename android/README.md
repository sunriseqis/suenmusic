# Android 端（已封库）

> ## ❄️ 本端自 2026-10-21 起**封库**
>
> - **不再更新**功能，不再修 bug（除安全高危）
> - **不再有 CI 构建**，不再产出/分发 APK
> - **不再上架**任何应用市场
> - 代码与 v1.5 的产物仅作**回溯参考**保留在仓库里
>
> **不要再在本目录开新功能。** 移动端以 **鸿蒙（`hw/`）** 与 **iOS（`ios/SuenMusic/`）** 原生客户端为准；
> PC 端走 Web（`web/`，同时是服务端管理面板）。

---

## 为什么封库

1. 客户端全原生化迭代（`docs/plan/2026-10-21-客户端全原生化迭代方案.md`）后，
   Android 端的三端共用 SPA 架构已被鸿蒙/iOS 的原生实现取代，继续维护等于付三份成本。
2. 用户口径：**"安卓封库，不再更新不再有 ci 构建分发上架"**。
3. 鸿蒙与 iOS 已覆盖全部使用场景，Android 不再是任何一个用户的唯一入口。

## 保留了什么

| 路径 | 内容 | 状态 |
|---|---|---|
| `app/src/main/java/.../SuenAudioPlugin.java` | media3 播放服务（含 `tailOnly`、`PendingCallback` 配对、重连逻辑） | 冻结，仅参考 |
| `app/src/main/java/.../SuenWidgetState.java` / `SuenWidget*.java` | 桌面卡片（AppWidget / RemoteViews） | 冻结，仅参考 |
| `app/src/main/res/` | 图标、卡片布局、splash | 冻结 |
| `keystore.properties.example` | 签名配置样例 | **仅历史参考**，口令早已轮换 |

## 若将来要重启本端

请先读 `docs/memory/2026-10-20-安卓卡片数据库恢复与分配收紧.md` 与批次 A–D 的实施记录，
那里记着这个端踩过的坑（签名缺失导致 CI 失败、RemoteViews 裸 View 崩溃、卡片数据库恢复流程等）。
不要假设"照着 iOS 抄一遍就行"——两端的后台模型完全不同。
