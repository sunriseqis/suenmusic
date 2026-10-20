#!/bin/bash
#
# 给模拟器产物补签 com.apple.security.get-task-allow。
#
# 为什么需要：Xcode 26 的 DarwinProductTypes.xcspec 对模拟器产品设置
# ENTITLEMENTS_ALLOWED = $(__IS_NOT_SIMULATOR)，模拟器包永远不会带
# get-task-allow。正常 Mac 上 lldb 还能走 taskgated 的授权路径；本机
# AMFI 被关（amfi=0x80），taskgated 直接拒绝，于是：
#   Could not attach to pid / Not allowed to attach to process
# 补签之后 attach 正常（已验证）。
#
# 调用点：App.xcscheme 的 BuildAction PostActions（build 之后、install 之前）。
# 不能放在 Run Script build phase —— 那一步在 CodeSign 之前，会被覆盖。
#
# 环境变量来自 scheme 的 EnvironmentBuildable，勿手工执行。

set -euo pipefail

# 只有模拟器产物需要；真机包由开发描述文件提供 get-task-allow
if [ "${PLATFORM_NAME:-}" != "iphonesimulator" ]; then
    exit 0
fi

APP="${BUILT_PRODUCTS_DIR:-}/${FULL_PRODUCT_NAME:-App.app}"
if [ ! -d "$APP" ]; then
    echo "fix-ios-sim-entitlement: 产物不存在，跳过：$APP"
    exit 0
fi

ENT="$(mktemp -t get-task-allow).plist"
trap 'rm -f "$ENT"' EXIT
cat > "$ENT" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>com.apple.security.get-task-allow</key>
	<true/>
</dict>
</plist>
PLIST

# 先签内嵌扩展，再签外层，避免嵌套签名失效
if [ -d "$APP/PlugIns" ]; then
    for ext in "$APP"/PlugIns/*.appex; do
        [ -d "$ext" ] || continue
        codesign --force --sign - --entitlements "$ENT" "$ext"
    done
fi
codesign --force --sign - --entitlements "$ENT" "$APP"

echo "fix-ios-sim-entitlement: 已补签 get-task-allow → $APP"
