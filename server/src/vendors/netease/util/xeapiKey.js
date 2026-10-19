const registerXeapiKey = require('../module/register_xeapikey')

const getXeapiPublicKey = async (currentPublicKey = {}, deviceId = '') => {
  const result = await registerXeapiKey(
    {
      deviceId,
      currentKeyVersion: currentPublicKey.version || '',
    },
    null,
  )

  const publicKey = result.body
  if (!publicKey.sk && currentPublicKey.sk) {
    publicKey.sk = currentPublicKey.sk
  }
  // sk 已于实测中不再随首次响应下发（2026-09 返回 {publicKey, version, nextUpdateTime}），
  // 而 crypto.js 里 sk 参与签名时本就写作 publicKeyState.sk || ''，缺省可接受 ——
  // 原版强校验 sk 会把 vendor 整个卡死在启动阶段。
  return publicKey
}

module.exports = {
  getXeapiPublicKey,
}
