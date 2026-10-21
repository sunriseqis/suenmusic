package com.suenmusic.app;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.util.Log;
import androidx.annotation.Nullable;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.List;

/**
 * 桌面卡片（小组件）快照的单一真相源。
 *
 * 服务（{@link SuenAudioService}）在播放状态/曲目/歌词变化时把快照写进
 * SharedPreferences，封面异步下载到 filesDir/widget/cover.jpg，
 * 然后触发 {@link SuenWidgetProvider} 重绘。卡片冷启动（开机、被 launcher
 * 重新拉起）时也只读这份快照渲染。
 *
 * 约定（docs/plan/2026-10-19-桌面卡片设计定稿.md）：
 *   - 进度是静态快照，只随状态/曲目变化推，不做平滑动画（另加 5s 轻量 tick）；
 *   - alive=false（服务已退出）时渲染空态，三键不响应。
 */
public final class SuenWidgetState {

  private static final String TAG = "SuenWidgetState";
  private static final String PREFS = "suen_widget";

  /** 广播动作：让 provider 重绘（发给 provider 自己）。 */
  public static final String ACTION_REFRESH = "com.suenmusic.app.widget.REFRESH";
  /** 广播动作：卡片按钮 → 服务（播放/暂停）。 */
  public static final String ACTION_PLAY_PAUSE = "com.suenmusic.app.widget.PLAY_PAUSE";
  /** 广播动作：卡片按钮 → 服务（下一首）。 */
  public static final String ACTION_NEXT = "com.suenmusic.app.widget.NEXT";
  /** 广播动作：卡片按钮 → 服务（上一首）。 */
  public static final String ACTION_PREV = "com.suenmusic.app.widget.PREV";

  private static final String K_ALIVE = "alive";
  private static final String K_TRACK_ID = "track_id";
  private static final String K_TITLE = "title";
  private static final String K_ARTIST = "artist";
  private static final String K_ALBUM = "album";
  private static final String K_COVER_PATH = "cover_path";
  private static final String K_COVER_URL = "cover_url";
  private static final String K_PLAYING = "playing";
  private static final String K_POSITION = "position_ms";
  private static final String K_DURATION = "duration_ms";
  private static final String K_FAVORITE = "favorite";
  private static final String K_LYRIC1 = "lyric1";
  private static final String K_LYRIC2 = "lyric2";
  private static final String K_LYRIC3 = "lyric3";
  private static final String K_LYRIC_ACTIVE = "lyric_active"; // 0..2，-1 无歌词

  /** 卡片进程与 App 进程共用一份 SharedPreferences（同包，MODE_PRIVATE 即可）。 */
  private static SharedPreferences prefs(Context ctx) {
    return ctx.getApplicationContext()
        .getSharedPreferences(PREFS, Context.MODE_PRIVATE);
  }

  private SuenWidgetState() {}

  // ---------------------------------------------------------------------
  // 写入侧（服务 / 插件）
  // ---------------------------------------------------------------------

  /**
   * 发布整份快照（曲目变化、播放态变化、歌词行变化时调用）。
   *
   * @param lyricLines 正好 3 行（上一行/当前/下一行），无歌词传空列表
   * @param lyricActive 当前行在 3 行里的下标（0..2），无歌词传 -1
   */
  public static void publish(
      Context ctx,
      @Nullable String trackId,
      @Nullable String title,
      @Nullable String artist,
      @Nullable String album,
      @Nullable String coverUrl,
      boolean playing,
      long positionMs,
      long durationMs,
      @Nullable List<String> lyricLines,
      int lyricActive) {

    SharedPreferences.Editor ed = prefs(ctx).edit();
    ed.putBoolean(K_ALIVE, true);
    // 切歌即重置红心：这个快照不带收藏态，而 web 只在"用户手动切收藏"时推
    // setFavorite —— 不重置的话新歌会沿用上一首的红心（重审 F）。
    // 之后 web 若已加载收藏集合，会在下一次元数据上报时推正确值。
    String nextTrackId = trackId == null ? "" : trackId;
    if (!nextTrackId.equals(prefs(ctx).getString(K_TRACK_ID, ""))) {
      ed.putBoolean(K_FAVORITE, false);
    }
    ed.putString(K_TRACK_ID, nextTrackId);
    ed.putString(K_TITLE, title == null ? "" : title);
    ed.putString(K_ARTIST, artist == null ? "" : artist);
    ed.putString(K_ALBUM, album == null ? "" : album);
    ed.putBoolean(K_PLAYING, playing);
    ed.putLong(K_POSITION, Math.max(0L, positionMs));
    ed.putLong(K_DURATION, Math.max(0L, durationMs));
    ed.putString(K_LYRIC1, lineAt(lyricLines, 0));
    ed.putString(K_LYRIC2, lineAt(lyricLines, 1));
    ed.putString(K_LYRIC3, lineAt(lyricLines, 2));
    ed.putInt(K_LYRIC_ACTIVE, lyricActive);

    // 封面 URL 变了就先清掉旧封面引用（异步下载完成后回填），
    // 否则切歌瞬间卡片会残留上一首的封面。
    String previousUrl = prefs(ctx).getString(K_COVER_URL, "");
    String nextUrl = coverUrl == null ? "" : coverUrl.trim();
    if (!previousUrl.equals(nextUrl)) {
      ed.remove(K_COVER_PATH);
      ed.putString(K_COVER_URL, nextUrl);
    }
    ed.apply();

    if (!nextUrl.isEmpty()) ensureCoverAsync(ctx, nextUrl);
    notifyWidgets(ctx);
  }

  /** 只更新进度（播放中 5 秒 tick，不重新下载封面）。 */
  public static void publishProgress(Context ctx, long positionMs, long durationMs) {
    SharedPreferences.Editor ed = prefs(ctx).edit();
    ed.putLong(K_POSITION, Math.max(0L, positionMs));
    if (durationMs > 0) ed.putLong(K_DURATION, durationMs);
    ed.apply();
    notifyWidgets(ctx);
  }

  /** 收藏状态（web 侧 favorites store 变化时经插件推过来）。 */
  public static void setFavorite(Context ctx, @Nullable String trackId, boolean favorite) {
    SharedPreferences sp = prefs(ctx);
    // 只认当前曲目的收藏态，避免后台刷新把别的曲目的收藏写到卡片上
    if (trackId != null && !trackId.equals(sp.getString(K_TRACK_ID, ""))) return;
    sp.edit().putBoolean(K_FAVORITE, favorite).apply();
    notifyWidgets(ctx);
  }

  /** 服务退出/无曲目：清空为空态。 */
  public static void publishEmpty(Context ctx) {
    SharedPreferences sp = prefs(ctx);
    String coverPath = sp.getString(K_COVER_PATH, "");
    if (coverPath != null && !coverPath.isEmpty()) {
      // noinspection ResultOfMethodCallIgnored
      new File(coverPath).delete();
    }
    sp.edit()
        .putBoolean(K_ALIVE, false)
        .putString(K_TRACK_ID, "")
        .putString(K_TITLE, "")
        .putString(K_ARTIST, "")
        .putString(K_ALBUM, "")
        .putBoolean(K_PLAYING, false)
        .putLong(K_POSITION, 0L)
        .putLong(K_DURATION, 0L)
        .putBoolean(K_FAVORITE, false)
        .remove(K_COVER_PATH)
        .remove(K_COVER_URL)
        .putString(K_LYRIC1, "")
        .putString(K_LYRIC2, "")
        .putString(K_LYRIC3, "")
        .putInt(K_LYRIC_ACTIVE, -1)
        .apply();
    notifyWidgets(ctx);
  }

  // ---------------------------------------------------------------------
  // 读取侧（provider 渲染）
  // ---------------------------------------------------------------------

  public static boolean isAlive(Context ctx) {
    return prefs(ctx).getBoolean(K_ALIVE, false);
  }

  public static String trackId(Context ctx) {
    return prefs(ctx).getString(K_TRACK_ID, "");
  }

  public static String title(Context ctx) {
    return prefs(ctx).getString(K_TITLE, "");
  }

  public static String artist(Context ctx) {
    return prefs(ctx).getString(K_ARTIST, "");
  }

  public static String album(Context ctx) {
    return prefs(ctx).getString(K_ALBUM, "");
  }

  public static boolean playing(Context ctx) {
    return prefs(ctx).getBoolean(K_PLAYING, false);
  }

  public static long position(Context ctx) {
    return prefs(ctx).getLong(K_POSITION, 0L);
  }

  public static long duration(Context ctx) {
    return prefs(ctx).getLong(K_DURATION, 0L);
  }

  public static boolean favorite(Context ctx) {
    return prefs(ctx).getBoolean(K_FAVORITE, false);
  }

  public static String lyric(Context ctx, int index) {
    switch (index) {
      case 0: return prefs(ctx).getString(K_LYRIC1, "");
      case 1: return prefs(ctx).getString(K_LYRIC2, "");
      case 2: return prefs(ctx).getString(K_LYRIC3, "");
      default: return "";
    }
  }

  public static int lyricActive(Context ctx) {
    return prefs(ctx).getInt(K_LYRIC_ACTIVE, -1);
  }

  /** 本地封面解码成 Bitmap（不存在/失败返回 null，调用方回落音符占位）。 */
  @Nullable
  public static Bitmap coverBitmap(Context ctx, int targetPx) {
    String path = prefs(ctx).getString(K_COVER_PATH, "");
    if (path == null || path.isEmpty()) return null;
    File f = new File(path);
    if (!f.exists() || f.length() == 0) return null;
    try {
      BitmapFactory.Options opts = new BitmapFactory.Options();
      opts.inJustDecodeBounds = true;
      BitmapFactory.decodeFile(path, opts);
      int sample = 1;
      while (Math.max(opts.outWidth, opts.outHeight) / (sample * 2) >= targetPx) {
        sample *= 2;
      }
      opts.inSampleSize = sample;
      opts.inJustDecodeBounds = false;
      return BitmapFactory.decodeFile(path, opts);
    } catch (Exception e) {
      Log.w(TAG, "封面解码失败: " + e.getMessage());
      return null;
    }
  }

  /** 触发两个 provider（2×2 / 2×4）的全部实例重绘。 */
  public static void notifyWidgets(Context ctx) {
    AppWidgetManager manager = AppWidgetManager.getInstance(ctx);
    if (manager == null) return;
    refreshComponent(ctx, manager, SuenWidget2x2Provider.class);
    refreshComponent(ctx, manager, SuenWidget2x4Provider.class);
  }

  private static void refreshComponent(
      Context ctx, AppWidgetManager manager, Class<? extends AppWidgetProvider> cls) {
    int[] ids = manager.getAppWidgetIds(new ComponentName(ctx, cls));
    if (ids == null) return;
    for (int id : ids) {
      // 每个实例按自己的 options（宽 → 2×4 布局）单独渲染
      manager.updateAppWidget(id, SuenWidgetProvider.buildRemoteViews(ctx, id));
    }
  }

  private static String lineAt(@Nullable List<String> lines, int i) {
    if (lines == null || i < 0 || i >= lines.size() || lines.get(i) == null) return "";
    return lines.get(i);
  }

  /**
   * 后台下载封面到 filesDir/widget/cover.jpg，完成后回填 prefs 并刷新卡片。
   * 失败静默（卡片回落到音符占位），不弹错、不重试风暴。
   */
  private static void ensureCoverAsync(Context ctx, String url) {
    new Thread(() -> {
      try {
        File dir = new File(ctx.getFilesDir(), "widget");
        if (!dir.exists() && !dir.mkdirs()) return;
        File out = new File(dir, "cover.jpg");
        File tmp = new File(dir, "cover.jpg.tmp");

        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setConnectTimeout(8000);
        conn.setReadTimeout(8000);
        conn.setInstanceFollowRedirects(true);
        try (InputStream in = conn.getInputStream();
            FileOutputStream fos = new FileOutputStream(tmp)) {
          byte[] buf = new byte[16384];
          int n;
          while ((n = in.read(buf)) > 0) fos.write(buf, 0, n);
        } finally {
          conn.disconnect();
        }
        if (!tmp.renameTo(out)) {
          // noinspection ResultOfMethodCallIgnored
          out.delete();
          if (!tmp.renameTo(out)) return;
        }

        // 下载期间可能又切了歌：URL 对不上就丢弃这批字节
        if (!url.equals(prefs(ctx).getString(K_COVER_URL, ""))) {
          // noinspection ResultOfMethodCallIgnored
          out.delete();
          return;
        }
        prefs(ctx).edit().putString(K_COVER_PATH, out.getAbsolutePath()).apply();
        notifyWidgets(ctx);
      } catch (Exception e) {
        Log.w(TAG, "封面下载失败: " + e.getMessage());
      }
    }, "suen-widget-cover").start();
  }
}
