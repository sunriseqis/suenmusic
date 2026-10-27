# syntax=docker/dockerfile:1
# ==============================================================================
# SuenMusic All-in-One Dockerfile (Web SPA + Server)
# ==============================================================================

# ---- 1. 构建前端 Web SPA ----
FROM --platform=$BUILDPLATFORM node:22-alpine AS web-builder
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ---- 2. 安装服务端纯 JS 依赖 ----
FROM --platform=$BUILDPLATFORM node:22-alpine AS server-deps
WORKDIR /server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# ---- 3. 运行镜像 ----
FROM node:22-alpine AS runner

RUN apk add --no-cache tzdata wget ca-certificates

WORKDIR /app

ENV NODE_ENV=production \
    SUENMUSIC_HOST=0.0.0.0 \
    SUENMUSIC_PORT=3210 \
    SUENMUSIC_DB=/app/data/suenmusic.db \
    SUENMUSIC_WEB_ROOT=/app/web/dist \
    TZ=Asia/Shanghai

# 复制服务端源码与依赖
COPY --from=server-deps /server/node_modules ./server/node_modules
COPY server/package.json ./server/
COPY server/src/ ./server/src/

# 复制前端编译产物
COPY --from=web-builder /web/dist ./web/dist

# 预先创建持久化数据目录，并将应用所有权赋予 node 用户
RUN mkdir -p /app/data && chown -R node:node /app

USER node
WORKDIR /app/server

EXPOSE 3210
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3210/api/health || exit 1

CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.ts"]
