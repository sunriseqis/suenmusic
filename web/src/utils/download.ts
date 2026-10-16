/**
 * 跨平台文件下载 / 导出工具。
 *
 * 1. 若宿主为 Android 壳且注入了 SuenNativeBackup 原生桥接，则转为 Base64 走 MediaStore 保存到系统 Downloads/SuenMusic 目录。
 * 2. 否则通过标准 Web 的 URL.createObjectURL + <a download> 触发浏览器下载。
 */
export async function downloadBlob(blob: Blob, defaultFilename: string): Promise<boolean> {
  const nativeBackup = (
    window as unknown as {
      SuenNativeBackup?: { saveBackup?: (b64: string, name: string) => boolean };
    }
  ).SuenNativeBackup;

  if (nativeBackup && typeof nativeBackup.saveBackup === 'function') {
    try {
      const buffer = await blob.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binary = '';
      const len = bytes.byteLength;
      for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i] ?? 0);
      }
      const b64 = btoa(binary);
      const ok = nativeBackup.saveBackup(b64, defaultFilename);
      if (ok) return true;
    } catch {
      // 降级走标准 Web 下载
    }
  }

  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = defaultFilename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  } catch {
    return false;
  }
}
