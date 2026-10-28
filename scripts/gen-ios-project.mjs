#!/usr/bin/env node
/**
 * 生成 iOS 工程文件（ios/App/App.xcodeproj/project.pbxproj）。
 *
 * 单一 target：
 *   · App —— ios/SuenMusic/** 全部 Swift + Assets + 原生 Info.plist
 *
 * 为什么用脚本而不是手改：本机（Linux）没有 Xcode，手改 pbxproj 必漏登记；
 * 这里按磁盘上的真实文件清单生成，加文件跑一次即可。
 *
 * Swift Package：MPVKit（libmpv + ffmpeg）通过 SPM 引入，
 * pbxproj 里必须同时写 packageReferences / packageProductDependencies /
 * XCSwiftPackageProductDependency / Frameworks 阶段，缺一条都链接不上。
 *
 * 用法：node scripts/gen-ios-project.mjs [--check]
 */
import { readdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const IOS = join(ROOT, 'ios');
const SRC = join(IOS, 'SuenMusic');
const PROJECT = join(IOS, 'App/App.xcodeproj/project.pbxproj');
const ASSETS = join(IOS, 'App/App/Assets.xcassets');

const GROUPS = ['App', 'Net', 'Player', 'UI'];

// Swift Package 依赖：MPVKit（libmpv + ffmpeg），tag 用 exactVersion 锁死。
// 0.38.0/0.39.0/…/1.0.0/1.1.0-n9.0.2 为仓库真实 tag（git ls-remote --tags），
// 取最新一个；写死版本号保证 --check 稳定、重复生成一致。
const MPVKIT_URL = 'https://github.com/mpvkit/MPVKit';
const MPVKIT_VERSION = '1.1.0-n9.0.2';
const MPVKIT_PRODUCT = 'MPVKit';

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

const hid = (s) => createHash('md5').update(s).digest('hex').slice(0, 24).toUpperCase();

function render(main) {
  const refMain = (f) => hid('ref:' + f.rel);
  const bldMain = (f) => hid('build:' + f.rel);
  const G = (n) => hid('group:' + n);
  const ASSETS_REF = hid('ref:assets'), ASSETS_BLD = hid('build:assets'), PLIST_REF = hid('ref:plist');
  const PROD_REF = hid('ref:product');
  const ROOTG = hid('group:root'), SUEN = hid('group:suen'), ASSETG = hid('group:assets'), PRODG = hid('group:products');
  const TARGET = hid('target'), PROJ = hid('project');
  const FRAMEWORKS = hid('phase:frameworks'), SOURCES = hid('phase:sources'), RESOURCES = hid('phase:resources');
  const CFG = { dbgP: hid('cfg:proj:debug'), relP: hid('cfg:proj:release'), dbgT: hid('cfg:tgt:debug'), relT: hid('cfg:tgt:release') };
  const LIST = { proj: hid('list:proj'), tgt: hid('list:tgt') };
  const PKG_REF = hid('pkg:mpvkit'), PKG_PROD = hid('pkgprod:mpvkit'), PKG_BLD = hid('build:pkg:mpvkit');
  const PKG_REF_CMT = 'XCRemoteSwiftPackageReference "' + MPVKIT_PRODUCT + '"';

  let o = '';
  o += '// !$*UTF8*$!\n{\n\tarchiveVersion = 1;\n\tclasses = {\n\t};\n\tobjectVersion = 60;\n\tobjects = {\n\n';

  o += '/* Begin PBXBuildFile section */\n';
  for (const f of main) o += '\t\t' + bldMain(f) + ' /* ' + f.file + ' in Sources */ = {isa = PBXBuildFile; fileRef = ' + refMain(f) + ' /* ' + f.file + ' */; };\n';
  o += '\t\t' + ASSETS_BLD + ' /* Assets.xcassets in Resources */ = {isa = PBXBuildFile; fileRef = ' + ASSETS_REF + ' /* Assets.xcassets */; };\n';
  o += '\t\t' + PKG_BLD + ' /* ' + MPVKIT_PRODUCT + ' in Frameworks */ = {isa = PBXBuildFile; productRef = ' + PKG_PROD + ' /* ' + MPVKIT_PRODUCT + ' */; };\n';
  o += '/* End PBXBuildFile section */\n\n';

  o += '/* Begin PBXFileReference section */\n';
  for (const f of main) o += '\t\t' + refMain(f) + ' /* ' + f.file + ' */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = ' + f.file + '; sourceTree = "<group>"; };\n';
  o += '\t\t' + ASSETS_REF + ' /* Assets.xcassets */ = {isa = PBXFileReference; lastKnownFileType = folder.assetcatalog; path = Assets.xcassets; sourceTree = "<group>"; };\n';
  o += '\t\t' + PLIST_REF + ' /* Info.plist */ = {isa = PBXFileReference; lastKnownFileType = text.plist.xml; path = Info.plist; sourceTree = "<group>"; };\n';
  o += '\t\t' + PROD_REF + ' /* App.app */ = {isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = App.app; sourceTree = BUILT_PRODUCTS_DIR; };\n';
  o += '/* End PBXFileReference section */\n\n';

  const phase = (id, name, isa, files) => {
    let s = '\t\t' + id + ' /* ' + name + ' */ = {\n\t\t\tisa = ' + isa + ';\n\t\t\tbuildActionMask = 2147483647;\n\t\t\tfiles = (\n';
    for (const f of files) s += '\t\t\t\t' + f + ',\n';
    s += '\t\t\t);\n\t\t\trunOnlyForDeploymentPostprocessing = 0;\n\t\t};\n';
    return s;
  };

  o += '/* Begin PBXFrameworksBuildPhase section */\n';
  o += phase(FRAMEWORKS, 'Frameworks', 'PBXFrameworksBuildPhase', [PKG_BLD + ' /* ' + MPVKIT_PRODUCT + ' in Frameworks */']);
  o += '/* End PBXFrameworksBuildPhase section */\n\n';

  o += '/* Begin PBXGroup section */\n';
  o += '\t\t' + ROOTG + ' = {\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = (\n\t\t\t\t' + SUEN + ' /* SuenMusic */,\n\t\t\t\t' + ASSETG + ' /* Assets */,\n\t\t\t\t' + PRODG + ' /* Products */,\n\t\t\t);\n\t\t\tsourceTree = "<group>";\n\t\t};\n';
  o += '\t\t' + SUEN + ' /* SuenMusic */ = {\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = (\n';
  for (const n of GROUPS) o += '\t\t\t\t' + G(n) + ' /* ' + n + ' */,\n';
  o += '\t\t\t);\n\t\t\tname = SuenMusic;\n\t\t\tpath = ../SuenMusic;\n\t\t\tsourceTree = "<group>";\n\t\t};\n';
  for (const n of GROUPS) {
    o += '\t\t' + G(n) + ' /* ' + n + ' */ = {\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = (\n';
    for (const f of main) if (f.group === n) o += '\t\t\t\t' + refMain(f) + ' /* ' + f.file + ' */,\n';
    if (n === 'App') o += '\t\t\t\t' + PLIST_REF + ' /* Info.plist */,\n';
    o += '\t\t\t);\n\t\t\tpath = ' + n + ';\n\t\t\tsourceTree = "<group>";\n\t\t};\n';
  }
  o += '\t\t' + ASSETG + ' /* Assets */ = {\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = (\n\t\t\t\t' + ASSETS_REF + ' /* Assets.xcassets */,\n\t\t\t);\n\t\t\tname = Assets;\n\t\t\tpath = App;\n\t\t\tsourceTree = "<group>";\n\t\t};\n';
  o += '\t\t' + PRODG + ' /* Products */ = {\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = (\n\t\t\t\t' + PROD_REF + ' /* App.app */,\n\t\t\t);\n\t\t\tname = Products;\n\t\t\tsourceTree = "<group>";\n\t\t};\n';
  o += '/* End PBXGroup section */\n\n';

  o += '/* Begin PBXNativeTarget section */\n';
  o += '\t\t' + TARGET + ' /* App */ = {\n\t\t\tisa = PBXNativeTarget;\n\t\t\tbuildConfigurationList = ' + LIST.tgt + ';\n';
  o += '\t\t\tbuildPhases = (\n\t\t\t\t' + SOURCES + ' /* Sources */,\n\t\t\t\t' + FRAMEWORKS + ' /* Frameworks */,\n\t\t\t\t' + RESOURCES + ' /* Resources */,\n\t\t\t);\n';
  o += '\t\t\tbuildRules = (\n\t\t\t);\n\t\t\tdependencies = (\n\t\t\t);\n\t\t\tname = App;\n';
  o += '\t\t\tbuildRules = (\n\t\t\t);\n\t\t\tdependencies = (\n\t\t\t);\n\t\t\tname = App;\n';
  o += '\t\t\tpackageProductDependencies = (\n\t\t\t\t' + PKG_PROD + ' /* ' + MPVKIT_PRODUCT + ' */,\n\t\t\t);\n';
  o += '\t\t\tproductName = App;\n\t\t\tproductReference = ' + PROD_REF + ' /* App.app */;\n\t\t\tproductType = "com.apple.product-type.application";\n\t\t};\n';
  o += '/* End PBXNativeTarget section */\n\n';

  o += '/* Begin PBXProject section */\n';
  o += '\t\t' + PROJ + ' /* Project object */ = {\n\t\t\tisa = PBXProject;\n\t\t\tattributes = {\n\t\t\t\tBuildIndependentTargetsInParallel = YES;\n\t\t\t\tLastUpgradeCheck = 2650;\n\t\t\t\tTargetAttributes = {\n';
  o += '\t\t\t\t\t' + TARGET + ' = {\n\t\t\t\t\t\tProvisioningStyle = Automatic;\n\t\t\t\t\t};\n';
  o += '\t\t\t\t};\n\t\t\t};\n';
  o += '\t\t\tbuildConfigurationList = ' + LIST.proj + ';\n\t\t\tcompatibilityVersion = "Xcode 14.0";\n\t\t\tdevelopmentRegion = zh_CN;\n\t\t\thasScannedForEncodings = 0;\n';
  o += '\t\t\tknownRegions = (\n\t\t\t\tzh_CN,\n\t\t\t\ten,\n\t\t\t\tBase,\n\t\t\t);\n\t\t\tmainGroup = ' + ROOTG + ';\n\t\t\tpackageReferences = (\n\t\t\t\t' + PKG_REF + ' /* ' + PKG_REF_CMT + ' */,\n\t\t\t);\n\t\t\tproductRefGroup = ' + PRODG + ' /* Products */;\n\t\t\tprojectDirPath = "";\n\t\t\tprojectRoot = "";\n';
  o += '\t\t\ttargets = (\n\t\t\t\t' + TARGET + ' /* App */,\n\t\t\t);\n\t\t};\n';
  o += '/* End PBXProject section */\n\n';

  o += '/* Begin PBXResourcesBuildPhase section */\n';
  o += phase(RESOURCES, 'Resources', 'PBXResourcesBuildPhase', [ASSETS_BLD + ' /* Assets.xcassets in Resources */']);
  o += '/* End PBXResourcesBuildPhase section */\n\n';

  o += '/* Begin PBXSourcesBuildPhase section */\n';
  o += phase(SOURCES, 'Sources', 'PBXSourcesBuildPhase', main.map((f) => bldMain(f) + ' /* ' + f.file + ' in Sources */'));
  o += '/* End PBXSourcesBuildPhase section */\n\n';

  const projCommon = (dbg) => [
    'ALWAYS_SEARCH_USER_PATHS = NO;', 'CLANG_ANALYZER_NONNULL = YES;', 'CLANG_ENABLE_MODULES = YES;', 'CLANG_ENABLE_OBJC_ARC = YES;',
    'CLANG_WARN_BOOL_CONVERSION = YES;', 'CLANG_WARN_DIRECT_OBJC_ISA_USAGE = YES_ERROR;', 'CLANG_WARN_INFINITE_RECURSION = YES;',
    'CLANG_WARN_UNGUARDED_AVAILABILITY = YES_AGGRESSIVE;', 'CLANG_WARN_UNREACHABLE_CODE = YES;', 'COPY_PHASE_STRIP = NO;',
    'DEBUG_INFORMATION_FORMAT = ' + (dbg ? 'dwarf;' : '"dwarf-with-dsym";'),
    'ENABLE_STRICT_OBJC_MSGSEND = YES;', 'ENABLE_USER_SCRIPT_SANDBOXING = YES;', 'GCC_C_LANGUAGE_STANDARD = gnu17;',
    'GCC_NO_COMMON_BLOCKS = YES;', 'GCC_WARN_ABOUT_RETURN_TYPE = YES_ERROR;', 'GCC_WARN_UNDECLARED_SELECTOR = YES;',
    'GCC_WARN_UNINITIALIZED_AUTOS = YES_AGGRESSIVE;', 'GCC_WARN_UNUSED_FUNCTION = YES;', 'GCC_WARN_UNUSED_VARIABLE = YES;',
    'IPHONEOS_DEPLOYMENT_TARGET = 17.0;', 'SDKROOT = iphoneos;',
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
    o += '\t\t\t\tIPHONEOS_DEPLOYMENT_TARGET = 17.0;\n';
    o += '\t\t\t\tLD_RUNPATH_SEARCH_PATHS = (\n\t\t\t\t\t"$(inherited)",\n\t\t\t\t\t"@executable_path/Frameworks",\n\t\t\t\t);\n';
    o += '\t\t\t\tMARKETING_VERSION = 2.0.0;\n\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = com.suenmusic.app;\n';
    o += '\t\t\t\tPRODUCT_NAME = "$(TARGET_NAME)";\n\t\t\t\tSWIFT_EMIT_LOC_STRINGS = YES;\n\t\t\t\tSWIFT_VERSION = 5.0;\n';
    o += '\t\t\t\tTARGETED_DEVICE_FAMILY = "1,2";\n';
    o += '\t\t\t};\n\t\t\tname = ' + name + ';\n\t\t};\n';
  }
  o += '/* End XCBuildConfiguration section */\n\n';

  o += '/* Begin XCConfigurationList section */\n';
  const cfgList = (id, dbg, rel) => '\t\t' + id + ' = {\n\t\t\tisa = XCConfigurationList;\n\t\t\tbuildConfigurations = (\n\t\t\t\t' + dbg + ' /* Debug */,\n\t\t\t\t' + rel + ' /* Release */,\n\t\t\t);\n\t\t\tdefaultConfigurationIsVisible = 0;\n\t\t\tdefaultConfigurationName = Debug;\n\t\t};\n';
  o += cfgList(LIST.proj, CFG.dbgP, CFG.relP);
  o += cfgList(LIST.tgt, CFG.dbgT, CFG.relT);
  o += '/* End XCConfigurationList section */\n\n';

  o += '/* Begin XCRemoteSwiftPackageReference section */\n';
  o += '\t\t' + PKG_REF + ' /* ' + PKG_REF_CMT + ' */ = {\n\t\t\tisa = XCRemoteSwiftPackageReference;\n';
  o += '\t\t\trepositoryURL = "' + MPVKIT_URL + '";\n';
  o += '\t\t\trequirement = {\n\t\t\t\tkind = exactVersion;\n\t\t\t\tversion = "' + MPVKIT_VERSION + '";\n\t\t\t};\n\t\t};\n';
  o += '/* End XCRemoteSwiftPackageReference section */\n\n';

  o += '/* Begin XCSwiftPackageProductDependency section */\n';
  o += '\t\t' + PKG_PROD + ' /* ' + MPVKIT_PRODUCT + ' */ = {\n\t\t\tisa = XCSwiftPackageProductDependency;\n';
  o += '\t\t\tpackage = ' + PKG_REF + ' /* ' + PKG_REF_CMT + ' */;\n';
  o += '\t\t\tproductName = ' + MPVKIT_PRODUCT + ';\n\t\t};\n';
  o += '/* End XCSwiftPackageProductDependency section */\n\n';

  o += '\t};\n\trootObject = ' + PROJ + ' /* Project object */;\n}\n';

  return o;
}

const main = collectMain();
if (main.length === 0) {
  console.error('未找到任何 Swift 文件，检查 ios/SuenMusic 结构');
  process.exit(1);
}
const rendered = render(main);
const check = process.argv.includes('--check');
const current = existsSync(PROJECT) ? readFileSync(PROJECT, 'utf8') : '';

if (check) {
  const missing = main.filter((f) => !current.includes('path = ' + f.file + ';'));
  console.log('主 target Swift:', main.length, '｜缺登记:', missing.length);
  console.log('工程与磁盘', current === rendered ? '一致' : '不一致（需重新生成）');
  process.exit(missing.length === 0 && current === rendered ? 0 : 1);
}

writeFileSync(PROJECT, rendered, 'utf8');
console.log('已生成工程：主 target', main.length, '个 Swift（纯原生单 Target）');
