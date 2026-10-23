# ヒダマリ 建物データ API（Render / Cloud Run / Fly 用）。HTTPS はプラットフォームが終端。
FROM node:22-slim
WORKDIR /app
COPY package.json package.json
RUN npm install --omit=dev
COPY scripts/server.mjs scripts/server.mjs
COPY cities-index.json cities-index.json
ENV DATA_DIR=/app
ENV CACHE_DIR=/tmp/.cache
EXPOSE 8787
CMD ["node", "scripts/server.mjs"]
