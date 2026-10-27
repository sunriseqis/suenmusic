// 云搜索（cloudsearch）：唯一带「官方原唱认证」的搜索接口
//
// 与 /api/search/get 的区别（实测 2026-10-26）：
//   · 旧接口返回 artists，**没有 originCoverType** —— 无法区分原唱与翻唱；
//   · 本接口返回 ar/al，并带 originCoverType：1=官方认证原唱，2=翻唱，0=未认证/合集。
// 零翻唱过滤依赖它，所以单曲搜索必须走这条。

const createOption = require('../util/option.js')

module.exports = (query, request) => {
  const data = {
    s: query.keywords,
    type: query.type || 1, // 1: 单曲
    limit: query.limit || 30,
    offset: query.offset || 0,
    total: true,
  }
  return request(`/api/cloudsearch/pc`, data, createOption(query))
}
