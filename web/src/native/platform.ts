/**
 * 平台判定的**单一来源**。
 *
 * 为什么单独一个文件：四个端（Web / Android / iOS / 鸿蒙）对"我是不是原生壳"
 * 的回答必须一致，否则会出现「一端认为自己是浏览器 → 隐藏服务端地址框 →
 * 永远连不上服务端」这种整端失联。
 *
 * 2026-10-20 审计发现的真实事故：`api/client.ts` 只问了 Capacitor，而鸿蒙
 * **不走 Capacitor**（见下），于是鸿蒙被判成「同源 Web 面板」：
 * 登录页不渲染地址框、`/api/**` 拼成相对路径打回 WebView 自己、
 * 跨源 cookie 会话永不成立 —— 整个鸿蒙端连不上服务端。
 * 结论：判定只能在这里做一次，其余模块一律 import。
 */

import { Capacitor } from '@capacitor/core';

/**
 * 鸿蒙 NEXT：**不走 Capacitor** —— 那套桥在鸿蒙端不存在，
 * `Capacitor.isNativePlatform()` / `getPlatform()` 在这里一律是 web。
 * 鸿蒙只通过 ArkTS 注入的全局对象 `window.SuenHarmony` 通信，
 * 所以用「注入对象在不在」来认平台。
 */
export const isHarmony: boolean =
  typeof window !== 'undefined' &&
  !!(window as unknown as { SuenHarmony?: unknown }).SuenHarmony;

/** Capacitor 原生壳（Android / iOS） */
export const isCapacitorNative: boolean = Capacitor.isNativePlatform();

/**
 * 所有原生壳：Capacitor（Android / iOS）∪ 鸿蒙 ArkTS 桥。
 *
 * 这类环境**没有「同源」概念** —— 页面来自 WebView 自身的 `localhost`/`capacitor://`，
 * 而 API 在用户配置的服务端地址上。因此：基地址必须显式配置，相对路径一律不可用。
 */
export const isNativeShell: boolean = isCapacitorNative || isHarmony;

/**
 * 是不是「Web 面板」——同源浏览器里的控制台（服务端自己发的前端）。
 *
 * 服务器配置类操作（账号管理、AI 模型增删改、音源扫码、数据备份）只允许
 * 从这里发起：约定见 docs/memory/2026-10-18-设置页与服务端边界.md，
 * 服务端配套 requireWebAdmin（Bearer 一律 403）。
 * 三个原生壳（安卓/iOS 的 Capacitor、鸿蒙的 bridge）都不是 Web 面板。
 */
export const isWebPanel: boolean = !isNativeShell;
