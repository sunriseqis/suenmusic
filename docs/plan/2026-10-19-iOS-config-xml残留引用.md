# iOS `config.xml` 残留引用待决（2026-10-19）

背景：[`docs/memory/2026-10-19-iOS编译四报错与单仓同步.md`](../memory/2026-10-19-iOS编译四报错与单仓同步.md)

## 问题

`ios/App/App.xcodeproj/project.pbxproj` 有 4 处引用 `config.xml`
（PBXBuildFile / PBXFileReference / group / Resources 各一处），但：

- Capacitor 8.5.2 的模板已不含该文件，`cap sync` 不会生成它；
- `ios/.gitignore` 却把它列为"Generated Config files"，不随仓库分发。

结果：**任何新克隆 / CI 全新构建都会复现今天的 4 个编译 error**。
当前只是靠手工放的存根文件（gitignored，不进仓库）压着。

## 方案

| 方案 | 做法 | 代价 |
|---|---|---|
| A（建议） | 从 pbxproj 删掉 4 处 `config.xml` 引用 | 手改 pbxproj 有风险，须用 Xcode 打开验证；文件运行时本就没人读 |
| B | 把 `config.xml` 移出 .gitignore 提交进仓库 | 最省事，但留一个 Cordova 遗留死文件，且与"生成物"定位矛盾 |
| C | 在 `scripts/build-ios.mjs` 的 sync 步骤里生成存根 | 自动化，但给构建脚本增加特例逻辑 |

## 验收

干净克隆后按 `docs/dev/ios-build.md` 的命令 `xcodebuild` 通过，且
`git status` 无残留。

## 顺带待办：根目录缺 package.json

`scripts/build-ios.mjs` 头部文档写着 `npm run ios:sync` / `npm run ios:ipa`，
但**仓库根没有 package.json**，这些脚本名实际不可用，只能
`node scripts/build-ios.mjs`。建议二选一：

- 根目录补一个 `package.json`，把三条命令登记为 scripts（与脚本文档对齐）；
- 或把脚本文档改成 `node scripts/build-ios.mjs` 的实际口径。
