# syntax=docker/dockerfile:1

# ---- 构建阶段：安装依赖、跑验收测试、产出静态页面 ----
FROM node:20-alpine AS build
WORKDIR /app

# 优先复制依赖清单以利用层缓存
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY . .
# 一次性验收：朴素预言机对照 + 3 秒时限 + 输入/编辑校验
RUN npm test
RUN npm run build

# ---- 运行阶段：nginx 纯静态托管 ----
FROM nginx:1.27-alpine AS runtime
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD wget -qO- http://localhost:80/ >/dev/null 2>&1 || exit 1
CMD ["nginx", "-g", "daemon off;"]
