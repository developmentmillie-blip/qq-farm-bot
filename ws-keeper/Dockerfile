FROM node:20-alpine

WORKDIR /app

# 复制 package.json 安装依赖
COPY ws-keeper/package.json ./
RUN npm install --omit=dev

# 复制保活服务代码
COPY ws-keeper/index.js ./
COPY ws-keeper/utils ./utils

# 从主程序复制 proto 文件
COPY core/src/proto ./proto

ENV PROTO_DIR=/app/proto
ENV KEEPER_PORT=4000
ENV NODE_ENV=production
ENV TZ=Asia/Shanghai

EXPOSE 4000

CMD ["node", "index.js"]

