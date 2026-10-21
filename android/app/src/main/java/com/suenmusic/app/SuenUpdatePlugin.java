package com.suenmusic.app;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "SuenUpdate")
public class SuenUpdatePlugin extends Plugin {
  private static final String TAG = "SuenUpdate";
  private static final String PACKAGE_NAME = "com.suenmusic.app";
  private static final long MAX_APK_BYTES = 100L * 1024L * 1024L;
  private final ExecutorService executor = Executors.newSingleThreadExecutor();

  @PluginMethod
  public void getAppVersion(PluginCall call) {
    try {
      PackageInfo info = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
      JSObject result = new JSObject();
      result.put("versionName", info.versionName == null ? "0.0.0" : info.versionName);
      result.put("versionCode", packageVersionCode(info));
      call.resolve(result);
    } catch (Exception e) {
      call.reject("无法读取应用版本");
    }
  }

  @PluginMethod
  public void downloadAndInstall(PluginCall call) {
    String url = call.getString("url", "");
    String accessToken = call.getString("accessToken", "");
    String fileName = call.getString("fileName", "SuenMusic-update.apk");
    String expectedVersionName = call.getString("expectedVersionName", "");
    Long expectedVersionCode = numberArg(call, "expectedVersionCode");
    String expectedSha256 = call.getString("expectedSha256", "");
    if (url.trim().isEmpty() || accessToken.trim().isEmpty()) {
      call.reject("更新请求缺少下载地址或登录凭据");
      return;
    }
    if (!fileName.matches("SuenMusic-v\\d+(?:\\.\\d+)*-release\\.apk")) {
      call.reject("更新文件名不符合安全规则");
      return;
    }

    executor.execute(() -> {
      try {
        File apk = download(url, accessToken, fileName);
        verifyApk(apk, expectedVersionName, expectedVersionCode, expectedSha256);
        openInstaller(apk, call);
      } catch (InstallPermissionException e) {
        getActivity().runOnUiThread(() -> {
          try {
            Intent intent = new Intent(
                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:" + getContext().getPackageName()));
            getActivity().startActivity(intent);
          } catch (Exception ignored) {
            // 部分旧系统没有该设置页，交给页面提示用户手动开启。
          }
          JSObject result = new JSObject();
          result.put("status", "install_permission_required");
          call.resolve(result);
        });
      } catch (Exception e) {
        android.util.Log.e(TAG, "更新下载或校验失败", e);
        call.reject(e.getMessage() == null ? "更新下载失败" : e.getMessage());
      }
    });
  }

  /**
   * 私网/本机地址判定（与 web 端 isPrivateIpUrl 同一口径）。
   *
   * 用途：自托管场景下局域网 http 是现实约束（没有证书），但**公网域名没有理由用 http** ——
   * 明文可被中间人替换成任意同签名 APK。所以只对私网放行 http，公网强制 https。
   */
  private static boolean isPrivateHost(String host) {
    if (host == null || host.isEmpty()) return false;
    String h = host.toLowerCase(Locale.ROOT);
    if (h.equals("localhost") || h.equals("127.0.0.1") || h.equals("::1")) return true;
    if (h.matches("^192\\.168\\.\\d{1,3}\\.\\d{1,3}$")) return true;
    if (h.matches("^10\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}$")) return true;
    if (h.matches("^172\\.(1[6-9]|2\\d|3[01])\\.\\d{1,3}\\.\\d{1,3}$")) return true;
    // Tailscale / CGNAT 100.64.0.0/10
    if (h.matches("^100\\.(6[4-9]|[7-9]\\d|1[01]\\d|12[0-7])\\.\\d{1,3}\\.\\d{1,3}$")) return true;
    // 局域网域名：mDNS(.local)、路由器默认后缀(.lan/.home/.localdomain)、自建内网 DNS(.internal)。
    // 只认 IP 字面量的话，http://nas.local:3210 这类部署会被自家更新链路拒绝（重审 F）。
    if (h.endsWith(".local") || h.endsWith(".lan") || h.endsWith(".home")
        || h.endsWith(".internal") || h.endsWith(".localdomain")) return true;
    // 单标签主机名（nas / fnos 之类，只在局域网内有意义）
    if (!h.contains(".")) return true;
    return false;
  }

  private File download(String rawUrl, String accessToken, String fileName) throws Exception {
    URL url = new URL(rawUrl);
    if (!("http".equalsIgnoreCase(url.getProtocol()) || "https".equalsIgnoreCase(url.getProtocol()))) {
      throw new Exception("更新地址协议不安全");
    }
    if ("http".equalsIgnoreCase(url.getProtocol()) && !isPrivateHost(url.getHost())) {
      throw new Exception("更新地址不安全：公网地址必须使用 https");
    }
    if (url.getPath() == null || !url.getPath().endsWith("/api/update/download")) {
      throw new Exception("更新地址不是 SuenMusic 更新接口");
    }

    File dir = new File(getContext().getCacheDir(), "updates");
    if (!dir.exists() && !dir.mkdirs()) throw new Exception("无法创建更新缓存目录");
    File part = new File(dir, fileName + ".part");
    File apk = new File(dir, fileName);
    if (apk.exists() && !apk.delete()) throw new Exception("无法清理旧更新包");

    HttpURLConnection conn = (HttpURLConnection) url.openConnection();
    conn.setConnectTimeout(15_000);
    conn.setReadTimeout(30_000);
    conn.setRequestProperty("Authorization", "Bearer " + accessToken);
    conn.setRequestProperty("Accept", "application/vnd.android.package-archive");
    conn.connect();
    try {
      if (conn.getResponseCode() < 200 || conn.getResponseCode() >= 300) {
        throw new Exception("更新服务器返回 HTTP " + conn.getResponseCode());
      }
      long expected = conn.getContentLengthLong();
      if (expected > MAX_APK_BYTES) throw new Exception("更新包超过允许大小");
      long written = 0;
      byte[] buffer = new byte[64 * 1024];
      try (java.io.InputStream in = conn.getInputStream(); FileOutputStream out = new FileOutputStream(part)) {
        int n;
        while ((n = in.read(buffer)) != -1) {
          written += n;
          if (written > MAX_APK_BYTES) throw new Exception("更新包超过允许大小");
          out.write(buffer, 0, n);
        }
        out.flush();
      }
      if (written == 0 || (expected >= 0 && expected != written)) throw new Exception("更新包下载不完整");
      if (!part.renameTo(apk)) throw new Exception("无法保存更新包");
      return apk;
    } finally {
      conn.disconnect();
      if (part.exists()) part.delete();
    }
  }

  private void verifyApk(File apk, String expectedVersionName, Long expectedVersionCode, String expectedSha256)
      throws Exception {
    PackageInfo info = getContext().getPackageManager().getPackageArchiveInfo(apk.getAbsolutePath(), 0);
    if (info == null || !PACKAGE_NAME.equals(info.packageName)) throw new Exception("更新包不是 SuenMusic APK");
    String actualName = info.versionName == null ? "" : info.versionName;
    long actualCode = packageVersionCode(info);
    PackageInfo current = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
    if (actualCode <= packageVersionCode(current)) throw new Exception("更新包版本不高于当前版本");
    if (!expectedVersionName.isEmpty() && !expectedVersionName.equals(actualName)) throw new Exception("更新包版本名称不匹配");
    if (expectedVersionCode != null && expectedVersionCode > 0 && expectedVersionCode != actualCode) throw new Exception("更新包版本号不匹配");
    if (!expectedSha256.isEmpty() && !expectedSha256.equalsIgnoreCase(sha256(apk))) throw new Exception("更新包校验失败");
  }

  private void openInstaller(File apk, PluginCall call) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !getContext().getPackageManager().canRequestPackageInstalls()) {
      throw new InstallPermissionException();
    }
    getActivity().runOnUiThread(() -> {
      Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", apk);
      Intent intent = new Intent(Intent.ACTION_VIEW);
      intent.setDataAndType(uri, "application/vnd.android.package-archive");
      intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
      getActivity().startActivity(intent);
      JSObject result = new JSObject();
      result.put("status", "installer_opened");
      call.resolve(result);
    });
  }

  private static long packageVersionCode(PackageInfo info) {
    return Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? info.getLongVersionCode() : info.versionCode;
  }

  private static String sha256(File file) throws Exception {
    MessageDigest digest = MessageDigest.getInstance("SHA-256");
    try (FileInputStream in = new FileInputStream(file)) {
      byte[] buffer = new byte[64 * 1024];
      int n;
      while ((n = in.read(buffer)) != -1) digest.update(buffer, 0, n);
    }
    StringBuilder out = new StringBuilder();
    for (byte b : digest.digest()) out.append(String.format(Locale.ROOT, "%02x", b));
    return out.toString();
  }

  private Long numberArg(PluginCall call, String name) {
    Object raw = call.getData().opt(name);
    return raw instanceof Number ? ((Number) raw).longValue() : null;
  }

  private static final class InstallPermissionException extends RuntimeException {}
}
