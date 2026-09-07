# syntax=docker/dockerfile:1
FROM node:24.16.0-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json index.js ./
COPY src/ ./src/

USER node
EXPOSE 3000
CMD ["node", "index.js"]
