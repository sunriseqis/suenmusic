# syntax=docker/dockerfile:1
# ==============================================================================
# SuenMusic Web Dockerfile
# 多阶段构建：Stage 1 Node 22 编译 Vue 3 前端，Stage 2 Nginx Alpine 静态托管与 API 反代
# ==============================================================================

# ---- 阶段 1：构建前端纯静态资源 ----
FROM node:22-alpine AS builder

WORKDIR /app

# 复制依赖定义
COPY package.json package-lock.json ./

# 安装依赖
RUN npm ci

# 复制前端全部代码
COPY . .

# 执行生产打包 (vue-tsc --noEmit && vite build)
RUN npm run build

# ---- 阶段 2：轻量级 Nginx 运行时 ----
FROM nginx:alpine AS runner

# 设置后端 API 默认地址（可通过 docker-compose 或 -e BACKEND_URL 覆盖）
ENV BACKEND_URL=http://suenmusic-server:3210

# 复制 Nginx 配置模板（nginx:alpine 自带模板替换功能，启动时自动将 $BACKEND_URL 写入 default.conf）
COPY nginx.conf.template /etc/nginx/templates/default.conf.template

# 复制静态产物
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80

# 健康检查：确保 Nginx 正常返回 200
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:80/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
