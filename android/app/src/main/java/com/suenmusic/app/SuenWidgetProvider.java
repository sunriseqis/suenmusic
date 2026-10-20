package com.suenmusic.app;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.os.Bundle;
import android.util.Log;
import android.widget.RemoteViews;

/**
 * 桌面卡片（小组件）基类。两个子类只是声明不同的 meta-data：
 *
 *   - {@link SuenWidget2x2Provider} → widget_suen_2x2.xml（小卡）
 *   - {@link SuenWidget2x4Provider} → widget_suen_2x4.xml（宽卡，三行歌词）
 *
 * 渲染逻辑共用：按实例 options 里的宽度选布局（用户把小卡拉宽会自动升级成
 * 宽卡布局，反之亦然），其余全部读 {@link SuenWidgetState} 的快照。
 *
 * 按钮动作以广播形式发给 {@link SuenAudioService} 的接收器：
 * 服务活着才响应；死了（alive=false）时不绑点击，按钮自然点不动。
 */
public class SuenWidgetProvider extends AppWidgetProvider {

  private static final String TAG = "SuenWidgetProvider";

  /** 宽度达到这个 dp 就用宽卡布局（2×2 ≈ 160dp，2×4 ≈ 330dp）。 */
  private static final int WIDE_THRESHOLD_DP = 240;

  // 哑光硬件令牌（与 web/src/styles/tokens.css 的深色主题一致）
  private static final int C_PANEL = 0xFF17181B;
  private static final int C_TEXT = 0xFFE9E7E2;
  private static final int C_TEXT2 = 0xFF8D8A83;
  private static final int C_AMBER = 0xFFE8A33D;
  private static final int C_DIM = 0xFF55575C;

  @Override
  public void onUpdate(Context context, AppWidgetManager manager, int[] appWidgetIds) {
    for (int id : appWidgetIds) {
      manager.updateAppWidget(id, buildRemoteViews(context, id));
    }
  }

  @Override
  public void onAppWidgetOptionsChanged(
      Context context, AppWidgetManager manager, int appWidgetId, Bundle newOptions) {
    // 用户拖动改变了大小：按新宽度重选布局（小卡拉宽 → 宽卡布局）
    manager.updateAppWidget(appWidgetId, buildRemoteViews(context, appWidgetId));
  }

  @Override
  public void onReceive(Context context, Intent intent) {
    String action = intent.getAction();
    if (SuenWidgetState.ACTION_REFRESH.equals(action)) {
      AppWidgetManager manager = AppWidgetManager.getInstance(context);
      if (manager == null) return;
      ComponentName me = new ComponentName(context, getClass());
      int[] ids = manager.getAppWidgetIds(me);
      if (ids != null) {
        for (int id : ids) {
          manager.updateAppWidget(id, buildRemoteViews(context, id));
        }
      }
      return;
    }
    super.onReceive(context, intent);
  }

  // ---------------------------------------------------------------------
  // 渲染
  // ---------------------------------------------------------------------

  /** 供 {@link SuenWidgetState} 与服务复用：按实例宽度渲染对应布局。 */
  public static RemoteViews buildRemoteViews(Context ctx, int appWidgetId) {
    AppWidgetManager manager = AppWidgetManager.getInstance(ctx);
    boolean wide = false;
    if (manager != null) {
      Bundle opts = manager.getAppWidgetOptions(appWidgetId);
      if (opts != null) {
        int minW = opts.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 0);
        int maxW = opts.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH, 0);
        wide = Math.max(minW, maxW) >= WIDE_THRESHOLD_DP;
      }
    }
    return wide ? buildWide(ctx) : buildSmall(ctx);
  }

  private static RemoteViews buildSmall(Context ctx) {
    RemoteViews rv = new RemoteViews(ctx.getPackageName(), R.layout.widget_suen_2x2);
    boolean alive = SuenWidgetState.isAlive(ctx) && !SuenWidgetState.trackId(ctx).isEmpty();

    bindOpenApp(ctx, rv, R.id.widgetRoot);
    bindOpenApp(ctx, rv, R.id.coverBox);
    bindOpenApp(ctx, rv, R.id.title);

    if (alive) {
      bindTrack(ctx, rv);
      bindProgress(ctx, rv, false);
      bindButtons(ctx, rv, true);
    } else {
      rv.setTextViewText(R.id.title, ctx.getString(R.string.widget_no_track));
      rv.setViewVisibility(R.id.artist, android.view.View.GONE);
      rv.setViewVisibility(R.id.coverPh, android.view.View.VISIBLE);
      rv.setImageViewBitmap(R.id.cover, null);
      rv.setInt(R.id.coverPh, "setColorFilter", C_DIM);
      rv.setTextViewText(R.id.timeCurrent, "--:--");
      rv.setProgressBar(R.id.progress, 1000, 0, false);
      bindButtons(ctx, rv, false);
    }
    return rv;
  }

  private static RemoteViews buildWide(Context ctx) {
    RemoteViews rv = new RemoteViews(ctx.getPackageName(), R.layout.widget_suen_2x4);
    boolean alive = SuenWidgetState.isAlive(ctx) && !SuenWidgetState.trackId(ctx).isEmpty();

    bindOpenApp(ctx, rv, R.id.widgetRoot);
    bindOpenApp(ctx, rv, R.id.coverBox);
    bindOpenApp(ctx, rv, R.id.title);

    if (alive) {
      bindTrack(ctx, rv);
      bindLyrics(ctx, rv);
      bindProgress(ctx, rv, true);
      bindFavorite(ctx, rv);
      bindButtons(ctx, rv, true);
    } else {
      rv.setTextViewText(R.id.title, ctx.getString(R.string.widget_no_track));
      rv.setViewVisibility(R.id.artist, android.view.View.GONE);
      rv.setViewVisibility(R.id.lyric1, android.view.View.GONE);
      rv.setViewVisibility(R.id.lyric2, android.view.View.GONE);
      rv.setViewVisibility(R.id.lyric3, android.view.View.GONE);
      rv.setViewVisibility(R.id.coverPh, android.view.View.VISIBLE);
      rv.setImageViewBitmap(R.id.cover, null);
      rv.setInt(R.id.coverPh, "setColorFilter", C_DIM);
      rv.setTextViewText(R.id.timeCurrent, "--:--");
      rv.setTextViewText(R.id.timeDuration, "--:--");
      rv.setProgressBar(R.id.progress, 1000, 0, false);
      // 空态保留收藏位（灰色，规则表：2×4 保留）
      rv.setInt(R.id.btnFav, "setColorFilter", C_DIM);
      bindButtons(ctx, rv, false);
    }
    return rv;
  }

  // ---------------------------------------------------------------------
  // 分项绑定
  // ---------------------------------------------------------------------

  private static void bindTrack(Context ctx, RemoteViews rv) {
    rv.setTextViewText(R.id.title, SuenWidgetState.title(ctx));
    String artist = SuenWidgetState.artist(ctx);
    if (artist.isEmpty()) {
      rv.setViewVisibility(R.id.artist, android.view.View.GONE);
    } else {
      rv.setViewVisibility(R.id.artist, android.view.View.VISIBLE);
      rv.setTextViewText(R.id.artist, artist);
    }
    Bitmap cover = SuenWidgetState.coverBitmap(ctx, 256);
    if (cover != null) {
      rv.setImageViewBitmap(R.id.cover, cover);
      rv.setViewVisibility(R.id.coverPh, android.view.View.GONE);
    } else {
      rv.setImageViewBitmap(R.id.cover, null);
      rv.setViewVisibility(R.id.coverPh, android.view.View.VISIBLE);
      rv.setInt(R.id.coverPh, "setColorFilter", C_DIM);
    }
  }

  private static void bindLyrics(Context ctx, RemoteViews rv) {
    int active = SuenWidgetState.lyricActive(ctx);
    int[] ids = {R.id.lyric1, R.id.lyric2, R.id.lyric3};
    for (int i = 0; i < ids.length; i++) {
      String text = SuenWidgetState.lyric(ctx, i);
      if (text.isEmpty()) {
        rv.setViewVisibility(ids[i], android.view.View.GONE);
        continue;
      }
      rv.setViewVisibility(ids[i], android.view.View.VISIBLE);
      rv.setTextViewText(ids[i], text);
      rv.setTextColor(ids[i], i == active ? C_AMBER : C_TEXT2);
    }
  }

  private static void bindProgress(Context ctx, RemoteViews rv, boolean withDuration) {
    long pos = SuenWidgetState.position(ctx);
    long dur = SuenWidgetState.duration(ctx);
    rv.setTextViewText(R.id.timeCurrent, formatMs(pos));
    if (withDuration) rv.setTextViewText(R.id.timeDuration, formatMs(dur));
    int value = 0;
    if (dur > 0) value = (int) Math.min(1000L, pos * 1000L / dur);
    rv.setProgressBar(R.id.progress, 1000, value, false);
  }

  private static void bindFavorite(Context ctx, RemoteViews rv) {
    boolean fav = SuenWidgetState.favorite(ctx);
    rv.setImageViewResource(R.id.btnFav, R.drawable.ic_w_heart);
    rv.setInt(R.id.btnFav, "setColorFilter", fav ? C_AMBER : C_TEXT2);
    // 收藏切换要过服务端，卡片不做无状态的乐观切换：点它打开 App
    bindOpenApp(ctx, rv, R.id.btnFav);
  }

  private static void bindButtons(Context ctx, RemoteViews rv, boolean alive) {
    if (alive) {
      rv.setInt(R.id.btnPlay, "setColorFilter", C_AMBER);
      rv.setInt(R.id.btnPrev, "setColorFilter", C_TEXT);
      rv.setInt(R.id.btnNext, "setColorFilter", C_TEXT);
      rv.setImageViewResource(
          R.id.btnPlay,
          SuenWidgetState.playing(ctx) ? R.drawable.ic_w_pause : R.drawable.ic_w_play);
      rv.setOnClickPendingIntent(R.id.btnPlay, broadcastIntent(ctx, SuenWidgetState.ACTION_PLAY_PAUSE));
      rv.setOnClickPendingIntent(R.id.btnPrev, broadcastIntent(ctx, SuenWidgetState.ACTION_PREV));
      rv.setOnClickPendingIntent(R.id.btnNext, broadcastIntent(ctx, SuenWidgetState.ACTION_NEXT));
    } else {
      // 空态：三键灰掉，不绑点击（不响应）
      rv.setImageViewResource(R.id.btnPlay, R.drawable.ic_w_play);
      rv.setInt(R.id.btnPlay, "setColorFilter", C_DIM);
      rv.setInt(R.id.btnPrev, "setColorFilter", C_DIM);
      rv.setInt(R.id.btnNext, "setColorFilter", C_DIM);
      rv.setOnClickPendingIntent(R.id.btnPlay, null);
      rv.setOnClickPendingIntent(R.id.btnPrev, null);
      rv.setOnClickPendingIntent(R.id.btnNext, null);
    }
  }

  private static void bindOpenApp(Context ctx, RemoteViews rv, int viewId) {
    Intent intent = new Intent(ctx, MainActivity.class);
    intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
    PendingIntent pi = PendingIntent.getActivity(
        ctx, viewId, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    rv.setOnClickPendingIntent(viewId, pi);
  }

  private static PendingIntent broadcastIntent(Context ctx, String action) {
    Intent intent = new Intent(action);
    intent.setPackage(ctx.getPackageName());
    return PendingIntent.getBroadcast(
        ctx, action.hashCode(), intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
  }

  private static String formatMs(long ms) {
    if (ms <= 0) return "--:--";
    long totalSec = ms / 1000;
    return String.format("%d:%02d", totalSec / 60, totalSec % 60);
  }

  static void logDebug(String msg) {
    Log.d(TAG, msg);
  }
}
