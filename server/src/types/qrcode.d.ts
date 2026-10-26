declare module 'qrcode' {
  const QRCode: {
    toDataURL(text: string, opts?: Record<string, unknown>): Promise<string>;
    toFile(path: string, text: string, opts?: Record<string, unknown>): Promise<void>;
  };
  export default QRCode;
}
