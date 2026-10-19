/**
 * HTTP 错误。
 *
 * 统一形状 `{ error: { code, message } }`。
 * `code` 是给程序判断的稳定标识，`message` 是给人和客户端直接展示的中文文案 ——
 * 前端不该再去维护一张"错误码 → 中文"的映射表。
 */

export class AppError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (message: string, code = 'bad_request') =>
  new AppError(400, code, message);

export const unauthorized = (message = '未登录或登录已过期') =>
  new AppError(401, 'unauthorized', message);

export const forbidden = (message = '没有权限') =>
  new AppError(403, 'forbidden', message);

export const notFound = (message = '资源不存在') =>
  new AppError(404, 'not_found', message);

export const conflict = (message: string, code = 'conflict') =>
  new AppError(409, code, message);

export const tooManyRequests = (message: string) =>
  new AppError(429, 'too_many_requests', message);

export const badGateway = (message = '上游服务异常', code = 'bad_gateway') =>
  new AppError(502, code, message);

export const serviceUnavailable = (message = '服务暂不可用', code = 'service_unavailable') =>
  new AppError(503, code, message);
