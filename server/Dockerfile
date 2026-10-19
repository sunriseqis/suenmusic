# syntax=docker/dockerfile:1
# ==============================================================================
# SuenMusic Server Dockerfile
# 基于 Node 22 轻量级 Alpine 镜像，原生运行 TypeScript（免构建步骤）
#
# 多架构构建注意：npm ci 必须在 --platform=$BUILDPLATFORM（构建机的原生架构）跑。
#   在 QEMU 模拟的 arm64 里执行 Node 会直接 SIGILL 崩溃（V8 的 JIT/CPU 特性探测
#   与模拟器不兼容，实测 exit code 132 / "uncaught target signal 4"）。
#   我们的依赖全部是纯 JS（无任何原生模块），node_modules 可以跨架构复制 ——
#   于是构建期完全不需要在模拟器里执行 Node，arm64 镜像照样能出。
# ==============================================================================

# ---- 依赖安装：跑在构建机原生架构上，绕开 QEMU 跑 Node 的坑 ----
FROM --platform=$BUILDPLATFORM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# ---- 运行镜像：目标架构（amd64 / arm64），只做文件复制，不再执行 npm ----
FROM node:22-alpine AS runner

# 安装基础运行工具与 CA 证书
RUN apk add --no-cache tzdata wget ca-certificates

WORKDIR /app

ENV NODE_ENV=production \
    SUENMUSIC_HOST=0.0.0.0 \
    SUENMUSIC_PORT=3210 \
    SUENMUSIC_DB=/app/data/suenmusic.db

# 纯 JS 依赖：直接复用原生平台装好的 node_modules
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./

# 复制服务端源码与数据库迁移脚本
COPY src/ ./src/

# 预先创建持久化数据目录，并将应用所有权赋予非 root 用户 node
RUN mkdir -p /app/data && chown -R node:node /app

USER node

EXPOSE 3210

VOLUME ["/app/data"]

# 容器健康检查：定时探测 /api/health
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3210/api/health || exit 1

# 启动服务
CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.ts"]
