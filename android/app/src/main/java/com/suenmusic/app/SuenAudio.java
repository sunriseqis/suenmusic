package com.suenmusic.app;

import android.net.Uri;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;

/**
 * 原生音频层的共享常量与流会话存储。
 *
 * 流会话（baseUrl + 会话流令牌）由 Web 端通过 Capacitor 插件写入，
 * SuenAudioService 在 onAddMediaItems 时用它把曲目 id 组装成
 * 带鉴权令牌的代理流地址。静态存储是因为插件与前台服务同进程，
 * 走 Intent 传参会把生命周期耦合在一起。
 */
public final class SuenAudio {

  /** 音乐类音频属性：true = 让 ExoPlayer 自动处理音频焦点（来电暂停、让路导航） */
  public static final AudioAttributes AUDIO_ATTRIBUTES = new AudioAttributes.Builder()
      .setUsage(C.USAGE_MEDIA)
      .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
      .build();

  /** 网络流需要 WAKE_MODE_NETWORK：熄屏时保持 CPU 拉流不断 */
  public static final int WAKE_MODE = C.WAKE_MODE_NETWORK;

  private static volatile String baseUrl;
  private static volatile String sessionToken;

  /**
   * 直连模式：曲目 id → 外部音源地址（B站 CDN 等）。
   *
   * 为什么需要它：不配服务端时没有 `/api/stream/<id>` 这个代理，
   * 客户端要自己解析出上游地址直接播。有这个映射，`streamUrlFor` 就优先返回它，
   * 既有的"服务端代理"路径完全不受影响（映射为空时行为与从前一致）。
   */
  private static final java.util.concurrent.ConcurrentHashMap<String, String> directUrls =
      new java.util.concurrent.ConcurrentHashMap<>();

  private SuenAudio() {}

  public static void setStreamSession(String base, String token) {
    baseUrl = base;
    sessionToken = token;
  }

  /** 登记一条直连地址（曲目 id → 可播放 URL） */
  public static void setDirectUrl(String trackId, String url) {
    if (trackId == null || trackId.isEmpty()) return;
    if (url == null || url.isEmpty()) {
      directUrls.remove(trackId);
    } else {
      directUrls.put(trackId, url);
    }
  }

  public static void clearDirectUrls() {
    directUrls.clear();
  }

  public static boolean hasDirectUrl(String trackId) {
    String u = trackId == null ? null : directUrls.get(trackId);
    return u != null && !u.isEmpty();
  }

  public static String getBaseUrl() {
    return baseUrl;
  }

  public static String getSessionToken() {
    return sessionToken;
  }

  /** 组装带会话令牌的代理流地址：`<base>/api/stream/<id>?t=<token>`（防御双斜杠） */
  public static String streamUrlFor(String trackId) {
    // 直连优先：登记过就直接用上游地址，不经过服务端
    String direct = trackId == null ? null : directUrls.get(trackId);
    if (direct != null && !direct.isEmpty()) return direct;

    String raw = getBaseUrl();
    if (raw == null || raw.isEmpty()) return "";
    while (raw.endsWith("/")) {
      raw = raw.substring(0, raw.length() - 1);
    }
    String token = getSessionToken();
    String encId = Uri.encode(trackId);
    if (token != null && !token.isEmpty()) {
      return raw + "/api/stream/" + encId + "?t=" + Uri.encode(token);
    }
    return raw + "/api/stream/" + encId;
  }
}
