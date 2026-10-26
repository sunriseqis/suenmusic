
import crypto from 'node:crypto';
import fs from 'node:fs';
const md5 = s => crypto.createHash('md5').update(s).digest('hex');
const WEB = 'NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt';
const LITE = 'LnT6xpN3khm36zse0QzvmgTZ3waWdRSA';
const guid = md5('suenmusic-kugou-device-v1');
const UA_WEB = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0';
const UA_LITE = 'Android13-1070-11440-3116-0-0-wifi';
function signedWeb(p) {
  const sig = md5(WEB + Object.keys(p).sort().map(k => k + '=' + p[k]).join('') + WEB);
  return new URLSearchParams({ ...p, signature: sig }).toString();
}
const kr = await (await fetch('https://login-user.kugou.com/v2/qrcode?' + signedWeb({ appid: '1014', type: '1', plat: '4', qrcode_txt: 'https://h5.kugou.com/apps/loginQRCode/html/index.html?appid=3116&', srcappid: '2919', mid: guid, dfid: '-', uuid: guid, clienttime: String(Math.floor(Date.now()/1000)), clientver: '11440' }), { headers: { 'User-Agent': UA_WEB, Referer: 'https://h5.kugou.com/' } })).json();
const key = kr?.data?.qrcode;
if (!key) { console.log('拿 key 失败', JSON.stringify(kr).slice(0,200)); process.exit(1); }
const loginUrl = 'https://h5.kugou.com/apps/loginQRCode/html/index.html?qrcode=' + key;
const QRCode = (await import('qrcode')).default;
await QRCode.toFile('/tmp/kg-qr.png', loginUrl, { width: 480, margin: 2 });
console.log('QR_SAVED /tmp/kg-qr.png');
console.log('LOGIN_URL ' + loginUrl);
console.log('KEY ' + key);
// 轮询 90 秒（3s 一次）
for (let i = 0; i < 30; i++) {
  await new Promise(r => setTimeout(r, 3000));
  const cr = await (await fetch('https://login-user.kugou.com/v2/get_userinfo_qrcode?plat=4&appid=3116&srcappid=2919&qrcode=' + key + '&dev=' + guid, { headers: { 'User-Agent': UA_LITE } })).json();
  const st = cr?.data?.status;
  if (st === 4) {
    console.log('LOGIN_SUCCESS');
    console.log('TOKEN ' + (cr?.data?.token ?? ''));
    console.log('USERID ' + (cr?.data?.userid ?? ''));
    fs.writeFileSync('/tmp/kg-token.json', JSON.stringify({ token: cr?.data?.token, userid: cr?.data?.userid }, null, 2));
    break;
  }
  if (i % 5 === 0) console.log('等待扫码/确认… status=' + st);
  if (st === 0) { console.log('二维码已过期'); break; }
}

