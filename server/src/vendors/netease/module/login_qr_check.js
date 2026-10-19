const createOption = require('../util/option.js')
module.exports = async (query, request) => {
  const data = {
    key: query.key,
    type: 3,
  }
  try {
    let result = await request(
      `/api/login/qrcode/client/login`,
      data,
      createOption(query),
    )
    result = {
      status: 200,
      body: {
        ...result.body,
        cookie: result.cookie.join(';'),
      },
      cookie: result.cookie,
    }
    return result
  } catch (error) {
    // 注意：request 抛错时 `result` 尚未赋值，原样引用会抛 ReferenceError
    // （上游原版的笔误，表现为"查询扫码结果失败：result is not defined"）
    return {
      status: 200,
      body: {},
      cookie: [],
    }
  }
}
