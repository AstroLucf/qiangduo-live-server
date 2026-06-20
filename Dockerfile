# 抖音云 容器服务 · 抢夺45分钟 直播小玩法服务端
# 零依赖（原生 http + SSE），无需 npm install / build。抖音云路由到 8000，日志走 stdout。
FROM node:16-alpine

WORKDIR /opt/application/

COPY . .

# 抖音云容器对外端口固定 8000（与下方 EXPOSE 一致）；本地默认 8787，互不影响
ENV PORT=8000
EXPOSE 8000

CMD ["node", "index.js"]
