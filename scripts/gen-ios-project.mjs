#!/usr/bin/env node
/**
 * 生成 iOS 工程文件（ios/App/App.xcodeproj/project.pbxproj）。
 *
 * 两个 target：
 *   · App         —— ios/SuenMusic/** 全部 Swift + Assets + 原生 Info.plist
 *   · SuenWidgets —— Live Activity / 灵动岛（ios/SuenWidgets/PlaybackLiveActivity.swift）
 *                    + 它依赖的公共文件（PlaybackActivity / DesignTokens / Dimension / Theme）各编一份
 *                    · widget 是独立进程，不能借用主 App 的代码，所以这些文件要**同时**属于两个 target
 *
 * 为什么用脚本而不是手改：本机（Linux）没有 Xcode，手改 pbxproj 必漏登记；
 * 这里按磁盘上的真实文件清单生成，加文件跑一次即可。
 *
 * 用法：node scripts/gen-ios-project.mjs [--check]
 */
import { readdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const IOS = join(ROOT, 'ios');
const SRC = join(IOS, 'SuenMusic');
const WIDGET_SRC = join(IOS, 'SuenWidgets');
const PROJECT = join(IOS, 'App/App.xcodeproj/project.pbxproj');
const ASSETS = join(IOS, 'App/App/Assets.xcassets');

const GROUPS = ['App', 'Net', 'Player', 'UI'];
const WIDGET_NAME = 'SuenWidgets';
const WIDGET_BUNDLE_ID = 'com.suenmusic.app.SuenWidgets';
const WIDGET_SHARED = [
  'Player/PlaybackActivity.swift',
  'Player/PlaybackIntents.swift',
  'UI/DesignTokens.swift',
  'UI/Dimension.swift',
  'UI/Theme.swift',
];

function collectMain() {
  const out = [];
  for (const g of GROUPS) {
    const dir = join(SRC, g);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).sort()) {
      if (f.endsWith('.swift')) out.push({ group: g, file: f, rel: g + '/' + f });
    }
  }
  return out;
}

function collectWidgetOwn() {
  if (!existsSync(WIDGET_SRC)) return [];
  return readdirSync(WIDGET_SRC).filter((f) => f.endsWith('.swift')).sort();
}

const hid = (s) => createHash('md5').update(s).digest('hex').slice(0, 24).toUpperCase();

function render(main, widgetOwn) {
  const refMain = (f) => hid('ref:' + f.rel);
  const bldMain = (f) => hid('build:' + f.rel);
  const refWidgetOwn = (f) => hid('ref:widget/' + f);
  const bldWidgetOwn = (f) => hid('build:widget/' + f);
  const bldWidgetShared = (f) => hid('build:widget-shared/' + f);
  const G = (n) => hid('group:' + n);
  const ASSETS_REF = hid('ref:assets'), ASSETS_BLD = hid('build:assets'), PLIST_REF = hid('ref:plist');
  const PROD_REF = hid('ref:product'), WPROD_REF = hid('ref:wproduct'), WPLIST_REF = hid('ref:wplist');
  const EMBED_BLD = hid('build:embed-widget');
  const ROOTG = hid('group:root'), SUEN = hid('group:suen'), ASSETG = hid('group:assets'), PRODG = hid('group:products'), WG = hid('group:widget');
  const TARGET = hid('target'), PROJ = hid('project'), WTARGET = hid('wtarget');
  const FRAMEWORKS = hid('phase:frameworks'), SOURCES = hid('phase:sources'), RESOURCES = hid('phase:resources');
  const WFRAMEWORKS = hid('phase:wframeworks'), WSOURCES = hid('phase:wsources'), WRESOURCES = hid('phase:wresources');
  const EMBED = hid('phase:embed');
  const DEP = hid('dep:widget'), PROXY = hid('proxy:widget');
  const CFG = { dbgP: hid('cfg:proj:debug'), relP: hid('cfg:proj:release'), dbgT: hid('cfg:tgt:debug'), relT: hid('cfg:tgt:release'), dbgW: hid('cfg:wtgt:debug'), relW: hid('cfg:wtgt:release') };
  const LIST = { proj: hid('list:proj'), tgt: hid('list:tgt'), wtgt: hid('list:wtgt') };

  let o = '';
  o += '// !$*UTF8*$!\n{\n\tarchiveVersion = 1;\n\tclasses = {\n\t};\n\tobjectVersion = 60;\n\tobjects = {\n\n';

  o += '/* Begin PBXBuildFile section */\n';
  for (const f of main) o += '\t\t' + bldMain(f) + ' /* ' + f.file + ' in Sources */ = {isa = PBXBuildFile; fileRef = ' + refMain(f) + ' /* ' + f.file + ' */; };\n';
  for (const f of widgetOwn) o += '\t\t' + bldWidgetOwn(f) + ' /* ' + f + ' in Sources */ = {isa = PBXBuildFile; fileRef = ' + refWidgetOwn(f) + ' /* ' + f + ' */; };\n';
  for (const rel of WIDGET_SHARED) {
    const f = main.find((x) => x.rel === rel);
    if (f) o += '\t\t' + bldWidgetShared(rel) + ' /* ' + f.file + ' in Sources */ = {isa = PBXBuildFile; fileRef = ' + refMain(f) + ' /* ' + f.file + ' */; };\n';
  }
  o += '\t\t' + ASSETS_BLD + ' /* Assets.xcassets in Resources */ = {isa = PBXBuildFile; fileRef = ' + ASSETS_REF + ' /* Assets.xcassets */; };\n';
  o += '\t\t' + EMBED_BLD + ' /* ' + WIDGET_NAME + '.appex in Embed Foundation Extensions */ = {isa = PBXBuildFile; fileRef = ' + WPROD_REF + ' /* ' + WIDGET_NAME + '.appex */; settings = {ATTRIBUTES = (RemoveHeadersOnCopy, ); }; };\n';
  o += '/* End PBXBuildFile section */\n\n';

  o += '/* Begin PBXContainerItemProxy section */\n';
  o += '\t\t' + PROXY + ' /* PBXContainerItemProxy */ = {\n\t\t\tisa = PBXContainerItemProxy;\n\t\t\tcontainerPortal = ' + PROJ + ' /* Project object */;\n\t\t\tproxyType = 1;\n\t\t\tremoteGlobalIDString = ' + WTARGET + ';\n\t\t\tremoteInfo = ' + WIDGET_NAME + ';\n\t\t};\n';
  o += '/* End PBXContainerItemProxy section */\n\n';

  o += '/* Begin PBXCopyFilesBuildPhase section */\n';
  o += '\t\t' + EMBED + ' /* Embed Foundation Extensions */ = {\n\t\t\tisa = PBXCopyFilesBuildPhase;\n\t\t\tbuildActionMask = 2147483647;\n\t\t\tdstPath = "";\n\t\t\tdstSubfolderSpec = 13;\n\t\t\tfiles = (\n\t\t\t\t' + EMBED_BLD + ' /* ' + WIDGET_NAME + '.appex in Embed Foundation Extensions */,\n\t\t\t);\n\t\t\tname = "Embed Foundation Extensions";\n\t\t\trunOnlyForDeploymentPostprocessing = 0;\n\t\t};\n';
  o += '/* End PBXCopyFilesBuildPhase section */\n\n';

  o += '/* Begin PBXFileReference section */\n';
  for (const f of main) o += '\t\t' + refMain(f) + ' /* ' + f.file + ' */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = ' + f.file + '; sourceTree = "<group>"; };\n';
  for (const f of widgetOwn) o += '\t\t' + refWidgetOwn(f) + ' /* ' + f + ' */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = ' + f + '; sourceTree = "<group>"; };\n';
  o += '\t\t' + ASSETS_REF + ' /* Assets.xcassets */ = {isa = PBXFileReference; lastKnownFileType = folder.assetcatalog; path = Assets.xcassets; sourceTree = "<group>"; };\n';
  o += '\t\t' + PLIST_REF + ' /* Info.plist */ = {isa = PBXFileReference; lastKnownFileType = text.plist.xml; path = Info.plist; sourceTree = "<group>"; };\n';
  o += '\t\t' + WPLIST_REF + ' /* Info.plist */ = {isa = PBXFileReference; lastKnownFileType = text.plist.xml; path = Info.plist; sourceTree = "<group>"; };\n';
  o += '\t\t' + PROD_REF + ' /* App.app */ = {isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = App.app; sourceTree = BUILT_PRODUCTS_DIR; };\n';
  o += '\t\t' + WPROD_REF + ' /* ' + WIDGET_NAME + '.appex */ = {isa = PBXFileReference; explicitFileType = "wrapper.app-extension"; includeInIndex = 0; path = ' + WIDGET_NAME + '.appex; sourceTree = BUILT_PRODUCTS_DIR; };\n';
  o += '/* End PBXFileReference section */\n\n';

  const phase = (id, name, isa, files) => {
    let s = '\t\t' + id + ' /* ' + name + ' */ = {\n\t\t\tisa = ' + isa + ';\n\t\t\tbuildActionMask = 2147483647;\n\t\t\tfiles = (\n';
    for (const f of files) s += '\t\t\t\t' + f + ',\n';
    s += '\t\t\t);\n\t\t\trunOnlyForDeploymentPostprocessing = 0;\n\t\t};\n';
    return s;
  };

  o += '/* Begin PBXFrameworksBuildPhase section */\n';
  o += phase(FRAMEWORKS, 'Frameworks', 'PBXFrameworksBuildPhase', []);
  o += phase(WFRAMEWORKS, 'Frameworks', 'PBXFrameworksBuildPhase', []);
  o += '/* End PBXFrameworksBuildPhase section */\n\n';

  o += '/* Begin PBXGroup section */\n';
  o += '\t\t' + ROOTG + ' = {\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = (\n\t\t\t\t' + SUEN + ' /* SuenMusic */,\n\t\t\t\t' + WG + ' /* ' + WIDGET_NAME + ' */,\n\t\t\t\t' + ASSETG + ' /* Assets */,\n\t\t\t\t' + PRODG + ' /* Products */,\n\t\t\t);\n\t\t\tsourceTree = "<group>";\n\t\t};\n';
  o += '\t\t' + SUEN + ' /* SuenMusic */ = {\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = (\n';
  for (const n of GROUPS) o += '\t\t\t\t' + G(n) + ' /* ' + n + ' */,\n';
  o += '\t\t\t);\n\t\t\tname = SuenMusic;\n\t\t\tpath = ../SuenMusic;\n\t\t\tsourceTree = "<group>";\n\t\t};\n';
  for (const n of GROUPS) {
    o += '\t\t' + G(n) + ' /* ' + n + ' */ = {\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = (\n';
    for (const f of main) if (f.group === n) o += '\t\t\t\t' + refMain(f) + ' /* ' + f.file + ' */,\n';
    if (n === 'App') o += '\t\t\t\t' + PLIST_REF + ' /* Info.plist */,\n';
    o += '\t\t\t);\n\t\t\tpath = ' + n + ';\n\t\t\tsourceTree = "<group>";\n\t\t};\n';
  }
  o += '\t\t' + WG + ' /* ' + WIDGET_NAME + ' */ = {\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = (\n';
  for (const f of widgetOwn) o += '\t\t\t\t' + refWidgetOwn(f) + ' /* ' + f + ' */,\n';
  o += '\t\t\t\t' + WPLIST_REF + ' /* Info.plist */,\n';
  o += '\t\t\t);\n\t\t\tname = ' + WIDGET_NAME + ';\n\t\t\tpath = ../SuenWidgets;\n\t\t\tsourceTree = "<group>";\n\t\t};\n';
  o += '\t\t' + ASSETG + ' /* Assets */ = {\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = (\n\t\t\t\t' + ASSETS_REF + ' /* Assets.xcassets */,\n\t\t\t);\n\t\t\tname = Assets;\n\t\t\tpath = App;\n\t\t\tsourceTree = "<group>";\n\t\t};\n';
  o += '\t\t' + PRODG + ' /* Products */ = {\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = (\n\t\t\t\t' + PROD_REF + ' /* App.app */,\n\t\t\t\t' + WPROD_REF + ' /* ' + WIDGET_NAME + '.appex */,\n\t\t\t);\n\t\t\tname = Products;\n\t\t\tsourceTree = "<group>";\n\t\t};\n';
  o += '/* End PBXGroup section */\n\n';

  o += '/* Begin PBXNativeTarget section */\n';
  o += '\t\t' + TARGET + ' /* App */ = {\n\t\t\tisa = PBXNativeTarget;\n\t\t\tbuildConfigurationList = ' + LIST.tgt + ';\n';
  o += '\t\t\tbuildPhases = (\n\t\t\t\t' + SOURCES + ' /* Sources */,\n\t\t\t\t' + FRAMEWORKS + ' /* Frameworks */,\n\t\t\t\t' + RESOURCES + ' /* Resources */,\n\t\t\t\t' + EMBED + ' /* Embed Foundation Extensions */,\n\t\t\t);\n';
  o += '\t\t\tbuildRules = (\n\t\t\t);\n\t\t\tdependencies = (\n\t\t\t\t' + DEP + ' /* PBXTargetDependency */,\n\t\t\t);\n\t\t\tname = App;\n\t\t\tproductName = App;\n\t\t\tproductReference = ' + PROD_REF + ' /* App.app */;\n\t\t\tproductType = "com.apple.product-type.application";\n\t\t};\n';
  o += '\t\t' + WTARGET + ' /* ' + WIDGET_NAME + ' */ = {\n\t\t\tisa = PBXNativeTarget;\n\t\t\tbuildConfigurationList = ' + LIST.wtgt + ';\n';
  o += '\t\t\tbuildPhases = (\n\t\t\t\t' + WSOURCES + ' /* Sources */,\n\t\t\t\t' + WFRAMEWORKS + ' /* Frameworks */,\n\t\t\t\t' + WRESOURCES + ' /* Resources */,\n\t\t\t);\n';
  o += '\t\t\tbuildRules = (\n\t\t\t);\n\t\t\tdependencies = (\n\t\t\t);\n\t\t\tname = ' + WIDGET_NAME + ';\n\t\t\tproductName = ' + WIDGET_NAME + ';\n\t\t\tproductReference = ' + WPROD_REF + ' /* ' + WIDGET_NAME + '.appex */;\n\t\t\tproductType = "com.apple.product-type.app-extension";\n\t\t};\n';
  o += '/* End PBXNativeTarget section */\n\n';

  o += '/* Begin PBXProject section */\n';
  o += '\t\t' + PROJ + ' /* Project object */ = {\n\t\t\tisa = PBXProject;\n\t\t\tattributes = {\n\t\t\t\tBuildIndependentTargetsInParallel = YES;\n\t\t\t\tLastUpgradeCheck = 2650;\n\t\t\t\tTargetAttributes = {\n';
  o += '\t\t\t\t\t' + TARGET + ' = {\n\t\t\t\t\t\tProvisioningStyle = Automatic;\n\t\t\t\t\t};\n';
  o += '\t\t\t\t\t' + WTARGET + ' = {\n\t\t\t\t\t\tProvisioningStyle = Automatic;\n\t\t\t\t\t};\n';
  o += '\t\t\t\t};\n\t\t\t};\n';
  o += '\t\t\tbuildConfigurationList = ' + LIST.proj + ';\n\t\t\tcompatibilityVersion = "Xcode 14.0";\n\t\t\tdevelopmentRegion = zh_CN;\n\t\t\thasScannedForEncodings = 0;\n';
  o += '\t\t\tknownRegions = (\n\t\t\t\tzh_CN,\n\t\t\t\ten,\n\t\t\t\tBase,\n\t\t\t);\n\t\t\tmainGroup = ' + ROOTG + ';\n\t\t\tproductRefGroup = ' + PRODG + ' /* Products */;\n\t\t\tprojectDirPath = "";\n\t\t\tprojectRoot = "";\n';
  o += '\t\t\ttargets = (\n\t\t\t\t' + TARGET + ' /* App */,\n\t\t\t\t' + WTARGET + ' /* ' + WIDGET_NAME + ' */,\n\t\t\t);\n\t\t};\n';
  o += '/* End PBXProject section */\n\n';

  o += '/* Begin PBXResourcesBuildPhase section */\n';
  o += phase(RESOURCES, 'Resources', 'PBXResourcesBuildPhase', [ASSETS_BLD + ' /* Assets.xcassets in Resources */']);
  o += phase(WRESOURCES, 'Resources', 'PBXResourcesBuildPhase', []);
  o += '/* End PBXResourcesBuildPhase section */\n\n';

  o += '/* Begin PBXSourcesBuildPhase section */\n';
  o += phase(SOURCES, 'Sources', 'PBXSourcesBuildPhase', main.map((f) => bldMain(f) + ' /* ' + f.file + ' in Sources */'));
  const wFiles = [
    ...widgetOwn.map((f) => bldWidgetOwn(f) + ' /* ' + f + ' in Sources */'),
    ...WIDGET_SHARED.filter((rel) => main.some((m) => m.rel === rel)).map((rel) => bldWidgetShared(rel) + ' /* ' + rel.split('/').pop() + ' in Sources */'),
  ];
  o += phase(WSOURCES, 'Sources', 'PBXSourcesBuildPhase', wFiles);
  o += '/* End PBXSourcesBuildPhase section */\n\n';

  o += '/* Begin PBXTargetDependency section */\n';
  o += '\t\t' + DEP + ' /* PBXTargetDependency */ = {\n\t\t\tisa = PBXTargetDependency;\n\t\t\ttarget = ' + WTARGET + ' /* ' + WIDGET_NAME + ' */;\n\t\t\ttargetProxy = ' + PROXY + ' /* PBXContainerItemProxy */;\n\t\t};\n';
  o += '/* End PBXTargetDependency section */\n\n';

  const projCommon = (dbg) => [
    'ALWAYS_SEARCH_USER_PATHS = NO;', 'CLANG_ANALYZER_NONNULL = YES;', 'CLANG_ENABLE_MODULES = YES;', 'CLANG_ENABLE_OBJC_ARC = YES;',
    'CLANG_WARN_BOOL_CONVERSION = YES;', 'CLANG_WARN_DIRECT_OBJC_ISA_USAGE = YES_ERROR;', 'CLANG_WARN_INFINITE_RECURSION = YES;',
    'CLANG_WARN_UNGUARDED_AVAILABILITY = YES_AGGRESSIVE;', 'CLANG_WARN_UNREACHABLE_CODE = YES;', 'COPY_PHASE_STRIP = NO;',
    'DEBUG_INFORMATION_FORMAT = ' + (dbg ? 'dwarf;' : '"dwarf-with-dsym";'),
    'ENABLE_STRICT_OBJC_MSGSEND = YES;', 'ENABLE_USER_SCRIPT_SANDBOXING = YES;', 'GCC_C_LANGUAGE_STANDARD = gnu17;',
    'GCC_NO_COMMON_BLOCKS = YES;', 'GCC_WARN_ABOUT_RETURN_TYPE = YES_ERROR;', 'GCC_WARN_UNDECLARED_SELECTOR = YES;',
    'GCC_WARN_UNINITIALIZED_AUTOS = YES_AGGRESSIVE;', 'GCC_WARN_UNUSED_FUNCTION = YES;', 'GCC_WARN_UNUSED_VARIABLE = YES;',
    'IPHONEOS_DEPLOYMENT_TARGET = 26.0;', 'SDKROOT = iphoneos;',
    dbg ? 'ENABLE_TESTABILITY = YES;' : 'ENABLE_NS_ASSERTIONS = NO;',
    dbg ? 'SWIFT_ACTIVE_COMPILATION_CONDITIONS = DEBUG;' : 'SWIFT_ACTIVE_COMPILATION_CONDITIONS = "$(inherited)";',
    dbg ? 'SWIFT_OPTIMIZATION_LEVEL = "-Onone";' : 'SWIFT_OPTIMIZATION_LEVEL = "-O";',
    dbg ? '' : 'SWIFT_COMPILATION_MODE = wholemodule;',
    dbg ? '' : 'VALIDATE_PRODUCT = YES;',
  ];

  o += '/* Begin XCBuildConfiguration section */\n';
  for (const [name, cid, dbg] of [['Debug', CFG.dbgP, true], ['Release', CFG.relP, false]]) {
    o += '\t\t' + cid + ' /* ' + name + ' */ = {\n\t\t\tisa = XCBuildConfiguration;\n\t\t\tbuildSettings = {\n';
    for (const line of projCommon(dbg)) if (line) o += '\t\t\t\t' + line + '\n';
    o += '\t\t\t};\n\t\t\tname = ' + name + ';\n\t\t};\n';
  }
  for (const [name, cid] of [['Debug', CFG.dbgT], ['Release', CFG.relT]]) {
    o += '\t\t' + cid + ' /* ' + name + ' */ = {\n\t\t\tisa = XCBuildConfiguration;\n\t\t\tbuildSettings = {\n';
    o += '\t\t\t\tASSETCATALOG_COMPILER_APPICON_NAME = AppIcon;\n';
    o += '\t\t\t\tCODE_SIGN_IDENTITY = "Apple Development";\n\t\t\t\tCODE_SIGN_STYLE = Automatic;\n';
    o += '\t\t\t\tCURRENT_PROJECT_VERSION = 2000000;\n\t\t\t\tDEVELOPMENT_TEAM = VV9F66AH8U;\n';
    o += '\t\t\t\tGENERATE_INFOPLIST_FILE = NO;\n\t\t\t\tINFOPLIST_FILE = "../SuenMusic/App/Info.plist";\n';
    o += '\t\t\t\tIPHONEOS_DEPLOYMENT_TARGET = 26.0;\n';
    o += '\t\t\t\tLD_RUNPATH_SEARCH_PATHS = (\n\t\t\t\t\t"$(inherited)",\n\t\t\t\t\t"@executable_path/Frameworks",\n\t\t\t\t);\n';
    o += '\t\t\t\tMARKETING_VERSION = 2.0.0;\n\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = com.suenmusic.app;\n';
    o += '\t\t\t\tPRODUCT_NAME = "$(TARGET_NAME)";\n\t\t\t\tSWIFT_EMIT_LOC_STRINGS = YES;\n\t\t\t\tSWIFT_VERSION = 5.0;\n';
    o += '\t\t\t\tTARGETED_DEVICE_FAMILY = "1,2";\n';
    o += '\t\t\t};\n\t\t\tname = ' + name + ';\n\t\t};\n';
  }
  for (const [name, cid] of [['Debug', CFG.dbgW], ['Release', CFG.relW]]) {
    o += '\t\t' + cid + ' /* ' + name + ' */ = {\n\t\t\tisa = XCBuildConfiguration;\n\t\t\tbuildSettings = {\n';
    o += '\t\t\t\tCODE_SIGN_STYLE = Automatic;\n\t\t\t\tCURRENT_PROJECT_VERSION = 2000000;\n';
    o += '\t\t\t\tDEVELOPMENT_TEAM = VV9F66AH8U;\n\t\t\t\tGENERATE_INFOPLIST_FILE = NO;\n';
    o += '\t\t\t\tINFOPLIST_FILE = "../SuenWidgets/Info.plist";\n';
    o += '\t\t\t\tIPHONEOS_DEPLOYMENT_TARGET = 26.0;\n';
    o += '\t\t\t\tLD_RUNPATH_SEARCH_PATHS = (\n\t\t\t\t\t"$(inherited)",\n\t\t\t\t\t"@executable_path/Frameworks",\n\t\t\t\t\t"@executable_path/../../Frameworks",\n\t\t\t\t);\n';
    o += '\t\t\t\tMARKETING_VERSION = 2.0.0;\n';
    o += '\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = ' + WIDGET_BUNDLE_ID + ';\n';
    o += '\t\t\t\tPRODUCT_NAME = "$(TARGET_NAME)";\n\t\t\t\tSKIP_INSTALL = YES;\n';
    o += '\t\t\t\tSWIFT_EMIT_LOC_STRINGS = YES;\n\t\t\t\tSWIFT_VERSION = 5.0;\n';
    o += '\t\t\t\tSWIFT_ACTIVE_COMPILATION_CONDITIONS = "WIDGET_EXTENSION $(inherited)";\n';
    o += '\t\t\t\tTARGETED_DEVICE_FAMILY = "1,2";\n';
    o += '\t\t\t};\n\t\t\tname = ' + name + ';\n\t\t};\n';
  }
  o += '/* End XCBuildConfiguration section */\n\n';

  o += '/* Begin XCConfigurationList section */\n';
  const cfgList = (id, dbg, rel) => '\t\t' + id + ' = {\n\t\t\tisa = XCConfigurationList;\n\t\t\tbuildConfigurations = (\n\t\t\t\t' + dbg + ' /* Debug */,\n\t\t\t\t' + rel + ' /* Release */,\n\t\t\t);\n\t\t\tdefaultConfigurationIsVisible = 0;\n\t\t\tdefaultConfigurationName = Debug;\n\t\t};\n';
  o += cfgList(LIST.proj, CFG.dbgP, CFG.relP);
  o += cfgList(LIST.tgt, CFG.dbgT, CFG.relT);
  o += cfgList(LIST.wtgt, CFG.dbgW, CFG.relW);
  o += '/* End XCConfigurationList section */\n\n\t};\n\trootObject = ' + PROJ + ' /* Project object */;\n}\n';

  return o;
}

const main = collectMain();
const widgetOwn = collectWidgetOwn();
if (main.length === 0) {
  console.error('未找到任何 Swift 文件，检查 ios/SuenMusic 结构');
  process.exit(1);
}
const rendered = render(main, widgetOwn);
const check = process.argv.includes('--check');
const current = existsSync(PROJECT) ? readFileSync(PROJECT, 'utf8') : '';

if (check) {
  const missing = main.filter((f) => !current.includes('path = ' + f.file + ';'));
  console.log('主 target Swift:', main.length, '｜widget 自有:', widgetOwn.length, '｜缺登记:', missing.length);
  console.log('工程与磁盘', current === rendered ? '一致' : '不一致（需重新生成）');
  process.exit(missing.length === 0 && current === rendered ? 0 : 1);
}

writeFileSync(PROJECT, rendered, 'utf8');
console.log('已生成工程：主 target', main.length, '个 Swift ｜widget target', widgetOwn.length + WIDGET_SHARED.length, '个 Swift');